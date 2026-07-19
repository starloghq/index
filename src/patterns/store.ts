import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../fsutil.js';
import {
  PatternRecordSchema,
  PatternStoreSchema,
  type PatternRecord,
  type PatternSignal,
  type PatternStatus,
  type PatternStore,
} from './schema.js';

export function getGlobalPatternsPath(): string {
  return join(homedir(), '.starlog', 'patterns.json');
}

export function getProjectPatternsPath(projectDir: string): string {
  return join(projectDir, '.starlog', 'patterns.json');
}

export function fingerprintSignals(category: string, signals: PatternSignal[]): string {
  const normalized = signals
    .map((s) => `${s.kind}:${s.value}`)
    .sort()
    .join('|');
  return createHash('sha256').update(`${category}::${normalized}`).digest('hex').slice(0, 16);
}

export async function readPatternStore(path: string): Promise<PatternStore> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const r = PatternStoreSchema.safeParse(parsed);
    return r.success ? r.data : { patterns: [] };
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { patterns: [] };
    }
    throw err;
  }
}

export async function writePatternStore(path: string, store: PatternStore): Promise<void> {
  await atomicWrite(path, JSON.stringify(store, null, 2) + '\n');
}

export interface UpsertPatternInput {
  category: string;
  signals: PatternSignal[];
  projectDir?: string;
  status?: PatternStatus;
}

/**
 * Upsert a pattern into project and global stores. Returns the merged record and
 * total occurrences across both stores (deduped by fingerprint).
 */
export async function upsertPattern(
  input: UpsertPatternInput,
  paths: { project?: string; global?: string } = {},
): Promise<PatternRecord> {
  const projectPath = paths.project ?? (input.projectDir ? getProjectPatternsPath(input.projectDir) : undefined);
  const globalPath = paths.global ?? getGlobalPatternsPath();
  const now = new Date().toISOString();
  const fingerprint = fingerprintSignals(input.category, input.signals);

  const projectStore = projectPath ? await readPatternStore(projectPath) : { patterns: [] };
  const globalStore = await readPatternStore(globalPath);

  const existing =
    projectStore.patterns.find((p) => p.fingerprint === fingerprint) ??
    globalStore.patterns.find((p) => p.fingerprint === fingerprint);

  const occurrences = (existing?.occurrences ?? 0) + 1;
  const sourceProjects = new Set(existing?.source_projects ?? []);
  if (input.projectDir) sourceProjects.add(input.projectDir);

  const record: PatternRecord = PatternRecordSchema.parse({
    id: existing?.id ?? `pat-${fingerprint}`,
    category: input.category,
    fingerprint,
    signals: input.signals,
    occurrences,
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    status: input.status ?? existing?.status ?? 'watching',
    source_projects: [...sourceProjects],
  });

  const upsert = (store: PatternStore): PatternStore => {
    const filtered = store.patterns.filter((p) => p.fingerprint !== fingerprint);
    return { patterns: [...filtered, record] };
  };

  if (projectPath) await writePatternStore(projectPath, upsert(projectStore));
  await writePatternStore(globalPath, upsert(globalStore));

  return record;
}

export async function listPatterns(projectDir?: string): Promise<PatternRecord[]> {
  const globalStore = await readPatternStore(getGlobalPatternsPath());
  if (!projectDir) return globalStore.patterns;

  const projectStore = await readPatternStore(getProjectPatternsPath(projectDir));
  const byFp = new Map<string, PatternRecord>();
  for (const p of globalStore.patterns) byFp.set(p.fingerprint, p);
  for (const p of projectStore.patterns) {
    const prev = byFp.get(p.fingerprint);
    if (!prev || p.occurrences > prev.occurrences) byFp.set(p.fingerprint, p);
  }
  return [...byFp.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export async function updatePatternStatus(
  patternId: string,
  status: PatternStatus,
  projectDir?: string,
): Promise<boolean> {
  const paths = [getGlobalPatternsPath()];
  if (projectDir) paths.push(getProjectPatternsPath(projectDir));

  let updated = false;
  for (const path of paths) {
    const store = await readPatternStore(path);
    const entry = store.patterns.find((p) => p.id === patternId);
    if (!entry) continue;
    entry.status = status;
    await writePatternStore(path, store);
    updated = true;
  }
  return updated;
}

export function totalOccurrences(record: PatternRecord, global?: PatternRecord): number {
  if (!global || global.fingerprint !== record.fingerprint) return record.occurrences;
  return Math.max(record.occurrences, global.occurrences);
}
