import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extractWritePayload, handleDiyPreToolUse } from './diy-hook-runner.js';
import * as adviseService from './advise-service.js';
import { generateHookScript } from './install/hook-shim.js';

const DIY_AUTH = `import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!);
}
export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}`;

describe('extractWritePayload', () => {
  it('extracts Write tool content', () => {
    const r = extractWritePayload('Write', { file_path: 'src/auth.ts', content: DIY_AUTH });
    expect(r).toEqual({ relPath: 'src/auth.ts', content: DIY_AUTH });
  });

  it('extracts Edit tool new_string', () => {
    const r = extractWritePayload('Edit', { path: 'src/auth.ts', new_string: DIY_AUTH });
    expect(r?.relPath).toBe('src/auth.ts');
  });

  it('relativizes absolute paths against projectRoot', () => {
    const root = '/Users/dev/my-app';
    const r = extractWritePayload(
      'Write',
      { file_path: `${root}/src/utils/helpers.ts`, content: 'export const x = 1;' },
      root,
    );
    expect(r?.relPath).toBe('src/utils/helpers.ts');
  });

  it('ignores non-write tools', () => {
    expect(extractWritePayload('Bash', { command: 'npm install x' })).toBeNull();
  });

  it('ignores non-source files', () => {
    expect(extractWritePayload('Write', { file_path: 'README.md', content: DIY_AUTH })).toBeNull();
  });
});

describe('handleDiyPreToolUse', () => {
  let projectDir: string;
  let homeDir: string;
  let adviseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'starlog-diy-hook-'));
    homeDir = mkdtempSync(join(tmpdir(), 'starlog-diy-home-'));
    process.env.HOME = homeDir;
    delete process.env.STARLOG_API_KEY;
    adviseSpy = vi.spyOn(adviseService, 'runAdvise');
    adviseSpy.mockResolvedValue({
      action: 'migrate',
      category: 'authentication',
      rationale: 'Safe alternatives exist',
      candidates: [
        {
          manifest_id: 'clerk',
          name: 'Clerk',
          package_name: '@clerk/nextjs',
          relevance_score: 80,
          facts_available: true,
        },
      ],
      playbook_steps: ['Vet with starlog_facts'],
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('emits ask + permissionDecisionReason for high-confidence DIY auth writes', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(adviseSpy).toHaveBeenCalled();
    const line = logs.find((l) => l.includes('hookSpecificOutput'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    // PreToolUse surfaces guidance via ask + reason (additionalContext is PostToolUse-only).
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('[Starlog DIY]');
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it('does not fire DIY when absolute path contains auth but relative path does not', async () => {
    // Project living under ~/auth-service must not match /auth/i against the abs path.
    const authNamedRoot = mkdtempSync(join(tmpdir(), 'auth-service-'));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    try {
      await handleDiyPreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: join(authNamedRoot, 'src/utils/helpers.ts'),
          content: `import jwt from 'jsonwebtoken';\nexport const x = 1;`,
        },
        cwd: authNamedRoot,
      });
    } finally {
      console.log = origLog;
      rmSync(authNamedRoot, { recursive: true, force: true });
    }

    expect(logs.length).toBe(0);
    expect(adviseSpy).not.toHaveBeenCalled();
  });

  it('stays silent for weak DIY signals', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectDir, 'notes.txt.ts'),
        content: '// JWT mentioned in a comment only',
      },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(logs.length).toBe(0);
    expect(adviseSpy).not.toHaveBeenCalled();
  });

  it('emits positive ack when using a known auth library', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'preToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: join(projectDir, 'src/middleware/auth.ts'),
        content: `import { clerkMiddleware } from '@clerk/nextjs/server';`,
      },
      cwd: projectDir,
    });

    console.log = origLog;
    expect(adviseSpy).not.toHaveBeenCalled();
    const line = logs.find((l) => l.includes('Good —') || l.includes('additional_context'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.permission).toBe('allow');
    expect(String(parsed.user_message ?? parsed.additional_context ?? '')).toContain('Good —');
  });

  it('denies when org diy_category policy is deny', async () => {
    mkdirSync(join(projectDir, '.starlog'), { recursive: true });
    writeFileSync(
      join(projectDir, '.starlog/policy.json'),
      JSON.stringify({
        org: 'acme',
        rules: [
          {
            id: 'diy-authentication',
            decision: 'deny',
            match: { diy_category: 'authentication' },
            rationale: 'use Clerk/Auth0',
          },
        ],
      }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await handleDiyPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    });

    console.log = origLog;
    const line = logs.find((l) => l.includes('permissionDecision'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Org policy blocks');
  });

  it('still denies when runAdvise rejects under diy_category deny (never fail-open)', async () => {
    mkdirSync(join(projectDir, '.starlog'), { recursive: true });
    writeFileSync(
      join(projectDir, '.starlog/policy.json'),
      JSON.stringify({
        org: 'acme',
        rules: [
          {
            id: 'diy-authentication',
            decision: 'deny',
            match: { diy_category: 'authentication' },
            rationale: 'use Clerk/Auth0',
          },
        ],
      }),
    );
    adviseSpy.mockRejectedValue(new Error('offline / corpus missing'));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await expect(
      handleDiyPreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
        cwd: projectDir,
      }),
    ).resolves.toBeUndefined();

    console.log = origLog;
    const denyLines = logs.filter((l) => l.includes('"permissionDecision":"deny"'));
    expect(denyLines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(denyLines[0]);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Org policy blocks');
  });

  it('fails open (no output) when runAdvise rejects on advisory path', async () => {
    adviseSpy.mockRejectedValue(new Error('network down'));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    await expect(
      handleDiyPreToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
        cwd: projectDir,
      }),
    ).resolves.toBeUndefined();

    console.log = origLog;
    expect(logs.length).toBe(0);
  });

  it('debounces repeated advisories for the same project+category', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
      cwd: projectDir,
    };

    await handleDiyPreToolUse(payload);
    await handleDiyPreToolUse(payload);

    console.log = origLog;
    const outputs = logs.filter((l) => l.includes('hookSpecificOutput'));
    expect(outputs.length).toBe(1);
  });

  it('keeps positive-ack debounce across saveCache prune past the DIY window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(String(args[0]));

    try {
      const positivePayload = {
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: join(projectDir, 'src/middleware/auth.ts'),
          content: `import { clerkMiddleware } from '@clerk/nextjs/server';`,
        },
        cwd: projectDir,
      };
      const diyPayload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(projectDir, 'src/auth/login.ts'), content: DIY_AUTH },
        cwd: projectDir,
      };

      await handleDiyPreToolUse(positivePayload);
      expect(logs.some((l) => l.includes('Good —'))).toBe(true);

      // Past DIY debounce (10m), still inside positive debounce (30m).
      // A DIY saveCache prune must not drop the positive:: entry early.
      vi.advanceTimersByTime(15 * 60 * 1000);
      await handleDiyPreToolUse(diyPayload);

      logs.length = 0;
      await handleDiyPreToolUse(positivePayload);

      expect(logs.some((l) => l.includes('Good —'))).toBe(false);
    } finally {
      console.log = origLog;
      vi.useRealTimers();
    }
  });
});

