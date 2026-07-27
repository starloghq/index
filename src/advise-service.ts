import { runSearch, type SearchArgs } from './search-service.js';
import { buildComposeDeps, resolveFactView, createFactsApiClient } from './engine/facts.js';
import { assessPackageSafety, defaultPackageizeSteps, loadPlaybookSteps } from './engine/advise.js';
import { packageNameForManifest } from './engine/package-aliases.js';
import { categoryFromObservation, scanProject } from './patterns/detect.js';
import {
  readPatternStore,
  getGlobalPatternsPath,
  getProjectPatternsPath,
  upsertPattern,
  updatePatternStatus,
  totalOccurrences,
} from './patterns/store.js';
import {
  RECURRENCE_THRESHOLD,
  type AdviseResult,
  type PatternSignal,
  type SafeCandidate,
} from './patterns/schema.js';
import { overlayPath } from './engine/overlay-discovery.js';

/** Capability-oriented search queries — DIY observation text ranks poorly against corpus manifests. */
const CATEGORY_SEARCH_QUERY: Record<string, string> = {
  authentication: 'managed authentication login session SSO Next.js',
  'feature-flags': 'feature flags experimentation rollout',
  caching: 'redis cache caching library',
  realtime: 'realtime websocket push',
  'background-jobs': 'background job queue worker',
  email: 'transactional email send',
  'orm-database': 'ORM database query builder',
};

/** Advise relevance floor when search is already category-filtered. */
const ADVISE_MIN_RELEVANCE = 50;

export interface AdviseArgs {
  observation?: string;
  project_root?: string;
  category?: string;
  force?: boolean;
  context?: string;
  top_k?: number;
  privateCorpusPath?: string;
  privateFactsPath?: string;
  policyPath?: string;
}

