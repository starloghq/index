import { describe, it, expect } from 'vitest';
import { L2OverlaySchema, L3RuleSchema } from '@starloghq/facts-schema';
import { CapabilityManifestSchema } from '../../manifest/schema.js';
import {
  assembleL2,
  buildPushPayload,
  buildL2FromInput,
  parseVulnFlag,
  upsertL2Entry,
  buildManifestFromInput,
  upsertManifestEntry,
  buildL3Rule,
  buildDiyL3Rule,
  ruleIdFor,
  upsertPolicy,
  type AddL2Input,
} from './authoring.js';

describe('buildPushPayload (facts push file → validated {overlays, policy})', () => {
  const ov = buildL2FromInput({ package: 'x', license: 'MIT', status: 'active' });
  const pol = { org: 'acme', rules: [{ id: 'pkg-x', decision: 'flag', match: { package: 'x' }, rationale: 'r' }] };

  it('reads valid l2 overlays from the file (and ignores l1 — accepts private-facts.json directly)', () => {
    const r = buildPushPayload({ l1: [{ package: 'cap' }], l2: [ov] });
    expect(r.overlays).toHaveLength(1);
    expect(r.droppedOverlays).toBe(0);
    expect(r.policy).toBeNull(); // no policy in private-facts.json
  });

  it('counts invalid overlays as dropped rather than throwing', () => {
    const r = buildPushPayload({ l2: [ov, { package: 'bad' /* missing required fields */ }] });
    expect(r.overlays).toHaveLength(1);
    expect(r.droppedOverlays).toBe(1);
  });

  it('takes policy from the same file when present', () => {
    const r = buildPushPayload({ l2: [ov], policy: pol });
    expect(r.policy?.org).toBe('acme');
    expect(r.policyInvalid).toBe(false);
  });

  it('a policy OVERRIDE (e.g. adopted policy.json) wins over the file policy', () => {
    const adopted = { org: 'acme', rules: [{ id: 'pkg-y', decision: 'deny', match: { package: 'y' }, rationale: 'banned' }] };
    const r = buildPushPayload({ l2: [ov], policy: pol }, adopted);
    expect(r.policy?.rules[0].match.package).toBe('y');
  });

  it('flags an invalid policy instead of pushing junk', () => {
    const r = buildPushPayload({ l2: [ov] }, { org: 123 /* invalid */ });
    expect(r.policy).toBeNull();
    expect(r.policyInvalid).toBe(true);
  });
});

