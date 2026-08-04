// project-hooks.ts — per-project hook wiring for Cursor and VS Code Copilot.
//
// Claude Code hooks live in ~/.claude (global); Cursor and Copilot use project-level
// config so each repo gets DIY detect + install vet when `starlog init` runs.
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { atomicWrite } from '../fsutil.js';
import { generateHookScript, HOOK_FILENAME } from './hook-shim.js';

const CURSOR_HOOKS_JSON = '.cursor/hooks.json';
const CURSOR_HOOK_SCRIPT = `.cursor/hooks/${HOOK_FILENAME}`;
const COPILOT_HOOKS_JSON = '.github/hooks/starlog.json';
const COPILOT_HOOK_SCRIPT = `.github/hooks/${HOOK_FILENAME}`;

const STARLOG_MARKER = 'starlog-pkg-check';

/** Match Claude global init: `node "/abs/path/to/starlog-pkg-check.js"`. */
function hookCommand(absoluteScriptPath: string): string {
  return `node "${absoluteScriptPath}"`;
}

function entryUsesStarlog(entry: { command?: string }): boolean {
  return Boolean(entry.command?.includes(STARLOG_MARKER));
}

async function writeHookScript(dest: string): Promise<{ changed: boolean }> {
  const desired = generateHookScript();
  let existing: string | null = null;
  try {
    existing = await readFile(dest, 'utf8');
  } catch { /* new */ }
  if (existing === desired) return { changed: false };
  await mkdir(dirname(dest), { recursive: true });
  await atomicWrite(dest, desired);
  return { changed: true };
}

type CursorHooksConfig = {
  version?: number;
  hooks?: Record<string, Array<{ command?: string; matcher?: string; timeout?: number }>>;
};

function buildCursorHooksConfig(existing: CursorHooksConfig | null, hookCmd: string): CursorHooksConfig {
  const config: CursorHooksConfig = existing ? structuredClone(existing) : { version: 1, hooks: {} };
  if (!config.hooks) config.hooks = {};
  if (config.version == null) config.version = 1;

  const preEntry = { command: hookCmd, matcher: 'Write|Edit|MultiEdit', timeout: 10 };
  const shellEntry = {
    command: hookCmd,
    matcher: 'npm install|npm i |pnpm add|yarn add|pip install',
    timeout: 10,
  };

  for (const [key, entry] of [
    ['preToolUse', preEntry],
    ['beforeShellExecution', shellEntry],
  ] as const) {
    const arr = (config.hooks[key] ?? []).filter((e) => !entryUsesStarlog(e));
    if (!arr.some((e) => e.command === entry.command && e.matcher === entry.matcher)) {
      arr.push(entry);
    }
    config.hooks[key] = arr;
  }

  return config;
}

