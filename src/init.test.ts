import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertMarkedSection, removeMarkedSection, markedSectionAction, desiredMcpServer } from './init.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'starlog-init-test-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(() => true, () => false);

describe('upsertMarkedSection() + removeMarkedSection()', () => {
  it('round-trips a file with pre-existing content byte-for-byte', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    const original = '# My Project\n\nSome existing instructions.\n';
    await writeFile(target, original);

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toContain('starlog:init');

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(original); // byte-identical
  });

  it('preserves content the user appended AFTER the Starlog section (the M2 bug)', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);

    // User edits the file and adds their own prose below the Starlog block.
    const withUserTail = (await readFile(target, 'utf8')) + '\n# My own notes\nKeep me.\n';
    await writeFile(target, withUserTail);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);

    const result = await readFile(target, 'utf8');
    expect(result).toContain('# Title');
    expect(result).toContain('# My own notes');
    expect(result).toContain('Keep me.');
    expect(result).not.toContain('starlog:init');
    expect(result).not.toContain('starlog:end');
  });

  it('writes a .bak with the pre-removal content before deleting', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);
    const beforeRemoval = await readFile(target, 'utf8');

    const down = await removeMarkedSection(target);
    expect(down.backedUp).toBe(true);
    expect(await exists(`${target}.bak`)).toBe(true);
    expect(await readFile(`${target}.bak`, 'utf8')).toBe(beforeRemoval);
  });

  it('handles a marker at the start of an otherwise-empty file', async () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const up = await upsertMarkedSection(target); // file did not exist
    expect(up.changed).toBe(true);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('');
  });

  it('is idempotent: a second upsert is a no-op', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await upsertMarkedSection(target);
    const afterFirst = await readFile(target, 'utf8');

    const second = await upsertMarkedSection(target);
    expect(second.changed).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(afterFirst);
  });

  it('removes a legacy section (start marker, no end marker) without throwing', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    // Simulate a pre-end-marker install: start marker, no end marker, trailing comment.
    const legacy =
      '# Title\n\n<!-- starlog:init -->\n## Starlog — Capability Search\n\nold instructions\n<!-- other-tool -->\nkeep this\n';
    await writeFile(target, legacy);

    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(true);
    const result = await readFile(target, 'utf8');
    expect(result).not.toContain('starlog:init');
    expect(result).toContain('# Title');
    expect(result).toContain('keep this');
  });

  it('refreshes drifted instruction text in place (L7), preserving surrounding content', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n');
    await upsertMarkedSection(target);
    // Simulate drift: user appends content, and the section body gets stale.
    const installed = await readFile(target, 'utf8');
    const staleBody = installed.replace(
      'vet it with',
      'OUTDATED please ignore — vet it with',
    );
    await writeFile(target, staleBody + '\n# User notes\nKeep me.\n');

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(true);

    const result = await readFile(target, 'utf8');
    expect(result).not.toContain('OUTDATED please ignore'); // stale body replaced
    expect(result).toContain('vet it with');                // current body present
    expect(result).toContain('# Title');                    // content before preserved
    expect(result).toContain('Keep me.');                   // content after preserved
    // Exactly one section remains (no duplication).
    expect(result.split('starlog:init').length - 1).toBe(1);
    expect(result.split('starlog:end').length - 1).toBe(1);

    // And it's now idempotent again.
    const again = await upsertMarkedSection(target);
    expect(again.changed).toBe(false);
  });

  it('does NOT touch a legacy section without an end marker (avoids clobbering)', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    const legacy =
      '# Title\n\n<!-- starlog:init -->\n## Starlog — Capability Search\n\nold body\n# User notes\nKeep me.\n';
    await writeFile(target, legacy);

    const up = await upsertMarkedSection(target);
    expect(up.changed).toBe(false);          // refused to refresh unbounded section
    expect(await readFile(target, 'utf8')).toBe(legacy); // untouched
  });

  it('is a no-op on a file with no Starlog marker', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Just my stuff\n');
    const down = await removeMarkedSection(target);
    expect(down.changed).toBe(false);
    expect(down.backedUp).toBe(false);
    expect(await exists(`${target}.bak`)).toBe(false);
  });
});

