import 'dotenv/config';
import { Command } from 'commander';
import { formatTable, formatJSON } from './engine/format.js';
import { KnownCategorySchema } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { runAdvise } from './advise-service.js';
import { formatAdviseMarkdown, formatAdviseJson } from './engine/advise-format.js';
import { scanProject } from './patterns/detect.js';
import { listPatterns, upsertPattern } from './patterns/store.js';
import { scaffoldPackageize } from './patterns/packageize.js';
import { overlayPath } from './engine/overlay-discovery.js';
import { runInit } from './init.js';
import { runDoctor } from './doctor.js';
import { startMcpServer } from './mcp.js';
import {
  buildComposeDeps,
  resolveFactView,
  createFactsApiClient,
  formatFactView,
  buildL2FromInput,
  upsertL2Entry,
  buildManifestFromInput,
  upsertManifestEntry,
  buildL3Rule,
  upsertPolicy,
  buildPushPayload,
  discoverCheckouts,
  syncCheckouts,
  gitLastCommitDaysAgo,
  today,
} from './engine/facts.js';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './fsutil.js';
import { getPackageVersion } from './paths.js';
import { detectAgents } from './install/detect.js';
import { track, telemetryStatus, setTelemetryEnabled } from './telemetry.js';
import { starlogMcpWiring } from './mcp-config.js';

const VALID_CATEGORIES = KnownCategorySchema.options;

/**
 * Self-heal nudge for the install-≠-wired gap. When an agent (or a person) drives
 * the CLI via Bash but never ran `starlog init`, the MCP tools were never
 * registered — so the agent shells out instead of calling starlog_search/_facts
 * automatically. One stderr line points them at the fix.
 *
 * Fires only when settings.json EXISTS but lacks starlog ('unwired') — i.e. a
 * confirmed Claude Code user who skipped init. Stays silent on 'unknown'
 * (no/invalid settings.json) and is suppressed by STARLOG_NO_NUDGE (used by the
 * e2e harness to keep spawned-binary stdout/stderr assertions hermetic).
 *
 * stderr, never stdout: keeps piped/JSON output clean. JSON callers are skipped
 * entirely.
 */
async function nudgeInitIfUnwired(format: string): Promise<void> {
  if (format === 'json') return;
  if (process.env.STARLOG_NO_NUDGE) return;
  if ((await starlogMcpWiring()) !== 'unwired') return;
  console.error(
    '\nTip: your AI agent is not wired to call Starlog automatically — run `starlog init` ' +
    '(then restart your agent) so it discovers and vets packages without being asked.',
  );
}

/** Turn a thrown error into a concise, actionable message + non-zero exit,
 *  instead of an UnhandledPromiseRejection stack trace. */
function fail(context: string, err: unknown): never {
  const e = err as NodeJS.ErrnoException;
  let hint = e?.message ?? String(err);
  if (e?.code === 'EACCES' || e?.code === 'EPERM') {
    hint = `permission denied (${e.path ?? 'a required file'}). Try a path you own or re-run with appropriate permissions.`;
  } else if (e instanceof SyntaxError) {
    hint = `invalid JSON — ${e.message}. Fix or remove the malformed file, then retry.`;
  }
  console.error(`starlog: ${context}: ${hint}`);
  process.exit(1);
}

/** Wrap an async action so any rejection is reported cleanly via fail(). */
function action<A extends unknown[]>(
  context: string,
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail(context, err);
    }
  };
}

const program = new Command();

program
  .name('starlog')
  .version(getPackageVersion())
  .description('Vet a package before you use it: authoritative facts (CVEs, license, maintenance, capability) for your AI coding agent. Run "starlog facts <package>" to look one up.')
  .option('--no-telemetry', 'Disable anonymous usage telemetry for this run');

/** True when the user passed --no-telemetry. */
const noTelemetry = () => program.opts().telemetry === false;

