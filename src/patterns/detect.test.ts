import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProject, categoryFromObservation, detectFile } from './detect.js';

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

  describe('detectFile (single-file tripwire)', () => {
    it('detects DIY auth in one file without a filesystem walk', () => {
      const hit = detectFile(
        'src/auth.ts',
        `import jwt from 'jsonwebtoken';
export const signToken = (id) => jwt.sign({ sub: id }, process.env.JWT_SECRET);`,
      );
      expect(hit?.category).toBe('authentication');
      expect(hit!.signals.some((s) => s.kind === 'path')).toBe(true);
    });

    it('returns null for a non-capability file', () => {
      expect(detectFile('src/util.ts', 'export const add = (a, b) => a + b;')).toBeNull();
    });

    it('returns null when a known library is already present', () => {
      expect(
        detectFile('src/mw.ts', `import { clerkMiddleware } from '@clerk/nextjs/server';`),
      ).toBeNull();
    });

    it('does not fire on a capability-ish filename alone (score below floor)', () => {
      // Path match (+2) without any import/keyword is below the score-3 floor —
      // avoids false-positiving on every file that merely lives in an auth/ dir.
      expect(detectFile('src/auth/index.ts', 'export const VERSION = "1.0.0";')).toBeNull();
    });

    it('returns null for empty content', () => {
      expect(detectFile('src/auth.ts', '')).toBeNull();
    });

    it('stays bounded and still detects on an oversized edit (head-slice scan)', () => {
      const diy = `import jwt from 'jsonwebtoken';\nexport const s = (i) => jwt.sign({ sub: i }, process.env.JWT_SECRET);\n`;
      const huge = diy + 'x'.repeat(1_000_000); // > 512KB, signal near the top
      const hit = detectFile('src/auth.ts', huge);
      expect(hit?.category).toBe('authentication');
    });
  });
});
