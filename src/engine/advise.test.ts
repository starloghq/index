import { describe, it, expect } from 'vitest';
import { assessPackageSafety } from './advise.js';
import type { QueryResult } from '../manifest/schema.js';
import { assembleL2 } from './facts/authoring.js';

function makeResult(overrides: Partial<QueryResult['manifest']> & { relevance_score?: number }): QueryResult {
  const { relevance_score = 85, ...manifestOverrides } = overrides;
  return {
    manifest: {
      id: 'clerk',
      name: 'Clerk',
      repo: 'clerk/javascript',
      ecosystem: 'npm',
      category: 'authentication',
      solves: 'Managed auth',
      stack_affinity: ['next.js'],
      integration_effort: 'easy',
      best_for: ['SaaS'],
      skip_when: ['self-hosted only'],
      hosted_alternative: null,
      alternative_ids: [],
      health: {
        stars: 1000,
        last_commit: '2026-01-01',
        contributors: 10,
        license: 'MIT',
        open_issues: 1,
      },
      quality: {
        has_tests: true,
        has_docs: true,
        has_types: true,
        maintenance_status: 'active',
      },
      ...manifestOverrides,
    },
    relevance_score,
    context_fit: '',
    vs_custom: '',
    tradeoffs: [],
  };
}

describe('assessPackageSafety', () => {
  it('rejects low relevance', () => {
    const v = assessPackageSafety(makeResult({ relevance_score: 50 }), null);
    expect(v.safe).toBe(false);
  });

  it('rejects DIY manifests', () => {
    const v = assessPackageSafety(
      makeResult({ id: 'custom-authentication', name: 'DIY', repo: null }),
      null,
    );
    expect(v.safe).toBe(false);
  });

  it('accepts corpus package with quality fallback when no facts', () => {
    const v = assessPackageSafety(makeResult({}), null);
    expect(v.safe).toBe(true);
    expect(v.facts_available).toBe(false);
  });

  it('advise minRelevance allows mid-score category hits', () => {
    const v = assessPackageSafety(makeResult({ relevance_score: 55 }), null, { minRelevance: 50 });
    expect(v.safe).toBe(true);
  });

  it('rejects below custom minRelevance', () => {
    const v = assessPackageSafety(makeResult({ relevance_score: 55 }), null, { minRelevance: 70 });
    expect(v.safe).toBe(false);
  });

  it('rejects package with critical vulns in facts', () => {
    const factView = {
      package: '@clerk/nextjs',
      ecosystem: 'npm' as const,
      l1: null,
      l2: assembleL2({
        package: '@clerk/nextjs',
        license: 'MIT',
        licenseRisk: 'none',
        maintenance: 'active',
        knownVulns: [{ id: 'CVE-1', severity: 'critical', affected: '*', summary: 'bad' }],
      }),
      l3: { decision: 'none' as const, rule_id: undefined, rationale: undefined },
    };
    const v = assessPackageSafety(makeResult({}), factView);
    expect(v.safe).toBe(false);
  });

  it('rejects org deny policy', () => {
    const factView = {
      package: '@clerk/nextjs',
      ecosystem: 'npm' as const,
      l1: null,
      l2: assembleL2({
        package: '@clerk/nextjs',
        license: 'MIT',
        licenseRisk: 'none',
        maintenance: 'active',
      }),
      l3: { decision: 'deny' as const, rule_id: 'r1', rationale: 'banned' },
    };
    const v = assessPackageSafety(makeResult({}), factView);
    expect(v.safe).toBe(false);
  });
});
