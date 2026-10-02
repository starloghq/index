import { describe, it, expect } from 'vitest';
import { L1CapabilityFactSchema } from '@starloghq/facts-schema';
import { L2OverlaySchema, VulnSchema } from '@starloghq/facts-schema';
import { L3PolicySchema, L3RuleSchema, evaluateDiyPolicy, type L3Policy } from '@starloghq/facts-schema';

// Helpers building minimal-valid records per layer.
const l1 = (o: Record<string, unknown> = {}) => ({
  package: 'p', ecosystem: 'npm', version_range: null, artifact_sha256: null,
  effect_surface: 'does a thing', capabilities: [],
  provenance: { derived_by: 'hand', source: 's', verified: true }, ...o,
});
const l2 = (o: Record<string, unknown> = {}) => ({
  package: 'p', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none',
  maintenance: 'active', transitive_risk: null,
  attestation: { source: 'hand', refs: [], fetched_at: '2026-06-01' }, ...o,
});

describe('L1CapabilityFactSchema', () => {
  it('parses a valid L1 fact and applies ecosystem default', () => {
    const r = L1CapabilityFactSchema.safeParse({ ...l1(), ecosystem: undefined });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ecosystem).toBe('npm');
  });

  it('has NO freshness field — L1 is immutable (last_verified/fetched_at are stripped, not stored)', () => {
    const r = L1CapabilityFactSchema.safeParse({ ...l1(), last_verified: '2026-06-01', fetched_at: '2026-06-01' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('last_verified' in r.data).toBe(false);
      expect('fetched_at' in r.data).toBe(false);
    }
  });

  it('requires effect_surface and provenance; rejects an unverifiable provenance shape', () => {
    expect(L1CapabilityFactSchema.safeParse({ ...l1(), effect_surface: undefined }).success).toBe(false);
    expect(L1CapabilityFactSchema.safeParse({ ...l1(), provenance: { derived_by: 'hand' } }).success).toBe(false);
  });

  it('rejects an out-of-domain derived_by and ecosystem', () => {
    expect(L1CapabilityFactSchema.safeParse({ ...l1(), provenance: { derived_by: 'magic', source: 's', verified: true } }).success).toBe(false);
    expect(L1CapabilityFactSchema.safeParse({ ...l1(), ecosystem: 'cargo' }).success).toBe(false);
  });

  it('defaults capabilities to [] and accepts an analyzer/content-addressed record', () => {
    const r = L1CapabilityFactSchema.safeParse({ ...l1(), capabilities: undefined });
    expect(r.success && r.data.capabilities).toEqual([]);
    expect(L1CapabilityFactSchema.safeParse(l1({ artifact_sha256: 'a'.repeat(64), provenance: { derived_by: 'analyzer', source: 'run#1', verified: true } })).success).toBe(true);
  });
});