program
  .command('search')
  .description('Discover candidate packages for a capability (org-sanctioned ones first when configured), then vet the named pick with "starlog facts <package>"')
  .argument('<query>', 'Natural language query (e.g., "auth for Next.js")')
  .option('--format <type>', 'Output format: json or table', 'table')
  .option('--category <cat>', 'Filter by category')
  .option('--top-k <n>', 'Number of results', '5')
  .option('--stack <stack>', 'Stack affinity filter (e.g., "next.js")')
  .option('--context <desc>', 'Project context for vs_custom analysis')
  .option('--diversity <lambda>', 'Diversity-relevance tradeoff (0=max diversity, 1=pure relevance; default: 0.5 MMR on)', parseFloat)
  .action(action('search failed', async (query: string, opts: Record<string, string>) => {
    // Validate category -- warn for unknown categories but still search (D-04)
    if (opts.category && !VALID_CATEGORIES.includes(opts.category as any)) {
      console.warn(`Note: "${opts.category}" is not a known category (${VALID_CATEGORIES.join(', ')}). Searching corpus anyway.`);
    }

    // Validate format
    if (opts.format !== 'json' && opts.format !== 'table') {
      console.error(`Invalid format: ${opts.format}. Use "json" or "table".`);
      process.exit(1);
    }

    // Validate --top-k: a non-numeric or non-positive value would otherwise
    // silently default (5) or return an empty set that reads as a misleading
    // "no strong match". Reject it loudly instead (parity with the MCP schema).
    if (!/^\d+$/.test(String(opts.topK)) || Number.parseInt(opts.topK as string, 10) < 1) {
      console.error(`Invalid --top-k "${opts.topK}". Use a positive integer (e.g. 5).`);
      process.exit(1);
    }

    // Shared search service: delegates to the hosted API when STARLOG_API_KEY
    // is set, otherwise runs the local engine — and falls back to local on API
    // failure (parity with the MCP server).
    const topK = Number.parseInt(opts.topK as string, 10);
    const results = await runSearch({
      query,
      category: opts.category,
      stack: opts.stack,
      top_k: Number.isNaN(topK) ? undefined : topK,
      context: opts.context,
      diversity_lambda: (opts as { diversity?: number }).diversity,
      // CLI parity: the MCP server reads the baked env var; the CLI falls back to a
      // project-local `.starlog/private-corpus.json` (walking up from cwd) so a bare
      // `starlog search` surfaces the org's private packages without an `export`.
      privateCorpusPath: overlayPath(process.env.STARLOG_PRIVATE_CORPUS, 'private-corpus.json'),
    });

    await track(
      'cli_search',
      {
        category: opts.category ?? null,
        top_k: Number.isNaN(topK) ? null : topK,
        result_count: results.length,
        used_api: !!process.env.STARLOG_API_KEY,
        format: opts.format,
      },
      { noTelemetry: noTelemetry() },
    );

    if (results.length === 0) {
      console.error(
        `No strong match in the local index. Discovery covers these JS/TS capabilities: ${VALID_CATEGORIES.join(', ')}.\n` +
        `If your stack is non-JS/TS, search has no candidates to surface — but \`starlog facts <package>\` still vets any package by name, and \`starlog corpus add <pkg> --solves "…"\` makes your internal packages discoverable here.`,
      );
      // JSON consumers asked for JSON: emit an empty array to stdout so a
      // `starlog search ... --format json | jq` pipeline gets valid JSON on a
      // miss instead of an empty stream (JSON.parse('') throws). The human
      // guidance above stays on stderr, where jq never reads. (#20)
      if (opts.format === 'json') console.log(formatJSON([]));
      await nudgeInitIfUnwired(opts.format);
      process.exit(0);
    }

    // A single isolated, modestly-scored hit means the query likely matched a
    // stray keyword rather than a real capability (the in-domain case returns a
    // cluster of same-category libraries). Flag it so a lone off-topic result
    // doesn't read as a confident recommendation. JSON output stays clean.
    if (opts.format !== 'json' && results.length === 1 && results[0].relevance_score < 70) {
      console.error(
        `No strong match in the local index (covers: ${VALID_CATEGORIES.join(', ')}). ` +
        `Closest by keyword:`,
      );
    }

    const output = opts.format === 'json'
      ? formatJSON(results)
      : formatTable(results);

    console.log(output);
    await nudgeInitIfUnwired(opts.format);
  }));

