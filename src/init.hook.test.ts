import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
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

// Drive the shim with a Claude Code edit-tool payload (Write/Edit/MultiEdit),
// returning every emitted advisory. Isolated HOME so the recurrence store lands
// in a throwaway ~/.starlog. Reusing one home across calls lets the recurrence
// counter accumulate, exactly as it would across real edits.
function runEdit(
  toolName: string,
  toolInput: Record<string, unknown>,
  env: { home: string; cwd: string },
): string[] {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: env.cwd });
  const out = execFileSync(process.execPath, [hookPath], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: env.home },
  });
  return out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l).hookSpecificOutput.additionalContext as string);
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

// The shim self-routes: an Edit/Write/MultiEdit payload drives the DIY tripwire
// (after_file_edit) instead of the install-facts path. Recurrence-gated: silent
// below threshold, one warn at the crossing, quiet after.
describe('edit tripwire (after_file_edit)', () => {
  const diyAuth = `import jwt from 'jsonwebtoken';
export const signToken = (id: string) => jwt.sign({ sub: id }, process.env.JWT_SECRET!);`;

  function freshEnv() {
    const home = mkdtempSync(join(tmpdir(), 'starlog-edit-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'starlog-edit-cwd-'));
    mkdirSync(join(cwd, '.starlog'), { recursive: true });
    return { home, cwd };
  }

  it('warns once at the recurrence threshold for recurring DIY capability code', () => {
    const env = freshEnv();
    const input = { file_path: join(env.cwd, 'src', 'auth.ts'), content: diyAuth };

    const first = runEdit('Write', input, env); // below threshold → silent
    expect(first.length).toBe(0);

    const second = runEdit('Write', input, env); // crosses threshold → warn
    expect(second.length).toBe(1);
    expect(second[0]).toContain('authentication');
    expect(second[0]).toContain('starlog_advise');

    const third = runEdit('Write', input, env); // above threshold → quiet
    expect(third.length).toBe(0);
  });

  it('stays silent for a non-capability edit', () => {
    const env = freshEnv();
    const msgs = runEdit(
      'Write',
      { file_path: join(env.cwd, 'src', 'util.ts'), content: 'export const add = (a, b) => a + b;' },
      env,
    );
    expect(msgs.length).toBe(0);
  });

  it('reads Edit new_string, not just Write content', () => {
    const env = freshEnv();
    const input = { file_path: join(env.cwd, 'src', 'auth.ts'), old_string: '', new_string: diyAuth };
    runEdit('Edit', input, env);
    const warned = runEdit('Edit', input, env);
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('authentication');
  });

  it('handles a MultiEdit edits[] payload', () => {
    const env = freshEnv();
    const input = {
      file_path: join(env.cwd, 'src', 'auth.ts'),
      edits: [
        { old_string: 'a', new_string: `import jwt from 'jsonwebtoken';` },
        { old_string: 'b', new_string: `export const s = (i) => jwt.sign({ sub: i }, process.env.JWT_SECRET);` },
      ],
    };
    runEdit('MultiEdit', input, env);
    const warned = runEdit('MultiEdit', input, env);
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('authentication');
  });
});

// GOLDEN: drive the shim with a payload shaped like Claude Code's REAL PostToolUse
// stdin (all top-level fields present, verified against code.claude.com/docs), not
// a minimal synthetic one. Proves the shim reads the right fields and ignores the
// rest — the guard against a silent no-op if the real envelope carries extras.
describe('real PostToolUse envelope (golden)', () => {
  function fullEnvelope(toolName: string, toolInput: Record<string, unknown>, cwd: string) {
    return JSON.stringify({
      session_id: 'abc123',
      prompt_id: '550e8400-e29b-41d4-a716-446655440000',
      transcript_path: '/home/u/.claude/projects/x/transcript.jsonl',
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu_01ABC',
      tool_output: 'File updated successfully',
    });
  }

  function driveFull(toolName: string, toolInput: Record<string, unknown>): string[] {
    const home = mkdtempSync(join(tmpdir(), 'starlog-golden-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'starlog-golden-cwd-'));
    mkdirSync(join(cwd, '.starlog'), { recursive: true });
    const payload = fullEnvelope(toolName, { ...toolInput, file_path: join(cwd, 'src', 'auth.ts') }, cwd);
    // Fire twice (same env) to cross the recurrence threshold deterministically.
    execFileSync(process.execPath, [hookPath], { input: payload, encoding: 'utf8', env: { ...process.env, HOME: home } });
    const out = execFileSync(process.execPath, [hookPath], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    return out
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l).hookSpecificOutput.additionalContext as string);
  }

  const diy = `import jwt from 'jsonwebtoken';
export const signToken = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET);`;

  it('Write: full envelope → tripwire warns and emits valid hookSpecificOutput', () => {
    const msgs = driveFull('Write', { content: diy });
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('authentication');
    expect(msgs[0]).toContain('starlog_advise');
  });

  it('Edit: full envelope with new_string → tripwire warns', () => {
    const msgs = driveFull('Edit', { old_string: '', new_string: diy });
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('authentication');
  });

  it('Bash install in a full envelope still surfaces install-facts (no regression)', () => {
    const home = mkdtempSync(join(tmpdir(), 'starlog-golden-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'starlog-golden-cwd-'));
    const payload = fullEnvelope('Bash', { command: 'npm install event-stream' }, cwd);
    const out = execFileSync(process.execPath, [hookPath], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    const msgs = out
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l).hookSpecificOutput.additionalContext as string);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('event-stream');
  });
});

// PreToolUse (before_execution) policy gate through the real shim. A PreToolUse
// Bash payload for a policy-denied install must emit Claude's permissionDecision
// (ask by default, deny under STARLOG_HOOK_ENFORCE=deny); an allowed install emits
// nothing (normal permission flow).
describe('PreToolUse policy gate (e2e)', () => {
  function drivePre(command: string, opts: { enforce?: boolean } = {}): any {
    const home = mkdtempSync(join(tmpdir(), 'starlog-pre-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'starlog-pre-cwd-'));
    mkdirSync(join(cwd, '.starlog'), { recursive: true });
    writeFileSync(
      join(cwd, '.starlog', 'policy.json'),
      JSON.stringify({ org: 'test', rules: [{ id: 'ban', decision: 'deny', match: { package: 'evil-pkg' }, rationale: 'malware' }] }),
    );
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
    const env: Record<string, string> = { ...process.env, HOME: home };
    delete env.STARLOG_POLICY; // let cwd resolution win
    delete env.STARLOG_PRIVATE_FACTS;
    if (opts.enforce) env.STARLOG_HOOK_ENFORCE = 'deny';
    const out = execFileSync(process.execPath, [hookPath], { input: payload, encoding: 'utf8', env });
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    return line ? JSON.parse(line) : null;
  }

  it('asks (does not hard-block) on a policy-denied install by default', () => {
    const r = drivePre('npm install evil-pkg');
    expect(r.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(r.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('evil-pkg');
  });

  it('denies (hard block) under STARLOG_HOOK_ENFORCE=deny', () => {
    const r = drivePre('npm install evil-pkg', { enforce: true });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('emits nothing for an allowed install (normal permission flow)', () => {
    expect(drivePre('npm install lodash')).toBeNull();
  });
});
