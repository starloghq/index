import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fc from 'fast-check';
import { runHook, dispatchRaw, type HookResult } from './dispatch.js';

// Property tests assert invariants that must hold for EVERY input, not just the
// hand-picked cases. HOME is redirected to a throwaway dir for the whole file so
// any recurrence-store writes triggered by randomly-DIY-looking payloads land in
// a temp ~/.starlog, never the real one.
const originalHome = process.env.HOME;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'starlog-prop-home-'));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

/** The contract every HookResult must satisfy. Encodes the load-bearing
 *  invariants: valid decision, no deny (warn-only), source stamp, warn⟺message. */
function isValidResult(r: HookResult): boolean {
  if (!r || r.source !== 'starlog') return false;
  if (!['allow', 'warn', 'deny'].includes(r.decision)) return false;
  if (r.decision === 'deny') return false; // warn-only until opt-in
  if (r.decision === 'warn' && typeof r.message !== 'string') return false;
  if (r.decision === 'allow' && r.message !== undefined) return false;
  return true;
}

const anyEvent = fc.oneof(
  fc.constantFrom('before_execution', 'after_file_edit', 'prompt_submit', 'stop'),
  fc.string(), // bogus/unknown events must still resolve to allow
);

const anyPayload = fc.oneof(
  fc.constant(undefined),
  fc.record({
    path: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined), fc.constant(null)),
    content: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined), fc.constant(null)),
  }),
  fc.object(),
  fc.anything(),
);

describe('dispatch — property invariants', () => {
  it('runHook never throws and always returns a valid decision, for any event+payload', async () => {
    await fc.assert(
      fc.asyncProperty(anyEvent, anyPayload, async (event, payload) => {
        const r = await runHook({ event: event as never, cwd: home, payload: payload as never });
        return isValidResult(r);
      }),
      { numRuns: 150 },
    );
  });

  it('dispatchRaw never throws and its output is always JSON-serializable and valid', async () => {
    const rawArb = fc.oneof(fc.string(), fc.json(), fc.constant(''), fc.constant('   '));
    await fc.assert(
      fc.asyncProperty(rawArb, fc.option(anyEvent, { nil: undefined }), async (raw, event) => {
        const r = await dispatchRaw(raw, event as never);
        // Round-trips through JSON (this is what the CLI writes to stdout).
        const roundTripped = JSON.parse(JSON.stringify(r)) as HookResult;
        return isValidResult(r) && isValidResult(roundTripped);
      }),
      { numRuns: 150 },
    );
  });

  it('never emits deny (the current warn-only invariant) across random capability-ish edits', async () => {
    // Bias toward payloads that actually trip detectFile, to exercise the
    // warn/allow branches — deny must never appear regardless.
    const capabilityPayload = fc.record({
      path: fc.constantFrom('src/auth.ts', 'src/cache.ts', 'src/queue.ts', 'src/util.ts'),
      content: fc.constantFrom(
        `import jwt from 'jsonwebtoken'; jwt.sign({}, 'x');`,
        `export function createCache(){ return new Map(); }`,
        `export const add = (a,b)=>a+b;`,
      ),
    });
    await fc.assert(
      fc.asyncProperty(capabilityPayload, async (payload) => {
        const cwd = mkdtempSync(join(home, 'proj-'));
        const r = await runHook({ event: 'after_file_edit', cwd, payload });
        return r.decision !== 'deny' && isValidResult(r);
      }),
      { numRuns: 60 },
    );
  });

  it('metamorphic: N sequential identical DIY edits warn EXACTLY once (fresh global store)', async () => {
    const diy = `import jwt from 'jsonwebtoken';\nexport const s = (i) => jwt.sign({ sub: i }, process.env.JWT_SECRET);`;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
        // Fresh HOME per run: the recurrence counter lives in the GLOBAL store
        // (~/.starlog), which is intentionally cross-project — so isolating it is
        // what makes "exactly once" a well-defined per-scenario invariant.
        const runHome = mkdtempSync(join(home, 'home-'));
        const prev = process.env.HOME;
        process.env.HOME = runHome;
        try {
          const cwd = mkdtempSync(join(runHome, 'proj-'));
          let warns = 0;
          for (let i = 0; i < n; i++) {
            const r = await runHook({ event: 'after_file_edit', cwd, payload: { path: 'src/auth.ts', content: diy } });
            if (r.decision === 'warn') warns++;
          }
          return warns === 1; // crosses the threshold exactly once
        } finally {
          process.env.HOME = prev;
        }
      }),
      { numRuns: 25 },
    );
  });

  // Regression for the fail-open bug this property suite found: JSON that parses
  // to a non-object (null/number/bool/string) must not throw on `.event`.
  it('dispatchRaw fails open on JSON that parses to a non-object', async () => {
    for (const raw of ['null', '123', 'true', '"a string"', '3.14']) {
      const r = await dispatchRaw(raw);
      expect(r).toEqual({ decision: 'allow', source: 'starlog' });
    }
  });
});
