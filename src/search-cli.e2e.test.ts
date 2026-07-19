import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for the `starlog search` CLI command (local keyword search).
 *
 * These SPAWN the REAL built binary (dist/cli.js) and exercise the whole shipped
 * path: commander parsing of `search`, runSearch() running the LOCAL keyword
 * engine (never hosted — no STARLOG_API_KEY is ever set), the private-corpus
 * overlay loader, formatTable/formatJSON, the no-match / lone-weak-hit honesty
 * branches, and the real process exit code.
 *
 * HARNESS / WHY spawnSync (not execFileSync like facts-cli.e2e.test.ts):
 *   `search` writes its load-bearing markers to STDERR on an exit-0 (success)
 *   run — the no-match guidance ("No strong match in the local index…"), the
 *   lone-weak-hit hedge ("Closest by keyword:"), and the corrupt-overlay warning
 *   ("[starlog] private corpus file unreadable"). execFileSync only surfaces
 *   stderr on a NON-zero exit, so it would go blind on every one of those. We use
 *   spawnSync, which captures stdout AND stderr regardless of exit code.
 *
 * HERMETICITY (mirrors facts-cli.e2e.test.ts env hygiene):
 *   - start from {...process.env}, then DELETE STARLOG_PRIVATE_FACTS,
 *     STARLOG_API_KEY, STARLOG_POLICY and STARLOG_PRIVATE_CORPUS so nothing
 *     inherited from the dev/CI shell leaks a hosted mode or an overlay into the
 *     public-corpus baseline. (No API key ⇒ runSearch stays purely local/offline.)
 *   - STARLOG_NO_NUDGE=1 + STARLOG_TELEMETRY=0 keep stderr deterministic and stop
 *     the offline PostHog fetch from hanging ~1500ms. We also pass --no-telemetry
 *     as belt-and-suspenders. Explicit per-test env is applied LAST.
 *   - Adversarial overlay files live under a TEMP dir, cleaned in afterEach.
 *
 * dist/ is assumed pre-built (the assignment guarantees it). We do NOT build.
 */

