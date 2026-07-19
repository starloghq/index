import { readFileSync } from 'node:fs';
import { resolveOverlayPath } from '../overlay-path.js';
import { L1CapabilityFactSchema, type L1CapabilityFact } from '@starloghq/facts-schema';
import { type L2Overlay } from '@starloghq/facts-schema';
import { handAuthoredL2Source, overlaySource, parseOverlay, type L2Source } from './l2-source.js';
import { L3PolicySchema, evaluatePolicy, type L3Policy } from '@starloghq/facts-schema';
import { composeFact, type ComposeDeps, type FactView } from './compose.js';
import type { FactsApiClient } from './api-client.js';
import { L1_BY_PACKAGE } from './l1-data.js';
import { L2_BY_PACKAGE, L2_OVERLAYS_LIST } from './l2-data.js';

/**
 * Facts service — wires the three INDEPENDENT layers together for serving.
 * Each private input loads on its own (private L1, private L2, L3 policy); the
 * layers never merge into each other, they only compose at query time.
 */

export interface ServiceDeps extends ComposeDeps {
  /** Ordered, de-duplicated package keys the name resolver scans (corpus first). */
  resolverKeys: string[];
  /** Names that came from the org-private STARLOG_PRIVATE_FACTS overlay — telemetry redacts these. */
  privatePackages: ReadonlySet<string>;
}

// ── Name resolution (the matcher) ────────────────────────────────────────────
//
// EXACT-ONLY (normalized). Facts is a by-NAME vetting lookup: `starlog_facts`
// takes `package` ("The package name to look up, e.g. ua-parser-js") and the CLI
// takes a `<package>` argument. Free-text / capability discovery is a SEPARATE
// path (`starlog_search`, which takes a NL `query`). So fuzzy matching has no
// place here — any non-exact match fabricates an authoritative answer about a
// DIFFERENT package. Two real failures from the prior fuzzy/token matcher, both
// trust-breaking on the hero (org-private) path:
//   • "@starloghq/facts-schema" → "q"        (scope "starloghq" contains char "q")
//   • "express-rate-limit"      → "express"  ("express" is a leading name-token)
// Normalization (lowercase + trim) is the only tolerance; everything else is a
// miss → honest "no facts on file". This closes the whole fabrication class
// (incl. "express rate limit", "lodash.merge", etc.) in one stroke. The NL
// affordance lives in search, where it belongs.
export function resolvePackage(query: string, keys: string[]): string | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  for (const key of keys) {
    if (key.toLowerCase().trim() === q) return key;
  }
  return null;
}

// ── Private input loaders (each layer, each resilient, never throws) ──────────

/**
 * Load org-private facts from STARLOG_PRIVATE_FACTS. The file is a JSON object
 * with independent `l1` and `l2` arrays: `{ "l1": [...L1...], "l2": [...L2...] }`.
 * Each entry is schema-validated; L1 must be verified. Bad file / bad entries
 * degrade to empty maps (warn to stderr), never throw.
 */
export function loadPrivateFacts(path?: string): { l1: Record<string, L1CapabilityFact>; l2: Record<string, L2Overlay> } {
  const empty = { l1: {}, l2: {} };
  const resolved = resolveOverlayPath(path);
  if (!resolved) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] private facts file unreadable (${resolved}): ${msg}; using public facts only.`);
    return empty;
  }
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? (parsed as Record<string, unknown>) : {};
  const l1: Record<string, L1CapabilityFact> = {};
  for (const entry of Array.isArray(obj.l1) ? obj.l1 : []) {
    const r = L1CapabilityFactSchema.safeParse(entry);
    if (r.success && r.data.provenance.verified) l1[r.data.package] = r.data;
  }
  const l2: Record<string, L2Overlay> = {};
  for (const entry of Array.isArray(obj.l2) ? obj.l2 : []) {
    const o = parseOverlay(entry);
    if (o) l2[o.package] = o;
  }
  return { l1, l2 };
}

/**
 * Load an L3 policy from STARLOG_POLICY (a JSON L3Policy). Bad/absent → null
 * (no policy → every verdict is 'none'). Never throws.
 */
export function loadPolicy(path?: string): L3Policy | null {
  const resolved = resolveOverlayPath(path);
  if (!resolved) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] policy file unreadable (${resolved}): ${msg}; no org policy applied.`);
    return null;
  }
  const r = L3PolicySchema.safeParse(parsed);
  if (!r.success) {
    console.error(`[starlog] policy file invalid (${resolved}); no org policy applied.`);
    return null;
  }
  return r.data;
}