program
  .command('init')
  .description('Configure AI coding agents to use Starlog (MCP server, hooks, instructions)')
  .option('--project', 'Also add Starlog instructions to the current project CLAUDE.md')
  .option('--all', 'Configure all supported agents, even ones not detected in this environment')
  .option('--dry-run', 'Preview the changes without writing anything')
  .option('-y, --yes', 'Apply changes without the confirmation prompt (for CI/non-interactive use)')
  .option('--uninstall', 'Remove Starlog from Claude Code settings and hooks')
  .option('--api-key <key>', 'Wire your org STARLOG_API_KEY into the MCP server (enables hosted org-private facts for your agent) — get a key at https://starlog.dev')
  .action(action('init failed', async (opts: { project?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean; uninstall?: boolean; apiKey?: string }) => {
    await runInit(opts);

    const agents = detectAgents();
    const detected = (Object.keys(agents) as (keyof typeof agents)[]).filter((k) => agents[k].detected);
    await track(
      'cli_init',
      {
        mode: opts.uninstall ? 'uninstall' : opts.dryRun ? 'dry-run' : 'apply',
        project: !!opts.project,
        all: !!opts.all,
        yes: !!opts.yes,
        agents_detected: detected,
        agents_count: detected.length,
      },
      { noTelemetry: noTelemetry() },
    );
  }));

program
  .command('doctor')
  .description('Diagnose your Starlog setup (corpus, MCP server, hook, agent configs)')
  .action(action('doctor failed', async () => {
    const code = await runDoctor();
    await track('cli_doctor', { ok: code === 0, code }, { noTelemetry: noTelemetry() });
    process.exit(code);
  }));

program
  .command('mcp')
  .description('Start the Starlog MCP server on stdio (for npx-launched registry clients)')
  .action(action('mcp server failed to start', async () => {
    // stdio transport owns stdout for the JSON-RPC protocol — emit nothing here.
    // This is the npx-launchable entry point (`npx -y starloghq mcp`) that MCP
    // registries and clients use; `dist/mcp.js`'s run-if-main guard remains for
    // the absolute-path invocation that `init` wires into settings.json.
    await startMcpServer();
  }));

const facts = program
  .command('facts')
  .description("Vet a package by name — authoritative facts (CVEs, license, maintenance, capability), or push your org's facts to the hosted API");

// `starlog facts <package>` keeps working via this default subcommand.
facts
  .command('lookup <package>', { isDefault: true })
  .description('Look up authoritative facts (CVEs, license, maintenance, capability) for a package')
  .option('--format <type>', 'Output format: json or table', 'table')
  .action(action('facts lookup failed', async (pkg: string, opts: { format: string }) => {
    if (opts.format !== 'json' && opts.format !== 'table') {
      console.error(`Invalid format: ${opts.format}. Use "json" or "table".`);
      process.exit(1);
    }

    // Same API-first serve path as the MCP server: hosted facts (org-private L2
    // + policy) when STARLOG_API_KEY is set, with the local layered corpus
    // (public L1+L2 + STARLOG_PRIVATE_FACTS/STARLOG_POLICY) as the offline fallback.
    // CLI parity: fall back to a project-local `.starlog/` (walking up from cwd) for
    // the vetting + policy overlays when the env vars aren't set (the MCP server bakes
    // them; a bare CLI run otherwise wouldn't see them).
    const factsPath = overlayPath(process.env.STARLOG_PRIVATE_FACTS, 'private-facts.json');
    const policyPath = overlayPath(process.env.STARLOG_POLICY, 'policy.json');
    const local = buildComposeDeps({ ...process.env, STARLOG_PRIVATE_FACTS: factsPath, STARLOG_POLICY: policyPath });
    const api = createFactsApiClient();
    const view = await resolveFactView(pkg, { local, api });

    await track(
      'cli_facts',
      {
        hit: view !== null,
        format: opts.format,
        private_overlay: !!factsPath,
        policy: !!policyPath,
        api: !!api,
      },
      { noTelemetry: noTelemetry() },
    );

    if (opts.format === 'json') {
      console.log(JSON.stringify(view, null, 2));
    } else {
      console.log(formatFactView(pkg, view));
    }
    await nudgeInitIfUnwired(opts.format);
    // A miss is an honest answer, not an error — exit 0 either way.
  }));