function buildCopilotHooksConfig(hookCmd: string): Record<string, unknown> {
  const entry = { type: 'command', command: hookCmd, timeout: 10 };
  return {
    hooks: {
      PreToolUse: [
        { ...entry, matcher: 'Write|Edit|MultiEdit' },
      ],
      PostToolUse: [
        { ...entry, matcher: 'Bash' },
      ],
    },
  };
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function installCursorProjectHooks(projectDir: string): Promise<{ changed: boolean }> {
  const scriptPath = join(projectDir, CURSOR_HOOK_SCRIPT);
  const hooksPath = join(projectDir, CURSOR_HOOKS_JSON);
  const script = await writeHookScript(scriptPath);
  const cmd = hookCommand(scriptPath);

  const existing = await readJsonIfPresent<CursorHooksConfig>(hooksPath);
  const desired = buildCursorHooksConfig(existing, cmd);
  const desiredText = JSON.stringify(desired, null, 2) + '\n';
  let hooksChanged = false;
  try {
    hooksChanged = (await readFile(hooksPath, 'utf8')) !== desiredText;
  } catch {
    hooksChanged = true;
  }
  if (hooksChanged) {
    await mkdir(join(projectDir, '.cursor'), { recursive: true });
    await atomicWrite(hooksPath, desiredText);
  }
  return { changed: script.changed || hooksChanged };
}

export async function removeCursorProjectHooks(projectDir: string): Promise<{ changed: boolean }> {
  let changed = false;
  const hooksPath = join(projectDir, CURSOR_HOOKS_JSON);
  const existing = await readJsonIfPresent<CursorHooksConfig>(hooksPath);
  if (existing?.hooks) {
    let touched = false;
    for (const key of Object.keys(existing.hooks)) {
      const before = existing.hooks[key]?.length ?? 0;
      existing.hooks[key] = (existing.hooks[key] ?? []).filter((e) => !entryUsesStarlog(e));
      if ((existing.hooks[key]?.length ?? 0) < before) touched = true;
    }
    if (touched) {
      await atomicWrite(hooksPath, JSON.stringify(existing, null, 2) + '\n');
      changed = true;
    }
  }
  try {
    await unlink(join(projectDir, CURSOR_HOOK_SCRIPT));
    changed = true;
  } catch { /* absent */ }
  return { changed };
}

export async function cursorProjectHooksAction(projectDir: string): Promise<'create' | 'update' | 'unchanged'> {
  const scriptPath = join(projectDir, CURSOR_HOOK_SCRIPT);
  const hooksPath = join(projectDir, CURSOR_HOOKS_JSON);
  let scriptExists = false;
  try {
    scriptExists = (await readFile(scriptPath, 'utf8')) === generateHookScript();
  } catch { /* absent */ }
  const existing = await readJsonIfPresent<CursorHooksConfig>(hooksPath);
  const desired = buildCursorHooksConfig(existing, hookCommand(scriptPath));
  const hooksMatch = existing != null && JSON.stringify(existing) === JSON.stringify(desired);
  if (scriptExists && hooksMatch) return 'unchanged';
  return existing == null && !scriptExists ? 'create' : 'update';
}

export async function installCopilotProjectHooks(projectDir: string): Promise<{ changed: boolean }> {
  const scriptPath = join(projectDir, COPILOT_HOOK_SCRIPT);
  const hooksPath = join(projectDir, COPILOT_HOOKS_JSON);
  const script = await writeHookScript(scriptPath);
  const cmd = hookCommand(scriptPath);

  const desired = buildCopilotHooksConfig(cmd);
  const desiredText = JSON.stringify(desired, null, 2) + '\n';
  let hooksChanged = false;
  try {
    hooksChanged = (await readFile(hooksPath, 'utf8')) !== desiredText;
  } catch {
    hooksChanged = true;
  }
  if (hooksChanged) {
    await mkdir(join(projectDir, '.github', 'hooks'), { recursive: true });
    await atomicWrite(hooksPath, desiredText);
  }
  return { changed: script.changed || hooksChanged };
}

export async function removeCopilotProjectHooks(projectDir: string): Promise<{ changed: boolean }> {
  let changed = false;
  try {
    await unlink(join(projectDir, COPILOT_HOOK_SCRIPT));
    changed = true;
  } catch { /* absent */ }
  try {
    await unlink(join(projectDir, COPILOT_HOOKS_JSON));
    changed = true;
  } catch { /* absent */ }
  return { changed };
}

export async function copilotProjectHooksAction(projectDir: string): Promise<'create' | 'update' | 'unchanged'> {
  const scriptPath = join(projectDir, COPILOT_HOOK_SCRIPT);
  const hooksPath = join(projectDir, COPILOT_HOOKS_JSON);
  let scriptExists = false;
  try {
    scriptExists = (await readFile(scriptPath, 'utf8')) === generateHookScript();
  } catch { /* absent */ }
  const existing = await readJsonIfPresent<Record<string, unknown>>(hooksPath);
  const desired = buildCopilotHooksConfig(hookCommand(scriptPath));
  const hooksMatch = existing != null && JSON.stringify(existing) === JSON.stringify(desired);
  if (scriptExists && hooksMatch) return 'unchanged';
  return existing == null && !scriptExists ? 'create' : 'update';
}

export const CURSOR_HOOKS_PATH = CURSOR_HOOKS_JSON;
export const COPILOT_HOOKS_PATH = COPILOT_HOOKS_JSON;
