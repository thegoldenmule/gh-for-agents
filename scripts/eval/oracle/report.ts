// The oracle's report: JSON first, markdown rendered from the JSON object only. No wall clock, no machine
// paths; questions sorted by id and answers in ARMS order, so the same fixtures give the same bytes.
import type { QuestionResult, StepResult } from './run.ts';
import { SCRUB_ROOT, SCRUB_RULES } from './scrub.ts';
import { RESULT_CHARS_PER_TOKEN, RESULT_TOKEN_OVERHEAD } from './tokens.ts';
import { ARMS, type Arm } from './types.ts';

/** Bump when a world, a script, a truth or a measurement rule changes what the report says. */
export const ORACLE_VERSION = 1;

export const CAVEATS: readonly string[] = [
  'API calls count fake-gh invocations: a gh porcelain command (pr view, pr checks, run view --log-failed) counts 1, though real gh makes several HTTP calls for some of them, so gh arms are a lower bound.',
  'Waits: ghx ci wait sees CI settled on its first poll (multi-poll waits need 10-30 s of real time per poll); gh arms poll through successive replies. ghx internal polls are under-counted.',
  'A background call is measured as the harness acknowledgement plus a later Read of the output file, which is how agents consumed ci wait in the transcripts (ghx-impact-findings §4.1, §5).',
  'Bytes and tokens count tool results only (what the agent reads), not the commands it writes.',
  'Truth is the minimal answer to each question. ghx also returns what the question did not ask for (same-on-main verdicts, flake signals, merge policy, artifact paths), which the gh arms would need more calls to match.',
  'Typical-gh scripts reproduce the sequences in gh-usage-findings §5 and §8 with sleep loops reduced to their gh calls; an incorrect typical answer is a finding, not a bug.',
];

export interface ReportStep extends Omit<StepResult, 'chars'> {}

export interface ReportAnswer {
  arm: Arm;
  source: string;
  correct: boolean;
  missing: string[];
  toolCalls: number;
  apiCalls: number;
  bytes: number;
  tokens: number;
  steps: ReportStep[];
}

export interface ReportQuestion {
  id: string;
  ask: string;
  repo: string;
  truth: { id: string; kind: string }[];
  answers: ReportAnswer[];
}

export interface ArmTotals {
  questions: number;
  correct: number;
  toolCalls: number;
  apiCalls: number;
  bytes: number;
  tokens: number;
}

export interface OracleReport {
  oracleVersion: number;
  constants: {
    resultCharsPerToken: number;
    resultTokenOverhead: number;
    scrubRoot: string;
    scrubRules: string[];
  };
  caveats: readonly string[];
  arms: readonly Arm[];
  questions: ReportQuestion[];
  totals: Record<Arm, ArmTotals>;
  /** M4's done-when: every question answered correctly by the ghx and gh-expert scripts. */
  done: boolean;
}

export function buildReport(results: readonly QuestionResult[]): OracleReport {
  const questions: ReportQuestion[] = results.map((q) => ({
    id: q.id,
    ask: q.ask,
    repo: q.repo,
    truth: (q.answers[0]?.facts ?? []).map((f) => ({ id: f.id, kind: f.kind })),
    answers: q.answers.map((a) => ({
      arm: a.arm,
      source: a.source,
      correct: a.correct,
      missing: a.missing,
      toolCalls: a.toolCalls,
      apiCalls: a.apiCalls,
      bytes: a.bytes,
      tokens: a.tokens,
      steps: a.steps.map(({ chars: _chars, ...s }) => s),
    })),
  }));
  const totals = Object.fromEntries(
    ARMS.map((arm) => {
      const as = questions.flatMap((q) => q.answers.filter((a) => a.arm === arm));
      const sum = (k: 'toolCalls' | 'apiCalls' | 'bytes' | 'tokens') => as.reduce((n, a) => n + a[k], 0);
      const t: ArmTotals = {
        questions: as.length,
        correct: as.filter((a) => a.correct).length,
        toolCalls: sum('toolCalls'),
        apiCalls: sum('apiCalls'),
        bytes: sum('bytes'),
        tokens: sum('tokens'),
      };
      return [arm, t];
    }),
  ) as Record<Arm, ArmTotals>;
  const done = questions.every((q) => q.answers.every((a) => a.arm === 'gh-typical' || a.correct));
  return {
    oracleVersion: ORACLE_VERSION,
    constants: {
      resultCharsPerToken: RESULT_CHARS_PER_TOKEN,
      resultTokenOverhead: RESULT_TOKEN_OVERHEAD,
      scrubRoot: SCRUB_ROOT,
      scrubRules: SCRUB_RULES.map((r) => r.id),
    },
    caveats: CAVEATS,
    arms: ARMS,
    questions,
    totals,
    done,
  };
}

export function serializeReport(r: OracleReport): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|');

/** A compact table: one row per question and arm, then per-arm totals. */
export function renderMarkdown(r: OracleReport): string {
  const lines = [
    `# ghx oracle (tier 2), v${r.oracleVersion}`,
    '',
    `Tokens per tool result: chars / ${r.constants.resultCharsPerToken} + ${r.constants.resultTokenOverhead}.`,
    '',
    '| question | arm | correct | tool calls | API calls | bytes | tokens | missing |',
    '|---|---|---|---:|---:|---:|---:|---|',
  ];
  for (const q of r.questions) {
    for (const a of q.answers) {
      lines.push(
        `| ${cell(q.id)} | ${a.arm} | ${a.correct ? 'yes' : 'no'} | ${a.toolCalls} | ${a.apiCalls} | ${a.bytes} | ${a.tokens} | ${cell(a.missing.join(', '))} |`,
      );
    }
  }
  lines.push('', '| arm | correct | tool calls | API calls | bytes | tokens |', '|---|---:|---:|---:|---:|---:|');
  for (const arm of r.arms) {
    const t = r.totals[arm];
    lines.push(`| ${arm} | ${t.correct}/${t.questions} | ${t.toolCalls} | ${t.apiCalls} | ${t.bytes} | ${t.tokens} |`);
  }
  lines.push('', `Done (every ghx and gh-expert answer correct): ${r.done ? 'yes' : 'no'}.`, '', '## Caveats', '');
  for (const c of r.caveats) lines.push(`- ${c}`);
  return `${lines.join('\n')}\n`;
}
