import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadCorpus } from './engine/corpus.js';
import { getPackageRoot } from './paths.js';

const execFileAsync = promisify(execFile);

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const HOOK_PATH = join(CLAUDE_DIR, 'hooks', 'starlog-pkg-check.js');
const HOOK_FILENAME = 'starlog-pkg-check.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  label: string;
  detail?: string;
}

const SYMBOL: Record<Level, string> = { ok: '[ok]', warn: '[!] ', fail: '[x] ' };

function print(check: Check): void {
  const line = `  ${SYMBOL[check.level]} ${check.label}`;
  console.log(check.detail ? `${line} — ${check.detail}` : line);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + parse a JSON file, distinguishing "absent" from "present but invalid"
 * so doctor can tell the difference between an unconfigured setup and a corrupt
 * settings.json (which `starlog init` would otherwise choke on).
 */
export type JsonResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string };

export async function readJson(p: string): Promise<JsonResult> {
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'invalid', error: (err as Error).message };
  }
  try {
    return { kind: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { kind: 'invalid', error: (err as Error).message };
  }
}

// ── Corpus ────────────────────────────────────────────────────────────────

async function checkCorpus(): Promise<Check> {
  try {
    const corpus = await loadCorpus();
    if (corpus.length === 0) {
      return { level: 'fail', label: 'Corpus', detail: 'no manifests found — reinstall starlog' };
    }
    return { level: 'ok', label: 'Corpus', detail: `${corpus.length} manifests loaded` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { level: 'fail', label: 'Corpus', detail: `failed to load (${msg})` };
  }
}

// ── Claude Code MCP server ──────────────────────────────────────────────────

interface McpCommand {
  command: string;
  args: string[];
}

function resolveMcpCommand(settings: Record<string, unknown> | null): McpCommand | null {
  const servers = settings?.mcpServers as Record<string, { command?: string; args?: unknown }> | undefined;
  const entry = servers?.starlog;
  if (entry && typeof entry.command === 'string' && Array.isArray(entry.args)) {
    return { command: entry.command, args: entry.args as string[] };
  }
  return null;
}

/**
 * Spawn the MCP server and run a minimal initialize -> tools/list handshake.
 * Resolves to the list of tool names, or throws on failure/timeout.
 */
function mcpHandshake(cmd: McpCommand, timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out waiting for MCP response'))),
      timeoutMs,
    );

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', () => finish(() => reject(new Error('MCP server exited without responding'))));

    child.stdout.on('data', (d) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            finish(() => resolve(msg.result.tools.map((t: { name: string }) => t.name)));
            return;
          }
        } catch {
          /* partial line */
        }
      }
    });

    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'starlog-doctor', version: '0' } },
    });
    setTimeout(() => {
      if (settled) return;
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 150);
  });
}