// Documented default paths for LOCAL authoring (distinct from push's
// `.starlog/facts.json`, which is a different shape). These match the file
// shapes loadPrivateFacts / loadPolicy read back.
const DEFAULT_PRIVATE_FACTS = '.starlog/private-facts.json';
const DEFAULT_POLICY = '.starlog/policy.json';
// `org sync` writes its suggested verdicts HERE, NOT to DEFAULT_POLICY — the
// agent does not read this file, so derived flags are proposals (review-then-
// apply), never auto-applied to the live policy. Regenerated fresh each sync.
const DEFAULT_SUGGESTED_POLICY = '.starlog/policy.suggested.json';
// The DISCOVERY corpus (STARLOG_PRIVATE_CORPUS) — what `search` reads to surface
// internal packages by capability. `org sync` and `corpus add` both write it.
const DEFAULT_PRIVATE_CORPUS = '.starlog/private-corpus.json';

/** ENOENT-tolerant JSON read: missing file → null; malformed JSON → throws
 *  (SyntaxError → fail() prints the "invalid JSON — fix or remove" message,
 *  so we never silently clobber an existing-but-broken file). */
function readJsonIfPresent(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// `starlog facts add <package>` — write/upsert a private L2 overlay LOCALLY
// (no hosted API call; that's `facts push`). Minimal input is --license +
// --status; defaults fill the rest so it validates (AUTH-01/02). Bad input
// fails loudly with a non-zero exit (AUTH-04).
facts
  .command('add <package>')
  .description('Add or update a private fact (L2 overlay) for a package — license, maintenance, optional vulns')
  .requiredOption('--license <spdx>', 'SPDX license id (e.g. MIT)')
  .requiredOption('--status <maintenance>', 'active | maintenance-only | deprecated | abandoned | compromised')
  .option('--ecosystem <eco>', 'npm | pypi | system', 'npm')
  .option('--license-risk <risk>', 'none | copyleft-weak | copyleft-strong | unknown', 'none')
  .option(
    '--vuln <id:severity:summary>',
    'A known vuln/incident (repeatable)',
    (v: string, acc: string[]) => {
      acc.push(v);
      return acc;
    },
    [] as string[],
  )
  .option('--transitive-risk <text>', 'Free-text note about transitive dependency risk')
  .action(
    action(
      'facts add failed',
      async (
        pkg: string,
        opts: {
          license: string;
          status: string;
          ecosystem: string;
          licenseRisk: string;
          vuln: string[];
          transitiveRisk?: string;
        },
      ) => {
        // A thrown Error here (bad enum / bad --vuln) → fail() → stderr + exit 1.
        const overlay = buildL2FromInput({
          package: pkg,
          license: opts.license,
          status: opts.status,
          ecosystem: opts.ecosystem,
          licenseRisk: opts.licenseRisk,
          transitiveRisk: opts.transitiveRisk,
          vulns: opts.vuln,
        });

        const envPath = process.env.STARLOG_PRIVATE_FACTS;
        const path = envPath ?? DEFAULT_PRIVATE_FACTS;
        const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
        const merged = upsertL2Entry(existing as { l1?: unknown[]; l2?: unknown[] } | null, overlay);
        // Unwritable path → EACCES → fail() prints the permission-denied message (AUTH-04).
        await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n');

        await track(
          'cli_facts_add',
          { ecosystem: overlay.ecosystem, has_vulns: overlay.known_vulns.length > 0, default_path: !envPath },
          { noTelemetry: noTelemetry() },
        );

        console.log(`Added ${pkg} to ${path}.`);
        if (path === DEFAULT_PRIVATE_FACTS) {
          console.log(`Your coding agent reads this automatically, per-project, after \`starlog init\` (no shell export needed).`);
          console.log(`Vet it from this project: starlog facts ${pkg}`);
        } else {
          console.log(`Note: \`starlog init\` wires the agent to the default ${DEFAULT_PRIVATE_FACTS}; a custom path is read by the CLI only.`);
          console.log(`Vet it: STARLOG_PRIVATE_FACTS=${path} starlog facts ${pkg}`);
        }
      },
    ),
  );

// `starlog facts policy <package> <verdict>` — set an org allow/deny/flag
// verdict LOCALLY (writes/upserts an L3 rule). The verdict renders in
// `facts <pkg>` only when the package also has an L1/L2 record (AUTH-03).
facts
  .command('policy <package> <verdict>')
  .description('Set an org allow/deny/flag verdict for a package (writes an L3 policy rule)')
  .option('--reason <text>', 'Rationale recorded with the verdict')
  .action(
    action('facts policy failed', async (pkg: string, verdict: string, opts: { reason?: string }) => {
      // Bad verdict throws "Invalid verdict ..." → fail() → exit 1.
      const rule = buildL3Rule(pkg, verdict, opts.reason);

      const envPath = process.env.STARLOG_POLICY;
      const path = envPath ?? DEFAULT_POLICY;
      const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
      const policy = upsertPolicy(existing as { org?: string; rules?: unknown[] } | null, rule);
      await atomicWrite(path, JSON.stringify(policy, null, 2) + '\n');

      await track(
        'cli_facts_policy',
        { decision: rule.decision, default_path: !envPath },
        { noTelemetry: noTelemetry() },
      );

      console.log(`Set org verdict ${verdict.toUpperCase()} for ${pkg} in ${path}.`);
      if (envPath) {
        console.log(`Your agent already reads this policy (STARLOG_POLICY). Vet it now: starlog facts ${pkg}`);
      } else {
        console.log(`Your coding agent applies this automatically, per-project, after \`starlog init\`.`);
        console.log(`Try it from this project: starlog facts ${pkg}`);
      }
    }),
  );

// `starlog facts push [file]` — upload the org's private L2 overlays (+ optional
// L3 policy) to the hosted facts API. File shape: { "l2": [L2Overlay...], "policy": L3Policy? }.
facts
  .command('push [file]')
  .description("Push your org's private L2 overlays (+ optional L3 policy) to the hosted facts API (needs STARLOG_API_KEY)")
  .option('--policy <file>', 'Also push an L3 policy from this file (e.g. your adopted .starlog/policy.json) — wins over any policy in <file>')
  .action(action('facts push failed', async (file: string | undefined, opts: { policy?: string }) => {
    const api = createFactsApiClient();
    if (!api) {
      console.error('facts push needs STARLOG_API_KEY (the org key these facts belong to).');
      process.exit(1);
    }
    // The L2 source: defaults to .starlog/facts.json, but a `.starlog/private-facts.json`
    // (from `org sync`, shape {l1,l2}) works directly — buildPushPayload reads .l2 and ignores l1.
    const path = file ?? '.starlog/facts.json';
    const readJson = (p: string): unknown => {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const msg = e.code === 'ENOENT' ? `no file at ${p}` : `cannot read ${p}: ${e.message}`;
        console.error(`facts push: ${msg}`);
        process.exit(1);
      }
    };
    const raw = readJson(path);
    const policyOverride = opts.policy ? readJson(opts.policy) : undefined;

    const payload = buildPushPayload(raw, policyOverride);
    if (payload.droppedOverlays > 0) {
      console.error(`facts push: skipped ${payload.droppedOverlays} invalid L2 overlay(s) (failed schema validation).`);
    }
    if (payload.policyInvalid) {
      console.error('facts push: policy failed schema validation; not pushed.');
    }

    let pushedPolicy = false;
    if (payload.policy) {
      const res = await api.pushPolicy(payload.policy);
      if (!res.ok) {
        console.error(`facts push: policy push failed (${res.error}).`);
        process.exit(1);
      }
      pushedPolicy = true;
    }

    const res = await api.pushL2(payload.overlays);
    if (!res.ok) {
      console.error(`facts push: L2 push failed (${res.error}).`);
      process.exit(1);
    }
    await track('cli_facts_push', { l2_count: payload.overlays.length, policy: pushedPolicy }, { noTelemetry: noTelemetry() });
    console.log(`Pushed ${res.count ?? payload.overlays.length} L2 overlay(s)${pushedPolicy ? ' + org policy' : ''} to the hosted facts API.`);
    // Exit explicitly: the fetch keep-alive pool would otherwise hold the event
    // loop open for seconds after the work is done, so the CLI appears to hang.
    process.exit(0);
  }));

