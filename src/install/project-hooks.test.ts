import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installCursorProjectHooks,
  installCopilotProjectHooks,
  CURSOR_HOOKS_PATH,
  COPILOT_HOOKS_PATH,
} from './project-hooks.js';

describe('project-hooks install', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-proj-hooks-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers Cursor hooks as node-prefixed absolute commands', async () => {
    await installCursorProjectHooks(dir);
    const cfg = JSON.parse(readFileSync(join(dir, CURSOR_HOOKS_PATH), 'utf8'));
    const pre = cfg.hooks.preToolUse[0];
    expect(pre.command).toMatch(/^node "/);
    expect(pre.command).toContain(join(dir, '.cursor/hooks/starlog-pkg-check.js'));
    expect(pre.command.endsWith('"')).toBe(true);
  });

  it('registers Copilot hooks as node-prefixed absolute commands', async () => {
    await installCopilotProjectHooks(dir);
    const cfg = JSON.parse(readFileSync(join(dir, COPILOT_HOOKS_PATH), 'utf8'));
    const pre = cfg.hooks.PreToolUse[0];
    expect(pre.command).toMatch(/^node "/);
    expect(pre.command).toContain(join(dir, '.github/hooks/starlog-pkg-check.js'));
  });
});
