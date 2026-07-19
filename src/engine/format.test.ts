import { describe, it, expect } from 'vitest';
import { formatJSON, formatTable } from './format.js';
import type { QueryResult } from '../manifest/schema.js';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    manifest: {
      id: 'clerk',
      name: 'Clerk',
      repo: 'clerkinc/clerk',
      ecosystem: 'npm',
      category: 'authentication',
      solves: 'Managed authentication with pre-built UI components.',
      stack_affinity: ['next.js', 'react'],
      integration_effort: 'easy',
      best_for: ['SaaS apps', 'rapid prototyping'],
      skip_when: ['self-hosted required'],
      hosted_alternative: null,
      alternative_ids: [],
      health: {
        stars: 8000,
        weekly_downloads: 200000,
        last_commit: '2026-01-15',
        contributors: 45,
        license: 'MIT',
        open_issues: 12,
      },
      quality: {
        has_tests: true,
        has_docs: true,
        has_types: true,
        maintenance_status: 'active',
      },
    },
    relevance_score: 85.5,
    context_fit: 'Great fit for Next.js SaaS.',
    vs_custom: 'Saves 3-4 weeks of development.',
    tradeoffs: ['Vendor lock-in', 'Monthly cost'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatJSON
// ---------------------------------------------------------------------------

describe('formatJSON()', () => {
  it('returns valid JSON string for non-empty results', () => {
    const output = formatJSON([makeResult()]);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('returns empty JSON array for empty results', () => {
    const output = formatJSON([]);
    expect(output).toBe('[]');
  });

  it('serializes multiple results', () => {
    const results = [makeResult(), makeResult({ relevance_score: 70 })];
    const parsed = JSON.parse(formatJSON(results));
    expect(parsed).toHaveLength(2);
  });

  it('round-trips relevance_score correctly', () => {
    const result = makeResult({ relevance_score: 42.75 });
    const parsed = JSON.parse(formatJSON([result]));
    expect(parsed[0].relevance_score).toBe(42.75);
  });

  it('includes manifest fields in output', () => {
    const output = formatJSON([makeResult()]);
    const parsed = JSON.parse(output);
    expect(parsed[0].manifest.id).toBe('clerk');
    expect(parsed[0].manifest.category).toBe('authentication');
  });

  it('includes vs_custom and tradeoffs in output', () => {
    const output = formatJSON([makeResult()]);
    const parsed = JSON.parse(output);
    expect(parsed[0].vs_custom).toBe('Saves 3-4 weeks of development.');
    expect(parsed[0].tradeoffs).toEqual(['Vendor lock-in', 'Monthly cost']);
  });

  it('uses 2-space indentation', () => {
    const output = formatJSON([makeResult()]);
    // Indented JSON will have lines starting with spaces
    expect(output).toContain('  "manifest"');
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe('formatTable()', () => {
  it('returns empty string for empty results', () => {
    expect(formatTable([])).toBe('');
  });

  it('includes a header row', () => {
    const output = formatTable([makeResult()]);
    expect(output).toContain('Library');
    expect(output).toContain('Category');
    expect(output).toContain('Score');
    expect(output).toContain('Solves');
  });

  it('includes separator line', () => {
    const output = formatTable([makeResult()]);
    expect(output).toContain('---');
  });

  it('includes library name in output', () => {
    const output = formatTable([makeResult()]);
    expect(output).toContain('Clerk');
  });

  it('includes category in output', () => {
    const output = formatTable([makeResult()]);
    expect(output).toContain('authentication');
  });

  it('formats relevance_score to 2 decimal places', () => {
    const output = formatTable([makeResult({ relevance_score: 85.5 })]);
    expect(output).toContain('85.50');
  });

  it('shows row number starting at 1', () => {
    const output = formatTable([makeResult()]);
    // Row 1 should appear in the output
    expect(output).toMatch(/^1\s/m);
  });

  it('numbers multiple rows sequentially', () => {
    const results = [
      makeResult(),
      makeResult({ relevance_score: 70 }),
      makeResult({ relevance_score: 55 }),
    ];
    const output = formatTable(results);
    expect(output).toMatch(/^1\s/m);
    expect(output).toMatch(/^2\s/m);
    expect(output).toMatch(/^3\s/m);
  });

  it('appends vs_custom line when vs_custom is non-empty', () => {
    const output = formatTable([makeResult({ vs_custom: 'Saves 40 hours of dev' })]);
    expect(output).toContain('vs custom: Saves 40 hours of dev');
  });

  it('does not append vs_custom line when vs_custom is empty string', () => {
    const output = formatTable([makeResult({ vs_custom: '' })]);
    expect(output).not.toContain('vs custom:');
  });

  it('truncates solves text longer than 80 chars with ellipsis', () => {
    const longSolves = 'A'.repeat(90);
    const result = makeResult({
      manifest: {
        ...makeResult().manifest,
        solves: longSolves,
      },
    });
    const output = formatTable([result]);
    expect(output).toContain('...');
    // The truncated portion should be 77 chars + '...'
    expect(output).toContain('A'.repeat(77) + '...');
  });

  it('does not truncate solves text exactly 80 chars', () => {
    const exactSolves = 'B'.repeat(80);
    const result = makeResult({
      manifest: {
        ...makeResult().manifest,
        solves: exactSolves,
      },
    });
    const output = formatTable([result]);
    expect(output).toContain('B'.repeat(80));
    expect(output).not.toContain('...');
  });

  it('does not truncate solves text shorter than 80 chars', () => {
    const shortSolves = 'Short description.';
    const result = makeResult({
      manifest: {
        ...makeResult().manifest,
        solves: shortSolves,
      },
    });
    const output = formatTable([result]);
    expect(output).toContain('Short description.');
    expect(output).not.toContain('...');
  });

  it('handles result with null repo in manifest', () => {
    const result = makeResult({
      manifest: { ...makeResult().manifest, repo: null },
    });
    // Should not throw
    expect(() => formatTable([result])).not.toThrow();
  });

  it('handles integer relevance_score correctly', () => {
    const output = formatTable([makeResult({ relevance_score: 100 })]);
    expect(output).toContain('100.00');
  });

  // Regression (feature audit BUG-1): a name longer than the old fixed 20-char
  // column ran straight into the category ("Flagsmith JavaScript Clientfeature-flags").
  it('keeps a gutter between long library names and the category column', () => {
    const longName = 'Flagsmith JavaScript Client';
    const result = makeResult({
      manifest: { ...makeResult().manifest, name: longName, category: 'feature-flags' },
    });
    const output = formatTable([result]);
    expect(output).not.toContain(`${longName}feature-flags`);
    expect(output).toContain(`${longName}  `);
  });

  it('keeps header and row columns aligned when widths grow', () => {
    const longName = 'A'.repeat(30);
    const result = makeResult({ manifest: { ...makeResult().manifest, name: longName } });
    const output = formatTable([result]);
    const [header, , row] = output.split('\n');
    // Header 'Category' and the row's category start at the same column.
    expect(header.indexOf('Category')).toBe(row.indexOf('authentication'));
  });
});