describe('markedSectionAction() — preview parity with upsertMarkedSection (init plan can\'t lie)', () => {
  // For every file state, the predicted plan action must agree with what apply
  // actually does: create/update => changed:true, unchanged => changed:false.
  async function assertParity(target: string, expected: 'create' | 'update' | 'unchanged') {
    const predicted = await markedSectionAction(target);
    expect(predicted).toBe(expected);
    const applied = await upsertMarkedSection(target);
    expect(applied.changed).toBe(expected !== 'unchanged');
  }

  it('predicts "create" for an absent file', async () => {
    await assertParity(join(tmpRoot, 'CLAUDE.md'), 'create');
  });

  it('predicts "update" for a file that exists but has no section', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# My stuff\n');
    await assertParity(target, 'update');
  });

  it('predicts "unchanged" for a freshly installed section', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await upsertMarkedSection(target); // install
    await assertParity(target, 'unchanged');
  });

  it('predicts "update" for a drifted bounded section', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await upsertMarkedSection(target);
    const stale = (await readFile(target, 'utf8')).replace('vet it with', 'STALE — vet it with');
    await writeFile(target, stale);
    await assertParity(target, 'update');
  });

  it('predicts "unchanged" for a legacy section (no end marker), matching upsert\'s refusal', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await writeFile(target, '# Title\n\n<!-- starlog:init -->\n## Starlog — Capability Search\n\nold\n');
    await assertParity(target, 'unchanged');
  });
});

describe('facts-first onboarding text (D-01/D-02/D-04)', () => {
  it('marked section is facts-first (starlog_facts hero, no stale search-first copy)', async () => {
    const target = join(tmpRoot, 'CLAUDE.md');
    await upsertMarkedSection(target);
    const written = await readFile(target, 'utf8');

    // The instruction injected into every harness leads with starlog_facts.
    expect(written).toContain('starlog_facts');
    expect(written).toContain('starlog_advise');
    expect(written).toContain('vet packages before you use them'); // facts-first header
    expect(written).toContain('vet it with');                      // stable body substring

    // The stale search-first copy is gone.
    expect(written).not.toContain('ALWAYS consult');
    expect(written).not.toContain('## Starlog — Capability Search');
  });
});

describe('desiredMcpServer — per-project private overlays baked into the agent server', () => {
  it('bakes CLAUDE_PROJECT_DIR-relative paths for facts, corpus, and policy (the agent never inherits the shell)', () => {
    const env = desiredMcpServer().env;
    // Resolves per-project at runtime via Claude Code's ${CLAUDE_PROJECT_DIR}
    // expansion — one global entry, no cross-project leak, no cwd dependency.
    expect(env.STARLOG_PRIVATE_FACTS).toBe('${CLAUDE_PROJECT_DIR}/.starlog/private-facts.json');
    expect(env.STARLOG_PRIVATE_CORPUS).toBe('${CLAUDE_PROJECT_DIR}/.starlog/private-corpus.json');
    expect(env.STARLOG_POLICY).toBe('${CLAUDE_PROJECT_DIR}/.starlog/policy.json');
  });

  it('omits the hosted key unless provided, and bakes it when given', () => {
    expect(desiredMcpServer().env.STARLOG_API_KEY).toBeUndefined();
    expect(desiredMcpServer('sk-test-123').env.STARLOG_API_KEY).toBe('sk-test-123');
  });

  it('still points at the shipped server entrypoint', () => {
    const e = desiredMcpServer();
    expect(e.command).toBe('node');
    expect(e.args[0]).toMatch(/dist[/\\]mcp\.js$/);
  });
});
