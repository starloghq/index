import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for the `starlog init` / `starlog doctor` lifecycle through
 * the REAL built binary (dist/cli.js), spawned via node:child_process.
 *
 * Theme: init idempotency, the pre-wiring → re-init migration that closes the
 * install-≠-wired gap, full --all --project uninstall (with .bak backups), and
 * the documented org-API-key migration footgun.
 *
 * HERMETICITY
 * -----------
 * Every test spawns from a TEMP project cwd (mkdtempSync) with an ABSOLUTE cli
 * path, and overrides $HOME to a TEMP dir so os.homedir() resolves there — that
 * is where `~/.claude/settings.json` and `~/.claude/hooks/` are read/written, so
 * the real user's ~/.claude is never touched. No network: telemetry is forced
 * off (STARLOG_TELEMETRY=0) and the self-heal nudge off (STARLOG_NO_NUDGE=1).
 *
 * ENV HYGIENE (mirrors facts-cli.e2e.test.ts verbatim): the child env starts
 * from {...process.env} but DELETES STARLOG_PRIVATE_FACTS / STARLOG_API_KEY /
 * STARLOG_POLICY / STARLOG_PRIVATE_CORPUS so a value inherited from the dev/CI
 * shell can never leak into a baseline run. The STARLOG_API_KEY deletion is also
 * the `env -u STARLOG_API_KEY` the api-key-footgun scenario's hermetic notes
 * REQUIRE — an exported key in the runner's shell would silently re-wire and
 * confound the "plain re-init drops the key" assertion. Explicit per-test env is
 * applied LAST so a test that WANTS a key (step 4 of the footgun) still gets it.
 *
 * dist/ is assumed pre-built (the assignment guarantees it); we never build here.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * General CLI spawn helper. Unlike facts-cli.e2e.test.ts's runFacts (which
 * hardcodes the `facts` subcommand), this takes the FULL arg vector so it can
 * drive init / doctor / init --uninstall. Returns a normalized RunResult for
 * BOTH zero and non-zero exits — execFileSync throws on a non-zero exit and we
 * recover status/stdout/stderr from the thrown error. This matters here because
 * the pre-wiring FIRST doctor legitimately exits 1 (its bogus mcp.js path fails
 * the MCP handshake), yet we still need to assert on its stdout.
 */
