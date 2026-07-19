import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for the `starlog corpus add` -> `starlog search` private-first
 * discovery round-trip, exercised through the REAL built binary (dist/cli.js).
 *
 * These spawn `node dist/cli.js ...` via node:child_process so they cover the whole
 * shipped path: commander argv parsing, loadPrivateCorpus() reading
 * STARLOG_PRIVATE_CORPUS off the real process env, the corpus add file write, the
 * keyword search engine, the relevance guard, and the table/JSON formatters — the
 * layers the unit tests (private-corpus.test.ts, search engine tests) never reach
 * because they never run cli.ts, never read argv, and never observe a real exit.
 *
 * HARNESS + HERMETICITY
 * - dist/ is assumed pre-built (the assignment guarantees it); we never `npm run build`.
 * - Two spawn helpers mirror facts-cli.e2e.test.ts's runFacts vs runRawFacts split:
 *     runCli()    — execFileSync, stdout-only, for the common exit-0 stdout assertions.
 *     runRawCli() — spawnSync, captures BOTH streams, for SUCCESS-exit runs where the
 *                   thing under test is on STDERR (search writes its "No strong match" /
 *                   "Closest by keyword:" guidance to stderr while exiting 0, so
 *                   execFileSync cannot see it).
 * - ENV HYGIENE (verbatim mirror): start from {...process.env}, then DELETE
 *     STARLOG_PRIVATE_FACTS, STARLOG_API_KEY, STARLOG_POLICY, STARLOG_PRIVATE_CORPUS
 *   so a value inherited from the dev/CI shell can never leak an overlay into a
 *   baseline run; set STARLOG_NO_NUDGE=1 + STARLOG_TELEMETRY=0 so the self-heal nudge
 *   and an offline PostHog fetch can never inject lines or hang. Per-test env LAST.
 * - NO NETWORK: never set STARLOG_API_KEY; never use search --context. Local keyword
 *   search only. --diversity 1.0 pins pure score-desc ordering so a "#1 is the private
 *   entry" assertion is deterministic.
 * - NO REPO POLLUTION: every corpus add / default-path test runs from a TEMP cwd
 *   (mkdtempSync) with an ABSOLUTE cli path, so the relative `.starlog/` it writes
 *   lands under the temp dir. Temp dirs are removed in afterEach.
 *
 * INVARIANTS we assert are structural markers the scenarios call out (the "Added <pkg>
 * to <path> (discovery)." line, the env-hint vs default-path branch text, the cross-ref
 * "Tip:" line, the private entry winning rank #1 under --diversity 1.0, score >= 70 for
 * a strong match, the "No strong match" / "Closest by keyword:" hedges on stderr, file
 * shape on disk). We do NOT pin volatile values (exact 76.86 score, which public lib is
 * #2) — those drift on corpus regen.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Hermetic base env: real env minus every overlay/key, telemetry off, nudge off. */
function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.STARLOG_PRIVATE_FACTS;
  delete env.STARLOG_API_KEY;
  delete env.STARLOG_POLICY;
  delete env.STARLOG_PRIVATE_CORPUS;
  env.STARLOG_NO_NUDGE = '1';
  env.STARLOG_TELEMETRY = '0';
  return env;
}

/**
 * Spawn `node <ABS cli> --no-telemetry <args>` from `cwd` via execFileSync. Returns a
 * normalized RunResult for both zero and non-zero exits (execFileSync throws on
 * non-zero; we recover status/stdout/stderr so a failing exit is assertable). stderr is
 * only populated on a NON-zero exit here — for success-path stderr use runRawCli.
 */
