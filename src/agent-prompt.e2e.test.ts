import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { AGENT_SETUP_PROMPT } from './agent-prompt.js';

/**
 * End-to-end tests for `starlog init --agent-prompt` (issue #48) through the REAL
 * built binary (dist/cli.js).
 *
 * Two jobs:
 *   1. The flag prints the canonical prompt to stdout, exits 0, writes nothing.
 *   2. DRIFT GUARD: every claim the prompt makes about `init` (flags, files it
 *      writes, non-interactive behavior) is checked against the real binary, so
 *      a change to init that would make the prompt lie fails here.
 *
 * HERMETICITY: temp project cwd + temp $HOME (so ~/.claude resolves there),
 * telemetry and nudge forced off, inherited STARLOG_* scrubbed, stdin closed.
 * dist/ is assumed pre-built.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

let tempPaths: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(d);
  return d;
}

afterEach(() => {
  for (const p of tempPaths) rmSync(p, { recursive: true, force: true });
  tempPaths = [];
});

function run(args: string[], opts: { proj: string; home: string }) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.STARLOG_PRIVATE_FACTS;
  delete env.STARLOG_API_KEY;
  delete env.STARLOG_POLICY;
  delete env.STARLOG_PRIVATE_CORPUS;
  env.STARLOG_TELEMETRY = '0';
  env.STARLOG_NO_NUDGE = '1';
  env.HOME = opts.home;
  const r = spawnSync('node', [CLI, ...args], { cwd: opts.proj, env, encoding: 'utf8', input: '', timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The `starlog init ...` invocations the prompt tells an agent to run. */
function promptInitInvocations(): string[] {
  return AGENT_SETUP_PROMPT.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('starlog init'));
}

describe('starlog init --agent-prompt', () => {
  it('prints exactly the canonical prompt, exits 0, and writes nothing', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const r = run(['init', '--agent-prompt'], { proj, home });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(AGENT_SETUP_PROMPT + '\n');
    expect(readdirSync(proj)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it('is byte-identical across runs', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    expect(run(['init', '--agent-prompt'], { proj, home }).stdout)
      .toBe(run(['init', '--agent-prompt'], { proj, home }).stdout);
  });

  it('wins over other init flags — never writes even when combined with -y', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const r = run(['init', '--agent-prompt', '-y', '--all', '--project'], { proj, home });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(AGENT_SETUP_PROMPT + '\n');
    expect(readdirSync(proj)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('agent prompt ↔ init drift guard', () => {
  it('every flag the prompt passes to init is a real init option', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const help = run(['init', '--help'], { proj, home }).stdout;
    const invocations = promptInitInvocations();
    expect(invocations.length).toBeGreaterThan(0);
    for (const inv of invocations) {
      for (const flag of inv.match(/(?<=\s)-{1,2}[a-z][a-z-]*/g) ?? []) {
        expect(help, `prompt uses "${flag}" but init --help does not list it`).toMatch(
          new RegExp(`(^|[\\s,])${flag}(?=[\\s,]|$)`, 'm'),
        );
      }
    }
  });

  it('the --dry-run step is non-interactive and writes nothing', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const r = run(['init', '--dry-run'], { proj, home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no changes written/i);
    expect(readdirSync(proj)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it('every file location the prompt says init writes appears in the real install plan', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const plan = run(['init', '--dry-run', '--all'], { proj, home }).stdout;
    // [what the prompt says, what the real plan prints]
    const claims: Array<[string, string]> = [
      ['~/.claude/', '~/.claude/settings.json'],
      ['~/.claude/', '~/.claude/hooks/'],
      ['.cursor/rules/', '.cursor/rules/starlog.mdc'],
      ['.github/copilot-instructions.md', '.github/copilot-instructions.md'],
      ['AGENTS.md', 'AGENTS.md'],
    ];
    for (const [said, written] of claims) {
      expect(AGENT_SETUP_PROMPT, `prompt should mention ${said}`).toContain(said);
      expect(plan, `init plan no longer writes ${written}`).toContain(written);
    }
  });

  it('the -y step applies without a TTY (no hang, no confirmation prompt)', () => {
    const proj = mkTemp('starlog-ap-proj-');
    const home = mkTemp('starlog-ap-home-');
    const r = run(['init', '-y'], { proj, home });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/Apply these changes\?/);
    expect(r.stdout).toMatch(/Done!/);
    expect(readdirSync(join(home, '.claude'))).toContain('settings.json');
  });
});
