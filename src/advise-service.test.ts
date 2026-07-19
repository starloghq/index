import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAdvise } from './advise-service.js';
import * as searchService from './search-service.js';
import type { QueryResult } from './manifest/schema.js';

function diyOnlyResult(): QueryResult {
  return {
    manifest: {
      id: 'custom-authentication',
      name: 'Custom/DIY Authentication',
      repo: null,
      ecosystem: 'npm',
      category: 'authentication',
      solves: 'Build auth from scratch',
      stack_affinity: ['any'],
      integration_effort: 'significant',
      best_for: ['learning'],
      skip_when: ['production'],
      hosted_alternative: null,
      alternative_ids: [],
      health: {
        stars: 0,
        last_commit: '2026-01-01',
        contributors: 0,
        license: 'UNLICENSED',
        open_issues: 0,
      },
      quality: {
        has_tests: false,
        has_docs: false,
        has_types: false,
        maintenance_status: 'active',
      },
    },
    relevance_score: 90,
    context_fit: '',
    vs_custom: '',
    tradeoffs: [],
  };
}

describe('runAdvise', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-advise-'));
    delete process.env.STARLOG_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('advises migrate for DIY auth when forced', async () => {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'session.ts'),
      `import jwt from 'jsonwebtoken';\nexport const verify = (t: string) => jwt.verify(t, 'secret');`,
    );

    const result = await runAdvise({
      observation: 'DIY JWT authentication',
      project_root: dir,
      category: 'authentication',
      force: true,
    });

    expect(result.action).toBe('migrate');
    expect(result.candidates?.length).toBeGreaterThan(0);
    expect(result.rationale.toLowerCase()).toContain('migrate');
    expect(result.candidates!.every((c) => c.relevance_score >= 70)).toBe(true);
  });

  it('returns watch below recurrence threshold', async () => {
    const result = await runAdvise({
      observation: 'DIY JWT authentication',
      project_root: dir,
      category: 'authentication',
      force: false,
    });

    expect(result.action).toBe('watch');
    expect(result.candidates?.length).toBeGreaterThan(0);
  });

  it('advises packageize when no safe candidates remain', async () => {
    vi.spyOn(searchService, 'runSearch').mockResolvedValue([diyOnlyResult()]);

    const result = await runAdvise({
      observation: 'niche custom auth',
      project_root: dir,
      category: 'authentication',
      force: true,
    });

    expect(result.action).toBe('packageize');
    expect(result.packageize_plan?.suggested_name).toContain('@acme/');
  });
});
