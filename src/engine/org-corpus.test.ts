import { afterEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fetchOrgCorpus, getOrgCorpusPackageIds } from './org-corpus.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const drizzle = JSON.parse(
  readFileSync(join(here, '..', '..', 'corpus-free', 'orm-database', 'drizzle.json'), 'utf-8'),
);
const orgManifest = { ...drizzle, id: '@acme/flags', name: '@acme/flags' };

function okResponse(manifests: unknown[]): Response {
  return { ok: true, status: 200, json: async () => ({ manifests }) } as unknown as Response;
}

const CORPUS_URL = 'https://corp.example.test/corpus.json';
const TOKEN = 'org-token-123';

describe('fetchOrgCorpus', () => {
  afterEach(() => {
    delete process.env.STARLOG_ORG_CORPUS_URL;
    delete process.env.STARLOG_ORG_CORPUS_TOKEN;
  });

  it('returns null when STARLOG_ORG_CORPUS_URL unset (no fetch)', async () => {
    const out = await fetchOrgCorpus({
      fetchImpl: (() => { throw new Error('should not fetch'); }) as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });

  it('returns manifests from { manifests: [...] } on 200', async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe(CORPUS_URL);
      return okResponse([orgManifest]);
    }) as unknown as typeof fetch;
    const out = await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl });
    expect(out).not.toBeNull();
    expect(out!.map((m) => m.id)).toEqual(['@acme/flags']);
  });

  it('sends Authorization: Bearer when STARLOG_ORG_CORPUS_TOKEN set', async () => {
    let auth = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).Authorization);
      return okResponse([orgManifest]);
    }) as unknown as typeof fetch;
    await fetchOrgCorpus({ url: CORPUS_URL, token: TOKEN, fetchImpl });
    expect(auth).toBe(`Bearer ${TOKEN}`);
  });

  it('omits Authorization when token unset', async () => {
    let auth: string | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return okResponse([orgManifest]);
    }) as unknown as typeof fetch;
    await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl });
    expect(auth).toBeUndefined();
  });

  it('returns null on non-2xx / throw / invalid JSON / empty manifests', async () => {
    const non200 = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl: non200 })).toBeNull();

    const throws = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl: throws })).toBeNull();

    const empty = (async () => okResponse([])) as unknown as typeof fetch;
    expect(await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl: empty })).toBeNull();

    const garbage = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl: garbage })).toBeNull();
  });

  it('skips schema-invalid entries; null if none survive', async () => {
    const fetchImpl = (async () => okResponse([{ id: 'broken' }])) as unknown as typeof fetch;
    expect(await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl })).toBeNull();
  });

  it('records package ids via getOrgCorpusPackageIds() after success', async () => {
    const fetchImpl = (async () => okResponse([orgManifest])) as unknown as typeof fetch;
    await fetchOrgCorpus({ url: CORPUS_URL, fetchImpl });
    expect(getOrgCorpusPackageIds().has('@acme/flags')).toBe(true);
  });
});
