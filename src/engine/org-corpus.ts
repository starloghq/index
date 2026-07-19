import { CapabilityManifestSchema, type CapabilityManifest } from '../manifest/schema.js';
import { getUserAgent } from '../paths.js';

/**
 * Company-hosted org corpus fetch — a static JSON tier between the base corpus
 * and the per-machine private overlay.
 *
 * When STARLOG_ORG_CORPUS_URL is set, runSearch pulls the org's shared discovery
 * manifests from that URL. The body matches the local private-corpus shape:
 * `{ "manifests": [ ...CapabilityManifest... ] }`. Optional Bearer auth via
 * STARLOG_ORG_CORPUS_TOKEN.
 *
 * Consumption conventions mirror hosted-corpus: short abort timeout, defensive
 * parsing, NEVER throws — any problem returns `null` so the caller skips the org
 * layer and search continues with base + local private only.
 */
const TIMEOUT_MS = 10_000;

let cachedPackageIds = new Set<string>();

/** Package ids from the last successful org corpus fetch (for telemetry redaction). */
export function getOrgCorpusPackageIds(): ReadonlySet<string> {
  return cachedPackageIds;
}

/** Test-only: clear the package-id cache so cases don't leak across files. */
export function resetOrgCorpusPackageIdsForTests(): void {
  cachedPackageIds = new Set();
}

/**
 * Fetch org-shared capability manifests from a company-hosted URL.
 * @returns the manifests, or `null` to signal "skip the org layer".
 */
export async function fetchOrgCorpus(opts: {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<CapabilityManifest[] | null> {
  const url = (opts.url ?? process.env.STARLOG_ORG_CORPUS_URL)?.trim();
  if (!url) return null;

  const token = (opts.token ?? process.env.STARLOG_ORG_CORPUS_TOKEN)?.trim();
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'User-Agent': getUserAgent() };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      console.error(`[starlog] org corpus → HTTP ${res.status}; skipping org layer.`);
      return null;
    }
    const body: unknown = await res.json();
    const entries =
      body && typeof body === 'object' && Array.isArray((body as { manifests?: unknown }).manifests)
        ? (body as { manifests: unknown[] }).manifests
        : [];
    const manifests: CapabilityManifest[] = [];
    for (const entry of entries) {
      const parsed = CapabilityManifestSchema.safeParse(entry);
      if (parsed.success) manifests.push(parsed.data);
    }
    if (manifests.length === 0) {
      // Ops visibility: a 200 with a `manifests` array that all fail schema is a
      // silent no-op without this — the common failure mode when someone hand-rolls
      // JSON instead of publishing `starlog corpus add` / `org sync` output.
      if (entries.length > 0) {
        console.error(
          `[starlog] org corpus → 0 of ${entries.length} entries passed schema; skipping org layer. Publish output from \`starlog corpus add\` / \`org sync\`, not a hand-rolled stub.`,
        );
      }
      return null;
    }
    cachedPackageIds = new Set(manifests.map((m) => m.id));
    return manifests;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[starlog] org corpus failed (${msg}); skipping org layer.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