describe('L2OverlaySchema', () => {
  it('parses a valid overlay', () => {
    expect(L2OverlaySchema.safeParse(l2()).success).toBe(true);
  });

  it('freshness lives here: attestation.fetched_at must be a VALID calendar date', () => {
    for (const bad of ['2026-13-99', '2026-02-30', '2026-1-1', '06-01-2026', 'yesterday', '']) {
      expect(L2OverlaySchema.safeParse(l2({ attestation: { source: 'hand', refs: [], fetched_at: bad } })).success).toBe(false);
    }
    expect(L2OverlaySchema.safeParse(l2({ attestation: { source: 'hand', refs: [], fetched_at: '2026-06-01' } })).success).toBe(true);
  });

  it('rejects out-of-domain license_risk / maintenance / attestation.source', () => {
    expect(L2OverlaySchema.safeParse(l2({ license_risk: 'gpl-ish' })).success).toBe(false);
    expect(L2OverlaySchema.safeParse(l2({ maintenance: 'sleepy' })).success).toBe(false);
    expect(L2OverlaySchema.safeParse(l2({ attestation: { source: 'made-up', refs: [], fetched_at: '2026-06-01' } })).success).toBe(false);
  });

  it('accepts the documented future attestation sources (osv/deps.dev/scorecard)', () => {
    for (const source of ['osv', 'deps.dev', 'scorecard']) {
      expect(L2OverlaySchema.safeParse(l2({ attestation: { source, refs: ['OSV-1'], fetched_at: '2026-06-01' } })).success).toBe(true);
    }
  });

  it("accepts 'analyzer' as an attestation source — clone-derived L2 (license/maintenance) needs an honest label, not 'hand'", () => {
    expect(L2OverlaySchema.safeParse(l2({ attestation: { source: 'analyzer', refs: [], fetched_at: '2026-06-01' } })).success).toBe(true);
  });

  it('VulnSchema enforces severity enum and required fields', () => {
    expect(VulnSchema.safeParse({ id: 'CVE-1', severity: 'critical', affected: '1.0', summary: 's' }).success).toBe(true);
    expect(VulnSchema.safeParse({ id: 'CVE-1', severity: 'apocalyptic', affected: '1.0', summary: 's' }).success).toBe(false);
    expect(VulnSchema.safeParse({ id: 'CVE-1', severity: 'high', summary: 's' }).success).toBe(false);
  });

  it('transitive_risk accepts null or a string, and defaults to null when omitted (overlay ergonomics)', () => {
    expect(L2OverlaySchema.safeParse(l2({ transitive_risk: 'pulled transitively' })).success).toBe(true);
    expect(L2OverlaySchema.safeParse(l2({ transitive_risk: null })).success).toBe(true);
    const { transitive_risk, ...without } = l2() as Record<string, unknown>;
    void transitive_risk;
    const r = L2OverlaySchema.safeParse(without);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.transitive_risk).toBeNull();
  });
});

describe('L3PolicySchema / L3RuleSchema', () => {
  it('parses a policy with rules and defaults rules to []', () => {
    expect(L3PolicySchema.safeParse({ org: 'acme' }).success).toBe(true);
    const r = L3PolicySchema.safeParse({ org: 'acme', rules: [{ id: 'r1', decision: 'deny', match: { license_risk: 'copyleft-strong' }, rationale: 'no AGPL' }] });
    expect(r.success).toBe(true);
  });

  it('rejects an out-of-domain decision', () => {
    expect(L3RuleSchema.safeParse({ id: 'r', decision: 'nuke', match: { package: 'x' }, rationale: 'y' }).success).toBe(false);
  });

  it('accepts diy_category match rules', () => {
    const r = L3RuleSchema.safeParse({
      id: 'diy-authentication',
      decision: 'deny',
      match: { diy_category: 'authentication' },
      rationale: 'use Clerk/Auth0',
    });
    expect(r.success).toBe(true);
  });
});

describe('evaluateDiyPolicy', () => {
  it('returns none when no policy or no diy rules', () => {
    expect(evaluateDiyPolicy(null, 'authentication')).toEqual({ decision: 'none' });
    expect(evaluateDiyPolicy({ org: 'acme', rules: [] }, 'authentication')).toEqual({ decision: 'none' });
  });

  it('matches diy_category rules and ignores package rules', () => {
    const policy: L3Policy = {
      org: 'acme',
      rules: [
        { id: 'pkg-x', decision: 'deny', match: { package: 'lodash' }, rationale: 'banned' },
        { id: 'diy-auth', decision: 'deny', match: { diy_category: 'authentication' }, rationale: 'no DIY auth' },
      ],
    };
    expect(evaluateDiyPolicy(policy, 'authentication')).toEqual({
      decision: 'deny',
      rule_id: 'diy-auth',
      rationale: 'no DIY auth',
    });
    expect(evaluateDiyPolicy(policy, 'caching')).toEqual({ decision: 'none' });
  });
});
