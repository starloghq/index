import { describe, it, expect } from 'vitest';
import { EVAL_CASES, type EvalCase, type EvalKind } from './dataset.js';
import { scoreFacts } from './score.js';

/**
 * Dataset INTEGRITY tests for the facts eval corpus.
 *
 * Scope: this file asserts properties of EVAL_CASES *as data* — it does NOT
 * exercise matcher behavior (lookupFacts), which the scorer (./score.ts) owns.
 * It consumes the SAME EVAL_CASES the scorer consumes (single source of truth);
 * no cases are duplicated here.
 *
 * `EvalKind` is a TYPE (erased at runtime) and the 11-package corpus is only
 * documented in dataset.ts's header comment (not exported), so both are mirrored
 * here as runtime Sets. If dataset.ts adds a kind or a corpus package, the
 * corresponding test below must be updated in lockstep — that coupling is the
 * point: it guards against silent drift.
 */

// The five EvalKind string-literals, mirrored from the `EvalKind` union in
// dataset.ts (a type cannot be enumerated at runtime).
const VALID_KINDS: ReadonlySet<EvalKind> = new Set<EvalKind>([
  'true-positive',
  'search-scope',
  'hard-negative',
  'out-of-corpus',
  'robustness',
]);

// The 11 L1 packages every POSITIVE `expected` must belong to. NOTE: the full
// facts corpus is larger (L2 adds axios, express, lodash, … ~45 total) — this set
// is just the L1 subject packages the positive eval cases assert against, and the
// test below guards that no positive points outside it. (Not the whole corpus.)
const CORPUS_PACKAGES: ReadonlySet<string> = new Set<string>([
  'xz-utils',
  'event-stream',
  'ua-parser-js',
  'node-ipc',
  'colors',
  'request',
  'moment',
  'left-pad',
  'grafana',
  'chalk',
  'date-fns',
]);

const positives = EVAL_CASES.filter((c) => c.expected !== null);
const negatives = EVAL_CASES.filter((c) => c.expected === null);

describe('EVAL_CASES dataset integrity', () => {
  it('has a non-empty case list', () => {
    expect(EVAL_CASES.length).toBeGreaterThan(0);
  });

  it('has unique ids across all cases', () => {
    const ids = EVAL_CASES.map((c) => c.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect([...new Set(dupes)]).toEqual([]);
    expect(new Set(ids).size).toBe(EVAL_CASES.length);
  });

  it('has unique queries across all cases', () => {
    const queries = EVAL_CASES.map((c) => c.query);
    const dupes = queries.filter((q, i) => queries.indexOf(q) !== i);
    // Exact-string duplicates are a hard failure: two identical queries are a
    // copy/paste slip, not intentional coverage.
    expect([...new Set(dupes)]).toEqual([]);
    expect(new Set(queries).size).toBe(EVAL_CASES.length);
  });

  it('flags near-duplicate queries (case/whitespace-insensitive)', () => {
    // Soft sibling to exact-uniqueness: queries that collapse to the same
    // normalized form (lowercased, whitespace-folded) are usually intentional
    // fuzzy variants (e.g. "chalk" vs "  CHALK  "), so we ASSERT NOTHING here —
    // we only surface them for human review without blocking the suite.
    const norm = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = new Map<string, string[]>();
    for (const c of EVAL_CASES) {
      const key = norm(c.query);
      const bucket = seen.get(key) ?? [];
      bucket.push(c.id);
      seen.set(key, bucket);
    }
    const flagged = [...seen.values()].filter((ids) => ids.length > 1);
    if (flagged.length > 0) {
      // Visibility only — intentional variants are expected, so this never fails.
      // eslint-disable-next-line no-console
      console.info(
        `[dataset.test] near-duplicate query groups (review only): ${JSON.stringify(
          flagged,
        )}`,
      );
    }
    expect(Array.isArray(flagged)).toBe(true);
  });

  it('every case has a kind in the EvalKind union', () => {
    const offenders = EVAL_CASES.filter((c) => !VALID_KINDS.has(c.kind)).map(
      (c) => ({ id: c.id, kind: c.kind }),
    );
    expect(offenders).toEqual([]);
  });

  it('every non-null expected is one of the 11 corpus packages', () => {
    const offenders = EVAL_CASES.filter(
      (c) => c.expected !== null && !CORPUS_PACKAGES.has(c.expected),
    ).map((c) => ({ id: c.id, expected: c.expected }));
    expect(offenders).toEqual([]);
  });

  it('has at least 10 hard-negative cases', () => {
    const hardNegatives = EVAL_CASES.filter((c) => c.kind === 'hard-negative');
    expect(hardNegatives.length).toBeGreaterThanOrEqual(10);
  });

  it('has both positives and negatives (neither empty)', () => {
    expect(positives.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThan(0);
  });
});

describe('scoreFacts(EVAL_CASES) smoke', () => {
  it('runs and returns finite metrics in [0,1]', () => {
    const report = scoreFacts(EVAL_CASES) as unknown;
    expect(report).toBeTypeOf('object');
    expect(report).not.toBeNull();

    // The bounded-rate metrics live under report.metrics (hit_recall,
    // positive_precision, hard_negative_fp_rate). Validate every numeric leaf of
    // that object shape-agnostically, so renaming/adding a metric still passes
    // as long as it stays a finite rate in [0,1]. (Sibling fields like `counts`
    // hold tallies, not rates, so we deliberately scope to `.metrics`.)
    const metrics = (report as { metrics?: unknown }).metrics;
    expect(metrics).toBeTypeOf('object');
    expect(metrics).not.toBeNull();

    const numbers = Object.values(metrics as Record<string, unknown>).filter(
      (v): v is number => typeof v === 'number',
    );
    expect(numbers.length).toBeGreaterThan(0);
    for (const v of numbers) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// Type-only reference to keep the EvalCase import load-bearing under
// isolatedModules / no-unused-vars without affecting runtime.
export type _EvalCaseRef = EvalCase;
