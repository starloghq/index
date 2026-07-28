#!/usr/bin/env tsx
/**
 * Runnable benchmark CLI for the facts matcher.
 *
 * Runs the facts-eval scorer and prints a human-readable scorecard so the diff
 * on every change is visible. Default mode compares the current report to a
 * committed baseline.json and FAILS on any regression. The `--update-baseline`
 * flag is the deliberate, manual re-baseline step.
 *
 * Imports `scoreFacts` + `SCOPE_NOTE` from the scorer (authored separately):
 *   ../src/engine/facts-eval/score.js
 * (.js extension on the import is the NodeNext/ESM convention for a .ts source.)
 *
 * Exit codes:
 *   0  pass (or successful --update-baseline)
 *   1  regression vs baseline (prints exactly what regressed)
 *   2  no baseline.json yet (run with --update-baseline to create it)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scoreFacts, SCOPE_NOTE } from '../src/engine/facts-eval/score.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(
  __dirname,
  '../src/engine/facts-eval/baseline.json',
);

/**
 * The report shape the scorer returns. Kept structurally loose on purpose: the
 * scorer owns the canonical type; this harness only depends on the fields the
 * spec names.
 */
interface FactsReport {
  metrics: {
    hit_recall: number;
    positive_precision: number;
    hard_negative_fp_rate: number;
  };
  counts: {
    total: number;
    positives: number;
    negatives: number;
    by_kind: Record<string, { total: number; correct: number }>;
  };
  false_positives: Array<{ id: string; query: string; expected: null; got: string }>;
  misses: Array<{ id: string; query: string; expected: string; got: string | null }>;
  search_scope: {
    total: number;
    facts_silent: number;
    facts_resolved: Array<{ id: string; query: string; got: string }>;
  };
  [key: string]: unknown;
}

/** Recursively sort object keys so JSON.stringify output is deterministic. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonicalize a report for the on-disk baseline: drop any timestamp, sort the
 * id lists, then recursively sort keys. Pretty-printed, trailing newline.
 */
function canonicalize(report: FactsReport): string {
  const { timestamp, ...rest } = report as FactsReport & { timestamp?: unknown };
  void timestamp; // explicitly stripped — baseline carries NO timestamp
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const stable = {
    ...rest,
    false_positives: [...report.false_positives].sort(byId),
    misses: [...report.misses].sort(byId),
  };
  return JSON.stringify(sortDeep(stable), null, 2) + '\n';
}

/** Pretty-print a 0..1 metric. */
function pct(n: number): string {
  return `${(n * 100).toFixed(1).padStart(5)}%  (${n.toFixed(4)})`;
}

/** Print the human-readable scorecard. SCOPE_NOTE is the FIRST line. */
function printScorecard(report: FactsReport): void {
  console.log(SCOPE_NOTE);
  console.log('');
  const byId = (a: { id: string }, b: { id: string }): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  console.log('=== facts-eval scorecard ===');
  console.log(`hit_recall            : ${pct(report.metrics.hit_recall)}`);
  console.log(`positive_precision    : ${pct(report.metrics.positive_precision)}`);
  console.log(`hard_negative_fp_rate : ${pct(report.metrics.hard_negative_fp_rate)}`);
  console.log('');
  console.log('per-kind counts:');
  for (const kind of Object.keys(report.counts.by_kind).sort()) {
    console.log(`  ${kind.padEnd(16)} ${JSON.stringify(report.counts.by_kind[kind])}`);
  }
  console.log('');
  console.log(`false_positives (${report.false_positives.length}):`);
  if (report.false_positives.length === 0) {
    console.log('  (none)');
  } else {
    for (const fp of [...report.false_positives].sort(byId))
      console.log(`  + ${fp.id}  "${fp.query}"  got=${fp.got}`);
  }
  console.log('');
  console.log(`misses (${report.misses.length}):`);
  if (report.misses.length === 0) {
    console.log('  (none)');
  } else {
    for (const m of [...report.misses].sort(byId))
      console.log(`  - ${m.id}  "${m.query}"  expected=${m.expected} got=${m.got}`);
  }
  console.log('');

  // Search-scope: reported on its own, NOT folded into the headline metrics.
  // facts SHOULD stay silent on these (they are starlog_search's job).
  const ss = report.search_scope;
  if (ss) {
    console.log(
      `search-scope (excluded from headline metrics): ${ss.facts_silent}/${ss.total} correctly silent`,
    );
    if (ss.facts_resolved.length > 0) {
      console.log('  ⚠ facts FABRICATED on search-scope queries (should be silent):');
      for (const r of [...ss.facts_resolved].sort(byId))
        console.log(`  ! ${r.id}  "${r.query}"  got=${r.got}`);
    }
    console.log('');
  }
}

