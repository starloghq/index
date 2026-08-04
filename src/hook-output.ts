/** Agent hook output formats differ; normalize emission here. */

export type HookPlatform = 'claude' | 'cursor' | 'copilot';

export interface PreToolUseEmit {
  additionalContext?: string;
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

/**
 * Infer platform from hook stdin payload shape.
 * Cursor uses camelCase lifecycle names; Claude Code uses PascalCase
 * (PreToolUse / PostToolUse). VS Code Copilot also uses PascalCase and the
 * same hookSpecificOutput shape as Claude — we return 'claude' for that
 * shared wire format so the type is honest. 'copilot' remains available for
 * callers that already know the host.
 */
export function detectHookPlatform(data: Record<string, unknown>): HookPlatform {
  const event = String(data.hook_event_name ?? data.hookEventName ?? '');
  if (
    event === 'preToolUse' ||
    event === 'postToolUse' ||
    event === 'postToolUseFailure' ||
    event === 'beforeShellExecution'
  ) {
    return 'cursor';
  }
  // PascalCase Claude Code / Copilot-compatible events → Claude wire format.
  return 'claude';
}

function cursorPermission(decision: PreToolUseEmit['permissionDecision']): 'allow' | 'deny' | 'ask' {
  if (decision === 'deny') return 'deny';
  if (decision === 'ask') return 'ask';
  return 'allow';
}

export function emitPreToolUse(platform: HookPlatform, out: PreToolUseEmit): void {
  if (platform === 'cursor') {
    const payload: Record<string, unknown> = { permission: cursorPermission(out.permissionDecision) };
    if (out.permissionDecisionReason) payload.user_message = out.permissionDecisionReason;
    if (out.additionalContext) payload.additional_context = out.additionalContext;
    if (out.permissionDecision === 'deny' && out.permissionDecisionReason) {
      payload.agent_message = out.permissionDecisionReason;
    }
    if (out.permissionDecision === 'ask' && out.permissionDecisionReason) {
      // Ask reason must reach the agent — Cursor surfaces agent_message to the model.
      payload.agent_message = out.permissionDecisionReason;
    }
    console.log(JSON.stringify(payload));
    return;
  }

  // Claude Code (+ Copilot-compatible) PreToolUse: only permissionDecision /
  // permissionDecisionReason / updatedInput are honored. additionalContext is
  // PostToolUse-only today (anthropics/claude-code#15664). Surface guidance via ask/deny.
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
  };
  if (out.permissionDecision) hookSpecificOutput.permissionDecision = out.permissionDecision;
  if (out.permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = out.permissionDecisionReason;
  console.log(JSON.stringify({ hookSpecificOutput }));
}

export function emitPostToolUseContext(platform: HookPlatform, context: string): void {
  if (platform === 'cursor') {
    console.log(JSON.stringify({ additional_context: context }));
    return;
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
    }),
  );
}
