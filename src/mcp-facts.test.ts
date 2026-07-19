import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, FACTS_TOOL_DESCRIPTION } from './mcp.js';
import { buildManifestFromInput } from './engine/facts/authoring.js';
import { getOrgCorpusPackageIds, resetOrgCorpusPackageIdsForTests } from './engine/org-corpus.js';
import * as telemetry from './telemetry.js';

/**
 * Integration test: the shipped MCP server registers BOTH starlog_search
 * (unchanged) and starlog_facts, and starlog_facts is callable over the public
 * MCP client API (InMemoryTransport — no stdio, no API key, no internals).
 */

// Literal copy of the validated willingness-benchmark description. This guards
// the exported const itself against an accidental edit — if the const drifts,
// this character-for-character comparison fails.
const VERBATIM_WILLINGNESS_DESCRIPTION =
  'Look up authoritative facts about a software package: known vulnerabilities/CVEs and supply-chain incidents, SPDX license and license risk, maintenance status (active/deprecated/abandoned/compromised), and what the package can do (effect surface). Use it to vet a package before recommending it.';

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'facts-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((b) => b.text ?? '').join('\n');
}

describe('starlog MCP server — facts tool', () => {
  it('the exported const equals the verbatim willingness string', () => {
    expect(FACTS_TOOL_DESCRIPTION).toBe(VERBATIM_WILLINGNESS_DESCRIPTION);
  });

  it('registers BOTH starlog_search and starlog_facts', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('starlog_search');
    expect(names).toContain('starlog_facts');
    await client.close();
  });

  it('starlog_facts reports the verbatim willingness description', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const facts = tools.find((t) => t.name === 'starlog_facts');
    expect(facts?.description).toBe(VERBATIM_WILLINGNESS_DESCRIPTION);
    await client.close();
  });

  it('returns verified facts (CVE/incident id + compromised signal) for a known package', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'starlog_facts', arguments: { package: 'ua-parser-js' } });
    const text = toolText(result);
    expect(text).toContain('ua-parser-js');
    expect(text).toContain('INCIDENT:ua-parser-js-2021');
    // recency is surfaced as a dated "as of" line
    expect(text).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    await client.close();
  });

  it('returns a clear "no facts on file" result for an unknown package', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'starlog_facts', arguments: { package: 'no-such-pkg' } });
    const text = toolText(result).toLowerCase();
    expect(text).toContain('no facts on file');
    await client.close();
  });
});

/**
 * The agent-spawn path, NOT the CLI. `starlog init` bakes
 * STARLOG_PRIVATE_CORPUS=${CLAUDE_PROJECT_DIR}/.starlog/private-corpus.json into
 * the MCP server's env; Claude Code expands it to an absolute project path and
 * sets it in the spawned server's environment. Here we set that absolute path on
 * process.env (the post-expansion state the server actually sees) and drive the
 * REAL server tool over the MCP client — proving discovery wiring fires through
 * the agent surface, not just the shell-inheriting CLI.
 */
describe('starlog MCP server — private discovery wiring (agent path)', () => {
  let dir: string | null = null;
  const saved = process.env.STARLOG_PRIVATE_CORPUS;
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    if (saved === undefined) delete process.env.STARLOG_PRIVATE_CORPUS;
    else process.env.STARLOG_PRIVATE_CORPUS = saved;
  });

  function writeCorpus(): string {
    dir = mkdtempSync(join(tmpdir(), 'starlog-mcp-corpus-'));
    const manifest = buildManifestFromInput({
      package: '@acme/flags',
      solves: 'Feature flags and remote configuration for Acme Node services — gradual rollout, kill switches, audit log.',
      category: 'feature-flags',
      stack: ['node'],
      bestFor: ['feature flags', 'remote config', 'gradual rollout', 'kill switches'],
    });
    const p = join(dir, 'private-corpus.json');
    writeFileSync(p, JSON.stringify({ manifests: [manifest] }, null, 2), 'utf8');
    return p;
  }

  it('starlog_search surfaces the org-private package when STARLOG_PRIVATE_CORPUS points at it (post-expansion)', async () => {
    process.env.STARLOG_PRIVATE_CORPUS = writeCorpus();
    const client = await connectClient();
    const result = await client.callTool({
      name: 'starlog_search',
      arguments: { query: 'feature flags for a node app' },
    });
    expect(toolText(result)).toContain('@acme/flags');
    await client.close();
  });

  it('without the env set, the same query does NOT surface the private package (proves the wiring is what did it)', async () => {
    delete process.env.STARLOG_PRIVATE_CORPUS;
    const client = await connectClient();
    const result = await client.callTool({
      name: 'starlog_search',
      arguments: { query: 'feature flags for a node app' },
    });
    expect(toolText(result)).not.toContain('@acme/flags');
    await client.close();
  });
});

