import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverOverlay, overlayPath } from './overlay-discovery.js';

let dirs: string[] = [];
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'starlog-discover-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('discoverOverlay — project-local .starlog/ fallback (issue #59)', () => {
  it('finds .starlog/<file> in the start directory', () => {
    const dir = mkTmp();
    mkdirSync(join(dir, '.starlog'), { recursive: true });
    writeFileSync(join(dir, '.starlog', 'private-corpus.json'), '{"manifests":[]}');
    expect(discoverOverlay('private-corpus.json', dir)).toBe(join(dir, '.starlog', 'private-corpus.json'));
  });

  it('walks UP from a nested subdirectory to the project-root .starlog/', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.starlog'), { recursive: true });
    writeFileSync(join(root, '.starlog', 'private-corpus.json'), '{"manifests":[]}');
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(discoverOverlay('private-corpus.json', nested)).toBe(join(root, '.starlog', 'private-corpus.json'));
  });

  it('returns undefined when no .starlog/<file> exists in any ancestor', () => {
    const dir = mkTmp();
    expect(discoverOverlay('private-corpus.json', dir)).toBeUndefined();
  });
});

describe('overlayPath — env value wins, else discover', () => {
  it('returns the explicit env value unchanged (override always wins)', () => {
    const dir = mkTmp();
    mkdirSync(join(dir, '.starlog'), { recursive: true });
    writeFileSync(join(dir, '.starlog', 'private-corpus.json'), '{"manifests":[]}');
    expect(overlayPath('/explicit/path.json', 'private-corpus.json', dir)).toBe('/explicit/path.json');
  });

  it('discovers the project-local overlay when the env value is unset', () => {
    const dir = mkTmp();
    mkdirSync(join(dir, '.starlog'), { recursive: true });
    writeFileSync(join(dir, '.starlog', 'private-corpus.json'), '{"manifests":[]}');
    expect(overlayPath(undefined, 'private-corpus.json', dir)).toBe(join(dir, '.starlog', 'private-corpus.json'));
  });

  it('treats an empty env value as unset (falls through to discovery)', () => {
    const dir = mkTmp();
    mkdirSync(join(dir, '.starlog'), { recursive: true });
    writeFileSync(join(dir, '.starlog', 'private-corpus.json'), '{"manifests":[]}');
    expect(overlayPath('', 'private-corpus.json', dir)).toBe(join(dir, '.starlog', 'private-corpus.json'));
  });

  it('returns undefined when env unset and nothing on disk (loaders no-op → public-only)', () => {
    const dir = mkTmp();
    expect(overlayPath(undefined, 'private-corpus.json', dir)).toBeUndefined();
  });
});