async function checkMcp(settings: Record<string, unknown> | null): Promise<Check[]> {
  const configured = resolveMcpCommand(settings);
  if (!configured) {
    return [{ level: 'warn', label: 'Claude Code MCP', detail: 'not configured — run `starlog init`' }];
  }

  const checks: Check[] = [
    { level: 'ok', label: 'Claude Code MCP', detail: `${configured.command} ${configured.args.join(' ')}` },
  ];

  try {
    const tools = await mcpHandshake(configured);
    if (tools.includes('starlog_search')) {
      checks.push({ level: 'ok', label: 'MCP handshake', detail: `starlog_search available` });
    } else {
      checks.push({ level: 'fail', label: 'MCP handshake', detail: `server responded but starlog_search missing (tools: ${tools.join(', ') || 'none'})` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ level: 'fail', label: 'MCP handshake', detail: `${msg} — try \`npm run build\` or reinstall` });
  }

  return checks;
}

// ── PostToolUse hook ────────────────────────────────────────────────────────

async function checkHook(settings: Record<string, unknown> | null): Promise<Check[]> {
  const checks: Check[] = [];
  const hookFilePresent = await fileExists(HOOK_PATH);

  const hooks = settings?.hooks as { PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } | undefined;
  const registered = (hooks?.PostToolUse ?? []).some((e) =>
    e.hooks?.some((h) => h.command?.includes(HOOK_FILENAME)),
  );

  if (!hookFilePresent && !registered) {
    checks.push({ level: 'warn', label: 'PostToolUse hook', detail: 'not installed — run `starlog init`' });
    return checks;
  }

  if (hookFilePresent) {
    try {
      await execFileAsync(process.execPath, ['--check', HOOK_PATH]);
      checks.push({ level: 'ok', label: 'PostToolUse hook', detail: 'script present and valid' });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      checks.push({ level: 'fail', label: 'PostToolUse hook', detail: `script has a syntax error (${msg})` });
    }

    // The installed hook is a thin shim that loads the package's dist/hook-runner.js
    // at runtime (so upgrades refresh behaviour with no re-init). Verify that logic
    // module is actually resolvable — a broken upgrade would otherwise silently stop
    // surfacing facts. Only meaningful for the shim; a legacy self-contained hook has
    // no such dependency, so we skip the check when the marker is absent.
    const runnerPath = join(getPackageRoot(), 'dist', 'hook-runner.js');
    const isShim = await readFile(HOOK_PATH, 'utf8').then((c) => c.includes('hook-runner.js')).catch(() => false);
    if (isShim) {
      checks.push(
        (await fileExists(runnerPath))
          ? { level: 'ok', label: 'Hook logic', detail: 'hook-runner.js resolves — upgrades refresh behaviour with no re-init' }
          : { level: 'fail', label: 'Hook logic', detail: `shim cannot load its logic (${runnerPath} missing) — re-run \`starlog init\`` },
      );
    }
  } else {
    checks.push({ level: 'fail', label: 'PostToolUse hook', detail: 'registered in settings but script file is missing' });
  }

  if (hookFilePresent && !registered) {
    checks.push({ level: 'warn', label: 'Hook registration', detail: 'script exists but not registered in settings.json' });
  }

  return checks;
}

// ── Project-level agent instructions ────────────────────────────────────────

const STARLOG_MARKER = '<!-- starlog:init -->';

async function fileHasMarker(p: string): Promise<boolean> {
  try {
    return (await readFile(p, 'utf8')).includes(STARLOG_MARKER);
  } catch {
    return false;
  }
}

async function checkProjectAgents(projectDir: string): Promise<Check[]> {
  const cursor = await fileExists(join(projectDir, '.cursor', 'rules', 'starlog.mdc'));
  const copilot = await fileHasMarker(join(projectDir, '.github', 'copilot-instructions.md'));
  const codex = await fileHasMarker(join(projectDir, 'AGENTS.md'));
  const claudeMd = await fileHasMarker(join(projectDir, 'CLAUDE.md'));

  const configured = [
    cursor && 'Cursor',
    copilot && 'Copilot',
    codex && 'Codex',
    claudeMd && 'CLAUDE.md',
  ].filter(Boolean) as string[];

  if (configured.length === 0) {
    return [{ level: 'warn', label: 'Project agents', detail: 'none configured in this directory' }];
  }
  return [{ level: 'ok', label: 'Project agents', detail: configured.join(', ') }];
}

// ── Ranking mode (informational) ─────────────────────────────────────────────

type RankingTier = 'keyword' | 'hosted';

// Keyword ranking is the default; a wired STARLOG_API_KEY opts into the hosted
// tier (full corpus + org-private facts). Scoring stays local either way — the
// key only widens what can be found (FIRST-03 / D-06).
function rankingState(settings: Record<string, unknown> | null): { tier: RankingTier; detail: string } {
  if (mcpEnv(settings)?.STARLOG_API_KEY) {
    return { tier: 'hosted', detail: 'hosted ranking — full corpus + org-private facts (STARLOG_API_KEY wired)' };
  }
  return {
    tier: 'keyword',
    detail: 'keyword ranking — offline, no key, no network (the default). Hosted tier available — get a key at https://starlog.dev, then `starlog init --api-key <key>`',
  };
}

// Both tiers are valid setups, reported as OK — never a warning.
async function checkRanker(settings: Record<string, unknown> | null): Promise<Check> {
  return { level: 'ok', label: 'Ranking', detail: rankingState(settings).detail };
}

// ── Private overlays (vetting + discovery + policy) ──────────────────────────
//
// Two distinct things, both invisible without this check:
//  1. Is the MCP server WIRED to read per-project overlays? (the baked
//     STARLOG_PRIVATE_* env — absent on installs predating that wiring.)
//  2. What has THIS project actually authored under `.starlog/`?
const OVERLAY_FILES: Array<{ rel: string; key: string; label: string }> = [
  { rel: '.starlog/private-facts.json', key: 'l2', label: 'vetting' },
  { rel: '.starlog/private-corpus.json', key: 'manifests', label: 'discovery' },
  { rel: '.starlog/policy.json', key: 'rules', label: 'policy' },
];

function mcpEnv(settings: Record<string, unknown> | null): Record<string, string> | null {
  const servers = settings?.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
  return servers?.starlog?.env ?? null;
}

export async function checkPrivateOverlays(settings: Record<string, unknown> | null, projectDir: string): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Wiring — only meaningful once the MCP server is configured at all.
  if (resolveMcpCommand(settings)) {
    const env = mcpEnv(settings);
    const wired = !!(env?.STARLOG_PRIVATE_CORPUS && env?.STARLOG_PRIVATE_FACTS);
    checks.push(
      wired
        ? { level: 'ok', label: 'Private overlays wired', detail: 'agent reads this project’s .starlog/ (vetting + discovery + policy)' }
        : { level: 'warn', label: 'Private overlays wired', detail: 'MCP server has no overlay env — re-run `starlog init` so the agent reads private facts/discovery' },
    );
  }

  // 2. What's authored in THIS project (counts, and a nudge when empty).
  const found: string[] = [];
  for (const { rel, key, label } of OVERLAY_FILES) {
    const res = await readJson(join(projectDir, rel));
    if (res.kind === 'ok') {
      const arr = (res.data as Record<string, unknown>)[key];
      found.push(`${label} ${Array.isArray(arr) ? arr.length : 0}`);
    } else if (res.kind === 'invalid') {
      checks.push({ level: 'warn', label: `Private ${label}`, detail: `${rel} is invalid JSON (${res.error}) — fix or remove` });
    }
  }
  checks.push(
    found.length
      ? { level: 'ok', label: 'Private overlays (this project)', detail: found.join(', ') }
      : { level: 'warn', label: 'Private overlays (this project)', detail: 'none yet — `starlog corpus add <pkg> --solves "…"` (discovery), `starlog facts add` (vetting)' },
  );
  return checks;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export async function runDoctor(): Promise<number> {
  const projectDir = process.cwd();
  console.log('Starlog doctor — checking your setup...\n');

  const settingsResult = await readJson(SETTINGS_PATH);
  const settings = settingsResult.kind === 'ok' ? settingsResult.data : null;

  const checks: Check[] = [];
  checks.push(await checkCorpus());
  if (settingsResult.kind === 'invalid') {
    checks.push({
      level: 'fail',
      label: 'settings.json',
      detail: `invalid JSON (${settingsResult.error}) — fix or remove ${SETTINGS_PATH}, then run \`starlog init\``,
    });
  }
  checks.push(...(await checkMcp(settings)));
  checks.push(...(await checkHook(settings)));
  checks.push(...(await checkPrivateOverlays(settings, projectDir)));
  checks.push(...(await checkProjectAgents(projectDir)));
  checks.push(await checkRanker(settings));

  for (const c of checks) print(c);

  const failures = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;

  console.log('');
  if (failures > 0) {
    console.log(`Found ${failures} problem${failures === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. See above.`);
    return 1;
  }
  if (warnings > 0) {
    console.log(`All critical checks passed (${warnings} warning${warnings === 1 ? '' : 's'}).`);
    return 0;
  }
  console.log('All checks passed. Starlog is ready.');
  return 0;
}
