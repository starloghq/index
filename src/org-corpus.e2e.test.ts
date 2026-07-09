import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildManifestFromInput } from './engine/facts/authoring.js';

/**
 * End-to-end tests for company-hosted org corpus (STARLOG_ORG_CORPUS_URL):
 * a fixture HTTP server serves `{ manifests }`, the real CLI searches against it,
 * and org packages surface private-first. Local private still wins on id collision;
 * a dead URL degrades without breaking keyless search.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.STARLOG_PRIVATE_FACTS;
  delete env.STARLOG_API_KEY;
  delete env.STARLOG_POLICY;
  delete env.STARLOG_PRIVATE_CORPUS;
  delete env.STARLOG_ORG_CORPUS_URL;
  delete env.STARLOG_ORG_CORPUS_TOKEN;
  env.STARLOG_NO_NUDGE = '1';
  env.STARLOG_TELEMETRY = '0';
  return env;
}

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

/** Async spawn so the parent event loop can serve the fixture HTTP server concurrently. */
function runCliAsync(cwd: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const childEnv = baseEnv();
    Object.assign(childEnv, env ?? {});
    const child = spawn('node', [CLI, '--no-telemetry', ...args], { cwd, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ status: typeof code === 'number' ? code : -1, stdout, stderr }));
    child.on('error', () => resolve({ status: -1, stdout, stderr }));
  });
}

function parseResults(stdout: string): Array<{ manifest?: { id?: string; solves?: string }; relevance_score?: number }> {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : (parsed.results ?? []);
}

function orgManifest() {
  return buildManifestFromInput({
    package: '@acme/flags',
    solves: 'Feature flags and remote configuration for Acme Node services — gradual rollout, kill switches, audit log.',
    category: 'feature-flags',
    stack: ['node'],
    bestFor: ['feature flags', 'remote config', 'gradual rollout', 'kill switches'],
  });
}

async function withFixtureServer(
  body: unknown,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/corpus.json`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('org remote corpus (e2e, spawned binary)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'starlog-org-corpus-e2e-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('surfaces the org package private-first when STARLOG_ORG_CORPUS_URL points at a fixture server', async () => {
    await withFixtureServer({ manifests: [orgManifest()] }, async (url) => {
      const out = await runCliAsync(cwd, [
        'search', 'feature flags for a node app',
        '--format', 'json', '--diversity', '1.0', '--top-k', '3',
      ], { STARLOG_ORG_CORPUS_URL: url });

      expect(out.status).toBe(0);
      const results = parseResults(out.stdout);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].manifest?.id).toBe('@acme/flags');
      expect(results[0].relevance_score).toBeGreaterThanOrEqual(70);
    });
  }, 20_000);

  it('local private overrides org remote on the same manifest id', async () => {
    const localOverride = buildManifestFromInput({
      package: '@acme/flags',
      solves: 'LOCAL OVERRIDE — machine-specific feature flags wiring.',
      category: 'feature-flags',
      stack: ['node'],
      bestFor: ['feature flags'],
    });
    const privPath = join(cwd, 'private-corpus.json');
    writeFileSync(privPath, JSON.stringify({ manifests: [localOverride] }), 'utf8');

    await withFixtureServer({ manifests: [orgManifest()] }, async (url) => {
      const out = await runCliAsync(cwd, [
        'search', 'feature flags for a node app',
        '--format', 'json', '--diversity', '1.0',
      ], {
        STARLOG_ORG_CORPUS_URL: url,
        STARLOG_PRIVATE_CORPUS: privPath,
      });

      expect(out.status).toBe(0);
      const hit = parseResults(out.stdout).find((r) => r.manifest?.id === '@acme/flags');
      expect(hit?.manifest?.solves).toContain('LOCAL OVERRIDE');
    });
  }, 20_000);

  it('degrades gracefully when the org corpus URL is unreachable — public search still works', async () => {
    const out = runRawCli(cwd, [
      'search', 'type-safe orm for the database',
      '--format', 'json', '--diversity', '1.0',
    ], { STARLOG_ORG_CORPUS_URL: 'http://127.0.0.1:1/dead' });

    expect(out.status).toBe(0);
    const ids = parseResults(out.stdout).map((r) => r.manifest?.id);
    expect(ids).toContain('drizzle');
  });
});
