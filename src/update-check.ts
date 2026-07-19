// update-check.ts — is a newer `starloghq` published than the one installed?
//
// Used by `starlog doctor` to nudge users off a stale install (an out-of-date
// security tool is a liability). Deliberately best-effort: a short timeout, an
// env opt-out, and silent failure on any network hiccup — a diagnostic must
// never hang or turn red because npm was unreachable.
import { getUserAgent } from './paths.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Compare two `x.y.z` versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Pre-release/build suffixes are ignored (a staleness nudge doesn't need to
 * reason about `-beta`), and missing/garbage segments read as 0 — never throws.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    String(v)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Fetch the latest published version of `starloghq` from the npm registry.
 * Returns null on opt-out, timeout, or any error — the caller stays silent.
 * The registry base is overridable via STARLOG_REGISTRY_URL (used by tests).
 */
export async function fetchLatestVersion(
  opts: { timeoutMs?: number; baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const base = opts.baseUrl ?? process.env.STARLOG_REGISTRY_URL ?? DEFAULT_REGISTRY;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(`${base}/starloghq/latest`, {
      signal: controller.signal,
      headers: { 'user-agent': getUserAgent(), accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data?.version === 'string' ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when the update check should be skipped (explicit opt-out). */
export function updateCheckDisabled(): boolean {
  return !!process.env.STARLOG_NO_UPDATE_CHECK;
}
