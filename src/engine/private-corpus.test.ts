import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPrivateCorpus } from './private-corpus.js';
import type { CapabilityManifest } from '../manifest/schema.js';

function validManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    id: 'acme-auth',
    name: '@acme/auth',
    repo: 'acme/auth',
    ecosystem: 'npm',
    category: 'authentication',
    solves: 'Internal SSO for ACME services',
    stack_affinity: ['next.js', 'node'],
    integration_effort: 'easy',
    best_for: ['ACME internal apps'],
    skip_when: ['external/public apps'],
    hosted_alternative: null,
    alternative_ids: [],
    health: {
      stars: 0,
      weekly_downloads: 0,
      last_commit: '2026-01-01',
      contributors: 3,
      license: 'UNLICENSED',
      open_issues: 0,
    },
    quality: {
      has_tests: true,
      has_docs: true,
      has_types: true,
      maintenance_status: 'active',
    },
    ...overrides,
  };
}

function writeTmp(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'starlog-private-corpus-'));
  const file = join(dir, 'corpus.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadPrivateCorpus — env-driven private manifest overlay (mirror of loadPrivateFacts)', () => {
  it('Test 1: loads manifests from a valid { manifests: [...] } file', () => {
    const path = writeTmp({ manifests: [validManifest(), validManifest({ id: 'acme-cache', name: '@acme/cache', category: 'caching' })] });
    const out = loadPrivateCorpus(path);
    expect(out.map((m) => m.id).sort()).toEqual(['acme-auth', 'acme-cache']);
  });

  it('Test 2: returns [] when path is undefined (no throw)', () => {
    expect(loadPrivateCorpus(undefined)).toEqual([]);
  });

  it('Test 3: unreadable/missing file returns [] and warns on stderr (no throw)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = join(tmpdir(), 'starlog-no-such-' + Date.now(), 'nope.json');
    expect(loadPrivateCorpus(missing)).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it('Test 4: an entry failing the schema is skipped with a warning; valid siblings still load', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = writeTmp({ manifests: [{ id: 'broken' /* missing required fields */ }, validManifest()] });
    const out = loadPrivateCorpus(path);
    expect(out.map((m) => m.id)).toEqual(['acme-auth']);
    expect(spy).toHaveBeenCalled();
  });

  it('returns [] when the shape is wrong (no manifests array)', () => {
    const path = writeTmp({ notManifests: [] });
    expect(loadPrivateCorpus(path)).toEqual([]);
  });
});

describe('loadPrivateCorpus — resolves ${CLAUDE_PROJECT_DIR} in the path at runtime (issue #57)', () => {
  let savedProj: string | undefined;
  beforeEach(() => {
    savedProj = process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    if (savedProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProj;
  });

  it('loads a corpus wired with the literal ${CLAUDE_PROJECT_DIR} token (the real incident)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'starlog-cpd-corpus-'));
    writeFileSync(join(dir, 'private-corpus.json'), JSON.stringify({ manifests: [validManifest()] }), 'utf-8');
    process.env.CLAUDE_PROJECT_DIR = dir;
    // The MCP server receives this token LITERAL (Claude Code does not expand it
    // in the env block); the loader must expand it from process.env at read time.
    const out = loadPrivateCorpus('${CLAUDE_PROJECT_DIR}/private-corpus.json');
    expect(out.map((m) => m.id)).toEqual(['acme-auth']);
  });
});
