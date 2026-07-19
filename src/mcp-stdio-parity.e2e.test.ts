import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * End-to-end tests for the Starlog MCP server over REAL stdio — the agent path.
 *
 * Unlike the in-process InMemoryTransport unit tests (mcp-facts.test.ts), these
 * spawn the actual built binary `node dist/cli.js mcp` as a child process and
 * drive it through the @modelcontextprotocol/sdk Client over StdioClientTransport,
 * exactly as a registry/agent client (Claude Code, etc.) would. This exercises the
 * whole shipped path: process startup, the JSON-RPC initialize handshake, stdout
 * framing (any stray log on stdout corrupts framing and fails connect — so a
 * resolving connect() is itself the "stdout is pure JSON-RPC" guard), tools/list
 * schema, tool dispatch, error results, and env-driven overlay/policy wiring.
 *
 * It also proves CLI<->MCP PARITY: the same org config (STARLOG_POLICY /
 * STARLOG_PRIVATE_FACTS) handed to both `starlog facts ...` (shelled CLI) and the
 * starlog_facts MCP tool yields the same authoritative verdict — the contract an
 * agent relies on whether it shells the human CLI or calls the tool.
 *
 * HERMETICITY / NO NETWORK:
 *  - Env hygiene mirrors facts-cli.e2e.test.ts: start from {...process.env}, DELETE
 *    STARLOG_API_KEY (else resolveFactView goes API-first → network/flaky),
 *    STARLOG_PRIVATE_FACTS, STARLOG_POLICY, STARLOG_PRIVATE_CORPUS (so an inherited
 *    shell value can't leak an overlay/verdict into a baseline run). Explicit
 *    per-test env is applied LAST.
 *  - STARLOG_TELEMETRY='0' on every spawn — with no opt-out an offline PostHog
 *    fetch hangs ~1500ms. STARLOG_NO_NUDGE='1' keeps the init nudge off stderr.
 *  - Every server is spawned with cwd = a fresh mkdtemp dir and an ABSOLUTE cli
 *    path, so the default .starlog/ is never read/written in the repo tree.
 *  - STARLOG_API_KEY is never set → local-composed facts only, no hosted API.
 *
 * Every Client/transport is registered in a module-level list and force-closed in
 * afterEach so a thrown assertion can never leak a child process and hang vitest.
 *
 * dist/ is assumed pre-built (the assignment guarantees it).
 */

// Repo root, derived from this file's location (src/ → ..) so spawns resolve on
// any machine/CI — NOT a hardcoded absolute path.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist/cli.js');

/** The built binary's own reported version — assert against this, never hardcode. */
const BINARY_VERSION = execFileSync('node', [CLI, '--version'], {
  cwd: REPO,
  encoding: 'utf8',
}).trim();

/**
 * Hermetic child env: start from the real environment, DROP the four overlay/key
 * vars so an inherited shell value can't leak in, force telemetry off + nudge off.
 * Per-test overrides are applied LAST and win.
 */
function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.STARLOG_API_KEY;
  delete env.STARLOG_PRIVATE_FACTS;
  delete env.STARLOG_POLICY;
  delete env.STARLOG_PRIVATE_CORPUS;
  env.STARLOG_TELEMETRY = '0';
  env.STARLOG_NO_NUDGE = '1';
  Object.assign(env, extra ?? {});
  // StdioClientTransport wants a Record<string,string>; strip undefineds.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Result of running the CLI: captured stdout and exit status. */
interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Shell the REAL CLI (`node dist/cli.js --no-telemetry facts ...`) from a given
 * cwd. Recovers status/stdout/stderr on a non-zero exit so a failing exit is a
 * first-class assertable outcome rather than an unhandled throw. Mirrors
 * facts-cli.e2e.test.ts's runFactsInDir.
 */
function runCliInDir(cwd: string, args: string[], extraEnv?: Record<string, string>): RunResult {
  try {
    const stdout = execFileSync('node', [CLI, '--no-telemetry', ...args], {
      cwd,
      encoding: 'utf8',
      env: childEnv(extraEnv),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    };
  }
}

// ── Subprocess lifecycle bookkeeping ────────────────────────────────────────
// Track every connected client so a thrown assertion mid-test cannot leak a
// child MCP server and hang vitest at exit. afterEach force-closes them all.
const openClients: Client[] = [];
const tmpDirs: string[] = [];

/** Spawn `node dist/cli.js mcp` over real stdio and complete the SDK handshake. */
async function connectMcp(cwd: string, extraEnv?: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'mcp'],
    cwd,
    env: childEnv(extraEnv),
  });
  const client = new Client({ name: 'e2e-parity-test', version: '1.0.0' });
  openClients.push(client);
  // connect() drives initialize→initialized over the spawned process's stdio.
  // It resolves only if stdout carries pure, well-framed JSON-RPC — any startup
  // log on stdout would corrupt framing and reject here, so a resolving connect
  // is itself the "stdout is clean" guard.
  await client.connect(transport);
  return client;
}