describe('assembleL2 (shared L2 construction seam)', () => {
  it('builds a schema-valid overlay, defaulting source=hand + today() + npm + [] + null', () => {
    const o = assembleL2({ package: 'x', license: 'MIT', licenseRisk: 'none', maintenance: 'active' });
    expect(L2OverlaySchema.safeParse(o).success).toBe(true);
    expect(o.attestation.source).toBe('hand');
    expect(o.ecosystem).toBe('npm');
    expect(o.known_vulns).toEqual([]);
    expect(o.transitive_risk).toBeNull();
    expect(o.attestation.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('honors an analyzer source + injected fetched_at (the org-sync case)', () => {
    const o = assembleL2({ package: 'x', license: 'MIT', licenseRisk: 'none', maintenance: 'active', source: 'analyzer', fetchedAt: '2026-06-10' });
    expect(o.attestation.source).toBe('analyzer');
    expect(o.attestation.fetched_at).toBe('2026-06-10');
  });

  it('surfaces the schema error (e.g. a bad fetched_at) rather than a generic failure', () => {
    expect(() => assembleL2({ package: 'x', license: 'MIT', licenseRisk: 'none', maintenance: 'active', fetchedAt: 'nope' })).toThrow(/fetched_at/i);
  });
});

/**
 * Unit tests for the PURE authoring layer (plan 11-01). These prove AUTH-02
 * (minimal input + constructed defaults validates against L2OverlaySchema) and
 * AUTH-04 (clear, actionable errors on bad input — never a silent default/skip)
 * at the function layer, before any spawned-binary e2e.
 */

describe('buildL2FromInput (AUTH-02 defaults + AUTH-04 errors)', () => {
  it('minimal { license, status } input produces an object that passes L2OverlaySchema', () => {
    const overlay = buildL2FromInput({ package: 'x', license: 'MIT', status: 'active' });
    expect(L2OverlaySchema.safeParse(overlay).success).toBe(true);
  });

  it('fills the documented defaults from minimal input', () => {
    const overlay = buildL2FromInput({ package: 'x', license: 'MIT', status: 'active' });
    expect(overlay.package).toBe('x');
    expect(overlay.ecosystem).toBe('npm');
    expect(overlay.known_vulns).toEqual([]);
    expect(overlay.license).toBe('MIT');
    expect(overlay.license_risk).toBe('none');
    expect(overlay.maintenance).toBe('active');
    expect(overlay.transitive_risk).toBeNull();
    expect(overlay.attestation.source).toBe('hand');
    expect(overlay.attestation.refs).toEqual([]);
    expect(overlay.attestation.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('threads transitive_risk through when provided', () => {
    const overlay = buildL2FromInput({ package: 'x', license: 'MIT', status: 'active', transitiveRisk: 'pulls in left-pad' });
    expect(overlay.transitive_risk).toBe('pulls in left-pad');
  });

  it('throws "Missing --license" when license is absent', () => {
    expect(() => buildL2FromInput({ package: 'x' })).toThrow('Missing --license');
  });

  it('throws "Missing --status" listing the valid enum when status is absent', () => {
    expect(() => buildL2FromInput({ package: 'x', license: 'MIT' })).toThrow('Missing --status');
    expect(() => buildL2FromInput({ package: 'x', license: 'MIT' })).toThrow('maintenance-only');
  });

  it('throws "Invalid --status" listing the valid enum on a bad status', () => {
    expect(() => buildL2FromInput({ package: 'x', license: 'MIT', status: 'bogus' })).toThrow('Invalid --status');
    expect(() => buildL2FromInput({ package: 'x', license: 'MIT', status: 'bogus' })).toThrow(
      'active, maintenance-only, deprecated, abandoned, compromised',
    );
  });

  it('throws "Invalid --license-risk" on a bad license_risk', () => {
    expect(() =>
      buildL2FromInput({ package: 'x', license: 'MIT', status: 'active', licenseRisk: 'weird' }),
    ).toThrow('Invalid --license-risk');
  });

  it('throws "Invalid --ecosystem" listing the valid enum on a bad ecosystem', () => {
    const bad: AddL2Input = { package: 'x', license: 'MIT', status: 'active', ecosystem: 'moon' };
    expect(() => buildL2FromInput(bad)).toThrow('Invalid --ecosystem');
    expect(() => buildL2FromInput(bad)).toThrow('npm, pypi, system');
  });

  it('parses --vuln strings into known_vulns', () => {
    const overlay = buildL2FromInput({
      package: 'x',
      license: 'MIT',
      status: 'active',
      vulns: ['CVE-1:high:Some summary'],
    });
    expect(overlay.known_vulns).toEqual([
      { id: 'CVE-1', severity: 'high', affected: 'unspecified', summary: 'Some summary' },
    ]);
  });
});

describe('parseVulnFlag', () => {
  it('parses id:severity:summary, defaulting affected to "unspecified"', () => {
    expect(parseVulnFlag('CVE-1:high:Some summary')).toEqual({
      id: 'CVE-1',
      severity: 'high',
      affected: 'unspecified',
      summary: 'Some summary',
    });
  });

  it('splits on the first two colons only (summary may contain colons)', () => {
    expect(parseVulnFlag('CVE-2:critical:RCE: drop tables; see GHSA-xxxx')).toEqual({
      id: 'CVE-2',
      severity: 'critical',
      affected: 'unspecified',
      summary: 'RCE: drop tables; see GHSA-xxxx',
    });
  });

  it('throws "Invalid vuln severity" on a bad severity', () => {
    expect(() => parseVulnFlag('CVE-1:nope:x')).toThrow('Invalid vuln severity');
  });

  it('throws "Invalid --vuln" with the expected format on a string with no colons', () => {
    expect(() => parseVulnFlag('garbage')).toThrow('Invalid --vuln');
    expect(() => parseVulnFlag('garbage')).toThrow('id:severity:summary');
  });
});

describe('upsertL2Entry (preserve l1 + other l2, replace by package)', () => {
  const overlayFor = (pkg: string) =>
    buildL2FromInput({ package: pkg, license: 'MIT', status: 'active' });

  it('preserves l1 unchanged and replaces only the same-package l2 entry', () => {
    const A = { package: 'l1-pkg' };
    const X = overlayFor('pkgA');
    const Y = overlayFor('pkgB');
    const newX = buildL2FromInput({ package: 'pkgA', license: 'Apache-2.0', status: 'deprecated' });
    const result = upsertL2Entry({ l1: [A], l2: [X, Y] }, newX);
    expect(result.l1).toEqual([A]);
    expect(result.l2).toHaveLength(2);
    const pkgA = result.l2.find((o) => o.package === 'pkgA');
    const pkgB = result.l2.find((o) => o.package === 'pkgB');
    expect(pkgA?.license).toBe('Apache-2.0');
    expect(pkgA?.maintenance).toBe('deprecated');
    expect(pkgB).toEqual(Y);
  });

  it('creates { l1: [], l2: [overlay] } from an absent/empty file object', () => {
    const overlay = overlayFor('newpkg');
    expect(upsertL2Entry({}, overlay)).toEqual({ l1: [], l2: [overlay] });
    expect(upsertL2Entry(null, overlay)).toEqual({ l1: [], l2: [overlay] });
    expect(upsertL2Entry(undefined, overlay)).toEqual({ l1: [], l2: [overlay] });
  });
});

describe('buildL3Rule + upsertPolicy (AUTH-03 authoring)', () => {
  it('builds a rule passing L3RuleSchema with id pkg-<package>', () => {
    const rule = buildL3Rule('@acme/x', 'deny', 'banned by security');
    expect(L3RuleSchema.safeParse(rule).success).toBe(true);
    expect(rule.id).toBe('pkg-@acme/x');
    expect(rule.decision).toBe('deny');
    expect(rule.match).toEqual({ package: '@acme/x' });
    expect(rule.rationale).toBe('banned by security');
  });

  it('defaults rationale to a non-empty string when no reason is given', () => {
    const rule = buildL3Rule('@acme/x', 'allow');
    expect(rule.rationale.length).toBeGreaterThan(0);
  });

  it('defaults rationale when reason is whitespace-only', () => {
    const rule = buildL3Rule('@acme/x', 'flag', '   ');
    expect(rule.rationale.length).toBeGreaterThan(0);
    expect(rule.rationale.trim()).not.toBe('');
  });

  it('throws "Invalid verdict" listing allow, deny, flag on a bad decision', () => {
    expect(() => buildL3Rule('@acme/x', 'nope')).toThrow('Invalid verdict');
    expect(() => buildL3Rule('@acme/x', 'nope')).toThrow('allow, deny, flag');
  });

  it('ruleIdFor produces a stable pkg-<package> id', () => {
    expect(ruleIdFor('@acme/x')).toBe('pkg-@acme/x');
  });

  it('creates { org: "local", rules: [rule] } from a null policy', () => {
    const rule = buildL3Rule('@acme/x', 'deny');
    expect(upsertPolicy(null, rule)).toEqual({ org: 'local', rules: [rule] });
  });

  it('preserves org + other rules and upserts by id', () => {
    const otherRule = buildL3Rule('@acme/other', 'allow', 'fine');
    const oldRule = buildL3Rule('@acme/x', 'flag', 'old reason');
    const newRule = buildL3Rule('@acme/x', 'deny', 'new reason');
    const result = upsertPolicy({ org: 'acme', rules: [otherRule, oldRule] }, newRule);
    expect(result.org).toBe('acme');
    expect(result.rules).toHaveLength(2);
    expect(result.rules.find((r) => r.id === 'pkg-@acme/other')).toEqual(otherRule);
    const upserted = result.rules.find((r) => r.id === 'pkg-@acme/x');
    expect(upserted?.decision).toBe('deny');
    expect(upserted?.rationale).toBe('new reason');
  });
});

describe('buildDiyL3Rule (DIY policy authoring)', () => {
  it('builds a diy_category rule passing L3RuleSchema', () => {
    const rule = buildDiyL3Rule('authentication', 'deny', 'use Clerk/Auth0');
    expect(L3RuleSchema.safeParse(rule).success).toBe(true);
    expect(rule.id).toBe('diy-authentication');
    expect(rule.match).toEqual({ diy_category: 'authentication' });
    expect(rule.decision).toBe('deny');
  });

  it('throws on invalid verdict', () => {
    expect(() => buildDiyL3Rule('authentication', 'nuke')).toThrow('Invalid verdict');
  });
});

describe('buildManifestFromInput — DISCOVERY authoring (defaults + errors)', () => {
  it('minimal { package, solves } produces a manifest that passes CapabilityManifestSchema', () => {
    const m = buildManifestFromInput({ package: '@acme/flags', solves: 'Feature flags for Acme services' });
    expect(CapabilityManifestSchema.safeParse(m).success).toBe(true);
  });

  it('fills documented defaults (id=name=package, npm, moderate, null repo, neutral signals)', () => {
    const m = buildManifestFromInput({ package: '@acme/flags', solves: 'Feature flags' });
    expect(m.id).toBe('@acme/flags');
    expect(m.name).toBe('@acme/flags');
    expect(m.repo).toBeNull();
    expect(m.ecosystem).toBe('npm');
    expect(m.category).toBe('other');
    expect(m.integration_effort).toBe('moderate');
    expect(m.stack_affinity).toEqual([]);
    expect(m.best_for).toEqual([]);
    expect(m.hosted_alternative).toBeNull();
    expect(m.quality.maintenance_status).toBe('active');
    expect(m.health.stars).toBe(0);
  });

  it('defaults auto_generated to false (hand-authored), and honors autoGenerated:true (org-sync)', () => {
    expect(buildManifestFromInput({ package: 'x', solves: 'does a thing' }).auto_generated).toBe(false);
    expect(buildManifestFromInput({ package: 'x', solves: 'does a thing', autoGenerated: true }).auto_generated).toBe(true);
  });

  it('carries through the discovery-relevant fields verbatim', () => {
    const m = buildManifestFromInput({
      package: '@acme/flags',
      solves: 'Feature flags and remote config',
      name: 'Acme Flags',
      category: 'feature-flags',
      stack: ['node', 'next.js'],
      bestFor: ['gradual rollout', 'kill switches'],
      skipWhen: ['static config'],
      effort: 'easy',
      ecosystem: 'both',
      repo: 'acme/flags',
      license: 'MIT',
    });
    expect(m.name).toBe('Acme Flags');
    expect(m.category).toBe('feature-flags');
    expect(m.stack_affinity).toEqual(['node', 'next.js']);
    expect(m.best_for).toEqual(['gradual rollout', 'kill switches']);
    expect(m.integration_effort).toBe('easy');
    expect(m.ecosystem).toBe('both');
    expect(m.repo).toBe('acme/flags');
    expect(m.health.license).toBe('MIT');
  });

  it('throws an actionable error when --solves is missing or blank (not discoverable)', () => {
    expect(() => buildManifestFromInput({ package: 'x' })).toThrow('--solves');
    expect(() => buildManifestFromInput({ package: 'x', solves: '   ' })).toThrow('--solves');
  });

  it('throws "Invalid --effort" / "Invalid --ecosystem" listing the allowed values', () => {
    expect(() => buildManifestFromInput({ package: 'x', solves: 's', effort: 'huge' })).toThrow('Invalid --effort');
    expect(() => buildManifestFromInput({ package: 'x', solves: 's', ecosystem: 'cargo' })).toThrow('Invalid --ecosystem');
  });
});

describe('upsertManifestEntry — { manifests } private-corpus shape', () => {
  const mk = (id: string) => buildManifestFromInput({ package: id, solves: id + ' does things' });

  it('creates { manifests: [m] } from an absent/empty/malformed file object', () => {
    const m = mk('@acme/a');
    expect(upsertManifestEntry(null, m)).toEqual({ manifests: [m] });
    expect(upsertManifestEntry({}, m)).toEqual({ manifests: [m] });
    expect(upsertManifestEntry(undefined, m)).toEqual({ manifests: [m] });
  });

  it('preserves other entries and upserts by id (re-run replaces, never duplicates)', () => {
    const a = mk('@acme/a');
    const bOld = mk('@acme/b');
    const bNew = buildManifestFromInput({ package: '@acme/b', solves: 'updated', category: 'auth' });
    const result = upsertManifestEntry({ manifests: [a, bOld] }, bNew);
    expect(result.manifests).toHaveLength(2);
    expect(result.manifests.find((m) => m.id === '@acme/a')).toEqual(a);
    expect(result.manifests.find((m) => m.id === '@acme/b')?.category).toBe('auth');
  });
});