describe('runDiy subprocess (stdin / exit-0)', () => {
  let hookPath: string;

  beforeAll(() => {
    // hook-runner is the installed shim target — ensure dist is current.
    const built = spawnSync(process.execPath, ['build.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(built.status).toBe(0);
    // Thin shim calls mod.run() — dist/hook-runner.js only exports run.
    hookPath = join(mkdtempSync(join(tmpdir(), 'starlog-diy-shim-')), 'starlog-pkg-check.js');
    writeFileSync(hookPath, generateHookScript());
  });

  it('exits 0 and emits ask decision for DIY write via hook shim', () => {
    const home = mkdtempSync(join(tmpdir(), 'starlog-diy-sub-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'starlog-diy-sub-cwd-'));
    try {
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: {
          file_path: join(cwd, 'src/auth/login.ts'),
          content: DIY_AUTH,
        },
        cwd,
      });
      const r = spawnSync(process.execPath, [hookPath], {
        input,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, STARLOG_TELEMETRY: '0' },
        timeout: 30_000,
      });
      expect(r.status).toBe(0);
      const line = (r.stdout ?? '').split('\n').find((l) => l.includes('hookSpecificOutput'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('[Starlog DIY]');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exits 0 with no output on invalid stdin (fail-open)', () => {
    const home = mkdtempSync(join(tmpdir(), 'starlog-diy-bad-'));
    try {
      const r = spawnSync(process.execPath, [hookPath], {
        input: 'not-json',
        encoding: 'utf8',
        env: { ...process.env, HOME: home, STARLOG_TELEMETRY: '0' },
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
