/**
 * Scorer for the facts matcher (lookupFacts in ../facts.ts).
 *
 * Consumes the canonical EVAL_CASES dataset and reports the RETRIEVAL
 * correctness of lookupFacts: does the substring matcher resolve the right
 * corpus package (and, critically, does it stay silent on hard negatives)?
 *
 * Pure + deterministic: one lookupFacts() call per case, no timestamps, no
 * randomness, arrays sorted by id, by_kind keys sorted. The same `cases` in →
 * the same report object out, byte-for-byte.
 *
 * SCOPE: this measures retrieval only. See SCOPE_NOTE.
 */

import { EVAL_CASES, type EvalCase } from './dataset.js';
import { lookupFacts } from '../facts.js';

export const SCOPE_NOTE =
  'Measures RETRIEVAL correctness of lookupFacts only — NOT whether facts change an agent\'s decision (that is the $-gated LLM decision-flip eval in starlogdev). ' +
  'facts is EXACT by-name (normalized lowercase+trim); free-text/fuzzy resolution is starlog_search\'s job. ' +
  '"search-scope" cases (NL/fuzzy/surface-form queries) are reported in their own bucket and EXCLUDED from hit_recall / positive_precision / hard_negative_fp_rate — for those, facts staying silent (null) is the CORRECT behavior.';

/** Cases whose correct facts answer is "defer to search" — scored separately. */
const SEARCH_SCOPE_KIND = 'search-scope';

/** A negative is a case whose CORRECT answer is "no match" (expected === null). */
function isPositive(c: EvalCase): boolean {
  return c.expected !== null;
}

/** Round to 4 decimals, returning a number (not a string). */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Safe ratio: 0/0 (and any 0 denominator) → 0, never NaN. */
function ratio(num: number, den: number): number {
  return den === 0 ? 0 : round4(num / den);
}

/** Deterministic codepoint id ordering (no locale/ICU variance). */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface FactsReport {
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
  /**
   * Search-scope cases, scored on their OWN terms and excluded from the headline
   * metrics above. Facts SHOULD stay silent on these (they are search's job), so
   * `facts_silent` is the correct-behavior count and `facts_resolved` lists any
   * case where the by-name path fabricated an answer (a real regression to watch).
   */
  search_scope: {
    total: number;
    facts_silent: number;
    facts_resolved: Array<{ id: string; query: string; got: string }>;
  };
}

/**
 * Score lookupFacts over a set of eval cases.
 *
 * Metric formulas (follow the formula, not the name):
 *   - hit_recall            = positives with got===expected / total positives
 *   - positive_precision    = of ALL cases where got!==null, fraction got===expected
 *   - hard_negative_fp_rate = of ALL negatives (expected===null), fraction got!==null
 */
export function scoreFacts(cases: EvalCase[] = EVAL_CASES): FactsReport {
  let positives = 0;
  let negatives = 0;

  // hit_recall
  let positiveHits = 0;
  // positive_precision (over got !== null)
  let predicted = 0; // got !== null
  let predictedCorrect = 0; // got !== null && got === expected
  // hard_negative_fp_rate (over expected === null)
  let negativeFalsePositives = 0; // expected === null && got !== null

  const byKind: Record<string, { total: number; correct: number }> = {};
  const falsePositives: FactsReport['false_positives'] = [];
  const misses: FactsReport['misses'] = [];

  // search-scope tally (kept OUT of the headline metrics).
  let searchScopeTotal = 0;
  let searchScopeSilent = 0;
  const searchScopeResolved: FactsReport['search_scope']['facts_resolved'] = [];

  for (const c of cases) {
    // One lookup per case; reuse for every output below.
    const got = lookupFacts(c.query)?.package ?? null;
    const correct = got === c.expected;

    // by_kind: uniform reading — correct == (got === expected), both polarities.
    // For search-scope, expected===null so "correct" == "facts stayed silent".
    const bucket = byKind[c.kind] ?? (byKind[c.kind] = { total: 0, correct: 0 });
    bucket.total += 1;
    if (correct) bucket.correct += 1;

    // Search-scope is scored in its own bucket and EXCLUDED from the by-name
    // contract's headline metrics (recall/precision/fp): resolving a NL/fuzzy
    // query would be fabrication, so silence is correct and not a "miss".
    if (c.kind === SEARCH_SCOPE_KIND) {
      searchScopeTotal += 1;
      if (got === null) searchScopeSilent += 1;
      else searchScopeResolved.push({ id: c.id, query: c.query, got });
      continue;
    }

    if (got !== null) {
      predicted += 1;
      if (correct) predictedCorrect += 1;
    }

    if (isPositive(c)) {
      positives += 1;
      if (correct) positiveHits += 1;
      // A miss is a positive the matcher got wrong (wrong package OR a null).
      if (!correct) {
        misses.push({ id: c.id, query: c.query, expected: c.expected as string, got });
      }
    } else {
      negatives += 1;
      // A false positive is a negative the matcher wrongly matched.
      if (got !== null) {
        negativeFalsePositives += 1;
        falsePositives.push({ id: c.id, query: c.query, expected: null, got });
      }
    }
  }

  falsePositives.sort(byId);
  misses.sort(byId);
  searchScopeResolved.sort(byId);

  // Rebuild by_kind with sorted keys so object key order is input-independent.
  const sortedByKind: Record<string, { total: number; correct: number }> = {};
  for (const kind of Object.keys(byKind).sort()) {
    sortedByKind[kind] = byKind[kind];
  }

  return {
    metrics: {
      hit_recall: ratio(positiveHits, positives),
      positive_precision: ratio(predictedCorrect, predicted),
      hard_negative_fp_rate: ratio(negativeFalsePositives, negatives),
    },
    counts: {
      total: cases.length,
      positives,
      negatives,
      by_kind: sortedByKind,
    },
    false_positives: falsePositives,
    misses,
    search_scope: {
      total: searchScopeTotal,
      facts_silent: searchScopeSilent,
      facts_resolved: searchScopeResolved,
    },
  };
}
