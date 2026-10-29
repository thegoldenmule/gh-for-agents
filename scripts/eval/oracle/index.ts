// Tier 2 replay oracle (plan 07): canonical GitHub questions answered three ways (ghx, expert gh, typical gh)
// against the fake gh, measured for tool calls, API calls, bytes, tokens and correctness.
import { QUESTIONS } from './questions/index.ts';
import { buildReport, type OracleReport } from './report.ts';
import { type RunOptions, runQuestions } from './run.ts';
import type { Question } from './types.ts';

export { QUESTIONS } from './questions/index.ts';
export { buildReport, type OracleReport, renderMarkdown, serializeReport } from './report.ts';
export { type AnswerResult, judge, type QuestionResult, type RunOptions, runQuestions } from './run.ts';
export { estimateResultTokens } from './tokens.ts';
export type { Answer, Arm, Fact, Question, Step, World } from './types.ts';

export interface OracleOptions extends RunOptions {
  /** Only these question ids (default: all). Unknown ids throw. */
  only?: readonly string[];
  questions?: readonly Question[];
}

/** Select questions by id; throws on an unknown id. */
export function selectQuestions(all: readonly Question[], only?: readonly string[]): Question[] {
  if (!only || only.length === 0) return [...all];
  const known = new Set(all.map((q) => q.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown question ${unknown.join(', ')}; known: ${[...known].sort().join(', ')}`);
  }
  return all.filter((q) => only.includes(q.id));
}

export async function runOracle(o: OracleOptions = {}): Promise<OracleReport> {
  const qs = selectQuestions(o.questions ?? QUESTIONS, o.only);
  return buildReport(await runQuestions(qs, o));
}