function uniqueOrder(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) for (const k of list) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/**
 * Build serve-time deps from env. Public L1 + public L2 (hand source), overlaid
 * with private L1/L2 (private wins per layer, independently), plus an optional
 * L3 policy. Reads files ONCE — call this at server start (or once per CLI run).
 */
export function buildComposeDeps(env: NodeJS.ProcessEnv = process.env): ServiceDeps {
  const priv = loadPrivateFacts(env.STARLOG_PRIVATE_FACTS);
  const mergedL1: Record<string, L1CapabilityFact> = { ...L1_BY_PACKAGE, ...priv.l1 };
  const l2Base: L2Source = handAuthoredL2Source(L2_BY_PACKAGE);
  const l2Priv: L2Source | null = Object.keys(priv.l2).length ? handAuthoredL2Source(priv.l2) : null;
  const l2Source = overlaySource(l2Base, l2Priv);
  const policy = loadPolicy(env.STARLOG_POLICY);
  // Corpus (L1) order first — preserves first-match-wins precedence the eval
  // baseline encodes — then any L2-only / private-only keys.
  const resolverKeys = uniqueOrder(Object.keys(mergedL1), L2_OVERLAYS_LIST.map((o) => o.package), Object.keys(priv.l2));
  const privatePackages = new Set<string>([...Object.keys(priv.l1), ...Object.keys(priv.l2)]);
  return { l1Lookup: (p) => mergedL1[p] ?? null, l2Source, policy, resolverKeys, privatePackages };
}

/** Resolve a free-text query to a composed FactView (LOCAL-only, sync), or null. */
export function lookupFactView(query: string, deps: ServiceDeps): FactView | null {
  const pkg = resolvePackage(query, deps.resolverKeys);
  // If the name resolves to an L1/L2 record, compose against that key. If it does
  // NOT resolve, still compose against the raw query so a standing package-only
  // policy verdict (a policy-only ban with no facts record) can surface (#21)
  // instead of silently no-opping; composeFact returns null when there is neither
  // a facts record nor a matching standing verdict.
  return composeFact(pkg ?? query, deps);
}

export interface ServeDeps {
  local: ServiceDeps;
  api: FactsApiClient | null;
}

/**
 * Resolve a package to a composed FactView, API-FIRST with local fallback —
 * the path the MCP server and CLI use. Per layer the API value WINS (it's
 * authoritative: the server resolves L2 public⊕private and supplies the org
 * policy); local fills any gap and is the FULL offline fallback on API
 * error/miss. evaluatePolicy runs HERE (client-side) per the contract.
 *
 * The package argument is passed to the API verbatim (the org may have private
 * packages not in the local corpus); local resolution (fuzzy) is used only for
 * the local-fallback parts.
 */
export async function resolveFactView(packageArg: string, deps: ServeDeps): Promise<FactView | null> {
  const { local, api } = deps;
  if (api) {
    const res = await api.getFacts(packageArg);
    if (res && res.found) {
      const localPkg = resolvePackage(packageArg, local.resolverKeys);
      const l1 = res.l1 ?? (localPkg ? local.l1Lookup(localPkg) : null);
      const l2 = res.l2 ?? (localPkg ? local.l2Source.lookup(localPkg) : null);
      if (l1 || l2) {
        const l3 = evaluatePolicy(res.l3 ?? local.policy, { l1, l2 });
        return {
          package: res.l1?.package ?? res.l2?.package ?? packageArg,
          ecosystem: l1?.ecosystem ?? l2?.ecosystem ?? 'npm',
          l1,
          l2,
          l3,
        };
      }
    }
    // res null (network/non-OK error) or found:false → fall through to local.
  }
  return lookupFactView(packageArg, local);
}
