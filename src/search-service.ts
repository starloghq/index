import { loadCorpus } from './engine/corpus.js';
import { fetchHostedCorpus } from './engine/hosted-corpus.js';
import { fetchOrgCorpus } from './engine/org-corpus.js';
import { loadPrivateCorpus } from './engine/private-corpus.js';
import { search } from './engine/search.js';
import { keywordSiftrank, createLlmFn } from './engine/siftrank.js';
import { type CapabilityManifest, type Category, type QueryResult } from './manifest/schema.js';

export interface SearchArgs {
  query: string;
  category?: string;
  stack?: string;
  top_k?: number;
  diversity_lambda?: number;
  context?: string;
}

/**
 * Execute a capability search, shared by both the MCP server and the CLI so
 * the two transports behave identically.
 *
 * Keyless: ranks the bundled local corpus with the offline keyword ranker — no
 * network. With STARLOG_API_KEY set, the candidate set is fetched from the hosted
 * full corpus (api.starlog.dev/search) and ranked locally with the SAME engine;
 * any hosted failure degrades to the local corpus. Pass `context` to enrich the
 * top results with a per-library `vs custom` rationale.
 */
export async function runSearch(args: SearchArgs): Promise<QueryResult[]> {
  const { query, category, stack, top_k, diversity_lambda, context } = args;

  // Full (hosted) corpus tier when STARLOG_API_KEY is set: the candidate set
  // comes from api.starlog.dev/search; ranking stays 100% local. Falls back to
  // the bundled corpus on no-key / any API failure — keyless users unaffected.
  const hosted = await fetchHostedCorpus(query, category);
  const corpus = hosted ?? (await loadCorpus(undefined, category as Category | undefined));

  // Company-hosted org corpus: shared discovery manifests from STARLOG_ORG_CORPUS_URL.
  // Fetched every run; any failure degrades to skipping this layer (never throws).
  const org = (await fetchOrgCorpus()) ?? [];

  // FACTS-03 discovery overlay: load the org's private manifests from
  // STARLOG_PRIVATE_CORPUS (mirror of STARLOG_PRIVATE_FACTS). This is the ONLY
  // place env is read for the corpus overlay — CLI and MCP both call runSearch,
  // so both transports get private-first for free. Empty when env unset/degraded.
  const priv = loadPrivateCorpus(process.env.STARLOG_PRIVATE_CORPUS);

  // Merge manifests into the searched corpus: base → org remote → local private.
  // Later layers win on id collision (local private overrides org remote).
  const byId = new Map<string, CapabilityManifest>();
  for (const m of corpus) byId.set(m.id, m);
  for (const m of org) byId.set(m.id, m);
  for (const m of priv) byId.set(m.id, m);
  const mergedCorpus = [...byId.values()];

  // Ids to float first (org-sanctioned). search() applies the relevance guard.
  const privateIds = new Set([...org, ...priv].map((m) => m.id));

  return search(
    query,
    mergedCorpus,
    {
      category: category as Category | undefined,
      stack,
      topK: top_k ?? 5,
      projectContext: context,
      diversityLambda: diversity_lambda,
      privateIds,
    },
    { siftrank: keywordSiftrank, llm: createLlmFn() },
  );
}
