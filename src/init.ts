import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { getPackageRoot } from './paths.js';
import { detectAgents } from './install/detect.js';
import { atomicWrite } from './fsutil.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
const HOOK_FILENAME = 'starlog-pkg-check.js';
const HOOK_PATH = join(HOOKS_DIR, HOOK_FILENAME);
const STARLOG_MARKER = '<!-- starlog:init -->';
const STARLOG_END_MARKER = '<!-- starlog:end -->';

// Shared instruction text used by all agent configs
const STARLOG_INSTRUCTIONS = `Before recommending or installing a package, vet it with the \`starlog_facts\` MCP tool. It returns known CVEs and supply-chain incidents, SPDX license + risk, and maintenance status (active / deprecated / abandoned / compromised), each dated. Trust it over training-data recall — your knowledge of a package's current status may be stale.

Use \`starlog_search\` to discover candidate packages for a capability, then vet the named candidate with \`starlog_facts\` before adopting it.`;

// ── Settings helpers ────────────────────────────────────────────────────

type Settings = Record<string, unknown>;

async function readSettingsJson(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mcpServers: {}, hooks: {} };
    }
    throw new Error(`Failed to parse ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
}

async function writeSettingsJson(settings: Settings): Promise<void> {
  // Atomic: a crash mid-write must never truncate the user's shared
  // settings.json (which holds unrelated MCP servers, hooks, and permissions).
  await atomicWrite(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

// ── MCP server ──────────────────────────────────────────────────────────

/** The Starlog MCP server entry written into ~/.claude/settings.json. Shared
 *  by the apply path (configureMcpServer) and the preview path (buildInstallPlan)
 *  so the two can never disagree on what "already configured" means. */
export function desiredMcpServer(apiKey?: string) {
  // The MCP server is spawned by the agent and does NOT inherit the user's shell
  // environment, so a shell `export STARLOG_PRIVATE_*` never reaches it. Bake the
  // overlay locations into the server's own `env` block instead.
  //
  // Claude Code expands `${CLAUDE_PROJECT_DIR}` to the session's project root and
  // sets it in the spawned server's environment, so this ONE global entry resolves
  // to EACH project's own `.starlog/` at runtime — per-project private discovery
  // (STARLOG_PRIVATE_CORPUS) + vetting (STARLOG_PRIVATE_FACTS) + policy, with no
  // cross-project leak and no working-directory dependency. When a project has no
  // such file the loaders no-op (empty / public-only), so baking these
  // unconditionally is safe: author `.starlog/*` in any project and the agent
  // picks it up there, with nothing to re-run.
  const PROJ = '${CLAUDE_PROJECT_DIR}';
  const env: Record<string, string> = {
    STARLOG_PRIVATE_FACTS: `${PROJ}/.starlog/private-facts.json`,
    STARLOG_PRIVATE_CORPUS: `${PROJ}/.starlog/private-corpus.json`,
    STARLOG_POLICY: `${PROJ}/.starlog/policy.json`,
  };
  // Hosted key (org-wide) so the agent can use hosted ranking/facts.
  if (apiKey) env.STARLOG_API_KEY = apiKey;

  return {
    command: 'node',
    args: [join(getPackageRoot(), 'dist', 'mcp.js')],
    description: 'starlog: vet packages before you adopt them — facts (CVEs, license, maintenance) plus capability discovery for AI coding agents',
    env,
  };
}

async function configureMcpServer(apiKey?: string): Promise<{ changed: boolean }> {
  const settings = await readSettingsJson();
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {};
  }
  const servers = settings.mcpServers as Record<string, unknown>;

  const desired = desiredMcpServer(apiKey);

  if (JSON.stringify(servers.starlog) === JSON.stringify(desired)) {
    return { changed: false };
  }

  servers.starlog = desired;
  await writeSettingsJson(settings);
  return { changed: true };
}

async function removeMcpServer(): Promise<{ changed: boolean }> {
  const settings = await readSettingsJson();
  const servers = settings.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !('starlog' in servers)) return { changed: false };
  delete servers.starlog;
  await writeSettingsJson(settings);
  return { changed: true };
}

// ── Hook script ─────────────────────────────────────────────────────────

export function generateHookScript(): string {
  return `#!/usr/bin/env node
// starlog-pkg-check.js — PostToolUse hook
// Generated by: starlog init
// Checks if an installed package has a Starlog manifest with relevant guidance.

const fs = require('fs');
const path = require('path');

// Atomic write: temp sibling + rename, so a crash can't truncate the queue.
function writeFileAtomic(p, data) {
  var tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}

let CORPUS_DIR;
try {
  CORPUS_DIR = require('path').join(
    require('path').dirname(require.resolve('starloghq/package.json')),
    'corpus-free'
  );
} catch {
  CORPUS_DIR = ${JSON.stringify(join(getPackageRoot(), 'corpus-free'))};
}

// L2 facts map (generated from l2-data.ts). Resolved the same dual way as
// CORPUS_DIR so the hook surfaces facts whether installed as a dep or run in-repo.
let L2_FACTS_PATH;
try {
  L2_FACTS_PATH = require('path').join(
    require('path').dirname(require.resolve('starloghq/package.json')),
    'corpus-free', 'l2-facts.json'
  );
} catch {
  L2_FACTS_PATH = ${JSON.stringify(join(getPackageRoot(), 'corpus-free', 'l2-facts.json'))};
}
function loadL2Facts() {
  try { return JSON.parse(fs.readFileSync(L2_FACTS_PATH, 'utf8')); } catch (e) { return {}; }
}
function lookupL2(rawPkg, normId) {
  var facts = loadL2Facts();
  return facts[rawPkg] || facts[normId] || null;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input && data.tool_input.command) || '';

    const patterns = [
      /(?:npm\\s+(?:install|i|add))\\s+(.+)/i,
      /(?:pnpm\\s+add)\\s+(.+)/i,
      /(?:yarn\\s+add)\\s+(.+)/i,
      /(?:pip\\s+install)\\s+(.+)/i,
    ];

    let pkgArgs = null;
    let ecosystem = 'npm';
    for (const pat of patterns) {
      const m = cmd.match(pat);
      if (m) {
        pkgArgs = m[1];
        ecosystem = pat.source.includes('pip') ? 'pypi' : 'npm';
        break;
      }
    }
    if (!pkgArgs) { process.exit(0); }

    // #29: stop at the first shell operator/redirection so a compound command
    // (npm i x && echo done; npm pack >/dev/null) can't bleed shell tokens into
    // the package list, then keep only well-formed package names.
    var headArgs = pkgArgs.split(/[;&|<>()\`#\\n]/)[0];
    var rawPkgs = headArgs.split(/\\s+/).filter(function(a) {
      return a && !a.startsWith('-') && isValidPkgName(a, ecosystem);
    });

    for (var i = 0; i < rawPkgs.length; i++) {
      var originalPkg = rawPkgs[i];
      var pkg = normalizeToManifestId(originalPkg);
      const manifestPath = findManifest(pkg) || findManifest(pkg.replace(/-/g, ''));

      // Surface FACTS for the just-installed package, looked up by name
      // independently of whether a corpus-free manifest exists. Exactly one
      // hookSpecificOutput per detected package (advisory; never fails).
      var l2 = lookupL2(originalPkg, pkg);
      var msg;
      if (l2) {
        var parts = [];
        if (l2.known_vulns && l2.known_vulns.length) {
          parts.push('KNOWN VULNS/INCIDENTS: ' + l2.known_vulns.map(function(v){ return v.id + ' [' + v.severity + '] ' + v.summary; }).join(' | '));
        } else {
          parts.push('No known vulns/incidents on file.');
        }
        parts.push('Maintenance: ' + l2.maintenance + '. License: ' + l2.license + ' (risk: ' + l2.license_risk + ').');
        parts.push('As of ' + l2.fetched_at + '. Vet with starlog_facts ' + l2.package + ' before building on it.');
        msg = '[Starlog facts] ' + originalPkg + ' — ' + parts.join(' ');
      } else {
        msg = '[Starlog] No facts on file for "' + originalPkg + '". Run starlog_facts ' + originalPkg + ' to vet it.';
      }
      console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg }
      }));

      if (!manifestPath) {
        // Queue for batch generation (per D-02, D-03)
        try {
          var homedir = require('os').homedir();
          var globalQueueDir = path.join(homedir, '.starlog');
          var globalQueuePath = path.join(globalQueueDir, 'pending.json');
          var localQueueDir = path.join(data.cwd || process.cwd(), '.starlog');
          var localQueuePath = path.join(localQueueDir, 'pending.json');

          var entry = {
            package_name: originalPkg,
            manifest_id: pkg,
            ecosystem: ecosystem,
            detected_at: new Date().toISOString(),
            source_project: data.cwd || process.cwd(),
            install_command: cmd,
            status: 'pending'
          };

          // Read global queue, deduplicate by manifest_id (per D-11)
          var globalQueue = [];
          try {
            globalQueue = JSON.parse(fs.readFileSync(globalQueuePath, 'utf8'));
          } catch (e) { /* file doesn't exist yet */ }

          var alreadyQueued = globalQueue.some(function(e) { return e.manifest_id === pkg; });
          if (!alreadyQueued) {
            globalQueue.push(entry);
            fs.mkdirSync(globalQueueDir, { recursive: true });
            writeFileAtomic(globalQueuePath, JSON.stringify(globalQueue, null, 2) + '\\n');

            // Append to project-local log
            var localQueue = [];
            try { localQueue = JSON.parse(fs.readFileSync(localQueuePath, 'utf8')); } catch (e) { /* */ }
            localQueue.push(entry);
            fs.mkdirSync(localQueueDir, { recursive: true });
            writeFileAtomic(localQueuePath, JSON.stringify(localQueue, null, 2) + '\\n');
          }
          // NB: the facts hookSpecificOutput was already emitted above for this
          // package; the queue write is a silent side-effect (no second JSON on stdout).
        } catch (e) {
          // Never fail -- advisory only
        }
      }
    }
  } catch (e) {
    // Never fail — advisory only
  }
  process.exit(0);
});

