import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, categoryFromObservation, scoreFile, scoreFileForHook, detectKnownLibraryUse, HOOK_MIN_CONFIDENCE, HOOK_HIGH_CONFIDENCE } from './detect.js';

describe('pattern detect', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-detect-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects DIY authentication patterns', async () => {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'auth.ts'),
      `
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!);
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}
`,
    );

    const hits = await scanProject(dir);
    const auth = hits.find((h) => h.category === 'authentication');
    expect(auth).toBeDefined();
    expect(auth!.confidence).toBeGreaterThanOrEqual(30);
  });

  it('skips when known auth library is present', async () => {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'middleware.ts'),
      `import { clerkMiddleware } from '@clerk/nextjs/server';`,
    );

    const hits = await scanProject(dir);
    expect(hits.find((h) => h.category === 'authentication')).toBeUndefined();
  });

  it('maps observation text to category', () => {
    expect(categoryFromObservation('hand-rolled JWT auth for login')).toBe('authentication');
    expect(categoryFromObservation('background job queue worker')).toBe('background-jobs');
  });

  it('scoreFile detects DIY auth in a single file', () => {
    const hit = scoreFile(
      'src/auth.ts',
      `import jwt from 'jsonwebtoken';
export function signToken(id: string) { return jwt.sign({ sub: id }, 'secret'); }`,
    );
    expect(hit).not.toBeNull();
    expect(hit!.category).toBe('authentication');
    expect(hit!.confidence).toBeGreaterThanOrEqual(45);
  });

  it('scoreFileForHook requires path + import and higher confidence', () => {
    const strong = scoreFileForHook(
      'src/auth/login.ts',
      `import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
export function signToken(id: string) { return jwt.sign({ sub: id }, 'secret'); }
export async function hashPassword(pw: string) { return bcrypt.hash(pw, 10); }`,
    );
    expect(strong).not.toBeNull();
    expect(strong!.confidence).toBeGreaterThanOrEqual(HOOK_MIN_CONFIDENCE);

    const importOnly = scoreFileForHook('src/utils.ts', `import jwt from 'jsonwebtoken';`);
    expect(importOnly).toBeNull();

    const keywordOnly = scoreFileForHook('src/auth.ts', '// JWT mentioned in a comment');
    expect(keywordOnly).toBeNull();
  });

  it('detectKnownLibraryUse finds vetted auth libraries on matching paths', () => {
    const hit = detectKnownLibraryUse(
      'src/middleware/auth.ts',
      `import { clerkMiddleware } from '@clerk/nextjs/server';`,
    );
    expect(hit?.category).toBe('authentication');
  });

  it('does not flag vetted ws / native WebSocket as DIY realtime', () => {
    expect(
      scoreFileForHook(
        'src/realtime/server.ts',
        `import { WebSocketServer } from 'ws';\nexport const wss = new WebSocketServer({ port: 8080 });`,
      ),
    ).toBeNull();
    expect(
      detectKnownLibraryUse(
        'src/realtime/server.ts',
        `import { WebSocketServer } from 'ws';`,
      )?.category,
    ).toBe('realtime');
    expect(
      scoreFileForHook(
        'src/socket/client.ts',
        `const ws = new WebSocket('wss://example.com');`,
      ),
    ).toBeNull();
  });

  it('scoreFile returns null for weak signals', () => {
    const hit = scoreFile('src/utils.ts', 'export const x = 1;');
    expect(hit).toBeNull();
  });

  it('scoreFile skips when known auth library is present', () => {
    const hit = scoreFile('src/middleware.ts', `import { clerkMiddleware } from '@clerk/nextjs/server';`);
    expect(hit).toBeNull();
  });

  it('exports hook confidence thresholds in ascending order', () => {
    expect(HOOK_HIGH_CONFIDENCE).toBeGreaterThan(HOOK_MIN_CONFIDENCE);
  });
});
