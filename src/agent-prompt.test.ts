import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_SETUP_PROMPT, KEY_URL } from './agent-prompt.js';

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

describe('AGENT_SETUP_PROMPT', () => {
  it('is plain text: no ANSI escapes, no trailing whitespace, no trailing newline', () => {
    expect(AGENT_SETUP_PROMPT).not.toMatch(/\x1b\[/);
    expect(AGENT_SETUP_PROMPT).not.toMatch(/[ \t]+$/m);
    expect(AGENT_SETUP_PROMPT.endsWith('\n')).toBe(false);
  });

  it('previews with --dry-run and applies with -y so an agent never hits the interactive prompt', () => {
    expect(AGENT_SETUP_PROMPT).toContain('starlog init --dry-run');
    expect(AGENT_SETUP_PROMPT).toContain('starlog init -y');
    expect(AGENT_SETUP_PROMPT).toContain('starlog init --api-key <key> -y');
    // Every bare `starlog init` invocation must be non-interactive.
    const initLines = AGENT_SETUP_PROMPT.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('starlog init'));
    for (const line of initLines) expect(line).toMatch(/--dry-run|-y\b/);
  });

  it('treats the hosted key as a human handoff and keeps keyless the default', () => {
    expect(AGENT_SETUP_PROMPT).toContain(KEY_URL);
    expect(AGENT_SETUP_PROMPT).toMatch(/say 'skip'/);
  });

  it('verifies with doctor and tells the user to restart before using MCP tools', () => {
    expect(AGENT_SETUP_PROMPT).toContain('starlog doctor');
    expect(AGENT_SETUP_PROMPT).toMatch(/restart/i);
    expect(AGENT_SETUP_PROMPT).toContain('starlog_search');
    expect(AGENT_SETUP_PROMPT).toContain('starlog_facts');
  });

  it('installs the published package name and states the real Node floor', () => {
    expect(AGENT_SETUP_PROMPT).toContain(`npm install -g ${PKG.name}`);
    const floor = String(PKG.engines.node).match(/\d+/)![0];
    expect(AGENT_SETUP_PROMPT).toContain(`Node ${floor}+`);
  });

  it('is stable (snapshot) — a change here must be deliberate and re-verified against init', () => {
    expect(AGENT_SETUP_PROMPT).toMatchSnapshot();
  });
});