// ── org: bulk-ingest a directory of internal checkouts ────────────────────────
// `starlog org sync <dir>` walks a directory of checked-out repos, derives an L2
// overlay per published package (source never leaves the machine), suggests org
// policy from the real signals, and writes the same local artifacts `facts add` /
// `facts policy` produce — merging over any existing ones. This is the runnable
// Phase-1 spine; GitHub enumeration bolts onto the front later.
const org = program
  .command('org')
  .description('Bulk-ingest your org: derive facts for many internal packages at once');

org
  .command('sync <dir>')
  .description('Scan a directory of checked-out repos and derive/refresh their private facts (+ suggested policy)')
  .option('--facts-out <path>', 'Where to write the private L2 facts (agent vets these by name)', DEFAULT_PRIVATE_FACTS)
  .option('--corpus-out <path>', 'Where to write the discovery corpus (search surfaces these by capability)', DEFAULT_PRIVATE_CORPUS)
  .option('--policy-out <path>', 'Where to write SUGGESTED L3 rules (a proposal file the agent does not read)', DEFAULT_SUGGESTED_POLICY)
  .option('--no-git', 'Skip git last-commit detection (maintenance falls back to active)')
  .action(
    action('org sync failed', async (dir: string, opts: { factsOut: string; corpusOut: string; policyOut: string; git: boolean }) => {
      const dirs = discoverCheckouts(dir);
      if (dirs.length === 0) {
        console.error(`org sync: no checkouts found under ${dir} (looked for immediate subdirectories containing a package.json or pyproject.toml).`);
        process.exit(1);
      }

      const now = Date.now();
      const checkouts = dirs.map((d) => ({
        dir: d,
        lastCommitDaysAgo: opts.git ? gitLastCommitDaysAgo(d, now) : null,
      }));

      // L2 facts merge over the existing file so hand-authored facts are preserved
      // (upsert replaces per package). Policy suggestions are regenerated FRESH (no
      // seed) so a fixed package stops being flagged, and they go to a SEPARATE file
      // the agent does not read — proposals, not auto-applied.
      const seedFacts = readJsonIfPresent(opts.factsOut) as { l1?: unknown[]; l2?: unknown[] } | null;
      const seedCorpus = readJsonIfPresent(opts.corpusOut) as { manifests?: unknown[] } | null;

      const res = syncCheckouts(checkouts, { fetchedAt: today(), seedFacts, seedCorpus });

      await atomicWrite(opts.factsOut, JSON.stringify(res.privateFacts, null, 2) + '\n');
      await atomicWrite(opts.corpusOut, JSON.stringify(res.corpus, null, 2) + '\n');
      // Always (re)write the suggestion file so stale flags are dropped on re-sync.
      const suggested = res.policy ?? { org: 'local', rules: [] };
      await atomicWrite(opts.policyOut, JSON.stringify(suggested, null, 2) + '\n');

      const flagged = res.derived.filter((d) => d.flagged).length;
      await track(
        'cli_org_sync',
        { scanned: dirs.length, derived: res.derived.length, skipped: res.skipped.length, flagged, discoverable: res.corpus.manifests.length },
        { noTelemetry: noTelemetry() },
      );

      for (const c of res.collisions) {
        console.warn(
          `Warning: "${c.package}" was derived from ${c.dirs.length} checkouts (${c.dirs.join(', ')}); kept the last. Rename or de-duplicate the repos so you don't lose the others' facts.`,
        );
      }
      console.log(`Scanned ${dirs.length} checkout(s): derived ${res.derived.length} package fact(s), skipped ${res.skipped.length} (no published name).`);
      console.log(`Wrote ${res.privateFacts.l2.length} L2 overlay(s) to ${opts.factsOut} — your agent vets these by name after \`starlog init\`.`);
      console.log(`Made ${res.corpus.manifests.length} package(s) DISCOVERABLE → ${opts.corpusOut} — \`search\` surfaces these by capability.`);
      if (res.noDescription.length > 0) {
        console.log(`  ${res.noDescription.length} package(s) have no description, so they are vettable but NOT discoverable: ${res.noDescription.join(', ')}. Add a description/[project].description to fix.`);
      }
      if (flagged > 0) {
        console.log(`Suggested ${flagged} policy flag(s) → ${opts.policyOut} (PROPOSALS — the agent does NOT read this file). Review it, then apply the ones you trust with \`starlog facts policy <pkg> flag\`.`);
      } else {
        console.log(`No policy flags suggested — wrote an empty proposal to ${opts.policyOut}.`);
      }
    }),
  );