/** Make a temp cwd for a spawn; auto-cleaned in afterEach. */
function newTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'starlog-mcp-e2e-'));
  tmpDirs.push(d);
  return d;
}

/**
 * A tools/call result, narrowed to the fields these tests assert. The SDK types
 * `content` as a broad multi-modal union (text/image/audio/resource); we only ever
 * read text, so `call()` casts the result to this shape once at the boundary.
 */
type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

/** Typed wrapper over client.callTool — casts the SDK's broad result to ToolResult. */
function call(
  client: Client,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<ToolResult> {
  return client.callTool(params) as unknown as Promise<ToolResult>;
}

/** Read the first text content block off a tools/call result. */
function textOf(result: ToolResult): string {
  const block = result.content?.find((c) => typeof c.text === 'string') ?? result.content?.[0];
  return block?.text ?? '';
}

afterEach(async () => {
  // Close every MCP client first (terminates each spawned subprocess) so no
  // child outlives the test and stalls the runner.
  for (const c of openClients.splice(0)) {
    try {
      await c.close();
    } catch {
      /* already gone — ignore */
    }
  }
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('MCP stdio: handshake + tools/list + CLI facts parity', () => {
  // MERGED: implements both
  //  - "stdio handshake returns serverInfo + negotiated protocol (real subprocess)"
  //  - "MCP stdio handshake: tools/list shape stability + facts tool-call parity"
  // They describe the same handshake/tools/list surface (one from the
  // agent-mcp-integration persona, one from ci-automation); a single test asserts
  // serverInfo, the two-tool schema, AND the facts-hit parity with the CLI.
  it(
    'handshake reports serverInfo, advertises the stable two-tool schema, and facts parity holds with the CLI',
    async () => {
      const cwd = newTmpDir();
      const client = await connectMcp(cwd);

      // serverInfo: name is 'starlog'; version equals the BUILT binary's version
      // (captured dynamically — never hardcode 0.4.0).
      const info = client.getServerVersion();
      expect(info?.name).toBe('starlog');
      expect(info?.version).toBe(BINARY_VERSION);
      // The SDK's connect() already negotiated a protocol version against the
      // server; this SDK build exposes no getProtocolVersion() accessor, so the
      // resolving connect() above is the negotiation proof. (Adapted from the
      // scenario per the SDK surface — not a product bug.)

      // tools/list: exactly two tools with stable names and required arg schemas.
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).toEqual(['starlog_advise', 'starlog_facts', 'starlog_search']);
      expect(byName.starlog_search.inputSchema?.required).toEqual(['query']);
      expect(byName.starlog_facts.inputSchema?.required).toEqual(['package']);

      // facts parity: the MCP tool result for a known package matches the CLI's
      // substance — same incident id, same package heading, a dated line.
      const mcpFacts = await call(client, {
        name: 'starlog_facts',
        arguments: { package: 'ua-parser-js' },
      });
      const mcpText = textOf(mcpFacts);
      expect(mcpFacts.isError).toBeFalsy();
      expect(mcpText).toContain('## ua-parser-js (npm)');
      expect(mcpText).toContain('INCIDENT:ua-parser-js-2021');
      expect(mcpText).toMatch(/as of \d{4}-\d{2}-\d{2}/);

      // The CLI, run with the SAME (baseline) env, produces the same incident id.
      const cli = runCliInDir(cwd, ['facts', 'ua-parser-js']);
      expect(cli.status).toBe(0);
      expect(cli.stdout).toContain('INCIDENT:ua-parser-js-2021');
      expect(cli.stdout).toContain('## ua-parser-js (npm)');
    },
    30000,
  );
});

describe('MCP stdio: CLI↔MCP parity on an org DENY verdict', () => {
  it(
    'shelling `starlog facts` and calling starlog_facts under one STARLOG_POLICY yield the same deny verdict',
    async () => {
      const cwd = newTmpDir();
      const polPath = join(cwd, 'policy.json');

      // Author the org L3 policy the org would ship.
      const policy = runCliInDir(
        cwd,
        ['facts', 'policy', 'ua-parser-js', 'deny', '--reason', 'BANNED-BY-SECTEAM-2026'],
        { STARLOG_POLICY: polPath },
      );
      expect(policy.status).toBe(0);
      expect(policy.stdout).toContain('Set org verdict DENY for ua-parser-js');

      // Surface A — shell the CLI with --format json: the machine-readable L3.
      const cli = runCliInDir(cwd, ['facts', 'ua-parser-js', '--format', 'json'], {
        STARLOG_POLICY: polPath,
      });
      expect(cli.status).toBe(0);
      const parsed = JSON.parse(cli.stdout);
      expect(parsed.l3.decision).toBe('deny');
      expect(parsed.l3.rule_id).toBe('pkg-ua-parser-js');
      expect(parsed.l3.rationale).toBe('BANNED-BY-SECTEAM-2026');

      // Surface B — call the tool over stdio with the IDENTICAL env.
      const client = await connectMcp(cwd, { STARLOG_POLICY: polPath });
      const mcp = await call(client, {
        name: 'starlog_facts',
        arguments: { package: 'ua-parser-js' },
      });
      const text = textOf(mcp);
      expect(mcp.isError).toBeFalsy();
      // Parity: same incident, same DENY verdict, same byte-identical reason +
      // rule id rendered for the agent.
      expect(text).toContain('INCIDENT:ua-parser-js-2021');
      expect(text).toContain('**Org policy:** DENY — BANNED-BY-SECTEAM-2026 (rule pkg-ua-parser-js)');
      expect(text).toMatch(/as of \d{4}-\d{2}-\d{2}/);
    },
    30000,
  );
});

describe('MCP stdio: agent error robustness', () => {
  it(
    'unknown tool and missing required arg return structured -32602 results without killing the stream',
    async () => {
      const cwd = newTmpDir();
      const client = await connectMcp(cwd);

      // Unknown tool name: the SDK surfaces this as an isError RESULT (not a
      // thrown protocol error), carrying the -32602 detail.
      const unknown = await call(client, { name: 'no_such_tool', arguments: {} });
      expect(unknown.isError).toBe(true);
      const unkText = textOf(unknown);
      expect(unkText).toContain('MCP error -32602');
      expect(unkText).toContain('Tool no_such_tool not found');

      // Missing required `package` arg: structured validation error, still a
      // result (not a thrown/closed stream).
      const missing = await call(client, { name: 'starlog_facts', arguments: {} });
      expect(missing.isError).toBe(true);
      const missText = textOf(missing);
      expect(missText).toContain('MCP error -32602');
      expect(missText).toContain('Invalid arguments for tool starlog_facts');

      // Stream survival: a normal call AFTER the two errors still works → the
      // subprocess and stdio framing survived both error results.
      const good = await call(client, {
        name: 'starlog_facts',
        arguments: { package: 'no-such-pkg-xyz' },
      });
      expect(good.isError).toBeFalsy();
      expect(textOf(good).toLowerCase()).toContain('no facts on file');
    },
    30000,
  );
});

describe('MCP stdio: search no-strong-match guidance (anti-hallucination contract)', () => {
  it(
    'an off-corpus query returns the agent-directed "do not present a forced match" guidance, an in-corpus query returns result blocks',
    async () => {
      const cwd = newTmpDir();
      const client = await connectMcp(cwd);

      // Off-corpus query: the no-match text is an INSTRUCTION to the agent to
      // suppress a hallucinated recommendation. Assert the verbatim guidance and
      // the capability-coverage list survive the stdio boundary.
      const off = await call(client, {
        name: 'starlog_search',
        arguments: { query: 'quantum blockchain raytracer for cobol' },
      });
      const offText = off.content?.map((c) => c.text ?? '').join('\n') ?? '';
      expect(off.isError).toBeFalsy();
      expect(offText).toContain('do not present a forced match as a recommendation');
      // Names the local capability coverage (a couple of stable category markers,
      // not the whole frozen list, so this survives category additions).
      expect(offText).toContain('authentication');
      expect(offText).toContain('orm-database');
      // Points the agent at facts vetting as the fallback.
      expect(offText).toContain('starlog_facts');
      // No fabricated '## <pkg>' recommendation block on the no-match.
      expect(offText).not.toContain('## ');

      // Contrast: a real in-corpus capability query DOES return concrete result
      // blocks — proving the guidance is a no-match signal, not a constant.
      // Assert the structural '## ' heading marker, NOT a specific library name
      // (the rank-1 library drifts as the corpus/ranker evolve).
      const hit = await call(client, {
        name: 'starlog_search',
        arguments: { query: 'http client' },
      });
      const hitText = hit.content?.map((c) => c.text ?? '').join('\n') ?? '';
      expect(hit.isError).toBeFalsy();
      expect(hitText).toContain('## ');
      expect(hitText).not.toContain('do not present a forced match as a recommendation');
    },
    30000,
  );
});

describe('MCP stdio: private overlay wiring through the spawned server', () => {
  it(
    'STARLOG_PRIVATE_FACTS surfaces an org-authored private-only package; absent env returns the honest miss',
    async () => {
      const cwd = newTmpDir();
      const pfPath = join(cwd, 'private-facts.json');
      const PKG = '@acme/internal-auth';

      // Author a private-only package into the overlay via the CLI (the env the
      // host `starlog init` would bake into the MCP server's env block).
      const add = runCliInDir(cwd, ['facts', 'add', PKG, '--license', 'MIT', '--status', 'active'], {
        STARLOG_PRIVATE_FACTS: pfPath,
      });
      expect(add.status).toBe(0);
      expect(add.stdout).toContain(`Added ${PKG} to`);
      // The overlay file exists under tempdir and names the package.
      expect(readFileSync(pfPath, 'utf8')).toContain(PKG);

      // WITH the env wired into the spawned server: the package resolves and the
      // authored license/maintenance render.
      const wired = await connectMcp(cwd, { STARLOG_PRIVATE_FACTS: pfPath });
      const resolved = await call(wired, { name: 'starlog_facts', arguments: { package: PKG } });
      const resolvedText = textOf(resolved);
      expect(resolved.isError).toBeFalsy();
      expect(resolvedText).toContain(`## ${PKG} (npm)`);
      expect(resolvedText).toContain('**License:** MIT');
      expect(resolvedText).toContain('**Maintenance:** active');

      // Exact-only resolver: a near-miss (no scope) is NOT fabricated even WITH
      // the env set — it's an honest miss.
      const nearMiss = await call(wired, {
        name: 'starlog_facts',
        arguments: { package: 'acme-internal-auth' },
      });
      expect(textOf(nearMiss).toLowerCase()).toContain('no facts on file');
      await wired.close();

      // WITHOUT the env: the same package is the honest miss — proving the env
      // wiring (not the built-in corpus) is what surfaced it.
      const bare = await connectMcp(cwd);
      const missed = await call(bare, { name: 'starlog_facts', arguments: { package: PKG } });
      const missedText = textOf(missed).toLowerCase();
      expect(missedText).toContain('no facts on file');
      expect(missedText).not.toContain('**license:** mit');
    },
    30000,
  );
});
