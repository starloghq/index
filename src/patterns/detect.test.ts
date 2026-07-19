import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, categoryFromObservation } from './detect.js';

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
});
