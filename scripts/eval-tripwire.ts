// Tripwire decision-flip eval harness (.planning/tripwire-eval.md).
//
//   npm run eval:tripwire            # k=15 per (scenario, arm), default model
//   npm run eval:tripwire -- --k 20
//   STARLOG_RANK_MODEL=anthropic/claude-sonnet-4.5 npm run eval:tripwire -- --k 5
//
// Needs OPENROUTER_API_KEY (same client as search's LLM enrichment). This is a
// $-gated MEASUREMENT run, not a deterministic regression gate.
import 'dotenv/config';
import { createLlmFn } from '../src/engine/siftrank.js';
import { runTripwireEval, type Arm } from '../src/engine/tripwire-eval/run.js';

const KILL_THRESHOLD_PP = 15; // precommitted: A->B lift < 15pp ⇒ kill/deprioritize

function argVal(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}

const ARM_LABEL: Record<Arm, string> = {
  A_control: 'A control      ',
  B_nudge: 'B +tripwire    ',
  C_advice: 'C +advice      ',
};

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('eval:tripwire needs OPENROUTER_API_KEY (the search LLM client).');
    process.exit(2);
  }
  const k = argVal('--k', 15);
  const model = process.env.STARLOG_RANK_MODEL || 'anthropic/claude-haiku-4.5';
  const llm = createLlmFn();

  console.log(`\nTripwire decision-flip eval — model=${model}, k=${k}/arm/scenario`);
  console.log('Measuring: does the tripwire nudge (arm B) move behavior beyond control (A)?\n');

  const t0 = Date.now();
  const report = await runTripwireEval(llm, { k, model });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log('Overall adopt-library rate by arm:');
  for (const arm of ['A_control', 'B_nudge', 'C_advice'] as Arm[]) {
    const r = report.overall[arm];
    const pct = (r.adopt_rate * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.round(r.adopt_rate * 30));
    console.log(`  ${ARM_LABEL[arm]} ${pct}%  ${bar}  (adopt ${r.adopt}/${r.n}, diy ${r.continue_diy}, other ${r.other})`);
  }

  console.log('\nPer-scenario adopt rate (A / B / C):');
  for (const s of report.byScenario) {
    const f = (x: number) => (x * 100).toFixed(0).padStart(3);
    console.log(`  ${s.id.padEnd(24)} ${f(s.rates.A_control)}% / ${f(s.rates.B_nudge)}% / ${f(s.rates.C_advice)}%`);
  }

  const ab = report.lift_A_to_B;
  const bc = report.lift_B_to_C;
  console.log(`\nA→B lift (the go/no-go number): ${ab >= 0 ? '+' : ''}${ab.toFixed(1)} pp`);
  console.log(`B→C lift (advice-content value): ${bc >= 0 ? '+' : ''}${bc.toFixed(1)} pp`);

  console.log(`\nPrecommitted rule: KILL/deprioritize the tripwire if A→B lift < ${KILL_THRESHOLD_PP}pp (single-turn = upper bound).`);
  const verdict =
    ab < KILL_THRESHOLD_PP
      ? `VERDICT: A→B lift ${ab.toFixed(1)}pp < ${KILL_THRESHOLD_PP}pp → KILL/deprioritize the nudge.` +
        (bc >= KILL_THRESHOLD_PP ? ' (But B→C is large → inlining advice would help; consider skipping the starlog_advise indirection.)' : '')
      : `VERDICT: A→B lift ${ab.toFixed(1)}pp ≥ ${KILL_THRESHOLD_PP}pp → KEEP; escalate to a multi-turn eval to confirm.`;
  console.log(verdict);
  console.log(`\n(${secs}s, ${k * report.byScenario.length * 3 * 2} LLM calls)\n`);

  // Machine-readable line for pasting into .planning/tripwire-eval.md.
  console.log('JSON:', JSON.stringify({
    model, k,
    adopt_rate: { A: report.overall.A_control.adopt_rate, B: report.overall.B_nudge.adopt_rate, C: report.overall.C_advice.adopt_rate },
    lift_A_to_B_pp: ab, lift_B_to_C_pp: bc,
  }));
}

main().catch((e) => {
  console.error('eval:tripwire failed:', e?.message ?? e);
  process.exit(1);
});
