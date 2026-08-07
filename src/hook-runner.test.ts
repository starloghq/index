import { describe, it, expect } from 'vitest';
import { editPayload } from './hook-runner.js';

// Direct unit coverage of the Claude-payload → { path, content } translation.
// Field names are pinned to Claude Code's REAL tool schemas — a regression here
// (e.g. someone "fixes" file_path→path per a bad docs summary) makes the whole
// tripwire silently no-op, so these assertions are load-bearing.
describe('editPayload — Claude edit tool_input translation', () => {
  it('reads Write { file_path, content } (full file content)', () => {
    expect(editPayload({ file_path: '/p/src/auth.ts', content: 'jwt.sign()' })).toEqual({
      path: '/p/src/auth.ts',
      content: 'jwt.sign()',
    });
  });

  it('reads Edit new_string (the replacement snippet, not old_string)', () => {
    const out = editPayload({ file_path: '/p/a.ts', old_string: 'OLD', new_string: 'NEW code' });
    expect(out).toEqual({ path: '/p/a.ts', content: 'NEW code' });
  });

  it('joins MultiEdit edits[].new_string into one content blob', () => {
    const out = editPayload({
      file_path: '/p/a.ts',
      edits: [
        { old_string: 'a', new_string: 'first' },
        { old_string: 'b', new_string: 'second' },
      ],
    });
    expect(out?.path).toBe('/p/a.ts');
    expect(out?.content).toBe('first\nsecond');
  });

  it('prefers content over new_string when both are present (Write-shaped)', () => {
    expect(editPayload({ file_path: '/p/a.ts', content: 'FULL', new_string: 'SNIP' })?.content).toBe('FULL');
  });

  it('returns null when file_path is missing or not a string', () => {
    expect(editPayload({ content: 'x' })).toBeNull();
    expect(editPayload({ file_path: 123, content: 'x' })).toBeNull();
    expect(editPayload({ file_path: '', content: 'x' })).toBeNull();
  });

  it('returns empty content (not null) when only the path is present', () => {
    // A path with no content is still a valid edit target; detectFile will just
    // score it on the path alone (below the floor → no warn).
    expect(editPayload({ file_path: '/p/a.ts' })).toEqual({ path: '/p/a.ts', content: '' });
  });

  it('tolerates malformed edits[] entries without throwing', () => {
    const out = editPayload({ file_path: '/p/a.ts', edits: [null, { new_string: 'ok' }, { foo: 1 }, 'nope'] });
    expect(out?.path).toBe('/p/a.ts'); // did not throw
    expect(out?.content).toContain('ok'); // the one valid new_string survives
  });

  it('returns null for non-object / empty input', () => {
    expect(editPayload({})).toBeNull();
    expect(editPayload(null)).toBeNull();
    expect(editPayload(undefined)).toBeNull();
  });
});