function loadBaseline(): FactsReport | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as FactsReport;
  } catch {
    return null;
  }
}

function main(): void {
  const updateBaseline = process.argv.includes('--update-baseline');

  const report = scoreFacts() as FactsReport;
  printScorecard(report);

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, canonicalize(report), 'utf-8');
    console.log(`Baseline updated: ${BASELINE_PATH}`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error(
      `No baseline yet — run with --update-baseline to create ${BASELINE_PATH}`,
    );
    process.exit(2);
  }

  const regressions: string[] = [];

  // Metric directions: recall/precision lower-is-worse; fp_rate higher-is-worse.
  if (report.metrics.hit_recall < baseline.metrics.hit_recall) {
    regressions.push(
      `hit_recall dropped: ${report.metrics.hit_recall} < baseline ${baseline.metrics.hit_recall}`,
    );
  }
  if (report.metrics.positive_precision < baseline.metrics.positive_precision) {
    regressions.push(
      `positive_precision dropped: ${report.metrics.positive_precision} < baseline ${baseline.metrics.positive_precision}`,
    );
  }
  if (report.metrics.hard_negative_fp_rate > baseline.metrics.hard_negative_fp_rate) {
    regressions.push(
      `hard_negative_fp_rate rose: ${report.metrics.hard_negative_fp_rate} > baseline ${baseline.metrics.hard_negative_fp_rate}`,
    );
  }

  // NEW-id check: any id now in false_positives/misses that the baseline did
  // not have is a regression, even if the aggregate metrics held.
  const byId = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  const baselineKnown = new Set<string>([
    ...(baseline.false_positives ?? []).map((fp) => fp.id),
    ...(baseline.misses ?? []).map((m) => m.id),
    ...(baseline.search_scope?.facts_resolved ?? []).map((r) => r.id),
  ]);
  const newFalsePositives = report.false_positives
    .filter((fp) => !baselineKnown.has(fp.id))
    .map((fp) => fp.id)
    .sort(byId);
  const newMisses = report.misses
    .filter((m) => !baselineKnown.has(m.id))
    .map((m) => m.id)
    .sort(byId);
  // A search-scope query the by-name path now RESOLVES (was silent) is a
  // fabrication regression — the exact class this contract exists to prevent.
  const newFabrications = (report.search_scope?.facts_resolved ?? [])
    .filter((r) => !baselineKnown.has(r.id))
    .map((r) => r.id)
    .sort(byId);
  for (const id of newFalsePositives) {
    regressions.push(`NEW false_positive: ${id}`);
  }
  for (const id of newMisses) {
    regressions.push(`NEW miss: ${id}`);
  }
  for (const id of newFabrications) {
    regressions.push(`NEW search-scope fabrication: ${id}`);
  }

  if (regressions.length > 0) {
    console.error('REGRESSION vs baseline.json:');
    for (const r of regressions) console.error(`  - ${r}`);
    console.error('');
    console.error(
      'If this change is intentional, re-baseline with: npm run bench:facts -- --update-baseline',
    );
    process.exit(1);
  }

  console.log('PASS — no regression vs baseline.json');
  process.exit(0);
}

main();
