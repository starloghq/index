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
  let home: string;
  let prevHome: string | undefined;
  let prevTelemetry: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-advise-'));
    // Isolate the global pattern store (~/.starlog/patterns.json resolves via
    // homedir()) so recurrence counts never leak across tests or in from the
    // developer's real store — otherwise the watch/threshold assertions flake.
    home = mkdtempSync(join(tmpdir(), 'starlog-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // Keep the suite offline/hermetic regardless of the developer's shell env.
    prevTelemetry = process.env.STARLOG_TELEMETRY;
    process.env.STARLOG_TELEMETRY = '0';
    delete process.env.STARLOG_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevTelemetry === undefined) delete process.env.STARLOG_TELEMETRY;
    else process.env.STARLOG_TELEMETRY = prevTelemetry;
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

  it('does not pass a project context to search (skips unused LLM enrichment)', async () => {
    const spy = vi.spyOn(searchService, 'runSearch');
    await runAdvise({
      observation: 'DIY JWT authentication',
      project_root: dir,
      category: 'authentication',
      force: true,
    });
    expect(spy).toHaveBeenCalled();
    // Advise discards vs_custom/context_fit/tradeoffs, so it must not trigger
    // search()'s per-candidate LLM round-trip by passing a projectContext.
    expect(spy.mock.calls[0][0].context).toBeUndefined();
  });

  it('increments occurrences once per advise call, not twice', async () => {
    // A tracked pattern needs signals, so seed DIY auth code the scanner detects.
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'session.ts'),
      `import jwt from 'jsonwebtoken';\nexport const verify = (t: string) => jwt.verify(t, 'secret');`,
    );
    const call = () =>
      runAdvise({
        observation: 'DIY JWT authentication',
        project_root: dir,
        category: 'authentication',
        force: true,
      });
    const first = await call();
    const second = await call();
    // A single observation per call must advance the recurrence count by 1.
    // The migrate/packageize status update must not re-increment.
    expect(second.occurrences! - first.occurrences!).toBe(1);
  });
});
