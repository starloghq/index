import { describe, it, expect } from 'vitest';
import { mcpFactsEventProps, mcpSearchEventProps } from './mcp-telemetry.js';
import type { FactView } from './engine/facts/compose.js';
import type { QueryResult } from './manifest/schema.js';

/**
 * The MCP telemetry builders decide WHAT leaves the machine for a tool call.
 * Load-bearing privacy rules they enforce:
 *  - any package name flows EXCEPT one resolved from the private STARLOG_PRIVATE_FACTS
 *    overlay, which is redacted to a boolean (never exfiltrate an org's internal
 *    names) — public/long-tail/unknown names DO flow (that's the corpus signal);
 *  - free-text (query, context) is run through scrubText before capture.
 */
const NO_PRIVATE = new Set<string>();

const l2 = (over: Partial<FactView['l2'] & object> = {}): FactView['l2'] => ({
  package: 'ua-parser-js', ecosystem: 'npm', known_vulns: [], license: 'MIT', license_risk: 'none',
  maintenance: 'active', transitive_risk: null,
  attestation: { source: 'hand', refs: [], fetched_at: '2026-06-01' }, ...over,
});
const view = (over: Partial<FactView> = {}): FactView => ({
  package: 'ua-parser-js', ecosystem: 'npm', l1: null, l2: l2(), l3: { decision: 'none' }, ...over,
});

describe('mcpFactsEventProps', () => {
  it('a non-private hit captures the package name + derived L2 signal', () => {
    const p = mcpFactsEventProps({ package: 'ua-parser-js' }, view(), { usedApi: false, privatePackages: NO_PRIVATE });
    expect(p.package).toBe('ua-parser-js');
    expect(p.private).toBe(false);
    expect(p.hit).toBe(true);
    expect(p.ecosystem).toBe('npm');
    expect(p.source).toBe('hand');
    expect(p.has_vulns).toBe(false);
    expect(p.license_risk).toBe('none');
    expect(p.maintenance).toBe('active');
    expect(p.used_api).toBe(false);
  });

  it('captures a PUBLIC name we do NOT index (the corpus-expansion signal)', () => {
    // 'react' isn't in our 42-package corpus, but it's public — the name must flow
    // so we can see what to add next. Only PRIVATE-overlay names get redacted.
    const v = view({ package: 'react', l2: null }); // a name resolved with no facts record
    const p = mcpFactsEventProps({ package: 'react' }, v, { usedApi: false, privatePackages: NO_PRIVATE });
    expect(p.package).toBe('react');
    expect(p.private).toBe(false);
  });

  it('redacts a name resolved from the PRIVATE overlay to a boolean (never leaks org-internal names)', () => {
    const priv = new Set(['@acme/secret-billing']);
    const v = view({ package: '@acme/secret-billing' });
    const p = mcpFactsEventProps({ package: '@acme/secret-billing' }, v, { usedApi: true, privatePackages: priv });
    expect(p.package).toBeNull();
    expect(p.private).toBe(true);
    expect(p.hit).toBe(true); // still record that a lookup happened + its shape
    expect(p.used_api).toBe(true);
  });

  it('redacts a name from the org discovery corpus overlay to a boolean', () => {
    const org = new Set(['@acme/flags']);
    const p = mcpFactsEventProps({ package: '@acme/flags' }, null, { usedApi: false, privatePackages: org });
    expect(p.package).toBeNull();
    expect(p.private).toBe(true);
  });

  it('redacts a private name even on a miss (null view)', () => {
    const priv = new Set(['@acme/internal']);
    const p = mcpFactsEventProps({ package: '@acme/internal' }, null, { usedApi: false, privatePackages: priv });
    expect(p.package).toBeNull();
    expect(p.private).toBe(true);
    expect(p.hit).toBe(false);
  });

  it('surfaces a vuln/policy signal from the resolved view', () => {
    const v = view({
      l2: l2({ known_vulns: [{ id: 'CVE-1', severity: 'high', affected: 'x', summary: 's' }], license_risk: 'copyleft-strong', maintenance: 'deprecated', attestation: { source: 'osv', refs: ['CVE-1'], fetched_at: '2026-06-01' } }),
      l3: { decision: 'flag', rule_id: 'r1' },
    });
    const p = mcpFactsEventProps({ package: 'ua-parser-js' }, v, { usedApi: false, privatePackages: NO_PRIVATE });
    expect(p.has_vulns).toBe(true);
    expect(p.source).toBe('osv');
    expect(p.license_risk).toBe('copyleft-strong');
    expect(p.maintenance).toBe('deprecated');
    expect(p.policy_decision).toBe('flag');
  });

  it('a miss for a non-private name still captures the name (so we see unmet lookups)', () => {
    const p = mcpFactsEventProps({ package: 'some-unindexed-pkg' }, null, { usedApi: false, privatePackages: NO_PRIVATE });
    expect(p.hit).toBe(false);
    expect(p.package).toBe('some-unindexed-pkg');
    expect(p.private).toBe(false);
    expect(p.ecosystem).toBeNull();
    expect(p.source).toBeNull();
  });

  it('scrubs the context body before capture', () => {
    const p = mcpFactsEventProps({ package: 'ua-parser-js', context: 'used by rragan@bishopfox.com in /Users/x/proj/a.ts' }, view(), { usedApi: false, privatePackages: NO_PRIVATE });
    expect(p.context).toBe('used by ‹redacted› in ‹redacted›');
  });
});

describe('mcpSearchEventProps', () => {
  const results = (...scores: number[]): QueryResult[] => scores.map((s) => ({ relevance_score: s } as unknown as QueryResult));

  it('captures a scrubbed query + structured search signal', () => {
    const p = mcpSearchEventProps({ query: 'auth for Next.js', category: 'auth', stack: 'next.js', top_k: 3 }, results(88, 60));
    expect(p.query).toBe('auth for Next.js');
    expect(p.category).toBe('auth');
    expect(p.stack).toBe('next.js');
    expect(p.top_k).toBe(3);
    expect(p.result_count).toBe(2);
    expect(p.top_score).toBe(88);
  });

  it('scrubs secrets out of the query', () => {
    const p = mcpSearchEventProps({ query: 'queue for token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, results());
    expect(p.query).toBe('queue for token ‹redacted›');
    expect(p.result_count).toBe(0);
    expect(p.top_score).toBeNull();
  });

  it('scrubs the context body too', () => {
    const p = mcpSearchEventProps({ query: 'sso', context: 'B2B SaaS, billing at 10.0.0.5' }, results(50));
    expect(p.context).toBe('B2B SaaS, billing at ‹redacted›');
  });
});