// ── corpus: org-private DISCOVERY authoring ───────────────────────────────────
// Mirror of `facts add` for the OTHER private overlay: `facts add` makes an
// internal package vettable (STARLOG_PRIVATE_FACTS); `corpus add` makes it
// DISCOVERABLE (STARLOG_PRIVATE_CORPUS) so `search` surfaces it private-first.

/** commander value parser: "a, b ,c" → ['a','b','c'] (repeatable-free comma list). */
function commaList(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const corpus = program
  .command('corpus')
  .description('Author org-private DISCOVERY entries so `search` surfaces your internal packages first');

corpus
  .command('add <package>')
  .description('Make an internal package discoverable — `search` surfaces it (private-first) for a matching capability')
  .requiredOption('--solves <text>', 'One line: what the package does (search matches capability queries against this)')
  .option('--category <cat>', 'Capability category, free-form (e.g. feature-flags, authentication)', 'other')
  .option('--stack <list>', 'Comma-separated stack affinity (e.g. node,next.js)', commaList, [] as string[])
  .option('--best-for <list>', 'Comma-separated use cases', commaList, [] as string[])
  .option('--skip-when <list>', 'Comma-separated anti-patterns', commaList, [] as string[])
  .option('--effort <level>', 'drop-in | easy | moderate | significant | major', 'moderate')
  .option('--ecosystem <eco>', 'npm | pypi | both', 'npm')
  .option('--name <name>', 'Human-readable name (default: the package name)')
  .option('--repo <owner/repo>', 'Source repo (default: none)')
  .option('--license <spdx>', 'License id for the discovery card (default: UNLICENSED)')
  .action(
    action(
      'corpus add failed',
      async (
        pkg: string,
        opts: {
          solves: string;
          category: string;
          stack: string[];
          bestFor: string[];
          skipWhen: string[];
          effort: string;
          ecosystem: string;
          name?: string;
          repo?: string;
          license?: string;
        },
      ) => {
        // A thrown Error here (missing --solves / bad enum) → fail() → stderr + exit 1.
        const manifest = buildManifestFromInput({
          package: pkg,
          solves: opts.solves,
          name: opts.name,
          category: opts.category,
          ecosystem: opts.ecosystem,
          stack: opts.stack,
          bestFor: opts.bestFor,
          skipWhen: opts.skipWhen,
          effort: opts.effort,
          repo: opts.repo,
          license: opts.license,
        });

        const envPath = process.env.STARLOG_PRIVATE_CORPUS;
        const path = envPath ?? DEFAULT_PRIVATE_CORPUS;
        const existing = readJsonIfPresent(path); // SyntaxError throws → no clobber
        const merged = upsertManifestEntry(existing as { manifests?: unknown[] } | null, manifest);
        await atomicWrite(path, JSON.stringify(merged, null, 2) + '\n');

        await track(
          'cli_corpus_add',
          { ecosystem: manifest.ecosystem, default_path: !envPath },
          { noTelemetry: noTelemetry() },
        );

        console.log(`Added ${pkg} to ${path} (discovery).`);
        if (path === DEFAULT_PRIVATE_CORPUS) {
          console.log(`Your coding agent's search surfaces this automatically, per-project, after \`starlog init\` (no shell export needed).`);
          console.log(`Try it from this project: starlog search "<the capability>"`);
        } else {
          console.log(`Note: \`starlog init\` wires the agent to the default ${DEFAULT_PRIVATE_CORPUS}; a custom path is searched by the CLI only.`);
          console.log(`Try it: STARLOG_PRIVATE_CORPUS=${path} starlog search "<the capability>"`);
        }
        console.log(`Tip: also vet it — starlog facts add ${pkg} --status active --license ${opts.license ?? '<spdx>'}`);
      },
    ),
  );

// ── patterns: track DIY capability patterns ─────────────────────────────────

const patterns = program
  .command('patterns')
  .description('Track repeated DIY capability patterns across projects');

patterns
  .command('scan [dir]')
  .description('Scan a project for DIY patterns and upsert into .starlog/patterns.json')
  .action(
    action('patterns scan failed', async (dir: string | undefined) => {
      const root = dir ?? process.cwd();
      const hits = await scanProject(root);
      if (hits.length === 0) {
        console.log(`No DIY patterns detected under ${root}.`);
        return;
      }
      for (const hit of hits) {
        const record = await upsertPattern({
          category: hit.category,
          signals: hit.signals,
          projectDir: root,
        });
        console.log(`[${hit.category}] confidence ${hit.confidence} → ${record.id} (${record.occurrences} occurrence(s))`);
      }
      await track('cli_patterns_scan', { hits: hits.length }, { noTelemetry: noTelemetry() });
    }),
  );

patterns
  .command('list')
  .description('List tracked patterns (project + global merge)')
  .option('--dir <path>', 'Project directory for local patterns', process.cwd())
  .option('--format <type>', 'json or table', 'table')
  .action(
    action('patterns list failed', async (opts: { dir: string; format: string }) => {
      const items = await listPatterns(opts.dir);
      if (opts.format === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('No patterns tracked yet. Run `starlog patterns scan`.');
        return;
      }
      for (const p of items) {
        console.log(`${p.id}  ${p.category}  ${p.status}  ${p.occurrences}x  last ${p.last_seen.slice(0, 10)}`);
      }
    }),
  );

// ── advise: migrate-or-packageize decision ──────────────────────────────────

const advise = program
  .command('advise')
  .description('Advise MIGRATE to a safe library or PACKAGEIZE when no safe alternative exists');

advise
  .argument('[observation]', 'What you observed, e.g. "DIY JWT auth"')
  .option('--dir <path>', 'Project root to scan', process.cwd())
  .option('--category <cat>', 'Capability category filter')
  .option('--force', 'Advise even when recurrence is below threshold')
  .option('--context <desc>', 'Project context for search ranking')
  .option('--format <type>', 'json or markdown', 'markdown')
  .action(
    action(
      'advise failed',
      async (observation: string | undefined, opts: { dir: string; category?: string; force?: boolean; context?: string; format: string }) => {
        if (opts.format !== 'json' && opts.format !== 'markdown') {
          console.error(`Invalid format: ${opts.format}. Use "json" or "markdown".`);
          process.exit(1);
        }
        const result = await runAdvise({
          observation,
          project_root: opts.dir,
          category: opts.category,
          force: opts.force,
          context: opts.context,
          privateCorpusPath: overlayPath(process.env.STARLOG_PRIVATE_CORPUS, 'private-corpus.json', opts.dir),
        });
        await track(
          'cli_advise',
          { action: result.action, category: result.category, force: !!opts.force },
          { noTelemetry: noTelemetry() },
        );
        const output = opts.format === 'json' ? formatAdviseJson(result) : formatAdviseMarkdown(result);
        console.log(output);
        await nudgeInitIfUnwired(opts.format === 'json' ? 'json' : 'table');
      },
    ),
  );

advise
  .command('packageize')
  .description('Scaffold private corpus + facts for a packageize recommendation')
  .requiredOption('--from-pattern <id>', 'Pattern id from starlog patterns list')
  .requiredOption('--name <pkg>', 'New internal package name, e.g. @acme/session-core')
  .option('--solves <text>', 'One-line capability description for discovery')
  .option('--dir <path>', 'Project directory', process.cwd())
  .action(
    action(
      'advise packageize failed',
      async (opts: { fromPattern: string; name: string; solves?: string; dir: string }) => {
        const { factsPath, corpusPath } = await scaffoldPackageize({
          patternId: opts.fromPattern,
          packageName: opts.name,
          solves: opts.solves,
          projectDir: opts.dir,
        });
        await track('cli_advise_packageize', { package: opts.name }, { noTelemetry: noTelemetry() });
        console.log(`Scaffolded ${opts.name}:`);
        console.log(`  facts → ${factsPath}`);
        console.log(`  corpus → ${corpusPath}`);
        console.log('Your agent can now discover and vet this internal package.');
      },
    ),
  );

program
  .command('telemetry')
  .description('Show or change anonymous usage telemetry (status | enable | disable)')
  .argument('[action]', 'status (default), enable, or disable', 'status')
  .action(action('telemetry command failed', async (action: string) => {
    if (action === 'enable' || action === 'disable') {
      setTelemetryEnabled(action === 'enable');
      console.log(`Telemetry ${action}d.`);
      return;
    }
    if (action !== 'status') {
      console.error(`Unknown action "${action}". Use: status, enable, or disable.`);
      process.exit(1);
    }
    const s = telemetryStatus();
    console.log(`Telemetry: ${s.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Anonymous ID: ${s.anonymousId}`);
    console.log(`Config: ${s.file}`);
    console.log('Opt out anytime: STARLOG_TELEMETRY=0, DO_NOT_TRACK=1, or `starlog telemetry disable`.');
  }));

// Backstop: anything that escapes an action handler still exits cleanly.
process.on('unhandledRejection', (reason) => {
  fail('unexpected error', reason);
});

program.parseAsync().catch((err) => fail('command failed', err));
