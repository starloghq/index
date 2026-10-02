import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectHookPlatform, emitPreToolUse } from './hook-output.js';

describe('hook-output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects Cursor from camelCase hook events', () => {
    expect(detectHookPlatform({ hook_event_name: 'preToolUse' })).toBe('cursor');
    expect(detectHookPlatform({ hook_event_name: 'beforeShellExecution' })).toBe('cursor');
  });

  it('detects Claude from PascalCase events (shared Copilot-compatible shape)', () => {
    expect(detectHookPlatform({ hook_event_name: 'PreToolUse' })).toBe('claude');
    expect(detectHookPlatform({ hook_event_name: 'PostToolUse' })).toBe('claude');
  });

  it('emits Cursor preToolUse shape with ask', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])));

    emitPreToolUse('cursor', {
      permissionDecision: 'ask',
      permissionDecisionReason: 'migrate to Clerk',
      additionalContext: 'migrate to Clerk',
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.permission).toBe('ask');
    expect(parsed.user_message).toBe('migrate to Clerk');
    expect(parsed.agent_message).toBe('migrate to Clerk');
    expect(parsed.additional_context).toBe('migrate to Clerk');
  });

  it('emits Claude PreToolUse ask + reason (no additionalContext — PostToolUse-only)', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])));

    emitPreToolUse('claude', {
      permissionDecision: 'ask',
      permissionDecisionReason: 'hand-rolled auth — migrate to Clerk',
      additionalContext: 'ignored on PreToolUse',
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('migrate to Clerk');
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it('emits Claude PreToolUse deny shape', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])));

    emitPreToolUse('claude', {
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked',
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('blocked');
  });
});
