import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fingerprintSignals,
  readPatternStore,
  upsertPattern,
  writePatternStore,
  getProjectPatternsPath,
} from './store.js';

describe('pattern store', () => {
  let dir: string;
  let globalPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starlog-patterns-'));
    globalPath = join(dir, 'global-patterns.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fingerprint is stable for same signals', () => {
    const signals = [{ kind: 'path' as const, value: 'src/auth.ts' }];
    const a = fingerprintSignals('authentication', signals);
    const b = fingerprintSignals('authentication', signals);
    expect(a).toBe(b);
  });

  it('upsert increments occurrences', async () => {
    const projectPath = getProjectPatternsPath(dir);
    const signals = [{ kind: 'import' as const, value: 'jsonwebtoken' }];

    const first = await upsertPattern(
      { category: 'authentication', signals, projectDir: dir },
      { project: projectPath, global: globalPath },
    );
    const second = await upsertPattern(
      { category: 'authentication', signals, projectDir: dir },
      { project: projectPath, global: globalPath },
    );

    expect(first.occurrences).toBe(1);
    expect(second.occurrences).toBe(2);
    expect(second.fingerprint).toBe(first.fingerprint);

    const store = await readPatternStore(projectPath);
    expect(store.patterns).toHaveLength(1);
  });

  it('writePatternStore round-trips', async () => {
    const path = join(dir, 'patterns.json');
    await writePatternStore(path, {
      patterns: [
        {
          id: 'pat-abc',
          category: 'caching',
          fingerprint: 'abc',
          signals: [],
          occurrences: 1,
          first_seen: '2026-01-01T00:00:00.000Z',
          last_seen: '2026-01-02T00:00:00.000Z',
          status: 'watching',
        },
      ],
    });
    const store = await readPatternStore(path);
    expect(store.patterns[0].category).toBe('caching');
  });
});
