import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for `starlog doctor` across un-wired / corrupt / half-migrated
 * install states, exercised through the REAL built binary (dist/cli.js) spawned via
 * node:child_process. These cover the layer the unit suites can't reach: checkHook,
 * checkMcp, the readJson absent-vs-invalid distinction, the summary line, and the
 * process exit code — none of which have vitest coverage today (only scripts/smoke-test.sh).
 *
 * HARNESS + HERMETICITY
 * ---------------------
 * - We spawn `node <ABSOLUTE dist/cli.js> doctor` from a fresh TEMP cwd (mkdtempSync)
 *   with HOME overridden to a TEMP dir. doctor's HOME-sensitive checks (MCP wiring,
 *   the PostToolUse hook) then read ONLY our synthetic ~/.claude/settings.json and
 *   ~/.claude/hooks, never the developer's real home; and its cwd-sensitive checks
 *   (Project agents, Private overlays) read a bare temp dir, never the repo tree.
 * - doctor runs fully offline: it only stats local files, runs `node --check` on the
 *   hook script, and loads the bundled corpus. No network, so telemetry is forced OFF
 *   (STARLOG_TELEMETRY='0' + DO_NOT_TRACK='1' + CI='1') to avoid a hanging PostHog
 *   fetch and to keep the doctor footer out of the asserted stdout.
 * - doctor exits 0 on a pass-with-warnings state and 1 when it finds a problem, so we
 *   use spawnSync (captures stdout/stderr/status on BOTH exit paths) rather than
 *   execFileSync (which throws on non-zero and hides stdout).
 *
 * ASSERTION DISCIPLINE
 * --------------------
 * We assert only the structural markers the scenarios name — '[ok] Corpus —',
 * '[!]' wiring lines, the '[x]' problem lines, the '[x]  settings.json — invalid JSON ('
 * marker, and the summary PHRASES ('All critical checks passed' / 'Found 1 problem') —
 * and the exit code. We deliberately do NOT assert the volatile warning COUNT (it shifts
 * 3↔4 depending on whether Project agents is detected in the cwd) nor the Project-agents
 * line itself (cwd-fragile, named by no scenario). All markers use the literal em-dash
 * (U+2014) copied from the binary's real output.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node dist/cli.js doctor` from `cwd` with HOME=`home`. Returns stdout/stderr/
 * status for both exit-0 and exit-1 runs (doctor uses both). Env hygiene mirrors
 * facts-cli.e2e.test.ts: start from the real env, DROP the overlay/key/policy/corpus
 * vars so an inherited shell value can't leak into a state we're asserting, force
 * telemetry OFF, suppress the init nudge — then apply HOME last.
 */
