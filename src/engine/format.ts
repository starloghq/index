import type { QueryResult } from '../manifest/schema.js';

/**
 * Format QueryResult array as pretty-printed JSON.
 */
export function formatJSON(results: QueryResult[]): string {
  return JSON.stringify(results, null, 2);
}

/**
 * Format QueryResult array as a human-readable table.
 */
export function formatTable(results: QueryResult[]): string {
  if (results.length === 0) return '';

  // Column widths grow with the data (plus a 2-space gutter) so a long library
  // name or category can never run into the next column.
  const nameWidth = Math.max('Library'.length, ...results.map((r) => r.manifest.name.length)) + 2;
  const categoryWidth = Math.max('Category'.length, ...results.map((r) => r.manifest.category.length)) + 2;

  const header = [
    '#'.padEnd(4),
    'Library'.padEnd(nameWidth),
    'Category'.padEnd(categoryWidth),
    'Score'.padEnd(8),
    'Solves',
  ].join('');

  const separator = '-'.repeat(80);

  const rows = results.map((r, i) => {
    const solves = r.manifest.solves.length > 80
      ? r.manifest.solves.slice(0, 77) + '...'
      : r.manifest.solves;

    let row = [
      String(i + 1).padEnd(4),
      r.manifest.name.padEnd(nameWidth),
      r.manifest.category.padEnd(categoryWidth),
      r.relevance_score.toFixed(2).padEnd(8),
      solves,
    ].join('');

    if (r.vs_custom) {
      row += `\n${''.padEnd(4)}vs custom: ${r.vs_custom}`;
    }

    return row;
  });

  return [header, separator, ...rows].join('\n');
}