export async function runAdvise(args: AdviseArgs): Promise<AdviseResult> {
  const projectRoot = args.project_root ?? process.cwd();
  let category = args.category as string | undefined;
  let signals: PatternSignal[] = [];

  if (args.project_root || !args.observation) {
    const hits = await scanProject(projectRoot);
    if (!category && hits.length > 0) {
      const best = hits.sort((a, b) => b.confidence - a.confidence)[0];
      category = best.category;
      signals = best.signals;
    } else if (category) {
      const hit = hits.find((h) => h.category === category);
      if (hit) signals = hit.signals;
    }
  }

  if (!category && args.observation) {
    category = categoryFromObservation(args.observation) ?? undefined;
    if (args.observation.trim()) {
      signals.push({ kind: 'keyword', value: args.observation.trim().slice(0, 120) });
    }
  }

  if (!category) {
    return {
      action: 'watch',
      category: 'authentication',
      rationale:
        'Could not map input to a known capability category. Provide --category or a clearer observation (e.g. "DIY JWT auth in Next.js").',
      playbook_steps: ['Re-run with --category or a more specific observation'],
      signals: signals.length ? signals : undefined,
    };
  }

  // Prefer a capability query so known libraries clear the safety gate; the
  // observation already drives category detection and pattern signals above.
  const query = CATEGORY_SEARCH_QUERY[category] ?? category.replace(/-/g, ' ');

  const privateCorpusPath =
    args.privateCorpusPath ?? overlayPath(process.env.STARLOG_PRIVATE_CORPUS, 'private-corpus.json', projectRoot);
  const privateFactsPath =
    args.privateFactsPath ?? overlayPath(process.env.STARLOG_PRIVATE_FACTS, 'private-facts.json', projectRoot);
  const policyPath = args.policyPath ?? overlayPath(process.env.STARLOG_POLICY, 'policy.json', projectRoot);

  // NB: deliberately no `context` here. A project context triggers search()'s
  // per-candidate LLM enrichment (vs_custom/context_fit/tradeoffs) — advise
  // never reads those fields, so passing it only adds a multi-second LLM
  // round-trip and token cost per call. Ranking is unaffected by context.
  const searchArgs: SearchArgs = {
    query,
    category,
    top_k: args.top_k ?? 8,
    privateCorpusPath,
  };

  const results = await runSearch(searchArgs);
  const factsDeps = {
    local: buildComposeDeps({
      ...process.env,
      STARLOG_PRIVATE_FACTS: privateFactsPath,
      STARLOG_POLICY: policyPath,
    }),
    api: createFactsApiClient(),
  };

  const safeCandidates: SafeCandidate[] = [];
  for (const result of results) {
    const pkg = result.manifest;
    const packageName = packageNameForManifest(pkg);
    const factView = await resolveFactView(packageName, factsDeps);
    const verdict = assessPackageSafety(result, factView, { minRelevance: ADVISE_MIN_RELEVANCE });
    if (!verdict.safe) continue;
    safeCandidates.push({
      manifest_id: pkg.id,
      name: pkg.name,
      package_name: verdict.package_name,
      relevance_score: result.relevance_score,
      facts_available: verdict.facts_available,
    });
  }

  // Prefer curated public packages over auto-generated packageize stubs when
  // both pass the gate — private-first search would otherwise surface the stub
  // and hide Clerk/Auth0 as migrate targets.
  safeCandidates.sort((a, b) => {
    const aAuto = results.find((r) => r.manifest.id === a.manifest_id)?.manifest.auto_generated ? 1 : 0;
    const bAuto = results.find((r) => r.manifest.id === b.manifest_id)?.manifest.auto_generated ? 1 : 0;
    if (aAuto !== bAuto) return aAuto - bAuto;
    return b.relevance_score - a.relevance_score;
  });

  // For MIGRATE decisions, only curated (non-auto_generated) packages count as
  // "known good alternatives". Auto-generated stubs alone are not migrate targets.
  const migrateCandidates = safeCandidates.filter((c) => {
    const m = results.find((r) => r.manifest.id === c.manifest_id)?.manifest;
    return !m?.auto_generated;
  });

  let patternRecord = signals.length
    ? await upsertPattern({ category, signals, projectDir: projectRoot })
    : undefined;

  if (patternRecord) {
    const global = (await readPatternStore(getGlobalPatternsPath())).patterns.find(
      (p) => p.fingerprint === patternRecord!.fingerprint,
    );
    const project = (await readPatternStore(getProjectPatternsPath(projectRoot))).patterns.find(
      (p) => p.fingerprint === patternRecord!.fingerprint,
    );
    const occ = totalOccurrences(project ?? patternRecord, global);
    patternRecord = { ...patternRecord, occurrences: occ };
  }

  const occurrences = patternRecord?.occurrences ?? 1;
  const belowThreshold = occurrences < RECURRENCE_THRESHOLD && !args.force;

  if (migrateCandidates.length > 0) {
    const top = migrateCandidates[0];
    const playbook_steps = [
      ...loadPlaybookSteps(top.manifest_id, category),
      'Vet the chosen package with starlog_facts before installing',
    ];

    if (belowThreshold) {
      return {
        action: 'watch',
        category,
        rationale: `Safe alternatives exist (${migrateCandidates.map((c) => c.name).join(', ')}), but recurrence is ${occurrences}/${RECURRENCE_THRESHOLD}. Watching before advising migration.`,
        pattern_id: patternRecord?.id,
        occurrences,
        candidates: migrateCandidates,
        playbook_steps: ['Continue monitoring; re-run with --force to advise migration now'],
        signals: signals.length ? signals : undefined,
      };
    }

    if (patternRecord) {
      // Status-only update — must NOT re-increment occurrences (upsertPattern
      // would bump the count a second time for the same observation).
      await updatePatternStatus(patternRecord.id, 'advised_migrate', projectRoot);
    }

    return {
      action: 'migrate',
      category,
      rationale: `Safe alternatives exist for ${category} — migrate off DIY code instead of packageizing. Do not extract a reusable auth/package layer when ${migrateCandidates.map((c) => c.name).join(', ')} are available.`,
      pattern_id: patternRecord?.id,
      occurrences,
      candidates: migrateCandidates,
      playbook_steps,
      signals: signals.length ? signals : undefined,
    };
  }

  const suggestedName = `@acme/${category}`;
  const packageize_steps = defaultPackageizeSteps(category, suggestedName);

  if (belowThreshold) {
    return {
      action: 'watch',
      category,
      rationale: `No safe corpus alternative for ${category}; would packageize, but recurrence is ${occurrences}/${RECURRENCE_THRESHOLD}.`,
      pattern_id: patternRecord?.id,
      occurrences,
      packageize_plan: { suggested_name: suggestedName, steps: packageize_steps },
      playbook_steps: ['Continue monitoring; re-run with --force to advise packageize now'],
      signals: signals.length ? signals : undefined,
    };
  }

  if (patternRecord) {
    // Status-only update — see the migrate branch: avoid double-counting.
    await updatePatternStatus(patternRecord.id, 'advised_packageize', projectRoot);
  }

  return {
    action: 'packageize',
    category,
    rationale: `No known good and safe package in the corpus for this ${category} niche. Extract a reusable internal package instead of repeating DIY code.`,
    pattern_id: patternRecord?.id,
    occurrences,
    packageize_plan: { suggested_name: suggestedName, steps: packageize_steps },
    playbook_steps: packageize_steps,
    signals: signals.length ? signals : undefined,
  };
}
