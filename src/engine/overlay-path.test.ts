import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveOverlayPath } from './overlay-path.js';

// Snapshot/restore the two env vars the resolver reads, so tests can't leak into
// each other or into the real process environment.
let saved: { proj?: string; cwd: string };
beforeEach(() => {
  saved = { proj: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd() };
});
afterEach(() => {
  if (saved.proj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = saved.proj;
});

describe('resolveOverlayPath — runtime expansion of MCP overlay paths', () => {
  it('expands ${CLAUDE_PROJECT_DIR} from the server process env (the real bug)', () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/proj-a';
    expect(resolveOverlayPath('${CLAUDE_PROJECT_DIR}/.starlog/private-corpus.json')).toBe(
      '/tmp/proj-a/.starlog/private-corpus.json',
    );
  });

  it('falls back to cwd when CLAUDE_PROJECT_DIR is unset (never yields a bogus /.starlog path)', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveOverlayPath('${CLAUDE_PROJECT_DIR}/.starlog/policy.json')).toBe(
      join(process.cwd(), '.starlog/policy.json'),
    );
  });

  it('leaves an already-absolute path unchanged (idempotent — existing loader tests stay green)', () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/proj-a';
    expect(resolveOverlayPath('/var/data/private-corpus.json')).toBe('/var/data/private-corpus.json');
  });

  it('expands a leading ~ to the home directory', () => {
    expect(resolveOverlayPath('~/.starlog/private-corpus.json')).toBe(join(homedir(), '.starlog/private-corpus.json'));
  });

  it('resolves a project-relative path against CLAUDE_PROJECT_DIR (the docs-recommended form)', () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/proj-b';
    const out = resolveOverlayPath('.starlog/private-corpus.json');
    expect(isAbsolute(out!)).toBe(true);
    expect(out).toBe('/tmp/proj-b/.starlog/private-corpus.json');
  });

  it('honors ${VAR:-default} when the variable is unset', () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(resolveOverlayPath('${CLAUDE_PROJECT_DIR:-/tmp/fallback}/x.json')).toBe('/tmp/fallback/x.json');
  });

  it('passes through undefined/empty (loaders treat falsy as "no overlay configured")', () => {
    expect(resolveOverlayPath(undefined)).toBeUndefined();
    expect(resolveOverlayPath('')).toBe('');
  });

  it('honors an explicit projectDir override (doctor validates against a KNOWN root, not its own cwd)', () => {
    // Even with a different CLAUDE_PROJECT_DIR in the env, the explicit base wins —
    // this is how `doctor` resolves the server-side env string against the project
    // it is inspecting rather than doctor's own process cwd.
    process.env.CLAUDE_PROJECT_DIR = '/tmp/doctors-own-cwd';
    expect(resolveOverlayPath('${CLAUDE_PROJECT_DIR}/.starlog/private-corpus.json', '/known/root')).toBe(
      '/known/root/.starlog/private-corpus.json',
    );
    expect(resolveOverlayPath('.starlog/private-corpus.json', '/known/root')).toBe('/known/root/.starlog/private-corpus.json');
  });
});
