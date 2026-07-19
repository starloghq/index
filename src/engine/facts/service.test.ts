import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePackage, loadPrivateFacts, loadPolicy, buildComposeDeps, lookupFactView } from './service.js';
import { L1_FACTS } from './l1-data.js';

const KEYS = L1_FACTS.map((f) => f.package); // corpus order

describe('resolvePackage — EXACT-ONLY matcher semantics & regression guards', () => {
  it('exact name resolves; normalization (case + surrounding whitespace) is the only tolerance', () => {
    expect(resolvePackage('chalk', KEYS)).toBe('chalk');
    expect(resolvePackage('\t  GRAFANA \n', KEYS)).toBe('grafana');
    expect(resolvePackage('xz-utils', KEYS)).toBe('xz-utils'); // exact full name, not the "xz" abbrev
  });

  it('empty/whitespace query and genuine miss → null', () => {
    expect(resolvePackage('', KEYS)).toBeNull();
    expect(resolvePackage('   ', KEYS)).toBeNull();
    expect(resolvePackage('zzz-nonexistent', KEYS)).toBeNull();
  });

  it('normalizes the KEY symmetrically (trailing-whitespace key still matches)', () => {
    expect(resolvePackage('left-pad', ['  Left-Pad  '])).toBe('  Left-Pad  ');
  });

  it('skips an empty/whitespace-only key — it must not match every query', () => {
    expect(resolvePackage('totally-unrelated', ['   ', 'chalk'])).toBeNull();
    expect(resolvePackage('chalk', ['   ', 'chalk'])).toBe('chalk');
  });

  it('REGRESSION: NO fabrication — a non-exact query never returns another package', () => {
    // Vetting is by-NAME (`starlog_facts` takes `package`); NL/capability discovery
    // is `starlog_search`'s job. So fuzzy/substring/token matching is gone — every
    // one of these is a DIFFERENT package than any key and must miss honestly.
    expect(resolvePackage('@starloghq/facts-schema', ['q', 'express', 'chalk'])).toBeNull(); // scope contained "q"
    expect(resolvePackage('express-rate-limit', ['express'])).toBeNull();   // "express" was a leading token
    expect(resolvePackage('express rate limit', ['express'])).toBeNull();   // same class, whitespace form
    expect(resolvePackage('lodash.merge', ['lodash'])).toBeNull();          // ".merge" is a different pkg
    expect(resolvePackage('expres', ['express'])).toBeNull();               // typo, not a fuzzy hit
    expect(resolvePackage('should I use moment for dates', ['moment'])).toBeNull(); // NL → use search, not facts
  });

  it('REGRESSION: an org-private exact name resolves even when a public key could have loose-matched', () => {
    // The hero failure mode: public "auth" must never shadow org "@acme/auth".
    // Under exact-only this is automatic — only the exact key can match.
    expect(resolvePackage('@acme/auth', ['auth', '@acme/auth'])).toBe('@acme/auth');
    expect(resolvePackage('@acme/auth', ['@acme/auth', 'auth'])).toBe('@acme/auth');
    expect(resolvePackage('auth', ['auth', '@acme/auth'])).toBe('auth'); // a bare "auth" query still hits the public key exactly
  });
});

