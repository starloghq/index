import { describe, it, expect } from 'vitest';
import { buildAgentPrompt, buildGraderPrompt, parseDecision, runTripwireEval } from './run.js';
import { SCENARIOS } from './scenarios.js';
import type { LlmFn } from '../types.js';

// Deterministic coverage of the money-free parts: prompt construction, the blind
// grader parser, and the scoring math (with a stubbed LLM — no network/spend).
describe('tripwire-eval prompt construction', () => {
  const s = SCENARIOS[0];

  it('arms differ ONLY by the injected note (so deltas are attributable)', () => {
    const a = buildAgentPrompt(s, 'A_control');
    const b = buildAgentPrompt(s, 'B_nudge');
    const c = buildAgentPrompt(s, 'C_advice');
    // All carry the same task + DIY state.
    for (const p of [a, b, c]) {
      expect(p).toContain(s.task);
      expect(p).toContain('jsonwebtoken');
      expect(p).toContain("What's your next step?");
    }
    // Only B/C add an intervention; A has none.
    expect(a).not.toContain('[Tool note]');
    expect(b).toContain('[Tool note]');
    expect(b).toContain(s.category);
    expect(c).toContain('[Tool note]');
    expect(c).toContain('Clerk'); // the inlined advice
    // B is the generic nudge, not the concrete advice.
    expect(b).not.toContain('Clerk');
  });

  it('grader prompt is blind to the arm', () => {
    const g = buildGraderPrompt('authentication', 'I will install Clerk and delete the custom code.');
    expect(g).not.toMatch(/arm|control|nudge|treatment|condition/i);
    expect(g).toContain('adopt_library');
  });
});

describe('parseDecision — robust to messy grader output', () => {
  it('extracts the decision from clean or noisy JSON', () => {
    expect(parseDecision('{"decision":"adopt_library"}')).toBe('adopt_library');
    expect(parseDecision('Sure! {"decision":"continue_diy"} hope that helps')).toBe('continue_diy');
    expect(parseDecision('```json\n{"decision":"adopt_library"}\n```')).toBe('adopt_library');
  });
  it('falls back to other on unparseable / unexpected values', () => {
    expect(parseDecision('not json at all')).toBe('other');
    expect(parseDecision('{"decision":"banana"}')).toBe('other');
    expect(parseDecision('')).toBe('other');
  });
});

describe('runTripwireEval scoring math (stubbed LLM)', () => {
  it('computes per-arm adopt rates and the A→B / B→C lifts', async () => {
    // Deterministic stub: the "agent" echoes the arm via the prompt; the "grader"
    // reads that echo. Encodes a fixture where B and C always adopt, A never does.
    const stub: LlmFn = async (prompt: string) => {
      if (prompt.includes("What's your next step?")) {
        // agent turn — leak the arm so the grader stub can act on it
        if (prompt.includes('a vetted library is recommended')) return 'ARM_C: install the library';
        if (prompt.includes('a vetted library may')) return 'ARM_B: consult tooling';
        return 'ARM_A: keep hand-rolling';
      }
      // grader turn
      if (prompt.includes('ARM_C') || prompt.includes('ARM_B')) return '{"decision":"adopt_library"}';
      return '{"decision":"continue_diy"}';
    };

    const report = await runTripwireEval(stub, { k: 4, model: 'stub', scenarios: SCENARIOS.slice(0, 2) });
    expect(report.overall.A_control.adopt_rate).toBe(0);
    expect(report.overall.B_nudge.adopt_rate).toBe(1);
    expect(report.overall.C_advice.adopt_rate).toBe(1);
    expect(report.lift_A_to_B).toBe(100);
    expect(report.lift_B_to_C).toBe(0);
    expect(report.byScenario).toHaveLength(2);
  });
});
