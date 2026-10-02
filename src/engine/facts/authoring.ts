import {
  L2OverlaySchema,
  L3RuleSchema,
  L3PolicySchema,
  type L2Overlay,
  type L3Rule,
  type L3Policy,
  type Vuln,
} from '@starloghq/facts-schema';
import { CapabilityManifestSchema, type CapabilityManifest } from '../../manifest/schema.js';

/**
 * PURE authoring layer — constructs schema-valid L2 overlays and L3 rules from
 * minimal CLI input, and upserts them into the on-disk file shapes the loaders
 * read. NO file I/O, NO env reads, NO CLI here (plan 11-02 wires these to
 * commander + atomicWrite).
 *
 * This is the seam that makes AUTH-02 (defaults fill the required L2 fields so
 * minimal `{license,status}` input validates against L2OverlaySchema) and
 * AUTH-04 (clear, actionable errors — never a silent default/skip) true and
 * unit-testable before any spawned-binary e2e.
 */

const MAINTENANCE = ['active', 'maintenance-only', 'deprecated', 'abandoned', 'compromised'] as const;
const LICENSE_RISK = ['none', 'copyleft-weak', 'copyleft-strong', 'unknown'] as const;
const SEVERITY = ['low', 'medium', 'high', 'critical'] as const;
const ECOSYSTEMS = ['npm', 'pypi', 'system'] as const;
const DECISIONS = ['allow', 'deny', 'flag'] as const;

/** Today as a YYYY-MM-DD date. MUST be slice(0,10) — z.iso.date() rejects a full timestamp. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface AddL2Input {
  package: string;
  license?: string;
  status?: string;
  ecosystem?: string;
  licenseRisk?: string;
  transitiveRisk?: string;
  vulns?: string[];
}

/**
 * The single L2 construction seam — assemble an overlay from already-RESOLVED
 * fields and validate it against L2OverlaySchema. Both the hand path
 * (buildL2FromInput, source='hand') and the analyzer path (ingest.buildDerivedL2,
 * source='analyzer') route through here so the shape + validation live in ONE
 * place. Defaults: source 'hand', fetched_at today(), ecosystem 'npm'. Throws a
 * clear, actionable Error surfacing the schema's own message (e.g. a bad
 * fetched_at) rather than a generic failure.
 */
export interface AssembleL2Fields {
  package: string;
  license: string;
  licenseRisk: string;
  maintenance: string;
  ecosystem?: string;
  knownVulns?: Vuln[];
  transitiveRisk?: string | null;
  source?: 'hand' | 'analyzer' | 'osv' | 'deps.dev' | 'scorecard';
  fetchedAt?: string;
  refs?: string[];
}

export function assembleL2(f: AssembleL2Fields): L2Overlay {
  const candidate = {
    package: f.package,
    ecosystem: f.ecosystem ?? 'npm',
    known_vulns: f.knownVulns ?? [],
    license: f.license,
    license_risk: f.licenseRisk,
    maintenance: f.maintenance,
    transitive_risk: f.transitiveRisk ?? null,
    attestation: { source: f.source ?? 'hand', refs: f.refs ?? [], fetched_at: f.fetchedAt ?? today() },
  };
  const r = L2OverlaySchema.safeParse(candidate);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error('Could not construct a valid L2 overlay: ' + why);
  }
  return r.data;
}

/**
 * Parse a `--vuln id:severity:summary` string. Splits on the FIRST TWO colons
 * only, so the summary may itself contain colons. `affected` defaults to
 * 'unspecified' (the flag is intentionally terse; refine via a full file later).
 */
export function parseVulnFlag(s: string): Vuln {
  const i = s.indexOf(':');
  const j = s.indexOf(':', i + 1);
  if (i === -1 || j === -1) {
    throw new Error(`Invalid --vuln "${s}": expected id:severity:summary (e.g. CVE-2024-1:high:RCE in parser).`);
  }
  const id = s.slice(0, i);
  const severity = s.slice(i + 1, j);
  const summary = s.slice(j + 1);
  if (!(SEVERITY as readonly string[]).includes(severity)) {
    throw new Error(`Invalid vuln severity "${severity}": use one of: ${SEVERITY.join(', ')}.`);
  }
  return { id, severity: severity as Vuln['severity'], affected: 'unspecified', summary };
}

/**
 * Build a schema-valid L2 overlay from minimal input, filling the required
 * fields with documented defaults. Throws a clear, actionable Error (AUTH-04)
 * on missing/invalid input rather than silently defaulting.
 */
