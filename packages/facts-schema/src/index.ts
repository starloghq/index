import { z } from 'zod/v4';

/**
 * @starloghq/facts-schema — the CANONICAL facts contract.
 *
 * The single source of truth for the L1/L2/L3 facts model, imported by BOTH the
 * starlog-index client AND the starlog-api worker (and any future analyzer /
 * OSV ingester). Zero deps except zod, so it bundles cleanly into a Cloudflare
 * Worker. Schemas + pure policy semantics only — NO data, sources, composition
 * I/O, or transport. Those live in the consuming app.
 *
 * Layer invariants (do not collapse):
 *   L1 capability — IMMUTABLE: no freshness field. Future: content-addressed.
 *   L2 overlay    — MUTABLE: freshness in attestation.fetched_at, only here.
 *   L3 policy     — org suitability; computed from L1+L2, never baked in.
 */

// ── shared ──────────────────────────────────────────────────────────────────
export const EcosystemSchema = z.enum(['npm', 'pypi', 'system']);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

// ── L1 — capability facts (immutable) ─────────────────────────────────────────
export const L1ProvenanceSchema = z.object({
  derived_by: z.enum(['hand', 'analyzer']), // 'analyzer' = future deterministic L1 pass
  source: z.string(),
  verified: z.boolean(),
});
export type L1Provenance = z.infer<typeof L1ProvenanceSchema>;

export const L1CapabilityFactSchema = z.object({
  package: z.string(),
  ecosystem: EcosystemSchema.default('npm'),
  version_range: z.string().nullable().default(null),
  artifact_sha256: z.string().nullable().default(null), // FUTURE content-addressing key
  effect_surface: z.string(),
  capabilities: z.array(z.string()).default([]),
  provenance: L1ProvenanceSchema,
  // NO freshness field — L1 is immutable.
});
export type L1CapabilityFact = z.infer<typeof L1CapabilityFactSchema>;

// ── L2 — reputation/vuln overlay (mutable) ────────────────────────────────────
export const VulnSchema = z.object({
  id: z.string(), // CVE / GHSA id, or "INCIDENT:<slug>"
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  affected: z.string(),
  summary: z.string(),
});
export type Vuln = z.infer<typeof VulnSchema>;

export const L2AttestationSchema = z.object({
  source: z.enum(['hand', 'analyzer', 'osv', 'deps.dev', 'scorecard']), // producers set this ('analyzer' = clone-derived, mirrors L1 derived_by)
  refs: z.array(z.string()).default([]), // advisory ids / hash-pinned overlay digests
  fetched_at: z.iso.date({ error: 'fetched_at must be a valid ISO date (YYYY-MM-DD)' }), // the freshness gate
});
export type L2Attestation = z.infer<typeof L2AttestationSchema>;

export const L2OverlaySchema = z.object({
  package: z.string(),
  ecosystem: EcosystemSchema.default('npm'),
  known_vulns: z.array(VulnSchema).default([]),
  license: z.string(),
  license_risk: z.enum(['none', 'copyleft-weak', 'copyleft-strong', 'unknown']),
  maintenance: z.enum(['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised']),
  transitive_risk: z.string().nullable().default(null),
  attestation: L2AttestationSchema,
});
export type L2Overlay = z.infer<typeof L2OverlaySchema>;

// ── L3 — org policy / governance (mutable, org-owned) ─────────────────────────
export const L3DecisionSchema = z.enum(['deny', 'flag', 'allow']);
export type L3Decision = z.infer<typeof L3DecisionSchema>;

export const L3RuleSchema = z.object({
  id: z.string(),
  decision: L3DecisionSchema,
  match: z.object({
    package: z.string().optional(),
    license_risk: z.enum(['none', 'copyleft-weak', 'copyleft-strong', 'unknown']).optional(),
    maintenance: z.enum(['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised']).optional(),
    has_known_vulns: z.boolean().optional(),
    capability: z.string().optional(),
    /** Block or flag hand-rolled DIY code for a capability category (e.g. authentication). */
    diy_category: z.string().optional(),
  }),
  rationale: z.string(),
});
export type L3Rule = z.infer<typeof L3RuleSchema>;

export const L3PolicySchema = z.object({
  org: z.string(),
  rules: z.array(L3RuleSchema).default([]),
});
export type L3Policy = z.infer<typeof L3PolicySchema>;

export interface L3Verdict {
  decision: L3Decision | 'none'; // 'none' = no policy / no rule fired
  rule_id?: string;
  rationale?: string;
}

/**
 * Canonical policy evaluation — pure, no I/O. First matching rule wins; no
 * policy / no match → { decision: 'none' }. Shared so the client and any server
 * agree on policy semantics. Per the contract, evaluation runs CLIENT-SIDE.
 */
export function evaluatePolicy(
  policy: L3Policy | null | undefined,
  facts: { l1: L1CapabilityFact | null; l2: L2Overlay | null },
): L3Verdict {
  if (!policy || policy.rules.length === 0) return { decision: 'none' };
  for (const rule of policy.rules) {
    if (ruleMatches(rule, facts)) {
      return { decision: rule.decision, rule_id: rule.id, rationale: rule.rationale };
    }
  }
  return { decision: 'none' };
}

function ruleMatches(rule: L3Rule, { l1, l2 }: { l1: L1CapabilityFact | null; l2: L2Overlay | null }): boolean {
  const m = rule.match;
  // DIY-category rules are evaluated separately via evaluateDiyPolicy.
  if (m.diy_category !== undefined) return false;
  if (m.package !== undefined && m.package !== (l1?.package ?? l2?.package)) return false;
  if (m.license_risk !== undefined && m.license_risk !== l2?.license_risk) return false;
  if (m.maintenance !== undefined && m.maintenance !== l2?.maintenance) return false;
  if (m.has_known_vulns !== undefined && m.has_known_vulns !== ((l2?.known_vulns.length ?? 0) > 0)) return false;
  if (m.capability !== undefined && !(l1?.capabilities ?? []).includes(m.capability)) return false;
  return Object.values(m).some((v) => v !== undefined); // empty match must not fire
}

export interface DiyPolicyVerdict {
  decision: L3Decision | 'none';
  rule_id?: string;
  rationale?: string;
}

/**
 * Evaluate org policy rules that target hand-rolled DIY capability code.
 * First matching diy_category rule wins; package/facts rules are ignored here.
 */
export function evaluateDiyPolicy(
  policy: L3Policy | null | undefined,
  category: string,
): DiyPolicyVerdict {
  if (!policy || policy.rules.length === 0) return { decision: 'none' };
  for (const rule of policy.rules) {
    if (rule.match.diy_category !== undefined && rule.match.diy_category === category) {
      return { decision: rule.decision, rule_id: rule.id, rationale: rule.rationale };
    }
  }
  return { decision: 'none' };
}

// ── FactView — the composed serve/API shape (the GET /facts envelope) ─────────
export interface FactView {
  package: string;
  ecosystem: Ecosystem;
  l1: L1CapabilityFact | null;
  l2: L2Overlay | null;
  l3: L3Verdict;
}