function runCli(
  args: string[],
  opts: { proj: string; home: string; env?: Record<string, string> },
): RunResult {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.STARLOG_PRIVATE_FACTS;
  delete childEnv.STARLOG_API_KEY;
  delete childEnv.STARLOG_POLICY;
  delete childEnv.STARLOG_PRIVATE_CORPUS;
  childEnv.STARLOG_TELEMETRY = '0';
  childEnv.STARLOG_NO_NUDGE = '1';
  childEnv.HOME = opts.home;
  Object.assign(childEnv, opts.env ?? {});
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      // Spawn from the TEMP project dir: the CLI resolves Cursor/Copilot/Codex/
      // CLAUDE.md targets from the child's process.cwd(), so an undefined/parent
      // cwd would silently write into the real repo tree.
      cwd: opts.proj,
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

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function readSettings(home: string): any {
  return JSON.parse(readFileSync(settingsPath(home), 'utf8'));
}

describe('starlog init / doctor lifecycle (e2e, spawned binary)', () => {
  // Each test mints its own temp HOME + temp PROJECT; track both so afterEach
  // tears both down (a leaked temp HOME would carry settings.json into the next
  // test). Reassigned per-test via mkTemps().
  let home: string | null = null;
  let proj: string | null = null;

  function mkTemps(): { home: string; proj: string } {
    home = mkdtempSync(join(tmpdir(), 'starlog-init-home-'));
    proj = mkdtempSync(join(tmpdir(), 'starlog-init-proj-'));
    return { home, proj };
  }

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    if (proj) rmSync(proj, { recursive: true, force: true });
    home = null;
    proj = null;
  });

  // ── 1. Idempotency at the process boundary ──────────────────────────────
  it('re-running init --all --project on a fully-wired install is byte-idempotent', () => {
    const { home, proj } = mkTemps();

    const first = runCli(['init', '--all', '--project', '-y'], { home, proj });
    expect(first.status).toBe(0);

    // The four agent files live under the project; settings.json under HOME.
    const agentFiles = [
      settingsPath(home),
      join(proj, '.cursor', 'rules', 'starlog.mdc'),
      join(proj, '.github', 'copilot-instructions.md'),
      join(proj, 'AGENTS.md'),
      join(proj, 'CLAUDE.md'),
    ];
    for (const f of agentFiles) expect(existsSync(f)).toBe(true);
    const before = agentFiles.map(sha);

    const second = runCli(['init', '--all', '--project', '-y'], { home, proj });
    expect(second.status).toBe(0);
    // The "nothing to do" signal, plus every plan line marked already-ok.
    expect(second.stdout).toContain('Everything is already configured. No changes needed.');
    expect(second.stdout).toContain('[= ok]');
    // A second run must not re-create or re-write anything.
    expect(second.stdout).not.toContain('[+ create]');
    expect(second.stdout).not.toContain('[~ update]');

    // The real invariant: byte-for-byte stability of every written file — proves
    // no duplicate mcpServers/hook entries and no rewritten agent sections.
    const after = agentFiles.map(sha);
    expect(after).toEqual(before);
  });

  // ── 2. Pre-wiring install → re-init upgrade (close install-≠-wired gap) ──
  it('pre-wiring install → re-init migrates the MCP entry and doctor confirms wired', () => {
    const { home, proj } = mkTemps();

    // Hand-write an OLD-style starlog MCP entry: NO env block (pre-overlay-wiring).
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(home),
      JSON.stringify({ mcpServers: { starlog: { command: 'node', args: ['/x/dist/mcp.js'] } } }),
      'utf8',
    );

    // First doctor: warns the overlay env is missing. It exits 1 here because the
    // bogus /x/dist/mcp.js path also fails the MCP handshake — so we do NOT pin
    // its exit code, only the overlay warn marker the scenario calls out.
    // (Match ASCII-stable fragments only; the full line carries a U+2019 curly
    // apostrophe in the "wired" variant.)
    const doctor1 = runCli(['doctor'], { home, proj });
    expect(doctor1.stdout).toContain('Private overlays wired');
    expect(doctor1.stdout).toContain('MCP server has no overlay env');
    expect(doctor1.stdout).toContain('re-run');
    expect(doctor1.stdout).toContain('starlog init');

    // Re-init: detects the entry differs and rewrites it.
    const init = runCli(['init', '-y'], { home, proj });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('[~ update] Claude Code · MCP server');

    // The env block now carries all three overlay keys (assert via parsed JSON,
    // never the env-specific dist/mcp.js absolute path).
    const env = readSettings(home).mcpServers.starlog.env;
    expect(env).toHaveProperty('STARLOG_PRIVATE_FACTS');
    expect(env).toHaveProperty('STARLOG_PRIVATE_CORPUS');
    expect(env).toHaveProperty('STARLOG_POLICY');

    // Second doctor: now reports wired and exits clean.
    const doctor2 = runCli(['doctor'], { home, proj });
    expect(doctor2.status).toBe(0);
    expect(doctor2.stdout).toContain('Private overlays wired');
    expect(doctor2.stdout).toContain('agent reads this project'); // ASCII prefix of the "wired" line
  });

  // ── 2b. Legacy Bash-only hook install → re-init adds the edit-tripwire matcher ─
  it('re-init adds the Edit|Write|MultiEdit matcher to a Bash-only install, preserving foreign hooks', () => {
    const { home, proj } = mkTemps();

    // Hand-write a PRE-tripwire install: the starlog shim registered ONLY under
    // the Bash matcher (the old single-hook world), alongside an unrelated
    // user-owned PostToolUse hook that init must never touch.
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    const shimCmd = `node "${join(home, '.claude', 'hooks', 'starlog-pkg-check.js')}"`;
    writeFileSync(
      settingsPath(home),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: shimCmd, timeout: 10 }] },
            { matcher: 'Read', hooks: [{ type: 'command', command: 'node /somewhere/foreign-hook.js' }] },
          ],
        },
      }),
      'utf8',
    );

    const init = runCli(['init', '-y'], { home, proj });
    expect(init.status).toBe(0);

    const settings = readSettings(home);
    const post = settings.hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const pre = (settings.hooks.PreToolUse ?? []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const isStarlog = (e: { hooks?: Array<{ command?: string }> }) =>
      e.hooks?.some((h) => h.command?.includes('starlog-pkg-check.js'));
    const postMatchers = post.filter(isStarlog).map((e) => e.matcher).sort();
    const preMatchers = pre.filter(isStarlog).map((e) => e.matcher).sort();

    // Both PostToolUse matchers now present, exactly once each (no Bash duplicate),
    // AND the new PreToolUse/Bash policy gate was added.
    expect(postMatchers).toEqual(['Bash', 'Edit|Write|MultiEdit']);
    expect(preMatchers).toEqual(['Bash']);
    // The unrelated user hook survived untouched.
    expect(post.some((e) => e.matcher === 'Read' && e.hooks?.some((h) => h.command === 'node /somewhere/foreign-hook.js'))).toBe(true);

    // A second re-init is idempotent for the hook (no duplicate starlog entries).
    const again = runCli(['init', '-y'], { home, proj });
    expect(again.status).toBe(0);
    const after = readSettings(home);
    expect((after.hooks.PostToolUse as any[]).filter(isStarlog).length).toBe(2);
    expect((after.hooks.PreToolUse as any[]).filter(isStarlog).length).toBe(1);
  });

  // ── 3. Uninstall reverses a full --all --project install + backs up markers ─
  it('init --uninstall reverses a full install and backs up edited marker files', () => {
    const { home, proj } = mkTemps();

    const install = runCli(['init', '--all', '--project', '-y'], { home, proj });
    expect(install.status).toBe(0);
    const hookFile = join(home, '.claude', 'hooks', 'starlog-pkg-check.js');
    expect(existsSync(hookFile)).toBe(true);

    const un = runCli(['init', '--uninstall', '-y'], { home, proj });
    expect(un.status).toBe(0);

    // Removal markers for every surface.
    expect(un.stdout).toContain('[x] MCP server removed');
    expect(un.stdout).toContain('[x] Hook removed');
    expect(un.stdout).toContain('[x] CLAUDE.md section removed');
    expect(un.stdout).toContain('[x] Cursor rule removed (.cursor/rules/starlog.mdc)');
    expect(un.stdout).toContain('[x] Copilot instructions removed (.github/copilot-instructions.md)');
    expect(un.stdout).toContain('[x] Codex instructions removed (AGENTS.md)');

    // Backup notices for the prose-carrying marker files.
    expect(un.stdout).toContain('[i] Backed up CLAUDE.md -> CLAUDE.md.bak');
    expect(un.stdout).toContain('[i] Backed up .github/copilot-instructions.md -> .github/copilot-instructions.md.bak');
    expect(un.stdout).toContain('[i] Backed up AGENTS.md -> AGENTS.md.bak');

    // On disk: starlog mcpServers entry gone (parse, don't path-match), hook file
    // gone, and the .bak safety nets exist.
    const settings = readSettings(home);
    expect(settings.mcpServers.starlog).toBeUndefined();
    expect(existsSync(hookFile)).toBe(false);
    expect(existsSync(join(proj, 'CLAUDE.md.bak'))).toBe(true);
    expect(existsSync(join(proj, 'AGENTS.md.bak'))).toBe(true);
    expect(existsSync(join(proj, '.github', 'copilot-instructions.md.bak'))).toBe(true);
  });

  // ── 4. Org-API-key migration footgun (plain re-init drops; env route rescues) ─
  it('plain re-init drops a wired org API key (documented footgun); env-var route restores it', () => {
    const { home, proj } = mkTemps();

    // Step 2 — wire the key via the explicit flag (base env already deletes any
    // inherited STARLOG_API_KEY, satisfying the `env -u` isolation requirement).
    const wire = runCli(['init', '--api-key', 'sk-org-abc123', '-y'], { home, proj });
    expect(wire.status).toBe(0);
    expect(readSettings(home).mcpServers.starlog.env.STARLOG_API_KEY).toBe('sk-org-abc123');
    // A wired key reports the hosted tier and does NOT nag about getting a key.
    expect(wire.stdout).toContain('Ranking mode: hosted');
    expect(wire.stdout).not.toContain('Get a key at https://starlog.dev');

    // Step 3 — plain re-init, no flag, no env var. init recomputes the MCP entry
    // wholesale with no key, so the key is silently DROPPED. This is the
    // documented migration footgun — pinned here as the CURRENT real behavior,
    // not endorsed as desirable. Run it exactly ONCE (a second plain run would be
    // a no-op `[= ok]` and not show the `[~ update]` transition).
    const plain = runCli(['init', '-y'], { home, proj });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('[~ update] Claude Code · MCP server');
    expect(readSettings(home).mcpServers.starlog.env.STARLOG_API_KEY).toBeUndefined();
    // Keyless: default keyword tier, plus the self-serve pointer to the hosted upgrade.
    expect(plain.stdout).toContain('Ranking mode: keyword');
    expect(plain.stdout).toContain('https://starlog.dev');

    // Step 4 — the env-var route restores the key without --api-key, confirming
    // init honors an exported STARLOG_API_KEY.
    const envRoute = runCli(['init', '-y'], { home, proj, env: { STARLOG_API_KEY: 'sk-org-xyz789' } });
    expect(envRoute.status).toBe(0);
    expect(readSettings(home).mcpServers.starlog.env.STARLOG_API_KEY).toBe('sk-org-xyz789');
  });
});