// Repo root, derived from this file's location (src/ → ..) so the spawn cwd works
// on any machine/CI — not a hardcoded path.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node dist/cli.js search <args>` and capture BOTH streams + exit code,
 * regardless of exit status (search's markers land on stderr on exit 0).
 *
 * Env is a controlled derivation of the real environment with the secret/overlay
 * vars stripped, so a profile STARLOG_API_KEY can never flip the run into hosted
 * mode. `cwd` defaults to a caller-chosen temp dir; `env` overrides apply last.
 */
function runSearch(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): RunResult {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.STARLOG_PRIVATE_FACTS;
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_POLICY;
  delete childEnv.STARLOG_PRIVATE_CORPUS;
  childEnv.STARLOG_NO_NUDGE = '1';
  childEnv.STARLOG_TELEMETRY = '0';
  Object.assign(childEnv, opts?.env ?? {});

  const r = spawnSync('node', [CLI, '--no-telemetry', 'search', ...args], {
    cwd: opts?.cwd ?? REPO,
    encoding: 'utf8',
    env: childEnv,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('starlog search CLI (e2e, spawned binary) — local keyword search', () => {
  let tmpDir: string | null = null;

  function newTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-search-e2e-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // 1. FIRST MISS — an off-domain query before any setup is an honest non-result,
  //    not a crash. exit 0, helpful guidance on stderr, empty stdout (no rows).
  it("an off-domain first search returns an honest 'No strong match' on stderr (exit 0, not an error)", () => {
    const dir = newTmpDir();
    // "graphql" is empirically off-domain for the local JS/TS capability corpus.
    const { status, stdout, stderr } = runSearch(['graphql'], { cwd: dir });

    expect(status).toBe(0); // a miss is an honest answer, NOT an error
    // The literal guidance prefix the agent/dev reads instead of an error.
    expect(stderr).toContain('No strong match in the local index. Discovery covers these JS/TS capabilities:');
    // Assert a couple of the covered categories (substrings, so the test survives
    // future category additions) rather than pinning the whole frozen list.
    expect(stderr).toContain('authentication');
    expect(stderr).toContain('orm-database');
    // The facts fallback hint — vet any package by name even with no candidates.
    expect(stderr).toContain('still vets any package by name');
    // No table rows printed on a no-match: stdout is empty.
    expect(stdout.trim()).toBe('');
  });

  // 2. HAPPY PATH — an in-domain query renders a ranked table AND clean JSON.
  //    Assert STRUCTURE (headers, a numbered row, array shape, key presence),
  //    never the exact rank-1 library or the exact score (those drift).
  it('an in-domain search renders a ranked table and machine-readable JSON', () => {
    const dir = newTmpDir();

    // Table mode.
    const table = runSearch(['http client'], { cwd: dir });
    expect(table.status).toBe(0);
    // Column headers on the first line of stdout.
    const firstLine = table.stdout.split('\n')[0];
    expect(firstLine).toContain('Library');
    expect(firstLine).toContain('Category');
    expect(firstLine).toContain('Score');
    expect(firstLine).toContain('Solves');
    // At least one numbered result row (multiline flag: stdout begins with '#').
    expect(table.stdout).toMatch(/^\d+\s/m);
    // This is a HIT, not a miss — the no-match guidance must NOT appear.
    expect(table.stderr).not.toContain('No strong match');

    // JSON mode — the shape the agent actually consumes over the hook.
    const jsonRun = runSearch(['http client', '--format', 'json'], { cwd: dir });
    expect(jsonRun.status).toBe(0);
    const parsed = JSON.parse(jsonRun.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    // Stable per-element shape: id lives UNDER manifest (nested), score is numeric.
    expect(typeof parsed[0].manifest.id).toBe('string');
    expect(typeof parsed[0].relevance_score).toBe('number');
    // Pure JSON — JSON callers are skipped by the nudge, so no notice text mixes in.
    expect(jsonRun.stderr).not.toContain('starlog init');
  });

  // 3. LONE-WEAK-HIT HEDGE — --top-k 1 on a term that only weakly matches one lib
  //    surfaces the "Closest by keyword:" honesty hedge (table-only); JSON stays clean.
  it("--top-k 1 on a weak match surfaces the 'Closest by keyword' hedge (table-only)", () => {
    const dir = newTmpDir();
    // Empirically verified on this build: 'redis --top-k 1' yields exactly ONE
    // result with relevance < 70, tripping the lone-weak-hit branch (cli.ts:156).
    const table = runSearch(['redis', '--top-k', '1'], { cwd: dir });
    expect(table.status).toBe(0);
    // The hedge: still a no-strong-match framing, but the closest row is shown.
    expect(table.stderr).toContain('No strong match in the local index');
    expect(table.stderr).toContain('Closest by keyword:');
    // The closest match IS printed — exactly one numbered row (#1, no #2).
    expect(table.stdout).toMatch(/^1\s/m);
    expect(table.stdout).not.toMatch(/^2\s/m);

    // Same query in JSON mode: the hedge is table-only, so stderr stays clean.
    const jsonRun = runSearch(['redis', '--top-k', '1', '--format', 'json'], { cwd: dir });
    expect(jsonRun.status).toBe(0);
    expect(jsonRun.stderr).not.toContain('Closest by keyword:');
    // JSON is still a parseable array on a hit.
    expect(Array.isArray(JSON.parse(jsonRun.stdout))).toBe(true);
  });

  // 3b. INVALID --top-k — a zero/negative/non-numeric value used to either
  //     silently default (5) or return an empty set framed as a misleading
  //     'No strong match'. It is now rejected loudly (feature audit BUG-3).
  it('rejects a non-positive or non-numeric --top-k with a clear error (exit 1)', () => {
    const dir = newTmpDir();
    for (const bad of ['0', '-3', 'abc']) {
      const r = runSearch(['email sending', '--top-k', bad], { cwd: dir });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Invalid --top-k "${bad}". Use a positive integer`);
      expect(r.stderr).not.toContain('No strong match');
    }
    // A valid value still works.
    const ok = runSearch(['email sending', '--top-k', '2'], { cwd: dir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^1\s/m);
  });

  // 4. --format json on a no-match (jq-pipeline footgun). The no-match branch
  //    console.error()'s the guidance to STDERR and exits BEFORE any console.log,
  //    so stdout is EMPTY — `--format json | jq` crashes on every miss. We assert
  //    ONLY fix-compatible invariants in the normal test (so it survives a fix);
  //    the buggy stdout shape is pinned by the it.fails living marker that follows.
  it('--format json on a no-match exits 0 with stderr guidance; a hit emits a parseable array', () => {
    const dir = newTmpDir();

    // A no-match is not an error, and the guidance goes to STDERR (prose), never
    // stdout. We do NOT assert the no-match stdout body here — that is the subject
    // of the KNOWN-BUG marker below. This stays green whether json no-match emits
    // empty stdout (today) or a proper `[]` (after a fix).
    const garbage = runSearch(['zzqqxx nonexistent capability foobar', '--format', 'json'], { cwd: dir });
    expect(garbage.status).toBe(0);
    expect(garbage.stderr).toContain('No strong match in the local index');

    // A real query forced into a non-matching category — same no-match path.
    const filtered = runSearch(['redis cache', '--category', 'authentication', '--format', 'json'], { cwd: dir });
    expect(filtered.status).toBe(0);
    expect(filtered.stderr).toContain('No strong match in the local index');

    // CONTRAST: a matching query DOES emit a JSON array with the documented shape.
    const ok = runSearch(['http client', '--format', 'json'], { cwd: dir });
    const arr = JSON.parse(ok.stdout);
    expect(Array.isArray(arr)).toBe(true);
    expect(typeof arr[0].manifest.id).toBe('string');
    expect(typeof arr[0].relevance_score).toBe('number');
  });

  // REGRESSION (#20): `search --format json` on a no-match emits a parseable `[]`
  // to stdout (it used to emit EMPTY stdout, which crashed `... --format json | jq`
  // on every miss). The human guidance stays on stderr. This was an `it.fails`
  // living marker until the fix landed; it is now a normal regression test.
  it('--format json emits a parseable [] on a no-match (stdout stays valid JSON)', () => {
    const dir = newTmpDir();
    const miss = runSearch(['zzqqxx nonexistent capability foobar', '--format', 'json'], { cwd: dir });
    const parsed = JSON.parse(miss.stdout); // valid JSON now (was empty stdout pre-fix)
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
    // The guidance is still on stderr, never mixed into the JSON on stdout.
    expect(miss.stderr).toContain('No strong match in the local index');
  });

  // 5. ADVERSARIAL — corrupt/invalid private corpus + empty/whitespace queries all
  //    degrade GRACEFULLY to public, exit 0, no stack trace.
  it('a corrupt/invalid private corpus and empty/whitespace queries degrade to public (exit 0, no crash)', () => {
    const dir = newTmpDir();

    // (a) Corrupt (truncated) private corpus → warn + use public corpus, still rank.
    const corruptPath = join(dir, 'corpus_corrupt.json');
    writeFileSync(corruptPath, '{ "manifests": [ {', 'utf8'); // truncated JSON
    const corrupt = runSearch(['caching for node', '--format', 'table'], {
      cwd: dir,
      env: { STARLOG_PRIVATE_CORPUS: corruptPath },
    });
    expect(corrupt.status).toBe(0);
    expect(corrupt.stderr).toContain('[starlog] private corpus file unreadable');
    expect(corrupt.stderr).toContain('using public corpus only');
    // Search did NOT abort — public results still printed (a header + a numbered row).
    expect(corrupt.stdout).toContain('Library');
    expect(corrupt.stdout).toMatch(/^\d+\s/m);
    expect(corrupt.stderr).not.toContain('at Object.'); // no node stack trace

    // (b) Schema-INVALID manifest entry (well-formed JSON, bad enum) → per-entry
    //     skip warning, search still completes at exit 0.
    const invalidPath = join(dir, 'corpus_invalid.json');
    writeFileSync(
      invalidPath,
      JSON.stringify({ manifests: [{ id: 'x', name: 'X', category: 'NOT_A_CAT', solves: 'stuff' }] }),
      'utf8',
    );
    const invalid = runSearch(['caching for node', '--format', 'table'], {
      cwd: dir,
      env: { STARLOG_PRIVATE_CORPUS: invalidPath },
    });
    expect(invalid.status).toBe(0);
    expect(invalid.stderr).toContain('[starlog] skipping invalid private manifest:');
    expect(invalid.stdout).toMatch(/^\d+\s/m); // public search still completed

    // (c) Empty query → honest no-strong-match guidance, exit 0.
    const empty = runSearch(['', '--format', 'table'], { cwd: dir });
    expect(empty.status).toBe(0);
    expect(empty.stderr).toContain('No strong match in the local index');
    expect(empty.stderr).toContain('authentication');

    // (d) Whitespace-only query (JSON mode) → same graceful no-match, exit 0.
    const ws = runSearch(['   ', '--format', 'json'], { cwd: dir });
    expect(ws.status).toBe(0);
    expect(ws.stderr).toContain('No strong match in the local index');
    expect(ws.stderr).toContain('orm-database');
  });
});
