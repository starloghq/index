// diy-hook-runner.ts — PreToolUse Write/Edit DIY detection hook logic.
//
// Contract: advisory by default. Reads a Claude Code PreToolUse payload on stdin,
// scores pending file writes for DIY capability patterns, validates via runAdvise,
// and surfaces migration guidance. Denies only when org DIY policy is "deny".
// Must NEVER throw or block a tool call except on explicit org policy deny.
//
// Latency tradeoff: the first qualifying write per category per debounce window
// runs runAdvise (project scan + corpus search + optional facts network). Debounce
// avoids repeat cost; richness of migration candidates is intentional on that hit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAdvise } from './advise-service.js';
import { formatAdviseMarkdown } from './engine/advise-format.js';
import { buildComposeDeps, resolveFactView, createFactsApiClient } from './engine/facts.js';
import { overlayPath } from './engine/overlay-discovery.js';
import { evaluateDiyPolicy, type DiyPolicyVerdict } from '@starloghq/facts-schema';
import { detectHookPlatform, emitPreToolUse, type HookPlatform } from './hook-output.js';
import {
  detectKnownLibraryUse,
  HOOK_HIGH_CONFIDENCE,
  HOOK_MIN_CONFIDENCE,
  HOOK_RECURRENCE_THRESHOLD,
  scoreFileForHook,
} from './patterns/detect.js';
import {
  fingerprintSignals,
  getGlobalPatternsPath,
  getProjectPatternsPath,
  readPatternStore,
  totalOccurrences,
} from './patterns/store.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const DEBOUNCE_MS = 10 * 60 * 1000;
const POSITIVE_DEBOUNCE_MS = 30 * 60 * 1000;
const MAX_CONTEXT_CHARS = 9000;
const CACHE_PATH = path.join(os.homedir(), '.starlog', 'diy-hook-cache.json');

interface WritePayload {
  relPath: string;
  content: string;
}

interface HookCache {
  entries: Record<string, number>;
}

function writeFileAtomic(p: string, data: string): void {
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

function loadCache(): HookCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as HookCache;
  } catch {
    return { entries: {} };
  }
}

/** TTL for a cache key — positive acks keep a longer window than DIY advisories. */
function pruneWindowForKey(key: string): number {
  return key.startsWith('positive::') ? POSITIVE_DEBOUNCE_MS : DEBOUNCE_MS;
}

function saveCache(cache: HookCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const now = Date.now();
    const pruned: Record<string, number> = {};
    for (const [k, v] of Object.entries(cache.entries)) {
      if (now - v < pruneWindowForKey(k)) pruned[k] = v;
    }
    writeFileAtomic(CACHE_PATH, JSON.stringify({ entries: pruned }, null, 2) + '\n');
  } catch {
    /* advisory only */
  }
}

function cacheKey(projectRoot: string, category: string): string {
  return createHash('sha256').update(`${projectRoot}::${category}`).digest('hex').slice(0, 16);
}

function isDebounced(projectRoot: string, category: string, kind: 'diy' | 'positive' = 'diy'): boolean {
  const key = `${kind}::` + cacheKey(projectRoot, category);
  const window = kind === 'positive' ? POSITIVE_DEBOUNCE_MS : DEBOUNCE_MS;
  const entry = loadCache().entries[key];
  return entry != null && Date.now() - entry < window;
}

function markDebounced(projectRoot: string, category: string, kind: 'diy' | 'positive' = 'diy'): void {
  const cache = loadCache();
  cache.entries[`${kind}::` + cacheKey(projectRoot, category)] = Date.now();
  saveCache(cache);
}

function isSourceFile(filePath: string): boolean {
  const ext = filePath.includes('.') ? '.' + filePath.split('.').pop()!.toLowerCase() : '';
  return SOURCE_EXTENSIONS.has(ext);
}

/** Relativize absolute tool paths against cwd so path patterns don't match the project dir name. */
function toRelPath(filePath: string, projectRoot?: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (!projectRoot) return normalized;
  const rel = path.relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return normalized;
  return rel.replace(/\\/g, '/');
}

