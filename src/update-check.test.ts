import { describe, it, expect } from 'vitest';
import { compareVersions, fetchLatestVersion } from './update-check.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.7.1', '0.7.1')).toBe(0);
  });

  it('orders by patch, minor, and major', () => {
    expect(compareVersions('0.7.2', '0.7.1')).toBe(1);
    expect(compareVersions('0.7.1', '0.7.2')).toBe(-1);
    expect(compareVersions('0.8.0', '0.7.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });

  it('ignores a leading v and pre-release suffixes', () => {
    expect(compareVersions('v0.7.1', '0.7.1')).toBe(0);
    expect(compareVersions('0.7.1-beta.2', '0.7.1')).toBe(0);
  });

  it('treats missing/garbage segments as 0 and never throws', () => {
    expect(compareVersions('0.7', '0.7.0')).toBe(0);
    expect(compareVersions('garbage', '0.0.0')).toBe(0);
  });
});

describe('fetchLatestVersion', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it('returns the version string from the registry response', async () => {
    const fetchImpl = (async () => okResponse({ version: '9.9.9' })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBe('9.9.9');
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = (async () => ({ ok: false }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
  });

  it('returns null when the body has no version field', async () => {
    const fetchImpl = (async () => okResponse({ nope: true })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
  });
});
