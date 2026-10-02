import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, dispatchRaw } from './dispatch.js';
import { RECURRENCE_THRESHOLD } from '../patterns/schema.js';

// Isolate HOME so upsertPattern's global ~/.starlog/patterns.json write never
// touches the real store, and each test gets a fresh recurrence counter.
const originalHome = process.env.HOME;

describe('hook dispatch', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'starlog-hook-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'starlog-hook-cwd-'));
    mkdirSync(join(cwd, '.starlog'), { recursive: true });
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const jwtFile = {
    path: 'src/auth.ts',
    content: `import jwt from 'jsonwebtoken';
export const signToken = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET!);`,
  };

  it('fails open on malformed input', async () => {
    expect(await dispatchRaw('not json')).toEqual({ decision: 'allow', source: 'starlog' });
    expect(await dispatchRaw('')).toEqual({ decision: 'allow', source: 'starlog' });
    expect(await dispatchRaw('   ')).toEqual({ decision: 'allow', source: 'starlog' });
    expect(await dispatchRaw('[1,2,3]')).toEqual({ decision: 'allow', source: 'starlog' }); // valid JSON, wrong shape
  });

  it('takes the event from the stdin body when no override is given', async () => {
    const raw = JSON.stringify({ event: 'after_file_edit', cwd, payload: { path: 'x.md', content: 'hi' } });
    const r = await dispatchRaw(raw);
    expect(r.decision).toBe('allow'); // dispatched, just not a capability file
  });

  it('allows valid JSON that carries no event and no override', async () => {
    const r = await dispatchRaw(JSON.stringify({ cwd, payload: { path: 'a.ts', content: 'x' } }));
    expect(r).toEqual({ decision: 'allow', source: 'starlog' });
  });

  it('never throws on hostile payload field types', async () => {
    const hostile = [
      { path: 123, content: 'x' },
      { path: 'a.ts', content: { nested: true } },
      { path: null, content: null },
      { path: 'a.ts' }, // content missing
      { content: 'x' }, // path missing
      {},
      undefined,
    ];
    for (const payload of hostile) {
      const r = await runHook({ event: 'after_file_edit', cwd, payload: payload as never });
      expect(r.decision).toBe('allow');
    }
  });

  it('allows unknown / not-yet-implemented events', async () => {
    for (const event of ['before_execution', 'prompt_submit', 'stop', 'bogus'] as const) {
      const r = await runHook({ event: event as never, cwd });
      expect(r.decision).toBe('allow');
    }
  });

  it('takes the event from the CLI override when stdin omits it', async () => {
    const raw = JSON.stringify({ cwd, payload: { path: 'README.md', content: 'hello' } });
    const r = await dispatchRaw(raw, 'after_file_edit');
    expect(r.decision).toBe('allow'); // README is not a tracked capability
  });

  it('stays silent (allow) for a non-capability edit', async () => {
    const r = await runHook({
      event: 'after_file_edit',
      cwd,
      payload: { path: 'src/util.ts', content: 'export const add = (a, b) => a + b;' },
    });
    expect(r.decision).toBe('allow');
    expect(r.message).toBeUndefined();
  });

  it('warns exactly once at the recurrence threshold for DIY capability code', async () => {
    // Below threshold → silent.
    const first = await runHook({ event: 'after_file_edit', cwd, payload: jwtFile });
    expect(first.decision).toBe('allow');

    // Crossing threshold → one warn pointing at starlog_advise.
    let warned = first;
    for (let i = 1; i < RECURRENCE_THRESHOLD; i++) {
      warned = await runHook({ event: 'after_file_edit', cwd, payload: jwtFile });
    }
    expect(warned.decision).toBe('warn');
    expect(warned.message).toContain('authentication');
    expect(warned.message).toContain('starlog_advise');
    // Names a concrete vetted library (the eval-motivated inline hint), not just
    // a bare "go call the tool" indirection.
    expect(warned.message).toMatch(/Clerk|Auth0|better-auth/);

    // Above threshold → quiet again (no nagging).
    const after = await runHook({ event: 'after_file_edit', cwd, payload: jwtFile });
    expect(after.decision).toBe('allow');
  });

  it('never returns deny (warn-only until opt-in)', async () => {
    const r = await runHook({ event: 'after_file_edit', cwd, payload: jwtFile });
    expect(r.decision).not.toBe('deny');
  });

  it('tracks distinct capability categories on independent counters', async () => {
    const cacheFile = {
      path: 'src/cache.ts',
      content: 'export function createCache() { const store = new Map(); return store; }',
    };
    // One auth edit + one cache edit: each at count 1, both below threshold.
    expect((await runHook({ event: 'after_file_edit', cwd, payload: jwtFile })).decision).toBe('allow');
    expect((await runHook({ event: 'after_file_edit', cwd, payload: cacheFile })).decision).toBe('allow');
    // A second auth edit crosses auth's threshold — and the message is auth,
    // proving the cache edit didn't bump the auth counter.
    const warned = await runHook({ event: 'after_file_edit', cwd, payload: jwtFile });
    expect(warned.decision).toBe('warn');
    expect(warned.message).toContain('authentication');
    expect(warned.message).not.toContain('caching');
  });

  it('survives concurrent edits without throwing or corrupting the store', async () => {
    // Agents fire tools sequentially in practice, but a hook must not crash or
    // corrupt its store under parallel invocation. Fire 8 identical DIY edits at
    // once and assert: every call resolves to a valid decision, none is deny, and
    // the recurrence store is still valid JSON afterward. (We do NOT assert
    // "exactly one warn" here — a read-modify-write race can legitimately skew
    // the count; atomicity is a non-goal for a best-effort advisory tripwire.)
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runHook({ event: 'after_file_edit', cwd, payload: jwtFile })),
    );
    for (const r of results) {
      expect(['allow', 'warn']).toContain(r.decision);
    }
    // Store is readable + parseable after the concurrent writes (no truncation).
    const store = JSON.parse(readFileSync(join(cwd, '.starlog', 'patterns.json'), 'utf8'));
    expect(Array.isArray(store.patterns)).toBe(true);
  });

  it('accumulates the same pattern across different projects (shared global store)', async () => {
    const otherCwd = mkdtempSync(join(tmpdir(), 'starlog-hook-cwd2-'));
    mkdirSync(join(otherCwd, '.starlog'), { recursive: true });
    try {
      // First occurrence in project A → silent.
      expect((await runHook({ event: 'after_file_edit', cwd, payload: jwtFile })).decision).toBe('allow');
      // Same DIY pattern, different project B, same HOME → global counter hits 2 → warn.
      const warned = await runHook({ event: 'after_file_edit', cwd: otherCwd, payload: jwtFile });
      expect(warned.decision).toBe('warn');
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

describe('before_execution — L3 policy gate', () => {
  // Clear ambient overlay env so the handler resolves policy from the temp cwd
  // (an exported STARLOG_POLICY in the dev shell would otherwise win).
  const savedEnv: Record<string, string | undefined> = {};
  let cwd: string;

  beforeEach(() => {
    for (const k of ['STARLOG_POLICY', 'STARLOG_PRIVATE_FACTS', 'STARLOG_HOOK_ENFORCE']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    cwd = mkdtempSync(join(tmpdir(), 'starlog-policy-cwd-'));
    mkdirSync(join(cwd, '.starlog'), { recursive: true });
    // Org policy: deny evil-pkg by name.
    writeFileSync(
      join(cwd, '.starlog', 'policy.json'),
      JSON.stringify({ org: 'test', rules: [{ id: 'ban-evil', decision: 'deny', match: { package: 'evil-pkg' }, rationale: 'known-malicious' }] }),
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it('warns (→ ask) by default on a policy-denied install', async () => {
    const r = await runHook({ event: 'before_execution', cwd, payload: { command: 'npm i evil-pkg' } });
    expect(r.decision).toBe('warn');
    expect(r.message).toContain('evil-pkg');
    expect(r.message).toContain('known-malicious');
  });

  it('denies (→ hard block) when STARLOG_HOOK_ENFORCE=deny', async () => {
    process.env.STARLOG_HOOK_ENFORCE = 'deny';
    const r = await runHook({ event: 'before_execution', cwd, payload: { command: 'pnpm add evil-pkg@1.2.3' } });
    expect(r.decision).toBe('deny');
    expect(r.message).toContain('evil-pkg'); // version stripped, still matches
  });

  it('allows an install with no denied package', async () => {
    const r = await runHook({ event: 'before_execution', cwd, payload: { command: 'npm i lodash' } });
    expect(r.decision).toBe('allow');
    expect(r.message).toBeUndefined();
  });

  it('allows a non-install command (not our gate)', async () => {
    const r = await runHook({ event: 'before_execution', cwd, payload: { command: 'rm -rf build && ls' } });
    expect(r.decision).toBe('allow');
  });

  it('fails open when the command is missing/garbage', async () => {
    expect((await runHook({ event: 'before_execution', cwd, payload: {} })).decision).toBe('allow');
    expect((await runHook({ event: 'before_execution', cwd, payload: { command: 123 } as never })).decision).toBe('allow');
  });
});
