import { readFileSync } from 'node:fs';
import { CapabilityManifestSchema, type CapabilityManifest } from '../manifest/schema.js';
import { resolveOverlayPath } from './overlay-path.js';

/**
 * Load org-private capability manifests from STARLOG_PRIVATE_CORPUS — the
 * DISCOVERY overlay that mirrors STARLOG_PRIVATE_FACTS (the facts overlay).
 *
 * The file is a JSON object with a top-level `manifests` array of
 * CapabilityManifest: `{ "manifests": [ ...CapabilityManifest... ] }`. Each
 * entry is schema-validated; valid entries load, invalid entries are skipped
 * with a stderr warning. A bad/unreadable file degrades to public-only (warn to
 * stderr) and never throws — same resilience contract as loadPrivateFacts /
 * loadCorpus.
 *
 * These manifests let discovery surface the org's sanctioned package FIRST for a
 * relevant capability match (see search() private-first partition). This loader
 * does NOT rank — it only sources the org manifests.
 */
export function loadPrivateCorpus(path?: string): CapabilityManifest[] {
  const resolved = resolveOverlayPath(path);
  if (!resolved) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] private corpus file unreadable (${resolved}): ${msg}; using public corpus only.`);
    return [];
  }

  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as Record<string, unknown>)
    : {};
  const entries = Array.isArray(obj.manifests) ? obj.manifests : [];

  const manifests: CapabilityManifest[] = [];
  for (const entry of entries) {
    const r = CapabilityManifestSchema.safeParse(entry);
    if (r.success) {
      manifests.push(r.data);
    } else {
      const summary = r.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      console.error(`[starlog] skipping invalid private manifest: ${summary}`);
    }
  }
  return manifests;
}
