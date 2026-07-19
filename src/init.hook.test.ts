import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateHookScript } from './init.js';

const hookPath = join(mkdtempSync(join(tmpdir(), 'starlog-hook-')), 'hook.js');

beforeAll(() => {
  // l2-facts.json must exist (build/gen step); regenerate to be safe.
  execFileSync('npx', ['tsx', 'scripts/gen-l2-facts.ts'], { stdio: 'inherit' });
  // The installed hook is now a thin shim that dynamically imports the package's
  // dist/hook-runner.js (so upgrades refresh behaviour without re-init) — build it
  // so the shim resolves against real, current logic.
  execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
  writeFileSync(hookPath, generateHookScript());
});

function runHook(command: string): any {
  const input = JSON.stringify({ tool_input: { command }, cwd: tmpdir() });
  const out = execFileSync(process.execPath, [hookPath], { input, encoding: 'utf8' });
  const jsonLine = out.split('\n').find((l) => l.trim().startsWith('{'));
  return jsonLine ? JSON.parse(jsonLine) : null;
}

// Returns EVERY emitted facts message (additionalContext). HOME + cwd are
// isolated to throwaway temp dirs so the hook's pending.json side-writes never
// touch the real ~/.starlog/pending.json.
function runHookAll(command: string): string[] {
  const home = mkdtempSync(join(tmpdir(), 'starlog-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'starlog-cwd-'));
  const input = JSON.stringify({ tool_input: { command }, cwd });
  const out = execFileSync(process.execPath, [hookPath], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l).hookSpecificOutput.additionalContext as string);
}

describe('install hook surfaces facts (D-05)', () => {
  it('emits hookSpecificOutput with vuln facts for a package with an L2 record', () => {
    const r = runHook('npm install event-stream');
    expect(r.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(r.hookSpecificOutput.additionalContext).toContain('event-stream');
    expect(r.hookSpecificOutput.additionalContext.toLowerCase()).toMatch(/vuln|incident|maintenance/);
  });

  it('emits honest-absence facts for a package with no record', () => {
    const r = runHook('npm install some-pkg-with-no-record-xyz');
    expect(r.hookSpecificOutput.additionalContext).toContain('No facts on file');
  });

  it('produces valid JS (node --check passes)', () => {
    expect(() => execFileSync(process.execPath, ['--check', hookPath])).not.toThrow();
  });
});

// Regression for starloghq/index#29: the hook used to capture the entire rest of
// the command after `npm install` and split it on whitespace, so compound /
// redirected commands turned shell tokens (`&&`, `>/dev/null`, `"$TARBALL"`,
// paths) into "packages" — spamming the agent with junk facts and polluting
// pending.json.
describe('compound-command parsing (#29) — only real package names', () => {
  it('keeps every real package in a plain multi-package install', () => {
    const msgs = runHookAll('npm install lodash react');
    expect(msgs.length).toBe(2);
    expect(msgs.join(' ')).toContain('lodash');
    expect(msgs.join(' ')).toContain('react');
  });

  it('ignores redirections, operators, and chained commands', () => {
    const msgs = runHookAll('npm i -g some-pkg-xyz >/dev/null 2>&1 && echo installed');
    expect(msgs.length).toBe(1);
    const blob = msgs.join(' || ');
    expect(blob).toContain('some-pkg-xyz');
    for (const junk of ['>/dev/null', '2>&1', '&&', 'echo', 'installed', '/dev/null']) {
      expect(blob).not.toContain(junk);
    }
  });

  it('drops shell variables and command substitution', () => {
    const msgs = runHookAll('npm i "$TARBALL" && echo done');
    expect(msgs.length).toBe(0);
  });

  it('does not record filesystem paths as packages', () => {
    const msgs = runHookAll('pip install /tmp/local-pkg.tgz');
    expect(msgs.join(' ')).not.toContain('/tmp/local-pkg');
  });

  it('strips a trailing version/tag and still surfaces the package', () => {
    const msgs = runHookAll('npm install lodash@4.17.21');
    expect(msgs.length).toBe(1);
    expect(msgs.join(' ')).toContain('lodash');
    // The version must be gone from the message — otherwise the facts lookup
    // and the starlog_facts suggestion key on a name that can never match.
    expect(msgs.join(' ')).not.toContain('@4.17.21');
  });
});

// A pinned install of a covered package MUST surface that package's facts —
// this is the hook's hero scenario (ua-parser-js@0.7.29 is one of the exact
// hijacked versions the corpus warns about). Regression for the version-suffix
// gap found in the feature audit.
describe('versioned installs still hit the facts lookup', () => {
  it('npm: surfaces L2 facts for a pinned covered package', () => {
    const msgs = runHookAll('npm install ua-parser-js@0.7.29');
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('ua-parser-js');
    expect(msgs[0]).not.toContain('No facts on file');
    expect(msgs[0].toLowerCase()).toMatch(/vuln|incident/);
  });

  it('npm: preserves the scope while stripping the version', () => {
    const msgs = runHookAll('pnpm add @scope/pkg@2.0.0');
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('@scope/pkg');
    expect(msgs[0]).not.toContain('@2.0.0');
  });

  it('pypi: strips == / >= specifiers before lookup and display', () => {
    const msgs = runHookAll('pip install requests==2.31.0');
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('requests');
    expect(msgs[0]).not.toContain('==2.31.0');
  });
});