export function extractWritePayload(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot?: string,
): WritePayload | null {
  if (!WRITE_TOOLS.has(toolName)) return null;

  const filePath = (toolInput.file_path ?? toolInput.path) as string | undefined;
  if (!filePath || !isSourceFile(filePath)) return null;

  let content = '';
  if (typeof toolInput.content === 'string') {
    content = toolInput.content;
  } else if (typeof toolInput.new_string === 'string') {
    content = toolInput.new_string;
  } else if (Array.isArray(toolInput.edits)) {
    content = toolInput.edits
      .map((e) => (e && typeof e === 'object' && 'new_string' in e ? String((e as { new_string?: string }).new_string ?? '') : ''))
      .join('\n');
  }

  if (!content.trim()) return null;
  return { relPath: toRelPath(filePath, projectRoot), content };
}

async function loadOccurrences(category: string, signals: { kind: string; value: string }[], projectRoot: string): Promise<number> {
  const fingerprint = fingerprintSignals(category, signals as Parameters<typeof fingerprintSignals>[1]);
  const global = await readPatternStore(getGlobalPatternsPath());
  const project = await readPatternStore(getProjectPatternsPath(projectRoot));
  const globalRec = global.patterns.find((p) => p.fingerprint === fingerprint);
  const projectRec = project.patterns.find((p) => p.fingerprint === fingerprint);
  if (!globalRec && !projectRec) return 0;
  return totalOccurrences(projectRec ?? globalRec!, globalRec);
}

function formatFactsLine(pkg: string, view: Awaited<ReturnType<typeof resolveFactView>>): string {
  if (!view?.l2) return `- ${pkg}: no facts on file — vet with starlog_facts ${pkg}`;
  const parts: string[] = [];
  if (view.l2.known_vulns.length) {
    parts.push(`${view.l2.known_vulns.length} known vuln(s)`);
  } else {
    parts.push('no known vulns on file');
  }
  parts.push(`maintenance: ${view.l2.maintenance}`);
  parts.push(`license: ${view.l2.license} (${view.l2.license_risk})`);
  return `- ${pkg}: ${parts.join('; ')} (as of ${view.l2.attestation.fetched_at})`;
}

async function buildAdvisoryMessage(
  result: Awaited<ReturnType<typeof runAdvise>>,
  projectRoot: string,
  policyPath?: string,
): Promise<string> {
  const lines: string[] = ['[Starlog DIY] Hand-rolled capability code detected — consider vetted libraries before building custom code.', ''];
  lines.push(formatAdviseMarkdown(result));

  if (result.candidates && result.candidates.length > 0) {
    lines.push('', '## Package facts (top candidates)');
    const factsDeps = {
      local: buildComposeDeps({
        ...process.env,
        STARLOG_PRIVATE_FACTS: overlayPath(process.env.STARLOG_PRIVATE_FACTS, 'private-facts.json', projectRoot),
        STARLOG_POLICY: policyPath,
      }),
      api: createFactsApiClient(),
    };
    for (const c of result.candidates.slice(0, 2)) {
      try {
        const view = await resolveFactView(c.package_name, factsDeps);
        lines.push(formatFactsLine(c.package_name, view));
      } catch {
        lines.push(`- ${c.package_name}: facts lookup failed — run starlog_facts ${c.package_name}`);
      }
    }
  }

  lines.push('', 'Call `starlog_advise` or `starlog advise` for full migration guidance.');
  let msg = lines.join('\n');
  if (msg.length > MAX_CONTEXT_CHARS) {
    msg = msg.slice(0, MAX_CONTEXT_CHARS - 20) + '\n…(truncated)';
  }
  return msg;
}

function emitHookOutput(platform: HookPlatform, payload: Parameters<typeof emitPreToolUse>[1]): void {
  emitPreToolUse(platform, payload);
}

function sparseDenyReason(category: string, policy: DiyPolicyVerdict): string {
  return [`Org policy blocks hand-rolled ${category} code.`, policy.rationale ?? '']
    .filter(Boolean)
    .join(' ');
}

