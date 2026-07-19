import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { KnownCategorySchema } from './manifest/schema.js';
import type { QueryResult } from './manifest/schema.js';
import { runSearch } from './search-service.js';
import { runAdvise } from './advise-service.js';
import { formatAdviseMarkdown } from './engine/advise-format.js';
import { buildComposeDeps, resolveFactView, createFactsApiClient, formatFactView } from './engine/facts.js';
import { getPackageVersion } from './paths.js';
import { track, pendingMcpDisclosure } from './telemetry.js';
import { mcpFactsEventProps, mcpSearchEventProps } from './mcp-telemetry.js';

// ── Result formatting ───────────────────────────────────────────────────────

function formatResults(query: string, results: QueryResult[]): string {
  const categories = KnownCategorySchema.options.join(', ');

  if (results.length === 0) {
    return `No strong match for "${query}" in the local index. Discovery covers these JS/TS capabilities: ${categories}. ` +
      `This capability may be outside the indexed corpus (e.g. a non-JS/TS stack) -- do not present a forced match as a recommendation. ` +
      `You can still vet any named package with starlog_facts.`;
  }

  const lines: string[] = [];

  // A single isolated, modestly-scored hit usually means a stray keyword match
  // rather than a real capability fit; tell the agent so it doesn't relay a
  // lone off-topic result as a confident recommendation.
  if (results.length === 1 && results[0].relevance_score < 70) {
    lines.push(
      `_No strong match in the local index (covers: ${categories}). Closest by keyword -- treat as low confidence:_`,
      '',
    );
  }
  for (const r of results) {
    const m = r.manifest;
    lines.push(`## ${m.name} (${m.id})`);
    lines.push(`**Solves:** ${m.solves}`);
    lines.push(`**Category:** ${m.category} | **Effort:** ${m.integration_effort} | **Ecosystem:** ${m.ecosystem}`);
    lines.push(`**Best for:** ${m.best_for.join('; ')}`);
    lines.push(`**Skip when:** ${m.skip_when.join('; ')}`);
    if (m.hosted_alternative) {
      lines.push(`**Hosted alternative:** ${m.hosted_alternative.name} -- ${m.hosted_alternative.pricing_summary}`);
    }
    if (r.vs_custom) {
      lines.push(`**vs. custom:** ${r.vs_custom}`);
    }
    if (r.tradeoffs && r.tradeoffs.length > 0) {
      lines.push(`**Tradeoffs:** ${r.tradeoffs.join('; ')}`);
    }
    lines.push(`**Stack affinity:** ${m.stack_affinity.join(', ')}`);
    lines.push(`**Health:** ${m.health.stars.toLocaleString()} stars, ${m.health.contributors} contributors, license: ${m.health.license}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── Facts tool ────────────────────────────────────────────────────────────

/**
 * VERBATIM willingness-benchmark tool description. This exact string earned the
 * unprompted tool call (100% recall / 98% specificity on a neutral prompt,
 * across 4 frontier models) in the validated facts experiment. It is
 * load-bearing — the agent must reach for the tool on this description alone.
 * Asserted character-for-character in src/mcp-facts.test.ts.
 */
export const FACTS_TOOL_DESCRIPTION =
  'Look up authoritative facts about a software package: known vulnerabilities/CVEs and supply-chain incidents, SPDX license and license risk, maintenance status (active/deprecated/abandoned/compromised), and what the package can do (effect surface). Use it to vet a package before recommending it.';

export const ADVISE_TOOL_DESCRIPTION =
  'When you detect DIY or repeated capability code (auth, caching, jobs, etc.), call this BEFORE building more custom code or extracting a reusable package. It tracks patterns, searches for safe alternatives, and advises MIGRATE to a known library when one exists (e.g. Clerk/Auth0/Supabase over DIY auth) or PACKAGEIZE only when no safe corpus alternative exists. Prefer migration over packageizing commodity capabilities.';

// Rendering of a composed FactView lives in engine/facts/format.ts
// (formatFactView) — shared by the MCP tool and the CLI.

// ── Server ──────────────────────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer({ name: 'starlog', version: getPackageVersion() });

  server.tool(
    'starlog_search',
    'Discover candidate packages for a capability: surfaces options for a need (org-sanctioned/private ones first when configured), with integration effort, best-for and skip-when notes. This is discovery — it surfaces what exists; to vet a specific named package (CVEs, license, maintenance), call starlog_facts. Use after you have a capability/need and want candidate package names.',
    {
      query: z.string().describe('What you need, e.g. "auth for Next.js SaaS" or "background job queue for Node.js"'),
      category: z.string().optional().describe(`Filter to a category. Known categories: ${KnownCategorySchema.options.join(', ')}. Any other string is accepted for dynamic categories (parity with the CLI).`),
      stack: z.string().optional().describe('Filter by stack affinity, e.g. "next.js", "python", "react"'),
      top_k: z.number().int().min(1).max(50).optional().describe('Max results to return, 1-50 (default 5)'),
      diversity_lambda: z.number().min(0).max(1).optional().describe('Diversity-relevance tradeoff (0=max diversity, 1=pure relevance). Omit to use the default diversity rerank (0.5).'),
      context: z.string().optional().describe('Project context to unlock DIY-vs-buy analysis, e.g. "B2B SaaS on Next.js + Postgres, small team, needs SSO soon"'),
    },
    async (args) => {
      const results = await runSearch(args);
      // On an unacknowledged install, surface the disclosure in THIS result (the
      // human-visible channel) and suppress this call's telemetry; capture begins
      // next call. Otherwise fire-and-forget (the agent never waits on telemetry).
      const disclosure = pendingMcpDisclosure();
      if (!disclosure) void track('mcp_search', mcpSearchEventProps(args, results), { surface: 'mcp' });
      const text = formatResults(args.query, results) + (disclosure ? `\n\n${disclosure}` : '');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // Build serve-time deps ONCE at server start. Local: public L1+L2 overlaid
  // with private L1+L2 (STARLOG_PRIVATE_FACTS) + org policy (STARLOG_POLICY).
  // API: the hosted facts client when STARLOG_API_KEY is set (org-private L2 +
  // policy come from the API, authoritative; local is the offline fallback).
  // createServer() stays synchronous; the per-call lookup is async.
  const factsLocal = buildComposeDeps();
  const factsApi = createFactsApiClient();

  server.tool(
    'starlog_facts',
    FACTS_TOOL_DESCRIPTION,
    {
      package: z.string().describe('The package name to look up, e.g. "ua-parser-js"'),
      context: z
        .string()
        .optional()
        .describe('Optional project context for relevance, e.g. "Next.js SaaS, needs SSO"'),
    },
    async (args) => {
      const view = await resolveFactView(args.package, { local: factsLocal, api: factsApi });
      const disclosure = pendingMcpDisclosure();
      if (!disclosure) void track('mcp_facts', mcpFactsEventProps(args, view, { usedApi: factsApi !== null, privatePackages: factsLocal.privatePackages }), { surface: 'mcp' });
      const text = formatFactView(args.package, view) + (disclosure ? `\n\n${disclosure}` : '');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'starlog_advise',
    ADVISE_TOOL_DESCRIPTION,
    {
      observation: z
        .string()
        .optional()
        .describe('What you observed, e.g. "hand-rolled JWT auth" or "third project with custom session middleware"'),
      project_root: z.string().optional().describe('Absolute path to scan for DIY patterns (defaults to cwd)'),
      category: z
        .string()
        .optional()
        .describe(`Capability category filter. Known: ${KnownCategorySchema.options.join(', ')}`),
      force: z.boolean().optional().describe('Advise migration/packageize even when recurrence is below threshold'),
      context: z.string().optional().describe('Project context for search ranking, e.g. "Next.js B2B SaaS"'),
    },
    async (args) => {
      const result = await runAdvise({
        observation: args.observation,
        project_root: args.project_root,
        category: args.category,
        force: args.force,
        context: args.context,
      });
      const disclosure = pendingMcpDisclosure();
      if (!disclosure) void track('mcp_advise', { action: result.action, category: result.category }, { surface: 'mcp' });
      const text = formatAdviseMarkdown(result) + (disclosure ? `\n\n${disclosure}` : '');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run-if-main guard: auto-start when executed directly (node dist/mcp.js, the
// command wired into settings.json), but stay importable for tests without
// opening stdio.
//
// Both sides are run through realpathSync before comparing. `import.meta.url`
// is already symlink-resolved by the loader, but `process.argv[1]` is the path
// exactly as the parent invoked it -- so on any install whose path crosses a
// symlink (macOS `/tmp -> /private/tmp`, some nvm/Homebrew layouts, an npx
// cache dir), a raw string compare is unequal and the server silently never
// starts. Canonicalizing both makes the guard fire regardless of symlinks.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    // CRITICAL: this module is also BUNDLED into dist/cli.js (cli.ts imports
    // startMcpServer). In that bundle `import.meta.url` resolves to cli.js, so
    // without this name check the guard would fire on `node dist/cli.js mcp` —
    // starting a SECOND server alongside the `mcp` command's, doubling every tool
    // call (work and telemetry). Only the standalone mcp entry may auto-start.
    if (!/[/\\]mcp\.(js|ts)$/.test(self)) return false;
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await startMcpServer();
}
