// Engine for the tripwire decision-flip eval (.planning/tripwire-eval.md).
//
// Three arms isolate the tripwire's MARGINAL value:
//   A control · B +tripwire-nudge · C +advice-inlined
// A->B lift in the adopt-library rate is the go/no-go number. The LLM fn is
// injected so the harness owns the client (and tests can stub it).

import type { LlmFn } from '../types.js';
import { SCENARIOS, type EvalScenario } from './scenarios.js';

// A/B/C use a NEUTRAL system prompt → measures the nudge vs a bare model (upper
// bound). D/E add the AMBIENT system prompt — a stand-in for the CLAUDE.md
// instruction Starlog already ships — so D→E measures the hook's MARGINAL value
// over the existing pull-surface (the honest go/no-go the bare-control A/B can't give).
export type Arm = 'A_control' | 'B_nudge' | 'C_advice' | 'D_ambient' | 'E_ambient_nudge';
export type Decision = 'adopt_library' | 'continue_diy' | 'other';

const AGENT_SYSTEM =
  'You are a pragmatic senior engineer pair-programming on a real codebase. ' +
  'Be concise. State the ONE next step you would actually take now and why, in 2-3 sentences.';

// Simulates the ambient guidance `starlog init` writes into CLAUDE.md — present in
// every real Claude Code session, hook or no hook.
const AGENT_SYSTEM_AMBIENT =
  AGENT_SYSTEM +
  ' This project uses Starlog: prefer vetted, well-maintained libraries over ' +
  'hand-rolled implementations, and consult the starlog_advise tool before building ' +
  'custom capability code (auth, caching, queues, email, feature flags, realtime, ORM).';

type Injection = 'none' | 'nudge' | 'advice';
const ARM_SPEC: Record<Arm, { ambient: boolean; injection: Injection }> = {
  A_control: { ambient: false, injection: 'none' },
  B_nudge: { ambient: false, injection: 'nudge' },
  C_advice: { ambient: false, injection: 'advice' },
  D_ambient: { ambient: true, injection: 'none' },
  E_ambient_nudge: { ambient: true, injection: 'nudge' },
};

/** Build the user-facing prompt for a given arm. Arms differ ONLY by the injected
 *  note (and, orthogonally, the system prompt), so deltas are attributable. */
export function buildAgentPrompt(scenario: EvalScenario, arm: Arm): string {
  const base =
    `Task: ${scenario.task}\n\n` +
    `Here's what I have so far:\n\n\`\`\`ts\n${scenario.diyState}\n\`\`\`\n\n`;

  const injection =
    ARM_SPEC[arm].injection === 'none'
      ? ''
      : ARM_SPEC[arm].injection === 'nudge'
        ? `\n[Tool note] Recurring DIY ${scenario.category} detected — a vetted library may ` +
          `already cover this. Consider consulting available tooling before writing more ` +
          `custom ${scenario.category} code.\n`
        : `\n[Tool note] For ${scenario.category}, a vetted library is recommended over DIY. ` +
          `${scenario.inlineAdvice}\n`;

  return base + injection + `\nWhat's your next step?`;
}

const GRADER_SYSTEM =
  'You are a strict, impartial classifier. You do not know or care about any ' +
  'experimental condition. Output ONLY a compact JSON object, no prose.';

/** Blind grader: classifies a next-step statement without seeing which arm produced
 *  it. adopt_library counts *deciding to use or seek* an existing third-party
 *  library; continue_diy = keep hand-rolling; other = neither/unclear. */
export function buildGraderPrompt(category: string, response: string): string {
  return (
    `An engineer is mid-task on ${category}. Here is their stated next step:\n\n` +
    `"""\n${response}\n"""\n\n` +
    `Classify their decision:\n` +
    `- "adopt_library": they choose to USE or SEEK/EVALUATE an existing third-party ` +
    `library/service instead of continuing custom code.\n` +
    `- "continue_diy": they keep building the custom/hand-rolled implementation.\n` +
    `- "other": neither is clear.\n\n` +
    `Respond as JSON: {"decision":"adopt_library"|"continue_diy"|"other"}`
  );
}