function runCli(cwd: string, args: string[], env?: Record<string, string>): RunResult {
  const childEnv = baseEnv();
  Object.assign(childEnv, env ?? {});
  try {
    const stdout = execFileSync('node', [CLI, '--no-telemetry', ...args], {
      cwd,
      encoding: 'utf8',
      env: childEnv,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

/**
 * spawnSync variant that captures BOTH stdout and stderr regardless of exit code —
 * required because `search` exits 0 but writes its honesty hedges ("No strong match
 * in the local index", "Closest by keyword:") to STDERR, which execFileSync drops.
 */
function runRawCli(cwd: string, args: string[], env?: Record<string, string>): RunResult {
  const childEnv = baseEnv();
  Object.assign(childEnv, env ?? {});
  const r = spawnSync('node', [CLI, '--no-telemetry', ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Parse search --format json stdout into an array of result rows. On a no-strong-match
 * the binary emits EMPTY stdout (guidance is on stderr), so empty/whitespace stdout
 * means "no results" — treat it as [] rather than throwing on JSON.parse('').
 */
function parseResults(stdout: string): Array<{ manifest?: { id?: string }; relevance_score?: number }> {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : (parsed.results ?? []);
}

function hasId(results: ReturnType<typeof parseResults>, id: string): boolean {
  return results.some((r) => r.manifest?.id === id);
}

describe('corpus add -> search private-first discovery round-trip (e2e, spawned binary)', () => {
  let dirs: string[] = [];

  function newTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'starlog-corpus-e2e-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  // 1. HEADLINE round-trip: author an internal package, prove `search` surfaces it
  //    private-first (rank #1, strong score) through the real CLI write + read + format.
  it('corpus add -> search round-trip surfaces the internal package private-first through the binary', () => {
    const cwd = newTmpDir();
    const pc = join(cwd, 'pc.json');
    const env = { STARLOG_PRIVATE_CORPUS: pc };

    const add = runCli(cwd, [
      'corpus', 'add', '@acme/flags',
      '--solves', 'feature flags and remote configuration for Acme Node services, gradual rollout, kill switches',
      '--category', 'feature-flags', '--stack', 'node',
      '--best-for', 'feature flags,remote config', '--license', 'MIT', '--name', 'Acme Flags',
    ], env);
    expect(add.status).toBe(0);
    // The custom-path (env-set) branch: confirms write target + the "Try it:" hint.
    expect(add.stdout).toContain('Added @acme/flags to ');
    expect(add.stdout).toContain(`${pc} (discovery)`);
    expect(add.stdout).toContain(`Try it: STARLOG_PRIVATE_CORPUS=${pc} starlog search`);

    // File written and parses with the manifest shape the scenario calls out.
    expect(existsSync(pc)).toBe(true);
    const written = JSON.parse(readFileSync(pc, 'utf8'));
    expect(Array.isArray(written.manifests)).toBe(true);
    expect(written.manifests[0].id).toBe('@acme/flags');
    expect(written.manifests[0].category).toBe('feature-flags');
    expect(written.manifests[0].ecosystem).toBe('npm');
    // Defaulted health/quality blocks exist (corpus add fills them in).
    expect(written.manifests[0].health).toBeTypeOf('object');
    expect(written.manifests[0].quality).toBeTypeOf('object');

    // search --format json: the private entry wins rank #1 (deterministic at
    // --diversity 1.0 = pure score-desc). We assert the private-first WIN + a strong
    // score (>=70), NOT the exact 76.86 nor which public lib lands at #2 (those drift).
    const sj = runRawCli(cwd, ['search', 'feature flags for a node app', '--format', 'json', '--diversity', '1.0'], env);
    expect(sj.status).toBe(0);
    expect(sj.stderr).toBe(''); // strong match -> no hedge, no unreadable-corpus warning
    const results = parseResults(sj.stdout);
    expect(results[0].manifest?.id).toBe('@acme/flags');
    expect(results[0].relevance_score).toBeGreaterThanOrEqual(70);

    // search table: first data row (rank '1') names the internal entry above public SDKs.
    const st = runRawCli(cwd, ['search', 'feature flags for a node app', '--diversity', '1.0'], env);
    expect(st.status).toBe(0);
    const firstDataRow = st.stdout.split('\n').find((l) => /^1\s/.test(l));
    expect(firstDataRow).toBeDefined();
    expect(firstDataRow).toContain('Acme Flags');
  });

  // 2. Default-path branch: `corpus add` with env UNSET writes ./.starlog/, and a BARE
  //    `search` from the project now AUTO-READS it (walking up from cwd) — matching the
  //    agent, with no STARLOG_PRIVATE_CORPUS export needed (issue #59).
  it('Default-path corpus add IS auto-discoverable to a bare `search` from the project (issue #59)', () => {
    const cwd = newTmpDir();

    // No STARLOG_PRIVATE_CORPUS -> the default-path branch.
    const add = runCli(cwd, [
      'corpus', 'add', '@acme/flags',
      '--solves', 'feature flags remote config node gradual rollout kill switches',
      '--category', 'feature-flags', '--stack', 'node', '--best-for', 'feature flags,remote config',
    ]);
    expect(add.status).toBe(0);
    // Default-path branch text advertises auto-discovery — no shell export needed.
    expect(add.stdout).toContain("Your coding agent's search surfaces this automatically, per-project, after `starlog init`");
    expect(add.stdout).toContain('Try it from this project: starlog search');

    const defaultPath = join(cwd, '.starlog', 'private-corpus.json');
    expect(existsSync(defaultPath)).toBe(true);

    // BARE search (env unset): the CLI now auto-reads ./.starlog/, so the internal
    // package is present — and #1 under pure score ordering.
    const bare = runRawCli(cwd, ['search', 'feature flags for node', '--format', 'json', '--diversity', '1.0']);
    expect(bare.status).toBe(0);
    const bareResults = parseResults(bare.stdout);
    expect(bareResults[0].manifest?.id).toBe('@acme/flags');
    expect(bareResults[0].relevance_score).toBeGreaterThanOrEqual(70);

    // Auto-discovery also works from a NESTED subdirectory (walks up to the project root).
    const nested = join(cwd, 'packages', 'web');
    mkdirSync(nested, { recursive: true });
    const fromNested = runRawCli(nested, ['search', 'feature flags for node', '--format', 'json', '--diversity', '1.0']);
    expect(fromNested.status).toBe(0);
    expect(hasId(parseResults(fromNested.stdout), '@acme/flags')).toBe(true);
  });

  // 3. Monorepo tenant isolation: each project dir's relative .starlog/ overlay is
  //    private to that dir; a search inside service-a must never surface service-b's
  //    internal package (or vice versa). Regression guard for per-project isolation.
  it("Monorepo per-project overlays: each project dir's .starlog isolates discovery", () => {
    const root = newTmpDir();
    const svcA = join(root, 'svc-a');
    const svcB = join(root, 'svc-b');
    mkdirSync(svcA, { recursive: true });
    mkdirSync(svcB, { recursive: true });

    expect(runCli(svcA, [
      'corpus', 'add', '@acme/flags',
      '--solves', 'feature flags and remote config for node services',
      '--category', 'feature-flags', '--stack', 'node',
    ]).status).toBe(0);
    expect(runCli(svcB, [
      'corpus', 'add', '@acme/billing',
      '--solves', 'usage based billing and metering for node apps',
      '--category', 'other', '--stack', 'node',
    ]).status).toBe(0);

    // Two distinct files; each contains ONLY its own package.
    const aManifest = JSON.parse(readFileSync(join(svcA, '.starlog', 'private-corpus.json'), 'utf8'));
    const bManifest = JSON.parse(readFileSync(join(svcB, '.starlog', 'private-corpus.json'), 'utf8'));
    expect(aManifest.manifests.map((m: { id: string }) => m.id)).toEqual(['@acme/flags']);
    expect(bManifest.manifests.map((m: { id: string }) => m.id)).toEqual(['@acme/billing']);

    const envRel = { STARLOG_PRIVATE_CORPUS: '.starlog/private-corpus.json' };

    // svc-a searching for billing must NOT leak svc-b's @acme/billing (empty stdout =
    // no strong match = absent; the helper treats empty as []).
    const aSearchBilling = runRawCli(svcA, ['search', 'billing and metering', '--format', 'json', '--diversity', '1.0'], envRel);
    expect(aSearchBilling.status).toBe(0);
    expect(hasId(parseResults(aSearchBilling.stdout), '@acme/billing')).toBe(false);

    // svc-b DOES surface its own billing package, and never svc-a's @acme/flags.
    const bSearchBilling = runRawCli(svcB, ['search', 'usage based billing and metering for node apps', '--format', 'json', '--diversity', '1.0'], envRel);
    expect(bSearchBilling.status).toBe(0);
    const bResults = parseResults(bSearchBilling.stdout);
    expect(hasId(bResults, '@acme/billing')).toBe(true);
    expect(hasId(bResults, '@acme/flags')).toBe(false);
  });

  // 4. Discover->vet loop for ONE package: the SAME @acme/flags authored into the
  //    discovery overlay (corpus add) AND the facts overlay (facts add). Proves the two
  //    overlays are independent files that don't clobber each other, and the package
  //    round-trips through BOTH surfaces (search finds it, facts vets it).
  it('Same internal package authored into BOTH overlays: discoverable via search AND vettable via facts', () => {
    const cwd = newTmpDir();
    const pc = join(cwd, 'pc.json');
    const pf = join(cwd, 'pf.json');
    const both = { STARLOG_PRIVATE_CORPUS: pc, STARLOG_PRIVATE_FACTS: pf };

    const add = runCli(cwd, [
      'corpus', 'add', '@acme/flags',
      '--solves', 'feature flags and remote config for node services gradual rollout kill switches',
      '--category', 'feature-flags', '--stack', 'node', '--best-for', 'feature flags,remote config',
    ], both);
    expect(add.status).toBe(0);
    // The cross-reference tip is the product's own guidance steering author corpus->facts.
    expect(add.stdout).toContain('Tip: also vet it — starlog facts add @acme/flags');

    expect(runCli(cwd, ['facts', 'add', '@acme/flags', '--license', 'MIT', '--status', 'active'], both).status).toBe(0);

    // Two SEPARATE files: corpus add wrote only pc.json (manifests), facts add only
    // pf.json (l1/l2). Neither clobbered the other.
    const corpusFile = JSON.parse(readFileSync(pc, 'utf8'));
    const factsFile = JSON.parse(readFileSync(pf, 'utf8'));
    expect(corpusFile.manifests[0].id).toBe('@acme/flags');
    expect(corpusFile.l2).toBeUndefined();
    expect(factsFile.l2[0].package).toBe('@acme/flags');
    expect(factsFile.manifests).toBeUndefined();

    // search surfaces it private-first.
    const sj = runRawCli(cwd, ['search', 'feature flags for node', '--format', 'json', '--diversity', '1.0'], both);
    expect(sj.status).toBe(0);
    expect(parseResults(sj.stdout)[0].manifest?.id).toBe('@acme/flags');

    // facts vets it: layered L2 overlay returned (license MIT, maintenance active) —
    // NOT the "No facts on file" / null miss.
    const facts = runCli(cwd, ['facts', '@acme/flags', '--format', 'json'], both);
    expect(facts.status).toBe(0);
    const fj = JSON.parse(facts.stdout);
    expect(fj).not.toBeNull();
    expect(fj.package).toBe('@acme/flags');
    expect(fj.l2.license).toBe('MIT');
    expect(fj.l2.maintenance).toBe('active');
  });

  // 5. Honesty rails: an off-topic query must NOT float an internal package to #1, and
  //    the "No strong match" guidance fires on stderr; a lone weak hit gets the
  //    "Closest by keyword:" hedge. stdout/stderr stay cleanly separated for json.
  it('Relevance guard: an off-topic internal package does NOT hijack search #1, and a lone weak hit is flagged', () => {
    const cwd = newTmpDir();
    const pc = join(cwd, 'pc.json');
    const env = { STARLOG_PRIVATE_CORPUS: pc };

    // A niche off-topic internal entry + a real on-topic one.
    expect(runCli(cwd, [
      'corpus', 'add', '@acme/widgetizer',
      '--solves', 'internal widget rendering toolkit for acme dashboards',
      '--category', 'other', '--stack', 'node',
    ], env).status).toBe(0);
    expect(runCli(cwd, [
      'corpus', 'add', '@acme/flags',
      '--solves', 'feature flags and remote config for node services',
      '--category', 'feature-flags', '--stack', 'node',
    ], env).status).toBe(0);

    // OFF-TOPIC table query: the relevance guard (<70) holds — no @acme entry at #1.
    // stdout has no rows (empty), the "No strong match" guidance + category list is on
    // stderr, exit 0.
    const offTable = runRawCli(cwd, ['search', 'image resizing library', '--diversity', '1.0'], env);
    expect(offTable.status).toBe(0);
    expect(offTable.stderr).toContain('No strong match in the local index');
    expect(offTable.stderr).toContain('authentication, feature-flags, caching, realtime, background-jobs, email, orm-database');
    expect(offTable.stdout).not.toContain('@acme/widgetizer');
    expect(offTable.stdout).not.toContain('@acme/flags');

    // NICHE-ONLY query ("widgetizer"): only the niche entry matches, weakly (<70) — the
    // single-low-score hedge fires on stderr while the closest row still prints to stdout.
    const niche = runRawCli(cwd, ['search', 'widgetizer', '--diversity', '1.0'], env);
    expect(niche.status).toBe(0);
    expect(niche.stderr).toContain('No strong match in the local index');
    expect(niche.stderr).toContain('Closest by keyword:');
    expect(niche.stdout).toContain('@acme/widgetizer');

    // OFF-TOPIC --format json: hedging text stays on stderr; stdout never carries a
    // spurious private #1.
    //
    // SUSPECTED BUG (reported, not enshrined as correct): on a no-strong-match,
    // `search --format json` emits EMPTY stdout instead of a valid `[]`. A jq/JSON.parse
    // consumer that expects an array on exit 0 breaks. We assert ONLY fix-compatible
    // invariants here (exit 0 + guidance on stderr + no spurious private #1) — NOT the
    // empty-stdout body, which is the jq-pipeline bug pinned by the it.fails living
    // marker in search-cli.e2e.test.ts. This keeps the suite green whether json
    // no-match emits empty stdout (today) or a proper `[]` (after a fix).
    const offJson = runRawCli(cwd, ['search', 'image resizing library', '--format', 'json', '--diversity', '1.0'], env);
    expect(offJson.status).toBe(0);
    expect(offJson.stderr).toContain('No strong match in the local index');
    // Whatever stdout is, it carries no spurious private #1 (parseResults treats empty as []).
    expect(hasId(parseResults(offJson.stdout), '@acme/widgetizer')).toBe(false);
  });
});
