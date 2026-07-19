import type { AdviseResult } from '../patterns/schema.js';

export function formatAdviseMarkdown(result: AdviseResult): string {
  const lines: string[] = [];
  const banner =
    result.action === 'migrate'
      ? '**Action: MIGRATE** — safe alternatives exist; do not packageize DIY code'
      : result.action === 'packageize'
        ? '**Action: PACKAGEIZE** — no safe corpus alternative; extract a reusable internal package'
        : '**Action: WATCH** — pattern detected; recurrence below threshold';

  lines.push(banner, '');
  lines.push(`**Category:** ${result.category}`);
  lines.push(`**Rationale:** ${result.rationale}`);

  if (result.pattern_id) {
    lines.push(`**Pattern:** ${result.pattern_id}${result.occurrences != null ? ` (${result.occurrences} occurrence(s))` : ''}`);
  }

  if (result.signals && result.signals.length > 0) {
    const sigPreview = result.signals
      .filter((s) => s.kind !== 'absence')
      .slice(0, 8)
      .map((s) => `${s.kind}:${s.value}`)
      .join('; ');
    if (sigPreview) lines.push(`**Signals:** ${sigPreview}`);
  }

  lines.push('');

  if (result.action === 'migrate' && result.candidates && result.candidates.length > 0) {
    lines.push('## Safe migration targets');
    for (const c of result.candidates) {
      lines.push(`### ${c.name} (${c.manifest_id})`);
      lines.push(`- Package: \`${c.package_name}\``);
      lines.push(`- Relevance: ${c.relevance_score}`);
      lines.push(`- Facts on file: ${c.facts_available ? 'yes' : 'no — vet with starlog_facts before adopting'}`);
      lines.push('');
    }
  }

  if (result.action === 'packageize' && result.packageize_plan) {
    lines.push('## Packageize plan');
    lines.push(`Suggested name: \`${result.packageize_plan.suggested_name}\``);
    for (const step of result.packageize_plan.steps) {
      lines.push(`- ${step}`);
    }
    lines.push('');
  }

  if (result.playbook_steps.length > 0) {
    lines.push('## Steps');
    for (const step of result.playbook_steps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join('\n');
}

export function formatAdviseJson(result: AdviseResult): string {
  return JSON.stringify(result, null, 2);
}