/** Parse the grader's JSON. Unparseable / unexpected → 'other' (never throws). */
export function parseDecision(raw: string): Decision {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : raw) as { decision?: string };
    if (obj.decision === 'adopt_library' || obj.decision === 'continue_diy') return obj.decision;
    return 'other';
  } catch {
    return 'other';
  }
}

async function classifyOnce(llm: LlmFn, scenario: EvalScenario, arm: Arm): Promise<Decision> {
  const system = ARM_SPEC[arm].ambient ? AGENT_SYSTEM_AMBIENT : AGENT_SYSTEM;
  const response = await llm(buildAgentPrompt(scenario, arm), system);
  const grade = await llm(buildGraderPrompt(scenario.category, response), GRADER_SYSTEM);
  return parseDecision(grade);
}

/** Run all decisions with bounded concurrency (respect provider rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface ArmRate {
  arm: Arm;
  n: number;
  adopt: number;
  continue_diy: number;
  other: number;
  adopt_rate: number;
}

export interface ScenarioResult {
  id: string;
  category: string;
  rates: Record<Arm, number>; // adopt_rate per arm
}

export interface EvalReport {
  k: number;
  model: string;
  overall: Record<Arm, ArmRate>;
  byScenario: ScenarioResult[];
  lift_A_to_B: number; // nudge vs bare model (upper bound, percentage points)
  lift_B_to_C: number; // advice content vs nudge
  lift_D_to_E: number; // nudge MARGINAL over the ambient CLAUDE.md instruction (honest go/no-go)
}

const ARMS: Arm[] = ['A_control', 'B_nudge', 'C_advice', 'D_ambient', 'E_ambient_nudge'];

export async function runTripwireEval(
  llm: LlmFn,
  opts: { k: number; model: string; concurrency?: number; scenarios?: EvalScenario[] },
): Promise<EvalReport> {
  const scenarios = opts.scenarios ?? SCENARIOS;
  const jobs: Array<{ scenario: EvalScenario; arm: Arm }> = [];
  for (const scenario of scenarios) {
    for (const arm of ARMS) {
      for (let i = 0; i < opts.k; i++) jobs.push({ scenario, arm });
    }
  }

  const decisions = await mapLimit(jobs, opts.concurrency ?? 6, (j) =>
    classifyOnce(llm, j.scenario, j.arm).then((decision) => ({ ...j, decision })),
  );

  const rate = (subset: typeof decisions) => {
    const n = subset.length || 1;
    const adopt = subset.filter((d) => d.decision === 'adopt_library').length;
    return { adopt, rate: adopt / n };
  };

  const overall = {} as Record<Arm, ArmRate>;
  for (const arm of ARMS) {
    const subset = decisions.filter((d) => d.arm === arm);
    const adopt = subset.filter((d) => d.decision === 'adopt_library').length;
    overall[arm] = {
      arm,
      n: subset.length,
      adopt,
      continue_diy: subset.filter((d) => d.decision === 'continue_diy').length,
      other: subset.filter((d) => d.decision === 'other').length,
      adopt_rate: adopt / (subset.length || 1),
    };
  }

  const byScenario: ScenarioResult[] = scenarios.map((s) => {
    const rates = {} as Record<Arm, number>;
    for (const arm of ARMS) {
      rates[arm] = rate(decisions.filter((d) => d.scenario.id === s.id && d.arm === arm)).rate;
    }
    return { id: s.id, category: s.category, rates };
  });

  return {
    k: opts.k,
    model: opts.model,
    overall,
    byScenario,
    lift_A_to_B: (overall.B_nudge.adopt_rate - overall.A_control.adopt_rate) * 100,
    lift_B_to_C: (overall.C_advice.adopt_rate - overall.B_nudge.adopt_rate) * 100,
    lift_D_to_E: (overall.E_ambient_nudge.adopt_rate - overall.D_ambient.adopt_rate) * 100,
  };
}