export function buildL2FromInput(input: AddL2Input): L2Overlay {
  const license = input.license;
  if (!license) {
    throw new Error('Missing --license <spdx> (e.g. --license MIT). A private fact needs a license to be useful.');
  }
  const status = input.status;
  if (!status) {
    throw new Error('Missing --status <maintenance> — one of: ' + MAINTENANCE.join(', '));
  }
  if (!(MAINTENANCE as readonly string[]).includes(status)) {
    throw new Error('Invalid --status "' + status + '" — use one of: ' + MAINTENANCE.join(', '));
  }

  const licenseRisk = input.licenseRisk ?? 'none';
  if (!(LICENSE_RISK as readonly string[]).includes(licenseRisk)) {
    throw new Error('Invalid --license-risk "' + licenseRisk + '" — use one of: ' + LICENSE_RISK.join(', '));
  }

  const ecosystem = input.ecosystem ?? 'npm';
  if (!(ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
    throw new Error('Invalid --ecosystem "' + ecosystem + '" — use one of: ' + ECOSYSTEMS.join(', '));
  }

  const known_vulns = (input.vulns ?? []).map(parseVulnFlag);

  // Construction + validation go through the shared seam (source defaults to 'hand').
  return assembleL2({
    package: input.package,
    ecosystem,
    license,
    licenseRisk,
    maintenance: status,
    knownVulns: known_vulns,
    transitiveRisk: input.transitiveRisk ?? null,
  });
}

export interface PrivateFactsFile {
  l1: unknown[];
  l2: L2Overlay[];
}

export interface PushPayload {
  overlays: L2Overlay[];
  droppedOverlays: number;
  policy: L3Policy | null;
  policyInvalid: boolean;
}

/**
 * PURE: turn a parsed `facts push` file into the validated payload to send. Reads
 * `l2` (any extra keys like `l1` are ignored, so a `private-facts.json` works
 * directly) and `policy`. An optional `policyOverride` (e.g. the adopted
 * `.starlog/policy.json`, passed via `--policy`) wins over any in-file policy.
 * Invalid overlays are counted (`droppedOverlays`), never thrown; an invalid
 * policy yields `policy: null, policyInvalid: true` so the caller can warn rather
 * than push junk.
 */
export function buildPushPayload(fileObj: unknown, policyOverride?: unknown): PushPayload {
  const obj = fileObj && typeof fileObj === 'object' && !Array.isArray(fileObj) ? (fileObj as Record<string, unknown>) : {};
  const overlays: L2Overlay[] = [];
  let droppedOverlays = 0;
  for (const entry of Array.isArray(obj.l2) ? obj.l2 : []) {
    const r = L2OverlaySchema.safeParse(entry);
    if (r.success) overlays.push(r.data);
    else droppedOverlays++;
  }

  const policySource = policyOverride !== undefined ? policyOverride : obj.policy;
  let policy: L3Policy | null = null;
  let policyInvalid = false;
  if (policySource !== undefined) {
    const p = L3PolicySchema.safeParse(policySource);
    if (p.success) policy = p.data;
    else policyInvalid = true;
  }

  return { overlays, droppedOverlays, policy, policyInvalid };
}

/**
 * Upsert an L2 overlay into the `{ l1, l2 }` private-facts file shape. l1 and
 * unrelated l2 entries are preserved; the same-package l2 entry is replaced.
 * An absent/empty/malformed file object yields `{ l1: [], l2: [overlay] }`.
 */
export function upsertL2Entry(
  file: { l1?: unknown[]; l2?: unknown[] } | null | undefined,
  overlay: L2Overlay,
): { l1: unknown[]; l2: L2Overlay[] } {
  const l1 = Array.isArray(file?.l1) ? file!.l1 : [];
  const existing = (Array.isArray(file?.l2) ? file!.l2 : []) as L2Overlay[];
  const filtered = existing.filter((o) => o.package !== overlay.package);
  return { l1, l2: [...filtered, overlay] };
}

// ── DISCOVERY authoring (private corpus) ──────────────────────────────────────
//
// `facts add` makes an internal package VETTABLE (STARLOG_PRIVATE_FACTS). This
// mirror makes it DISCOVERABLE (STARLOG_PRIVATE_CORPUS) — so `search` surfaces the
// org's sanctioned package private-first for a capability query. The
// CapabilityManifest schema requires public-signal fields (health/quality) that
// are meaningless for an internal package; we fill honest zero/neutral defaults.
// They are NOT scorer inputs (keyword ranking keys on name/category/solves/
// best_for/stack), so defaulting them does not affect discoverability.

const INTEGRATION_EFFORT = ['drop-in', 'easy', 'moderate', 'significant', 'major'] as const;
const MANIFEST_ECOSYSTEMS = ['npm', 'pypi', 'both'] as const;

export interface AddManifestInput {
  package: string; // becomes id + default name
  solves?: string; // REQUIRED — the one line search matches a capability against
  name?: string;
  category?: string; // free-form; default 'other'
  ecosystem?: string; // npm | pypi | both; default npm
  stack?: string[]; // stack_affinity
  bestFor?: string[];
  skipWhen?: string[];
  effort?: string; // integration_effort; default 'moderate'
  repo?: string; // default null
  license?: string; // for the discovery card's health.license; default 'UNLICENSED'
  autoGenerated?: boolean; // true when derived (org sync); default false (hand-authored, e.g. corpus add)
}

/**
 * Build a schema-valid CapabilityManifest from minimal input, filling required
 * signal fields with honest defaults. Throws a clear, actionable Error on
 * missing/invalid input (mirrors buildL2FromInput's AUTH-04 contract).
 */
export function buildManifestFromInput(input: AddManifestInput): CapabilityManifest {
  const solves = input.solves?.trim();
  if (!solves) {
    throw new Error(
      'Missing --solves "<what it does>" — the one line agents match a capability query against. Without it the package is not discoverable.',
    );
  }
  const ecosystem = input.ecosystem ?? 'npm';
  if (!(MANIFEST_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
    throw new Error('Invalid --ecosystem "' + ecosystem + '" — use one of: ' + MANIFEST_ECOSYSTEMS.join(', '));
  }
  const effort = input.effort ?? 'moderate';
  if (!(INTEGRATION_EFFORT as readonly string[]).includes(effort)) {
    throw new Error('Invalid --effort "' + effort + '" — use one of: ' + INTEGRATION_EFFORT.join(', '));
  }

  const candidate = {
    id: input.package,
    name: input.name?.trim() || input.package,
    repo: input.repo ?? null,
    ecosystem,
    category: input.category?.trim() || 'other',
    solves,
    stack_affinity: input.stack ?? [],
    integration_effort: effort,
    best_for: input.bestFor ?? [],
    skip_when: input.skipWhen ?? [],
    hosted_alternative: null,
    alternative_ids: [],
    health: {
      stars: 0,
      weekly_downloads: 0,
      last_commit: today(),
      contributors: 0,
      license: input.license ?? 'UNLICENSED',
      open_issues: 0,
    },
    quality: { has_tests: false, has_docs: false, has_types: false, maintenance_status: 'active' as const },
    auto_generated: input.autoGenerated ?? false,
  };

  const r = CapabilityManifestSchema.safeParse(candidate);
  if (!r.success) {
    const why = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error('Internal: constructed manifest failed schema validation: ' + why);
  }
  return r.data;
}

/**
 * Upsert a manifest into the `{ manifests }` private-corpus file shape. Unrelated
 * entries are preserved; the same-id entry is replaced. An absent/empty/malformed
 * file object yields `{ manifests: [manifest] }`.
 */
export function upsertManifestEntry(
  file: { manifests?: unknown[] } | null | undefined,
  manifest: CapabilityManifest,
): { manifests: CapabilityManifest[] } {
  const existing = (Array.isArray(file?.manifests) ? file!.manifests : []) as CapabilityManifest[];
  const filtered = existing.filter((m) => m.id !== manifest.id);
  return { manifests: [...filtered, manifest] };
}

/** Stable rule id for a package — re-running policy UPSERTS, never duplicates. */
export function ruleIdFor(pkg: string): string {
  return 'pkg-' + pkg;
}

/**
 * Build a schema-valid L3 rule from a package + verdict (+ optional reason).
 * Throws a clear Error (AUTH-04) on a bad verdict.
 */
export function buildL3Rule(pkg: string, decision: string, reason?: string): L3Rule {
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    throw new Error('Invalid verdict "' + decision + '" — use one of: allow, deny, flag');
  }
  const candidate = {
    id: ruleIdFor(pkg),
    decision,
    match: { package: pkg },
    rationale: reason && reason.trim() ? reason : 'Set via starlog facts policy.',
  };
  const r = L3RuleSchema.safeParse(candidate);
  if (!r.success) throw new Error('Internal: constructed L3 rule failed schema validation.');
  return r.data;
}

/** Stable rule id for a DIY capability category. */
export function diyRuleIdFor(category: string): string {
  return 'diy-' + category;
}

/**
 * Build a schema-valid L3 rule that targets hand-rolled DIY code for a capability.
 */
export function buildDiyL3Rule(category: string, decision: string, reason?: string): L3Rule {
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    throw new Error('Invalid verdict "' + decision + '" — use one of: allow, deny, flag');
  }
  const candidate = {
    id: diyRuleIdFor(category),
    decision,
    match: { diy_category: category },
    rationale: reason && reason.trim() ? reason : 'Set via starlog facts diy-policy.',
  };
  const r = L3RuleSchema.safeParse(candidate);
  if (!r.success) throw new Error('Internal: constructed DIY L3 rule failed schema validation.');
  return r.data;
}

/**
 * Upsert an L3 rule into the `{ org, rules }` policy file shape. The org field
 * and unrelated rules are preserved; the rule with the same id is replaced. A
 * null/absent policy yields `{ org: 'local', rules: [rule] }`.
 */
export function upsertPolicy(
  policy: { org?: string; rules?: unknown[] } | null | undefined,
  rule: L3Rule,
): L3Policy {
  const org = policy?.org && typeof policy.org === 'string' ? policy.org : 'local';
  const existing = (Array.isArray(policy?.rules) ? policy!.rules : []) as L3Rule[];
  const filtered = existing.filter((r) => r.id !== rule.id);
  const p = L3PolicySchema.safeParse({ org, rules: [...filtered, rule] });
  if (!p.success) throw new Error('Internal: constructed L3 policy failed schema validation.');
  return p.data;
}
