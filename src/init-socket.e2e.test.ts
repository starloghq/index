import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/**
 * End-to-end tests for `starlog init --with-socket` (issue #67): opt-in wiring of
 * Socket's free hosted MCP server (live dependency scanner) alongside Starlog.
 *
 * Starlog facts are dated, point-in-time data; the live scanner covers anything
 * disclosed since. It is OPT-IN because it sends package names to a third party,
 * and the default install promises no network. Contract:
 *   - without the flag, nothing about Socket is written,
 *   - with it, a `socket` HTTP MCP entry is added next to `starlog`,
 *   - a `socket` entry the user already configured is never overwritten or removed,
 *   - `--uninstall` removes only the entry Starlog wrote.
 *
 * HERMETICITY: temp project cwd + temp $HOME, telemetry/nudge off, inherited
 * STARLOG_* scrubbed, stdin closed. No network (init only writes config).
 * dist/ is assumed pre-built.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');
const SOCKET_ENTRY = { type: 'http', url: 'https://mcp.socket.dev/' };

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

function env() {
  return { proj: mkTemp('starlog-sock-proj-'), home: mkTemp('starlog-sock-home-') };
}

function run(args: string[], opts: { proj: string; home: string }) {
  const e: Record<string, string | undefined> = { ...process.env };
  delete e.STARLOG_PRIVATE_FACTS;
  delete e.STARLOG_API_KEY;
  delete e.STARLOG_POLICY;
  delete e.STARLOG_PRIVATE_CORPUS;
  e.STARLOG_TELEMETRY = '0';
  e.STARLOG_NO_NUDGE = '1';
  e.HOME = opts.home;
  const r = spawnSync('node', [CLI, ...args], { cwd: opts.proj, env: e, encoding: 'utf8', input: '', timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function servers(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).mcpServers ?? {};
}

describe('starlog init --with-socket', () => {
  it('default init does not wire Socket', () => {
    const t = env();
    expect(run(['init', '-y'], t).status).toBe(0);
    expect(servers(t.home)).toHaveProperty('starlog');
    expect(servers(t.home)).not.toHaveProperty('socket');
  });

  it('--dry-run previews the Socket item and writes nothing', () => {
    const t = env();
    const r = run(['init', '--dry-run', '--with-socket'], t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[\+ create\] Claude Code · Socket MCP/);
    expect(readdirSync(t.home)).toEqual([]);
  });

  it('adds the Socket HTTP MCP entry next to starlog and says what it sends', () => {
    const t = env();
    const r = run(['init', '-y', '--with-socket'], t);
    expect(r.status).toBe(0);
    expect(servers(t.home).socket).toEqual(SOCKET_ENTRY);
    expect(servers(t.home)).toHaveProperty('starlog');
    expect(r.stdout).toMatch(/package names.*socket\.dev/is);
  });

  it('is idempotent', () => {
    const t = env();
    run(['init', '-y', '--with-socket'], t);
    const r = run(['init', '-y', '--with-socket'], t);
    expect(r.stdout).toMatch(/\[= ok\]\s+Claude Code · Socket MCP/);
    expect(r.stdout).toMatch(/already configured/i);
  });

  it('never overwrites a socket entry the user configured themselves', () => {
    const t = env();
    const mine = { type: 'http', url: 'https://mcp.socket.dev/', headers: { Authorization: 'Bearer mine' } };
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    writeFileSync(join(t.home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { socket: mine } }));
    const r = run(['init', '-y', '--with-socket'], t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[= ok\]\s+Claude Code · Socket MCP/);
    expect(servers(t.home).socket).toEqual(mine);
  });

  it('--uninstall removes the entry Starlog wrote', () => {
    const t = env();
    run(['init', '-y', '--with-socket'], t);
    const r = run(['init', '--uninstall'], t);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Socket MCP server removed/);
    expect(servers(t.home)).not.toHaveProperty('socket');
  });

  it('--uninstall leaves a user-configured socket entry alone', () => {
    const t = env();
    const mine = { type: 'http', url: 'https://mcp.socket.dev/', headers: { Authorization: 'Bearer mine' } };
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    writeFileSync(join(t.home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { socket: mine } }));
    run(['init', '-y'], t);
    run(['init', '--uninstall'], t);
    expect(servers(t.home).socket).toEqual(mine);
  });
});

describe('agent instructions treat facts as dated', () => {
  it('tell the agent to also run a live scanner (Socket depscore) when one is available', () => {
    const t = env();
    run(['init', '-y', '--all'], t);
    const agents = readFileSync(join(t.proj, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/point-in-time/i);
    expect(agents).toContain('depscore');
  });
});