describe('loadPrivateFacts — independent L1 + L2 private inputs', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });
  const write = (obj: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-priv-'));
    const p = join(dir, 'private.json');
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
    return p;
  };
  const l1 = (pkg: string) => ({ package: pkg, ecosystem: 'npm', version_range: null, artifact_sha256: null, effect_surface: 'internal', capabilities: [], provenance: { derived_by: 'hand', source: 'acme', verified: true } });
  const l2 = (pkg: string) => ({ package: pkg, ecosystem: 'npm', known_vulns: [], license: 'UNLICENSED', license_risk: 'unknown', maintenance: 'active', transitive_risk: null, attestation: { source: 'hand', refs: ['acme internal'], fetched_at: '2026-06-01' } });

  it('unset path → empty maps', () => {
    expect(loadPrivateFacts(undefined)).toEqual({ l1: {}, l2: {} });
  });

  it('loads independent l1 and l2 arrays from one file', () => {
    const { l1: pl1, l2: pl2 } = loadPrivateFacts(write({ l1: [l1('@acme/auth')], l2: [l2('@acme/auth')] }));
    expect(pl1['@acme/auth']).toBeDefined();
    expect(pl2['@acme/auth']).toBeDefined();
  });

  it('skips an unverified private L1 fact but keeps verified ones', () => {
    const { l1: pl1 } = loadPrivateFacts(write({ l1: [{ ...l1('@acme/draft'), provenance: { derived_by: 'hand', source: 'a', verified: false } }, l1('@acme/ok')] }));
    expect(pl1['@acme/draft']).toBeUndefined();
    expect(pl1['@acme/ok']).toBeDefined();
  });

  it('skips a schema-malformed L2 entry without throwing', () => {
    const { l2: pl2 } = loadPrivateFacts(write({ l2: [{ package: '@acme/broken' }, l2('@acme/good')] }));
    expect(pl2['@acme/broken']).toBeUndefined();
    expect(pl2['@acme/good']).toBeDefined();
  });

  it('degrades to empty on missing file / bad JSON / non-object (never throws)', () => {
    expect(loadPrivateFacts(join(tmpdir(), 'nope-' + Date.now(), 'x.json'))).toEqual({ l1: {}, l2: {} });
    expect(loadPrivateFacts(write('{ not json'))).toEqual({ l1: {}, l2: {} });
    expect(loadPrivateFacts(write([1, 2, 3]))).toEqual({ l1: {}, l2: {} });
  });
});

describe('loadPolicy — independent L3 input', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });
  const write = (obj: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-pol-'));
    const p = join(dir, 'policy.json');
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
    return p;
  };

  it('unset path → null (no policy)', () => {
    expect(loadPolicy(undefined)).toBeNull();
  });

  it('loads a valid policy', () => {
    const pol = loadPolicy(write({ org: 'acme', rules: [{ id: 'r1', decision: 'deny', match: { license_risk: 'copyleft-strong' }, rationale: 'no AGPL' }] }));
    expect(pol?.org).toBe('acme');
    expect(pol?.rules).toHaveLength(1);
  });

  it('invalid / unreadable policy → null (never throws)', () => {
    expect(loadPolicy(write({ rules: 'nope' }))).toBeNull();
    expect(loadPolicy(write('{ bad'))).toBeNull();
  });
});

describe('loadPrivateFacts / loadPolicy — resolve ${CLAUDE_PROJECT_DIR} at runtime (issue #57)', () => {
  // The MCP server receives STARLOG_PRIVATE_FACTS / STARLOG_POLICY as literal
  // `${CLAUDE_PROJECT_DIR}/...` tokens (Claude Code does not expand them in the env
  // block), so the loaders must expand them from process.env at read time.
  let dir: string | null = null;
  let savedProj: string | undefined;
  beforeEach(() => { savedProj = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    if (savedProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProj;
  });

  it('loadPrivateFacts expands the literal ${CLAUDE_PROJECT_DIR} token', () => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-cpd-facts-'));
    writeFileSync(join(dir, 'private-facts.json'), JSON.stringify({
      l1: [{ package: '@acme/auth', ecosystem: 'npm', version_range: null, artifact_sha256: null, effect_surface: 'internal', capabilities: [], provenance: { derived_by: 'hand', source: 'acme', verified: true } }],
      l2: [],
    }), 'utf-8');
    process.env.CLAUDE_PROJECT_DIR = dir;
    const { l1 } = loadPrivateFacts('${CLAUDE_PROJECT_DIR}/private-facts.json');
    expect(l1['@acme/auth']).toBeDefined();
  });

  it('loadPolicy expands the literal ${CLAUDE_PROJECT_DIR} token', () => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-cpd-pol-'));
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({ org: 'acme', rules: [{ id: 'r1', decision: 'deny', match: { license_risk: 'copyleft-strong' }, rationale: 'no AGPL' }] }), 'utf-8');
    process.env.CLAUDE_PROJECT_DIR = dir;
    const pol = loadPolicy('${CLAUDE_PROJECT_DIR}/policy.json');
    expect(pol?.org).toBe('acme');
  });
});

