// dispatch.ts — the generic, cross-platform agent-lifecycle hook contract.
//
// This is the transport-agnostic core behind `starlog hook <event>`. It is the
// keystone of the Hookshot integration (.planning/hookshot-integration.md): a
// single stable envelope that any host — Starlog's own Claude Code wiring, or a
// thin Go shim fronting Cursor/Windsurf/Factory/Codex via Hookshot's unified
// API — can call to get a facts/policy decision.
//
// Contract:
//   stdin  → HookInput  { event, cwd?, payload? }
//   stdout → HookResult { decision: allow|warn|deny, message?, source }
//
// Two invariants, both non-negotiable for a hook that sits in the agent's
// critical path:
//   1. FAIL OPEN. Any malformed input or internal error resolves to `allow`
//      with no message. A facts server must never be why an edit or command
//      fails.
//   2. DEFAULT WARN, NEVER DENY (until opt-in). A false-positive block breaks
//      the developer's flow and burns trust; `deny` is reserved for explicit
//      per-policy opt-in (Phase 2+).
//
// NB: this deliberately does NOT reuse hook-runner.ts's Claude-Code-native
// `hookSpecificOutput` output shape — that path stays as-is for the installed
// PostToolUse shim. This module owns the portable decision envelope.
import { relative, isAbsolute } from 'node:path';
import { detectFile } from '../patterns/detect.js';
import { upsertPattern } from '../patterns/store.js';
import { RECURRENCE_THRESHOLD } from '../patterns/schema.js';
import { parseInstallCommand } from '../patterns/install-parse.js';
import { buildComposeDeps, lookupFactView } from '../engine/facts.js';
import { overlayPath } from '../engine/overlay-discovery.js';

export type HookEvent = 'before_execution' | 'after_file_edit' | 'prompt_submit' | 'stop';

export interface HookInput {
  event: HookEvent;
  /** Absolute project root the agent is operating in. Defaults to process.cwd(). */
  cwd?: string;
  /** Event-specific data (command string, edited file path + content, prompt text). */
  payload?: Record<string, unknown>;
}

export type HookDecision = 'allow' | 'warn' | 'deny';

export interface HookResult {
  decision: HookDecision;
  /** Markdown surfaced to the agent/user. Present only for warn/deny. */
  message?: string;
  source: 'starlog';
}

const ALLOW: HookResult = { decision: 'allow', source: 'starlog' };

// Illustrative vetted libraries per capability, to make the nudge CONCRETE — the
// tripwire eval (.planning/tripwire-eval.md) showed a named hint moves behavior
// far more than a bare "go call the tool" indirection (B→C +16.7pp). These are
// only a teaser to break the DIY anchor; the AUTHORITATIVE, safety- and
// policy-checked recommendation still comes from starlog_advise against the live
// corpus. Kept as flagship names (stable), not the full corpus.
const CATEGORY_HINTS: Record<string, string> = {
  authentication: 'Clerk, Auth0, or better-auth',
  'feature-flags': 'LaunchDarkly, PostHog, or Flagsmith',
  caching: 'ioredis, keyv, or Upstash Redis',
  realtime: 'Socket.IO, Ably, or Pusher',
  'background-jobs': 'BullMQ or Inngest',
  email: 'Resend or SendGrid',
  'orm-database': 'Prisma, Drizzle, or Kysely',
};

/** Payload shape for the `after_file_edit` event. */
interface FileEditPayload {
  /** Path of the file the agent just wrote (absolute or relative to cwd). */
  path?: unknown;
  /** Full post-edit content of the file. */
  content?: unknown;
}

/**
 * `after_file_edit` — the Phase 1 MVP. A cheap, recurrence-gated tripwire for
 * DIY capability code.
 *
 * Cost discipline: the hook fires on every file the agent writes, so the common
 * path must be ~free. `detectFile` is a synchronous regex scan of the single
 * edited file; only if it clears the confidence floor do we touch the (local,
 * cheap) recurrence store. We deliberately do NOT run the full `runAdvise`
 * search here — no network, no LLM in the hot path. When the pattern recurs to
 * threshold we emit one `warn` pointing at `starlog_advise`, which is the
 * explicit resolver that ranks safe migrate/packageize candidates.
 *
 * (Deviation from the plan's first sketch, which fed each edit through
 * `runAdvise` directly — that pays a multi-second search per edit even to return
 * `watch`. Owning the tripwire here and delegating the expensive ranking to the
 * tool is cheaper and sidesteps double-counting the recurrence store. Logged as
 * an open question in .planning/hookshot-integration.md.)
 */