async function maybeEmitPositiveAck(
  write: WritePayload,
  projectRoot: string,
  platform: HookPlatform,
): Promise<boolean> {
  const known = detectKnownLibraryUse(write.relPath, write.content);
  if (!known) return false;

  // Mixed signal: DIY patterns alongside a known lib — skip praise, let DIY gate decide.
  if (scoreFileForHook(write.relPath, write.content)) return false;
  if (isDebounced(projectRoot, known.category, 'positive')) return false;

  const msg = `[Starlog] Good — using an established ${known.category} library in ${write.relPath}. No DIY migration needed.`;
  // Cursor still honors additional_context on preToolUse; Claude PreToolUse does not —
  // permissionDecisionReason with allow is the portable field.
  emitHookOutput(platform, {
    permissionDecision: 'allow',
    permissionDecisionReason: msg,
    additionalContext: msg,
  });
  markDebounced(projectRoot, known.category, 'positive');
  return true;
}

export async function handleDiyPreToolUse(data: Record<string, unknown>): Promise<void> {
  const platform = detectHookPlatform(data);
  const toolName = String(data.tool_name ?? '');
  const toolInput = (data.tool_input ?? {}) as Record<string, unknown>;
  const projectRoot = String(data.cwd ?? process.cwd());
  const write = extractWritePayload(toolName, toolInput, projectRoot);
  if (!write) return;

  if (await maybeEmitPositiveAck(write, projectRoot, platform)) return;

  const hit = scoreFileForHook(write.relPath, write.content);
  if (!hit || hit.confidence < HOOK_MIN_CONFIDENCE) return;

  const policyPath = overlayPath(process.env.STARLOG_POLICY, 'policy.json', projectRoot);
  let diyPolicy: DiyPolicyVerdict = { decision: 'none' };
  try {
    if (policyPath && fs.existsSync(policyPath)) {
      const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      diyPolicy = evaluateDiyPolicy(raw, hit.category);
    }
  } catch {
    /* no policy */
  }

  const occurrences = await loadOccurrences(hit.category, hit.signals, projectRoot);
  const highConfidence = hit.confidence >= HOOK_HIGH_CONFIDENCE;
  const recurrenceMet = occurrences >= HOOK_RECURRENCE_THRESHOLD;
  const shouldAdvise = highConfidence || recurrenceMet;

  if (!shouldAdvise && diyPolicy.decision !== 'deny') return;
  if (isDebounced(projectRoot, hit.category) && diyPolicy.decision !== 'deny') return;

  // ── Org deny: emit FIRST so enrichment I/O can never fail-open to allow ──
  if (diyPolicy.decision === 'deny') {
    const sparse = sparseDenyReason(hit.category, diyPolicy);
    emitHookOutput(platform, {
      permissionDecision: 'deny',
      permissionDecisionReason: sparse,
    });
    markDebounced(projectRoot, hit.category);

    try {
      const observation = `hand-rolled ${hit.category} code in ${write.relPath}`;
      const advise = await runAdvise({
        observation,
        project_root: projectRoot,
        category: hit.category,
        force: true,
        policyPath,
      });
      const candidates = advise.candidates?.map((c) => c.name).join(', ') || 'see starlog_advise';
      const enriched = [sparse, `Migrate to: ${candidates}.`].filter(Boolean).join(' ');
      emitHookOutput(platform, {
        permissionDecision: 'deny',
        permissionDecisionReason: enriched,
      });
    } catch {
      // Sparse deny already emitted — never degrade to silent allow.
    }
    return;
  }

  if (!shouldAdvise) return;

  // Advisory path: PreToolUse ignores additionalContext — use ask + reason so the
  // agent actually sees migration guidance (Claude Code hooks reference).
  try {
    const observation = `hand-rolled ${hit.category} code in ${write.relPath}`;
    const advise = await runAdvise({
      observation,
      project_root: projectRoot,
      category: hit.category,
      force: highConfidence,
      policyPath,
    });
    const reason = await buildAdvisoryMessage(advise, projectRoot, policyPath);
    emitHookOutput(platform, {
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
      // Cursor also maps this to additional_context for hosts that support it.
      additionalContext: reason,
    });
    markDebounced(projectRoot, hit.category);
  } catch {
    // Advisory only — fail open (no output) on enrichment errors.
  }
}

/** Read the PreToolUse payload from stdin and process it. Never throws; always exits 0. */
export function runDiy(): void {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 8000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    void (async () => {
      try {
        const data = JSON.parse(input) as Record<string, unknown>;
        await handleDiyPreToolUse(data);
      } catch {
        /* advisory only */
      }
      process.exit(0);
    })();
  });
}
