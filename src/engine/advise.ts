import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QueryResult } from '../manifest/schema.js';
import type { FactView } from '../engine/facts/compose.js';
import { isDiyManifest, packageNameForManifest } from './package-aliases.js';
import { getPackageRoot } from '../paths.js';

const SAFE_MAINTENANCE = new Set(['active', 'maintained', 'maintenance-only']);
const UNSAFE_MAINTENANCE = new Set(['deprecated', 'abandoned', 'compromised']);
const HIGH_SEVERITY = new Set(['critical', 'high']);

export interface SafetyVerdict {
  safe: boolean;
  package_name: string;
  facts_available: boolean;
  reason: string;
}

export interface AssessSafetyOptions {
  /**
   * Minimum relevance score. Advise uses a lower bar (50) when results are
   * already category-filtered — keyword scores for "DIY JWT auth" rarely clear
   * 70 for Clerk/Auth0 even though they are the correct migrate targets.
   */
  minRelevance?: number;
}

/**
 * Determine whether a search result is a safe migration target.
 * Uses L2 facts when available; falls back to manifest quality signals when
 * facts are missing (common for corpus packages not yet in l2-data).
 */
export function assessPackageSafety(
  result: QueryResult,
  factView: FactView | null,
  opts: AssessSafetyOptions = {},
): SafetyVerdict {
  const manifest = result.manifest;
  const packageName = packageNameForManifest(manifest);
  const minRelevance = opts.minRelevance ?? 70;

  if (result.relevance_score < minRelevance) {
    return { safe: false, package_name: packageName, facts_available: !!factView, reason: 'relevance below threshold' };
  }

  if (isDiyManifest(manifest)) {
    return { safe: false, package_name: packageName, facts_available: !!factView, reason: 'DIY pattern manifest' };
  }

  if (factView?.l3?.decision === 'deny') {
    return { safe: false, package_name: packageName, facts_available: true, reason: 'org policy deny' };
  }

  if (factView?.l2) {
    const maint = factView.l2.maintenance;
    if (UNSAFE_MAINTENANCE.has(maint)) {
      return { safe: false, package_name: packageName, facts_available: true, reason: `maintenance: ${maint}` };
    }
    if (!SAFE_MAINTENANCE.has(maint)) {
      return { safe: false, package_name: packageName, facts_available: true, reason: `maintenance: ${maint}` };
    }
    const badVuln = factView.l2.known_vulns.some((v) => HIGH_SEVERITY.has(v.severity));
    if (badVuln) {
      return { safe: false, package_name: packageName, facts_available: true, reason: 'critical/high known vulns' };
    }
    return { safe: true, package_name: packageName, facts_available: true, reason: 'passed facts gate' };
  }

  // No L2 facts — use manifest quality as corpus-trust fallback; agent must still vet.
  const qMaint = manifest.quality.maintenance_status;
  if (qMaint === 'archived' || qMaint === 'slowing') {
    return { safe: false, package_name: packageName, facts_available: false, reason: `manifest quality: ${qMaint}` };
  }
  if (qMaint === 'active' || qMaint === 'maintained') {
    return {
      safe: true,
      package_name: packageName,
      facts_available: false,
      reason: 'corpus quality signals (vet with starlog_facts before adopting)',
    };
  }

  return { safe: false, package_name: packageName, facts_available: false, reason: 'insufficient safety evidence' };
}

export function loadPlaybookSteps(manifestId: string, category: string): string[] {
  const root = getPackageRoot();
  const candidates = [
    join(root, 'corpus-free', 'playbooks', category, `${manifestId}.md`),
    join(root, 'corpus-free', 'playbooks', category, 'category-fallback.md'),
    join(root, 'corpus-free', 'playbooks', 'category-fallback.md'),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf-8');
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') || /^\d+\./.test(l))
      .map((l) => l.replace(/^(- |\d+\.\s*)/, '').trim())
      .filter(Boolean);
  }

  return [
    'Inventory DIY modules handling this capability',
    'Pick the top-ranked safe alternative and vet it with starlog_facts',
    'Replace DIY code incrementally; delete custom crypto/token logic',
    'Re-run auth/session tests and rotate any exposed secrets',
  ];
}

export function defaultPackageizeSteps(category: string, suggestedName: string): string[] {
  return [
    `Confirm no safe public package exists for ${category} (starlog_advise returned packageize)`,
    `Extract a minimal API surface from repeated DIY code into ${suggestedName}`,
    `Run starlog corpus add ${suggestedName} --solves "<what it does>" --category ${category}`,
    `Run starlog facts add ${suggestedName} --status active --license <spdx>`,
    'Migrate call sites to the internal package; mark pattern as applied',
  ];
}