describe('buildComposeDeps + lookupFactView (public, no env)', () => {
  it('resolves a public package to a composed view with both layers and a default L3 verdict', () => {
    const deps = buildComposeDeps({});
    const view = lookupFactView('ua-parser-js', deps);
    expect(view?.package).toBe('ua-parser-js');
    expect(view?.l1?.effect_surface).toBeTruthy();
    expect(view?.l2?.known_vulns[0].id).toContain('ua-parser-js');
    expect(view?.l3.decision).toBe('none');
  });

  it('a miss resolves to null', () => {
    expect(lookupFactView('no-such-pkg', buildComposeDeps({}))).toBeNull();
  });
});

describe('private L2 overlay over a public package — must not suppress the upstream CVE', () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } });
  const writePriv = (obj: unknown): string => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-overlay-'));
    const p = join(dir, 'private.json');
    writeFileSync(p, JSON.stringify(obj), 'utf-8');
    return p;
  };

  // ua-parser-js ships an upstream critical advisory in the public corpus
  // (INCIDENT:ua-parser-js-2021). An org overlay for the SAME package must
  // layer its own rulings WITHOUT dropping or downgrading that advisory.
  it('keeps the upstream critical vuln while applying the private org ruling and net-new advisory', () => {
    const path = writePriv({
      l2: [{
        package: 'ua-parser-js',
        ecosystem: 'npm',
        // org tries to downgrade the upstream incident + adds its own advisory
        known_vulns: [
          { id: 'INCIDENT:ua-parser-js-2021', severity: 'low', affected: '*', summary: 'we pin away from it' },
          { id: 'INCIDENT:acme-sbom-flag', severity: 'medium', affected: '*', summary: 'flagged by acme SBOM gate' },
        ],
        license: 'MIT',
        license_risk: 'none',
        maintenance: 'deprecated', // org ruling: scalar private-wins
        transitive_risk: null,
        attestation: { source: 'hand', refs: ['acme internal'], fetched_at: '2026-06-02' },
      }],
    });
    const view = lookupFactView('ua-parser-js', buildComposeDeps({ STARLOG_PRIVATE_FACTS: path }));
    const upstream = view?.l2?.known_vulns.find((v) => v.id === 'INCIDENT:ua-parser-js-2021');
    // base wins on the colliding id — the critical signal is NOT silently downgraded
    expect(upstream?.severity).toBe('critical');
    // union adds the org's net-new advisory
    expect(view?.l2?.known_vulns.map((v) => v.id)).toContain('INCIDENT:acme-sbom-flag');
    // scalar org ruling still wins
    expect(view?.l2?.maintenance).toBe('deprecated');
  });

  // The real-world harm of the suppression bug: a private overlay that records
  // no vulns silently flipped has_known_vulns to false, so a governance rule
  // gating on it stopped firing. This guards the verdict, not just the data.
  it('REGRESSION: a private overlay must not disable a has_known_vulns policy rule', () => {
    const privDir = mkdtempSync(join(tmpdir(), 'starlog-reg-priv-'));
    const polDir = mkdtempSync(join(tmpdir(), 'starlog-reg-pol-'));
    try {
      const privPath = join(privDir, 'private.json');
      writeFileSync(privPath, JSON.stringify({
        l2: [{
          package: 'ua-parser-js',
          ecosystem: 'npm',
          known_vulns: [], // org records ONLY a ruling, says nothing about vulns
          license: 'MIT',
          license_risk: 'none',
          maintenance: 'deprecated',
          transitive_risk: null,
          attestation: { source: 'hand', refs: ['acme internal'], fetched_at: '2026-06-02' },
        }],
      }), 'utf-8');
      const polPath = join(polDir, 'policy.json');
      writeFileSync(polPath, JSON.stringify({
        org: 'acme',
        rules: [{ id: 'flag-vulnerable', decision: 'flag', match: { has_known_vulns: true }, rationale: 'review packages with known vulns' }],
      }), 'utf-8');

      const deps = buildComposeDeps({ STARLOG_PRIVATE_FACTS: privPath, STARLOG_POLICY: polPath });
      const view = lookupFactView('ua-parser-js', deps);
      // upstream vuln survives the overlay, so the rule still fires
      expect(view?.l3.decision).toBe('flag');
      expect(view?.l3.rule_id).toBe('flag-vulnerable');
    } finally {
      rmSync(privDir, { recursive: true, force: true });
      rmSync(polDir, { recursive: true, force: true });
    }
  });
});
