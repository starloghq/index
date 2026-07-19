import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSearch } from './search-service.js';
import { buildManifestFromInput } from './engine/facts/authoring.js';

/**
 * Integration coverage for the hosted-corpus wiring in runSearch: the unit tests
 * (engine/hosted-corpus.test.ts) prove fetchHostedCorpus in isolation; these prove
 * runSearch actually USES it when keyed, and FALLS BACK to the bundled corpus on
 * any failure. STARLOG_API_KEY is stubbed in every test so the dev/CI shell's real
 * key can't leak in and flip the tier (the same hermeticity trap we hit before).
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const drizzle = JSON.parse(readFileSync(join(here, '..', 'corpus-free', 'orm-database', 'drizzle.json'), 'utf-8'));

function okSearch(manifest: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ results: [{ rank: 1, score: 9, manifest }] }) } as unknown as Response;
}

function okOrgCorpus(manifests: unknown[]): Response {
  return { ok: true, status: 200, json: async () => ({ manifests }) } as unknown as Response;
}

describe('runSearch — hosted corpus tier wiring', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  function hermeticEnv(key: string) {
    vi.stubEnv('STARLOG_API_KEY', key);
    vi.stubEnv('STARLOG_ORG_CORPUS_URL', '');
    vi.stubEnv('STARLOG_PRIVATE_CORPUS', ''); // no private overlay interfering
    vi.stubEnv('OPENROUTER_API_KEY', ''); // keep the LLM ranker offline
  }

  it('uses the HOSTED candidate set when STARLOG_API_KEY is set', async () => {
    hermeticEnv('sk-test');
    // A manifest that exists ONLY in the hosted response — if it surfaces, the
    // candidate set came from /search, not the bundled corpus.
    const hostedOnly = { ...drizzle, id: 'hosted-only-orm', name: 'hosted-only-orm' };
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('/search?');
      return okSearch(hostedOnly);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(fetchMock).toHaveBeenCalled();
    expect(out.map((r) => r.manifest.id)).toContain('hosted-only-orm');
  });

  it('falls back to the LOCAL corpus when the hosted fetch fails', async () => {
    hermeticEnv('sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    // The bundled drizzle is still found — the failure degraded to local, not nothing.
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });

  it('keyless: never calls the hosted API, ranks the local corpus', async () => {
    hermeticEnv('');
    const fetchMock = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });
});

describe('runSearch — org remote corpus tier wiring', () => {
  const ORG_URL = 'https://corp.example.test/corpus.json';
  let tmpDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function hermeticEnv() {
    vi.stubEnv('STARLOG_API_KEY', '');
    vi.stubEnv('STARLOG_ORG_CORPUS_URL', ORG_URL);
    vi.stubEnv('STARLOG_PRIVATE_CORPUS', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
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

  it('merges org corpus between base and local private; local wins on id', async () => {
    hermeticEnv();
    const orgOnly = orgManifest();
    const localOverride = buildManifestFromInput({
      package: '@acme/flags',
      solves: 'LOCAL OVERRIDE — machine-specific feature flags wiring.',
      category: 'feature-flags',
      stack: ['node'],
      bestFor: ['feature flags'],
    });
    tmpDir = mkdtempSync(join(tmpdir(), 'starlog-org-merge-'));
    const privPath = join(tmpDir, 'private-corpus.json');
    writeFileSync(privPath, JSON.stringify({ manifests: [localOverride] }), 'utf8');
    vi.stubEnv('STARLOG_PRIVATE_CORPUS', privPath);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toBe(ORG_URL);
      return okOrgCorpus([orgOnly]);
    }) as unknown as typeof fetch);

    const out = await runSearch({ query: 'feature flags for a node app' });
    const hit = out.find((r) => r.manifest.id === '@acme/flags');
    expect(hit).toBeDefined();
    expect(hit!.manifest.solves).toContain('LOCAL OVERRIDE');
  });

  it('floats org ids private-first when score >= 70', async () => {
    hermeticEnv();
    const orgOnly = orgManifest();
    vi.stubGlobal('fetch', vi.fn(async () => okOrgCorpus([orgOnly])) as unknown as typeof fetch);

    const out = await runSearch({ query: 'feature flags for a node app', top_k: 3 });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].manifest.id).toBe('@acme/flags');
  });

  it('skips org layer when fetch returns null; search still works', async () => {
    hermeticEnv();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });

  it('does not call org fetch when STARLOG_ORG_CORPUS_URL empty', async () => {
    vi.stubEnv('STARLOG_API_KEY', '');
    vi.stubEnv('STARLOG_ORG_CORPUS_URL', '');
    vi.stubEnv('STARLOG_PRIVATE_CORPUS', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const fetchMock = vi.fn(async () => { throw new Error('should not fetch'); });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const out = await runSearch({ query: 'type-safe orm for the database' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.map((r) => r.manifest.id)).toContain('drizzle');
  });
});