function runDoctor(cwd: string, home: string): RunResult {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.STARLOG_PRIVATE_FACTS;
  delete env.STARLOG_API_KEY;
  delete env.STARLOG_POLICY;
  delete env.STARLOG_PRIVATE_CORPUS;
  env.STARLOG_NO_NUDGE = '1';
  // Hermetic + no-network: any one of these disables the PostHog telemetry fetch;
  // we set all three so an offline run can never hang on a ~1500ms socket timeout.
  env.STARLOG_TELEMETRY = '0';
  env.DO_NOT_TRACK = '1';
  env.CI = '1';
  env.HOME = home; // applied LAST so it wins over the inherited value
  const r = spawnSync('node', [CLI, 'doctor'], { cwd, encoding: 'utf8', env });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('starlog doctor — install-state diagnostics (e2e, spawned binary)', () => {
  let home: string | null = null;
  let cwd: string | null = null;

  /** Fresh temp HOME + temp cwd for one doctor run. */
  function freshDirs(): { home: string; cwd: string } {
    home = mkdtempSync(join(tmpdir(), 'starlog-doctor-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'starlog-doctor-cwd-'));
    return { home, cwd };
  }

  /** Write $HOME/.claude/settings.json with the given raw string (or object). */
  function writeSettings(home: string, raw: string | object): void {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const body = typeof raw === 'string' ? raw : JSON.stringify(raw);
    writeFileSync(join(claudeDir, 'settings.json'), body, 'utf8');
  }

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    home = null;
    cwd = null;
  });

  // 1. FRESH MACHINE — "did the install actually do anything?"
  // Pre-init: no ~/.claude/settings.json, no .starlog/. The corpus loads with zero
  // config; MCP + hook report NOT configured and point at `starlog init`. Un-wired is
  // a WARN state, so the run passes (exit 0) with the "All critical checks passed" phrase.
  it('on a fresh, un-init\'d machine reports corpus loaded but agent wiring not configured, and passes with warnings', () => {
    const { home, cwd } = freshDirs();
    // No settings.json written at all — the genuine post-npx state.
    const { status, stdout } = runDoctor(cwd, home);

    expect(status).toBe(0); // un-wired is a warn, not a hard failure
    // Bundled corpus loads with no config (count asserted only as a digit, not its value).
    expect(stdout).toMatch(/\[ok\] Corpus — \d+ manifests loaded/);
    // The two un-wired pieces are flagged as warnings ([!]) that point at init.
    expect(stdout).toContain('[!]  Claude Code MCP — not configured — run `starlog init`');
    expect(stdout).toContain('[!]  PostToolUse hook — not installed — run `starlog init`');
    // Summary PHRASE (not the warning count, which drifts with cwd-detected agents).
    expect(stdout).toContain('All critical checks passed');
  });

  // 2. HALF-MIGRATED — hook file vs registration drift (two states, one scenario).
  //    State A (orphaned registration): a PostToolUse hook entry naming
  //    starlog-pkg-check.js is in settings.json, but the script file does not exist →
  //    a PROBLEM ([x]), exit 1.
  //    State B (unregistered script): the script file exists and is valid JS, but the
  //    settings PostToolUse array is empty → the script is [ok] yet registration is a
  //    WARNING ([!]); the run still passes (exit 0).
  it('truthfully separates orphaned-registration (problem) from unregistered-script (warning)', () => {
    // ---- State A: registered in settings, script file missing ----
    {
      const { home, cwd } = freshDirs();
      writeSettings(home, {
        mcpServers: {},
        hooks: {
          PostToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'node /missing/path/starlog-pkg-check.js' }] },
          ],
        },
      });
      const { status, stdout } = runDoctor(cwd, home);

      // doctor must name the orphaned registration as a PROBLEM and fail.
      expect(stdout).toContain('[x]  PostToolUse hook — registered in settings but script file is missing');
      expect(stdout).toContain('Found 1 problem'); // phrase only; warning count omitted
      expect(status).toBe(1);
    }

    // ---- State B: script present + valid, but NOT registered ----
    {
      const { home, cwd } = freshDirs();
      const hooksDir = join(home, '.claude', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      // Any syntactically valid JS — doctor runs `node --check` on it locally.
      writeFileSync(join(hooksDir, 'starlog-pkg-check.js'), 'process.exit(0)\n', 'utf8');
      writeSettings(home, { mcpServers: {}, hooks: { PostToolUse: [] } });
      const { status, stdout } = runDoctor(cwd, home);

      // The script itself is fine ([ok]) but the missing registration is a WARNING ([!]).
      expect(stdout).toContain('[ok] PostToolUse hook — script present and valid');
      expect(stdout).toContain('[!]  Hook registration — script exists but not registered in settings.json');
      // Warning-only state: the overall run still passes.
      expect(stdout).toContain('All critical checks passed');
      expect(status).toBe(0);
    }
  });

  // 2b. RANKING TIER — keyword (default) points to the hosted upgrade; a wired
  //     STARLOG_API_KEY in the MCP env flips the report to the hosted tier and
  //     drops the upgrade nudge. Both are OK states (exit 0).
  it('reports the keyword tier with a hosted-upgrade pointer, and the hosted tier when a key is wired', () => {
    const mcpServer = (env: Record<string, string>) => ({
      mcpServers: { starlog: { command: 'node', args: ['/x/dist/mcp.js'], env } },
    });

    // ---- Keyword (no key wired): self-serve pointer to starlog.dev ----
    // (Exit code is driven by the bogus MCP path, not ranking — ranking prints
    // on every run regardless, so this scenario asserts only the ranking line.)
    {
      const { home, cwd } = freshDirs();
      writeSettings(home, mcpServer({}));
      const { stdout } = runDoctor(cwd, home);
      expect(stdout).toContain('keyword ranking');
      expect(stdout).toContain('https://starlog.dev');
    }

    // ---- Hosted (key wired into the MCP env): no upgrade nudge ----
    {
      const { home, cwd } = freshDirs();
      writeSettings(home, mcpServer({ STARLOG_API_KEY: 'sk-org-abc123' }));
      const { stdout } = runDoctor(cwd, home);
      expect(stdout).toContain('hosted ranking');
      expect(stdout).not.toContain('get a key at https://starlog.dev');
    }
  });

  // 2c. HOOK SHIM — a shim hook (loads dist/hook-runner.js) reports "Hook logic"
  //     resolving against the built runner, proving upgrades refresh behaviour
  //     without a re-init. The runner ships in dist/, so it resolves.
  it('reports Hook logic resolving when the installed hook is the runtime-shim form', () => {
    const { home, cwd } = freshDirs();
    const hooksDir = join(home, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Minimal valid-JS stand-in carrying the shim marker doctor keys on.
    writeFileSync(join(hooksDir, 'starlog-pkg-check.js'), '// loads dist/hook-runner.js\nprocess.exit(0)\n', 'utf8');
    writeSettings(home, {
      mcpServers: {},
      hooks: { PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node ' + join(hooksDir, 'starlog-pkg-check.js') }] }] },
    });
    const { stdout } = runDoctor(cwd, home);
    expect(stdout).toContain('Hook logic');
    expect(stdout).toContain('resolves');
  });

  // 3. CORRUPT settings.json — flagged as invalid, NOT mistaken for "not configured".
  // Malformed bytes ('{ broken json ') must surface a '[x]  settings.json — invalid JSON ('
  // problem with 'fix or remove' + 'starlog init' guidance, exit 1. Crucially, doctor
  // degrades gracefully: the corpus check still reports loaded manifests rather than
  // crashing on the parse error.
  it('flags a corrupt settings.json as invalid JSON (not "unconfigured"), keeps running other checks, exits 1', () => {
    const { home, cwd } = freshDirs();
    // Literal malformed bytes — an interrupted atomic write / bad hand-merge.
    writeSettings(home, '{ broken json ');
    const { status, stdout } = runDoctor(cwd, home);

    // The invalid-JSON marker (stable prefix; the parser's exact error text is
    // engine-version specific, so we match only the leading substring).
    expect(stdout).toContain('[x]  settings.json — invalid JSON (');
    expect(stdout).toContain('fix or remove');
    expect(stdout).toContain('starlog init');
    // Graceful degradation: the corpus check still ran and reported loaded manifests.
    expect(stdout).toMatch(/\[ok\] Corpus — \d+ manifests loaded/);
    // A corrupt config is a problem, not a pass-with-warnings.
    expect(stdout).toContain('Found 1 problem');
    expect(status).toBe(1);
  });
});