/**
 * Regression: createServer() must not snapshot org-corpus package ids before the
 * warm fetch settles. A sync snapshot at server-start time is empty while the
 * async fetch (up to 10s) is in flight, so mcp_facts would leak org-internal
 * package names into telemetry. The facts handler must await the warm and build
 * the redaction set at call time.
 */
describe('starlog MCP server — org corpus telemetry redaction', () => {
  const ORG_URL = 'https://corp.example.test/org-corpus.json';
  const drizzle = JSON.parse(
    readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'corpus-free', 'orm-database', 'drizzle.json'),
      'utf-8',
    ),
  );
  const orgManifest = { ...drizzle, id: '@acme/org-only', name: '@acme/org-only' };

  beforeEach(() => {
    resetOrgCorpusPackageIdsForTests();
  });

  afterEach(() => {
    resetOrgCorpusPackageIdsForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts an org-corpus package name in mcp_facts after the warm fetch settles', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubEnv('STARLOG_ORG_CORPUS_URL', ORG_URL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pending) as unknown as typeof fetch,
    );

    const trackSpy = vi.spyOn(telemetry, 'track').mockResolvedValue(undefined);

    // createServer starts the warm fetch but must not freeze an empty id set.
    const server = createServer();
    expect(getOrgCorpusPackageIds().has('@acme/org-only')).toBe(false);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'org-redact-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Call facts while the warm is still in flight — the handler must await it
    // (not a sync snapshot from createServer) before building the redaction set.
    const callPromise = client.callTool({ name: 'starlog_facts', arguments: { package: '@acme/org-only' } });
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ manifests: [orgManifest] }),
    } as unknown as Response);
    await callPromise;

    expect(getOrgCorpusPackageIds().has('@acme/org-only')).toBe(true);
    expect(trackSpy).toHaveBeenCalledWith(
      'mcp_facts',
      expect.objectContaining({ package: null, private: true }),
      expect.objectContaining({ surface: 'mcp' }),
    );
    await client.close();
  });

  it('retries org corpus fetch on mcp_facts when the warm fetch failed (no permanent redaction gap)', async () => {
    // Warm fails at createServer; a later facts call must not freeze that empty
    // id set — otherwise org-internal names leak into telemetry forever.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('warm network down'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ manifests: [orgManifest] }),
      } as unknown as Response);
    vi.stubEnv('STARLOG_ORG_CORPUS_URL', ORG_URL);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const trackSpy = vi.spyOn(telemetry, 'track').mockResolvedValue(undefined);

    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'org-redact-retry-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Let the warm settle as a failure before the facts call.
    await new Promise((r) => setTimeout(r, 20));
    expect(getOrgCorpusPackageIds().has('@acme/org-only')).toBe(false);

    await client.callTool({ name: 'starlog_facts', arguments: { package: '@acme/org-only' } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getOrgCorpusPackageIds().has('@acme/org-only')).toBe(true);
    expect(trackSpy).toHaveBeenCalledWith(
      'mcp_facts',
      expect.objectContaining({ package: null, private: true }),
      expect.objectContaining({ surface: 'mcp' }),
    );
    await client.close();
  });
});
