import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, checkPrivateOverlays, checkOrgCorpus } from './doctor.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-doctor-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('readJson() — distinguishes absent from invalid (M6)', () => {
  it('returns {kind: "absent"} when the file does not exist', async () => {
    const res = await readJson(join(tmpRoot, 'nope.json'));
    expect(res).toEqual({ kind: 'absent' });
  });

  it('returns {kind: "ok", data} for valid JSON', async () => {
    const p = join(tmpRoot, 'settings.json');
    await writeFile(p, JSON.stringify({ mcpServers: { starlog: {} } }));
    const res = await readJson(p);
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.data.mcpServers).toBeDefined();
    }
  });

  it('returns {kind: "invalid", error} for malformed JSON (NOT confused with absent)', async () => {
    const p = join(tmpRoot, 'settings.json');
    await writeFile(p, '{ broken json ');
    const res = await readJson(p);
    expect(res.kind).toBe('invalid');
    if (res.kind === 'invalid') {
      expect(res.error).toBeTruthy();
    }
  });
});

describe('checkPrivateOverlays() — wiring + per-project authoring visibility', () => {
  const WIRED = {
    mcpServers: {
      starlog: { command: 'node', args: ['/x/dist/mcp.js'], env: {
        STARLOG_PRIVATE_FACTS: '${CLAUDE_PROJECT_DIR}/.starlog/private-facts.json',
        STARLOG_PRIVATE_CORPUS: '${CLAUDE_PROJECT_DIR}/.starlog/private-corpus.json',
      } },
    },
  };
  const byLabel = (cs: Array<{ label: string; level: string; detail?: string }>, l: string) => cs.find((c) => c.label === l);
  const writeOverlay = async (rel: string, obj: unknown) => {
    await mkdir(join(tmpRoot, '.starlog'), { recursive: true });
    await writeFile(join(tmpRoot, rel), JSON.stringify(obj));
  };

  it('reports OK wiring when the MCP server env carries the overlay paths', async () => {
    const checks = await checkPrivateOverlays(WIRED, tmpRoot);
    const w = byLabel(checks, 'Private overlays wired');
    expect(w?.level).toBe('ok');
  });

  it('warns to re-run init when the MCP server is configured WITHOUT the overlay env (pre-wiring install)', async () => {
    const settings = { mcpServers: { starlog: { command: 'node', args: ['/x/dist/mcp.js'] } } };
    const checks = await checkPrivateOverlays(settings, tmpRoot);
    const w = byLabel(checks, 'Private overlays wired');
    expect(w?.level).toBe('warn');
    expect(w?.detail).toContain('starlog init');
  });

  it('omits the wiring check entirely when no MCP server is configured', async () => {
    const checks = await checkPrivateOverlays({ mcpServers: {} }, tmpRoot);
    expect(byLabel(checks, 'Private overlays wired')).toBeUndefined();
  });

  it('counts authored entries per overlay in this project', async () => {
    await writeOverlay('.starlog/private-facts.json', { l1: [], l2: [{ package: 'a' }, { package: 'b' }] });
    await writeOverlay('.starlog/private-corpus.json', { manifests: [{ id: 'x' }] });
    const checks = await checkPrivateOverlays(WIRED, tmpRoot);
    const p = byLabel(checks, 'Private overlays (this project)');
    expect(p?.level).toBe('ok');
    expect(p?.detail).toContain('vetting 2');
    expect(p?.detail).toContain('discovery 1');
  });

  it('nudges toward authoring when no overlays exist in this project', async () => {
    const checks = await checkPrivateOverlays(WIRED, tmpRoot);
    const p = byLabel(checks, 'Private overlays (this project)');
    expect(p?.level).toBe('warn');
    expect(p?.detail).toContain('corpus add');
  });

  it('flags an invalid overlay file rather than silently ignoring it', async () => {
    await mkdir(join(tmpRoot, '.starlog'), { recursive: true });
    await writeFile(join(tmpRoot, '.starlog', 'private-corpus.json'), '{ broken ');
    const checks = await checkPrivateOverlays(WIRED, tmpRoot);
    expect(byLabel(checks, 'Private discovery')?.level).toBe('warn');
  });
});

describe('checkOrgCorpus() — optional company-hosted discovery URL', () => {
  it('reports OK when STARLOG_ORG_CORPUS_URL is wired in MCP env', () => {
    const settings = {
      mcpServers: {
        starlog: {
          command: 'node',
          args: ['/x/dist/mcp.js'],
          env: { STARLOG_ORG_CORPUS_URL: 'https://corp.example.test/corpus.json' },
        },
      },
    };
    const check = checkOrgCorpus(settings);
    expect(check?.level).toBe('ok');
    expect(check?.label).toBe('Org corpus URL wired');
  });

  it('returns null when org corpus URL is not configured', () => {
    expect(checkOrgCorpus({ mcpServers: { starlog: { command: 'node', args: [] } } })).toBeNull();
    expect(checkOrgCorpus(null)).toBeNull();
  });
});