function normalizeToManifestId(pkg) {
  return pkg.replace(/^@[^\\/]+\\//, '')
    .replace(/\\./g, '-')
    .toLowerCase();
}

// #29: a token is a real package name only if it matches ecosystem naming rules
// (after stripping a trailing version/tag). Rejects shell tokens, paths, quotes,
// and anything with metacharacters — by construction, since the grammars below
// allow only [a-z0-9._-] plus one optional npm scope slash.
function isValidPkgName(name, ecosystem) {
  if (!name) return false;
  var n = String(name);
  if (ecosystem === 'pypi') {
    n = n.split(/[<>=!~;\\[]/)[0];
  } else {
    var at = n.lastIndexOf('@');
    if (at > 0) n = n.slice(0, at); // strip trailing @version/@tag, keep leading scope
  }
  if (!n || n.length > 214) return false;
  if (ecosystem === 'pypi') return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(n);
  return /^(@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*$/i.test(n);
}

function findManifest(id) {
  try {
    const categories = fs.readdirSync(CORPUS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const cat of categories) {
      const p = path.join(CORPUS_DIR, cat.name, id + '.json');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* ignore */ }
  return null;
}
`;
}

async function installHookScript(): Promise<{ changed: boolean }> {
  // Write the hook file
  await mkdir(HOOKS_DIR, { recursive: true });
  const desired = generateHookScript();

  let existing: string | null = null;
  try {
    existing = await readFile(HOOK_PATH, 'utf8');
  } catch { /* doesn't exist yet */ }

  const fileChanged = existing !== desired;
  if (fileChanged) {
    await atomicWrite(HOOK_PATH, desired);
  }

  // Add hook entry to settings.json
  const settings = await readSettingsJson();
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!Array.isArray(hooks.PostToolUse)) {
    hooks.PostToolUse = [];
  }

  const hookCommand = `node "${HOOK_PATH}"`;
  const alreadyRegistered = hooks.PostToolUse.some((entry: unknown) => {
    const e = entry as { hooks?: Array<{ command?: string }> };
    return e.hooks?.some(h => h.command?.includes(HOOK_FILENAME));
  });

  if (alreadyRegistered && !fileChanged) {
    return { changed: false };
  }

  if (!alreadyRegistered) {
    hooks.PostToolUse.push({
      matcher: 'Bash',
      hooks: [{
        type: 'command',
        command: hookCommand,
        timeout: 10,
      }],
    });
    await writeSettingsJson(settings);
  }

  return { changed: true };
}

async function removeHookScript(): Promise<{ changed: boolean }> {
  // Remove hook entry from settings.json
  const settings = await readSettingsJson();
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks && Array.isArray(hooks.PostToolUse)) {
    const before = hooks.PostToolUse.length;
    hooks.PostToolUse = hooks.PostToolUse.filter((entry: unknown) => {
      const e = entry as { hooks?: Array<{ command?: string }> };
      return !e.hooks?.some(h => h.command?.includes(HOOK_FILENAME));
    });
    if (hooks.PostToolUse.length < before) {
      await writeSettingsJson(settings);
    }
  }

  // Remove the hook file
  try {
    await unlink(HOOK_PATH);
  } catch { /* already gone */ }

  return { changed: true };
}

// ── Marked instruction sections (CLAUDE.md / Copilot / Codex) ───────────
//
// These three agent-config files share one format: the Starlog block is
// delimited by an explicit start marker AND end marker so it can be removed
// without disturbing anything the user wrote before or after it.

/** The Starlog block, wrapped in start/end markers. Leading + trailing \n so it
 *  appends cleanly and removes back to the file's original bytes. */
function buildMarkedSection(): string {
  return `\n${STARLOG_MARKER}\n## Starlog — vet packages before you use them\n\n${STARLOG_INSTRUCTIONS}\n${STARLOG_END_MARKER}\n`;
}

/**
 * Locate the Starlog section within a file's content. Returns the byte range
 * [start, end) to remove/replace — `start` consumes the section's leading
 * newline so an edit returns the file to its pre-install bytes.
 *
 * `bounded` is true only when a real end marker delimits the section (the safe
 * case for in-place replacement). Legacy installs (start marker, no end marker)
 * report `bounded: false` and a best-effort range; callers must not blind-write
 * over those without a backup.
 */
function findSectionBounds(
  content: string,
): { start: number; end: number; bounded: boolean } | null {
  if (!content.includes(STARLOG_MARKER)) return null;

  const withNl = content.indexOf(`\n${STARLOG_MARKER}`);
  const start = withNl !== -1 ? withNl : content.indexOf(STARLOG_MARKER);

  const endIdx = content.indexOf(STARLOG_END_MARKER, start);
  if (endIdx !== -1) {
    let end = endIdx + STARLOG_END_MARKER.length;
    if (content[end] === '\n') end += 1;
    return { start, end, bounded: true };
  }

  // Legacy install (no end marker): stop at the next HTML comment if present,
  // else EOF. Best-effort only.
  const nextComment = content.indexOf('\n<!-- ', start + 1);
  return { start, end: nextComment !== -1 ? nextComment : content.length, bounded: false };
}

/**
 * Ensure the Starlog section is present and up to date.
 * - Absent: append it.
 * - Present and current: no-op.
 * - Present but drifted (instruction text changed): replace it in place, but
 *   only for sections delimited by an end marker (the safe case). Legacy
 *   sections without an end marker are left untouched to avoid clobbering
 *   user content — uninstall+reinstall migrates them.
 */
export async function upsertMarkedSection(target: string): Promise<{ changed: boolean }> {
  let content = '';
  try {
    content = await readFile(target, 'utf8');
  } catch { /* doesn't exist yet */ }

  const desired = buildMarkedSection();
  const bounds = findSectionBounds(content);

  if (!bounds) {
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await atomicWrite(target, content + separator + desired);
    return { changed: true };
  }

  const existing = content.substring(bounds.start, bounds.end);
  if (existing === desired) {
    return { changed: false };
  }

  // Drifted. Only refresh sections we can bound precisely with an end marker.
  if (!bounds.bounded) {
    return { changed: false };
  }

  const updated = content.substring(0, bounds.start) + desired + content.substring(bounds.end);
  await atomicWrite(target, updated);
  return { changed: true };
}

/** Remove the Starlog section, preserving any content the user added before or
 *  after it. Backs the file up to `<file>.bak` before the (destructive) edit. */
export async function removeMarkedSection(
  target: string,
): Promise<{ changed: boolean; backedUp: boolean }> {
  let content: string;
  try {
    content = await readFile(target, 'utf8');
  } catch {
    return { changed: false, backedUp: false };
  }

  const bounds = findSectionBounds(content);
  if (!bounds) {
    return { changed: false, backedUp: false };
  }

  const cleaned = content.substring(0, bounds.start) + content.substring(bounds.end);
  await atomicWrite(`${target}.bak`, content);
  await atomicWrite(target, cleaned);
  return { changed: true, backedUp: true };
}

// ── CLAUDE.md ───────────────────────────────────────────────────────────

function writeClaudeMd(projectDir: string): Promise<{ changed: boolean }> {
  return upsertMarkedSection(join(projectDir, 'CLAUDE.md'));
}

function removeClaudeMd(projectDir: string): Promise<{ changed: boolean; backedUp: boolean }> {
  return removeMarkedSection(join(projectDir, 'CLAUDE.md'));
}

// ── Cursor (.cursor/rules/starlog.mdc) ─────────────────────────────────

function buildCursorMdc(): string {
  return `---
description: Starlog — vet packages with facts before adopting them
alwaysApply: true
---

${STARLOG_INSTRUCTIONS}
`;
}

async function configureCursor(projectDir: string): Promise<{ changed: boolean }> {
  const rulesDir = join(projectDir, '.cursor', 'rules');
  const target = join(rulesDir, 'starlog.mdc');
  const desired = buildCursorMdc();

  let existing: string | null = null;
  try {
    existing = await readFile(target, 'utf8');
  } catch { /* doesn't exist yet */ }

  if (existing === desired) {
    return { changed: false };
  }

  await atomicWrite(target, desired);
  return { changed: true };
}

async function removeCursor(projectDir: string): Promise<{ changed: boolean }> {
  const target = join(projectDir, '.cursor', 'rules', 'starlog.mdc');
  try {
    await unlink(target);
    return { changed: true };
  } catch {
    return { changed: false };
  }
}

// ── VS Code Copilot (.github/copilot-instructions.md) ──────────────────

function configureCopilot(projectDir: string): Promise<{ changed: boolean }> {
  return upsertMarkedSection(join(projectDir, '.github', 'copilot-instructions.md'));
}

function removeCopilot(projectDir: string): Promise<{ changed: boolean; backedUp: boolean }> {
  return removeMarkedSection(join(projectDir, '.github', 'copilot-instructions.md'));
}

// ── Codex (AGENTS.md) ──────────────────────────────────────────────────

function configureCodex(projectDir: string): Promise<{ changed: boolean }> {
  return upsertMarkedSection(join(projectDir, 'AGENTS.md'));
}

function removeCodex(projectDir: string): Promise<{ changed: boolean; backedUp: boolean }> {
  return removeMarkedSection(join(projectDir, 'AGENTS.md'));
}

// ── Orchestrator ────────────────────────────────────────────────────────

// ── Install plan (preview + confirm) ──────────────────────────────────────
//
// init never writes blind. It first builds a read-only plan of every file it
// would touch, prints it, and (unless --yes) asks the user to confirm. The plan
// reuses the SAME comparison helpers the apply path uses, so "unchanged" here
// means the apply step would be a genuine no-op.

type PlanAction = 'create' | 'update' | 'unchanged';

interface PlanItem {
  label: string;
  path: string;
  action: PlanAction;
  apply: () => Promise<{ changed: boolean }>;
}

interface SkippedItem {
  label: string;
  reason: string;
}

/** Abbreviate an absolute path under the home dir to a leading `~`. */
function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Action for a marker-delimited section file (CLAUDE.md / Copilot / Codex),
 *  mirroring upsertMarkedSection's decision so the preview can't lie. */
export async function markedSectionAction(target: string): Promise<PlanAction> {
  let content: string;
  try {
    content = await readFile(target, 'utf8');
  } catch {
    return 'create'; // file absent — upsert will create it
  }
  const bounds = findSectionBounds(content);
  if (!bounds) return 'update'; // file exists, no section — upsert appends
  const existing = content.substring(bounds.start, bounds.end);
  if (existing === buildMarkedSection()) return 'unchanged';
  // Drifted: refreshed only when bounded; legacy (unbounded) is left untouched.
  return bounds.bounded ? 'update' : 'unchanged';
}

/** Action for the Cursor rule file. */
async function cursorAction(projectDir: string): Promise<PlanAction> {
  const target = join(projectDir, '.cursor', 'rules', 'starlog.mdc');
  let existing: string | null = null;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    return 'create';
  }
  return existing === buildCursorMdc() ? 'unchanged' : 'update';
}

/** Action for the Claude Code MCP server entry in settings.json. */
async function mcpServerAction(apiKey?: string): Promise<PlanAction> {
  const settings = await readSettingsJson();
  const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  if (!('starlog' in servers)) return 'create';
  return JSON.stringify(servers.starlog) === JSON.stringify(desiredMcpServer(apiKey))
    ? 'unchanged'
    : 'update';
}

/** Action for the PostToolUse hook (file on disk + settings.json registration). */
async function hookAction(): Promise<PlanAction> {
  let existing: string | null = null;
  try {
    existing = await readFile(HOOK_PATH, 'utf8');
  } catch { /* absent */ }
  const fileMatches = existing === generateHookScript();

  const settings = await readSettingsJson();
  const hooks = settings.hooks as { PostToolUse?: unknown[] } | undefined;
  const registered = Array.isArray(hooks?.PostToolUse) && hooks!.PostToolUse.some((entry) => {
    const e = entry as { hooks?: Array<{ command?: string }> };
    return e.hooks?.some((h) => h.command?.includes(HOOK_FILENAME));
  });

  if (fileMatches && registered) return 'unchanged';
  return existing === null ? 'create' : 'update';
}

/** Build the full plan for an install run, honouring detection and --all/--project. */
async function buildInstallPlan(
  opts: InitOpts,
  projectDir: string,
  apiKey?: string,
): Promise<{ items: PlanItem[]; skipped: SkippedItem[] }> {
  const items: PlanItem[] = [];
  const skipped: SkippedItem[] = [];

  items.push({
    label: 'Claude Code · MCP server',
    path: tildify(SETTINGS_PATH),
    action: await mcpServerAction(apiKey),
    apply: () => configureMcpServer(apiKey),
  });
  items.push({
    label: 'Claude Code · PostToolUse hook',
    path: tildify(HOOK_PATH),
    action: await hookAction(),
    apply: installHookScript,
  });

  const detection = detectAgents({ projectDir });

  if (opts.all || detection.cursor.detected) {
    items.push({
      label: 'Cursor · rule',
      path: join(projectDir, '.cursor', 'rules', 'starlog.mdc'),
      action: await cursorAction(projectDir),
      apply: () => configureCursor(projectDir),
    });
  } else {
    skipped.push({ label: 'Cursor', reason: detection.cursor.reason });
  }

  if (opts.all || detection.copilot.detected) {
    items.push({
      label: 'VS Code Copilot · instructions',
      path: join(projectDir, '.github', 'copilot-instructions.md'),
      action: await markedSectionAction(join(projectDir, '.github', 'copilot-instructions.md')),
      apply: () => configureCopilot(projectDir),
    });
  } else {
    skipped.push({ label: 'VS Code Copilot', reason: detection.copilot.reason });
  }

  if (opts.all || detection.codex.detected) {
    items.push({
      label: 'Codex · instructions',
      path: join(projectDir, 'AGENTS.md'),
      action: await markedSectionAction(join(projectDir, 'AGENTS.md')),
      apply: () => configureCodex(projectDir),
    });
  } else {
    skipped.push({ label: 'Codex', reason: detection.codex.reason });
  }

  if (opts.project) {
    items.push({
      label: 'CLAUDE.md · project instructions',
      path: join(projectDir, 'CLAUDE.md'),
      action: await markedSectionAction(join(projectDir, 'CLAUDE.md')),
      apply: () => writeClaudeMd(projectDir),
    });
  }

  return { items, skipped };
}

/** Prompt the user to confirm. Returns false on anything but an explicit yes. */
async function confirmApply(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('\nApply these changes? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

interface InitOpts {
  project?: boolean;
  uninstall?: boolean;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  apiKey?: string;
}

/**
 * True when this package was run from npm's npx cache (~/.npm/_npx/<hash>/...).
 * That directory is temporary -- npm garbage-collects it -- so an MCP server or
 * hook pinned to a path inside it will silently stop working once the cache is
 * cleared. We warn and steer the user to a durable global install.
 */
function isEphemeralInstall(): boolean {
  return /[/\\]_npx[/\\]/.test(getPackageRoot());
}

/** Post-install guidance: what's active, what to do next, and any caveats. */
function printPostInstallSummary(apiKey?: string): void {
  console.log('\nDone! Next steps:');
  console.log('  1. Restart your AI coding agent so it loads the MCP server.');
  console.log('  2. Run `starlog doctor` to confirm everything is wired up.');

  if (apiKey) {
    console.log('\nRanking mode: hosted — full corpus + org-private facts (STARLOG_API_KEY wired).');
  } else {
    console.log('\nRanking mode: keyword — offline, no key, no setup (the default).');
    console.log('Want hosted ranking (full corpus) + org-private facts? Get a key at https://starlog.dev, then:');
    console.log('  starlog init --api-key <key>');
  }

  console.log('\nYour agent will now vet packages with `starlog_facts` before adopting them.');
  console.log('Try it now:  starlog facts <a package you already use>');
  console.log('(e.g. `starlog facts axios`) — you get CVEs, license risk, and maintenance status.');

  console.log('\nGot internal/private packages? Teach your agent about them (per-project, auto-read here):');
  console.log('  starlog corpus add <pkg> --solves "<what it does>"   # so search surfaces it for a capability');
  console.log('  starlog facts add  <pkg> --status active --license MIT   # so it vets clean');
  console.log('This is the strongest case — the model can\'t know your private packages exist.');

  console.log('\nThe `starlog` CLI works in any terminal; Cursor, Copilot, and Codex get instruction files.');

  if (isEphemeralInstall()) {
    console.log('\n⚠  Heads up: this ran from a temporary npx cache, so the configured paths');
    console.log('   will break when npm clears that cache. For a durable setup, install');
    console.log('   globally and re-run:');
    console.log('     npm install -g starloghq && starlog init');
  }
}

export async function runInit(opts: InitOpts): Promise<void> {
  const projectDir = process.cwd();
  // An explicit --api-key wins; otherwise pick up an exported STARLOG_API_KEY so
  // `STARLOG_API_KEY=... starlog init` also wires the agent.
  const apiKey = opts.apiKey ?? process.env.STARLOG_API_KEY;

  if (opts.uninstall) {
    console.log('Starlog — removing integrations...\n');

    // Global (Claude Code)
    const mcp = await removeMcpServer();
    const hook = await removeHookScript();
    console.log(mcp.changed  ? '  [x] MCP server removed' : '  [=] MCP server was not configured');
    console.log(hook.changed ? '  [x] Hook removed' : '  [=] Hook was not installed');

    // Project-level
    const md = await removeClaudeMd(projectDir);
    const cursor = await removeCursor(projectDir);
    const copilot = await removeCopilot(projectDir);
    const codex = await removeCodex(projectDir);
    console.log(md.changed      ? '  [x] CLAUDE.md section removed' : '  [=] No CLAUDE.md section found');
    console.log(cursor.changed  ? '  [x] Cursor rule removed (.cursor/rules/starlog.mdc)' : '  [=] No Cursor rule found');
    console.log(copilot.changed ? '  [x] Copilot instructions removed (.github/copilot-instructions.md)' : '  [=] No Copilot instructions found');
    console.log(codex.changed   ? '  [x] Codex instructions removed (AGENTS.md)' : '  [=] No Codex instructions found');

    // Surface backups so the user knows a .bak sibling was written.
    for (const [label, res] of [['CLAUDE.md', md], ['.github/copilot-instructions.md', copilot], ['AGENTS.md', codex]] as const) {
      if (res.backedUp) console.log(`      [i] Backed up ${label} -> ${label}.bak`);
    }

    console.log('\nDone. Restart your AI coding agent for changes to take effect.');
    return;
  }

  const { items, skipped } = await buildInstallPlan(opts, projectDir, apiKey);
  const changes = items.filter((i) => i.action !== 'unchanged');

  // ── Preview ──
  console.log('Starlog init — planned changes:\n');
  const mark: Record<PlanAction, string> = {
    create: '[+ create]',
    update: '[~ update]',
    unchanged: '[= ok]    ',
  };
  for (const item of items) {
    console.log(`  ${mark[item.action]} ${item.label}`);
    console.log(`             ${item.path}`);
  }
  for (const s of skipped) {
    console.log(`  [- skip]   ${s.label} — ${s.reason} (use --all to force)`);
  }

  if (changes.length === 0) {
    console.log('\nEverything is already configured. No changes needed.');
    printPostInstallSummary(apiKey);
    return;
  }

  console.log(
    `\n${changes.length} file${changes.length === 1 ? '' : 's'} will be written. ` +
    'Nothing has been changed yet.',
  );

  // ── Dry run: stop before writing ──
  if (opts.dryRun) {
    console.log('Dry run — no changes written. Re-run without --dry-run to apply.');
    return;
  }

  // ── Confirm ──
  let proceed = opts.yes === true;
  if (!proceed) {
    if (!process.stdin.isTTY) {
      console.log('\nNon-interactive shell — re-run with --yes to apply, or --dry-run to preview only.');
      return;
    }
    proceed = await confirmApply();
  }
  if (!proceed) {
    console.log('\nAborted. No changes made.');
    return;
  }

  // ── Apply ──
  console.log('');
  for (const item of changes) {
    await item.apply();
    console.log(`  [done] ${item.label}`);
  }
  printPostInstallSummary(apiKey);
}