async function handleAfterFileEdit(input: HookInput): Promise<HookResult> {
  const payload = (input.payload ?? {}) as FileEditPayload;
  const filePath = typeof payload.path === 'string' ? payload.path : undefined;
  const content = typeof payload.content === 'string' ? payload.content : undefined;
  if (!filePath || content === undefined) return ALLOW;

  const cwd = input.cwd ?? process.cwd();
  const relPath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;

  const hit = detectFile(relPath, content);
  if (!hit) return ALLOW; // cheap path: not a tracked capability

  // Record the occurrence (cheap local write). This is the recurrence counter.
  const record = await upsertPattern({
    category: hit.category,
    signals: hit.signals,
    projectDir: cwd,
  });

  // Fire exactly once, at the threshold crossing — silent below, and quiet again
  // above so we don't nag on every subsequent edit of the same pattern.
  if (record.occurrences !== RECURRENCE_THRESHOLD) return ALLOW;

  const hint = CATEGORY_HINTS[hit.category];
  const teaser = hint
    ? `Vetted libraries like ${hint} likely cover this. `
    : 'A vetted library may already cover this. ';
  return {
    decision: 'warn',
    source: 'starlog',
    message:
      `[Starlog] Recurring DIY ${hit.category} detected (${record.occurrences}× across your projects). ` +
      `${teaser}Call starlog_advise for a safety- and policy-checked recommendation before writing ` +
      `more custom ${hit.category} code, and starlog_facts to vet any package you reach for.`,
  };
}

/** Payload shape for the `before_execution` event. */
interface CommandPayload {
  /** The shell command the agent is about to run. */
  command?: unknown;
}

/**
 * `before_execution` — L3 policy gating on dependency INTRODUCTION only (Decision
 * 3 in the plan). Parses `npm i <pkg>` / `pnpm add` / `pip install` and, for each
 * package, checks the org's L3 policy locally (no network in a blocking pre-hook).
 * If a package is policy-DENIED:
 *   - default → `warn` (Claude maps to permissionDecision "ask": surface + let the
 *     user decide — the right posture for an org rule).
 *   - STARLOG_HOOK_ENFORCE=deny → `deny` (hard block).
 * This is NOT general command safety — L3 rules match on package name / license /
 * maintenance, so there is nothing to gate on for an arbitrary shell command.
 */
function handleBeforeExecution(input: HookInput): HookResult {
  const payload = (input.payload ?? {}) as CommandPayload;
  const command = typeof payload.command === 'string' ? payload.command : undefined;
  if (!command) return ALLOW;

  const parsed = parseInstallCommand(command);
  if (!parsed || parsed.packages.length === 0) return ALLOW; // not a dependency install

  // Resolve the policy/overlay paths from cwd exactly as advise does — the hook
  // subprocess does NOT inherit the MCP server's baked STARLOG_POLICY env, so
  // default to <cwd>/.starlog/policy.json. LOCAL-only, sync, no network.
  const cwd = input.cwd ?? process.cwd();
  const deps = buildComposeDeps({
    ...process.env,
    STARLOG_POLICY: overlayPath(process.env.STARLOG_POLICY, 'policy.json', cwd),
    STARLOG_PRIVATE_FACTS: overlayPath(process.env.STARLOG_PRIVATE_FACTS, 'private-facts.json', cwd),
  });

  const denied: string[] = [];
  for (const { name } of parsed.packages) {
    const view = lookupFactView(name, deps);
    if (view?.l3?.decision === 'deny') {
      denied.push(`${name} (${view.l3.rationale ?? 'org policy'})`);
    }
  }
  if (denied.length === 0) return ALLOW;

  const enforce = process.env.STARLOG_HOOK_ENFORCE === 'deny';
  return {
    decision: enforce ? 'deny' : 'warn',
    source: 'starlog',
    message:
      `[Starlog policy] Org policy denies: ${denied.join('; ')}. ` +
      (enforce
        ? 'Install blocked — use an approved alternative (starlog_search) or obtain a policy exception.'
        : 'Confirm before installing, or use an approved alternative (starlog_search).'),
  };
}

/**
 * Dispatch a fully-typed hook input to its handler. Wraps every handler in a
 * fail-open guard: any thrown error resolves to `allow`.
 */
export async function runHook(input: HookInput): Promise<HookResult> {
  try {
    switch (input?.event) {
      case 'after_file_edit':
        return await handleAfterFileEdit(input);
      case 'before_execution':
        return handleBeforeExecution(input);
      // prompt_submit (facts context injection) and stop (verification gate) are
      // later phases — allow for now so the contract stays forward-compatible.
      case 'prompt_submit':
      case 'stop':
        return ALLOW;
      default:
        return ALLOW; // unknown event → fail open
    }
  } catch {
    return ALLOW; // fail open on any internal error
  }
}

/**
 * Parse a raw stdin envelope and dispatch it. `eventOverride` lets the CLI set
 * the event from its `<event>` argument while stdin carries only `{cwd, payload}`
 * (the shape a Go/Hookshot shim naturally produces). Fail-open on unparseable
 * input.
 */
export async function dispatchRaw(raw: string, eventOverride?: HookEvent): Promise<HookResult> {
  let parsed: Partial<HookInput> = {};
  try {
    const trimmed = raw.trim();
    if (trimmed) {
      // JSON.parse can yield null / a number / a string / a bool — accessing
      // `.event` on a non-object (esp. null) would throw OUTSIDE this try and
      // break the fail-open contract. Only adopt an actual object.
      const p: unknown = JSON.parse(trimmed);
      if (p !== null && typeof p === 'object') parsed = p as Partial<HookInput>;
    }
  } catch {
    return ALLOW; // fail open on malformed JSON
  }
  const event = eventOverride ?? parsed.event;
  if (!event) return ALLOW;
  return runHook({ event, cwd: parsed.cwd, payload: parsed.payload });
}
