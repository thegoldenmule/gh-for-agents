// Tier 2 replay oracle (plan 07): the shape of a canonical question. Each question names a world (a fake-gh
// scenario composed from recorded fixtures), three scripted answers, and a ground truth the answers are
// checked against. Questions live one per file under oracle/questions/.

/** The three arms every question is answered by. */
export const ARMS = ['ghx', 'gh-expert', 'gh-typical'] as const;
export type Arm = (typeof ARMS)[number];

/**
 * A fake-gh world: existing scenarios under test/fixtures/gh (composed in order) plus an optional extras file
 * test/fixtures/eval/oracle/<extras>.json holding the gh fixtures the existing scenarios lack (porcelain
 * `gh pr view`/`gh pr checks`/`gh run view` replies, writes and read-backs). Later sources are served after
 * earlier ones for the same argv; `skip` drops base files an extras fixture replaces.
 */
export interface World {
  /** owner/name: the `origin` of the agent's checkout (the cwd every answer runs in). */
  repo: string;
  base: { scenario: string; skip?: string[] }[];
  extras?: string;
}

/**
 * One tool call the agent makes.
 * - `bash`: a foreground Bash call; the agent sees stdout and stderr (and `Exit code N` when non-zero).
 * - `bash-background`: Bash with run_in_background; the command runs to completion, but the agent sees only
 *   the harness acknowledgement until a `read-output` step reads the task's output file.
 * - `read-output`: the Read call on a background task's output file.
 * - `write`: the Write tool creating a file in the checkout (a JSON input for ghx, a body file for gh).
 */
export type Step =
  | { tool: 'bash'; command: string }
  | { tool: 'bash-background'; command: string; task: string }
  | { tool: 'read-output'; task: string }
  | { tool: 'write'; path: string; content: string };

export interface Answer {
  arm: Arm;
  /** Where the script comes from: the CLAUDE.md block, a command's examples, or the transcript findings. */
  source: string;
  steps: Step[];
}

/** One gh invocation as the fake gh logged it. */
export interface GhCall {
  argv: string[];
}

/**
 * A ground-truth predicate. `seen` facts must be readable in what the agent was shown (every tool result,
 * joined by newlines) and `not-seen` facts must not (a false alarm); `call` facts must match a gh invocation
 * (its argv joined by spaces) and `no-call` facts must match none.
 */
export interface Fact {
  id: string;
  kind: 'seen' | 'not-seen' | 'call' | 'no-call';
  pattern: RegExp;
}

export interface Question {
  /** Stable id: the report is sorted by it. */
  id: string;
  /** The question as a user would ask it. */
  ask: string;
  world: World;
  truth: Fact[];
  answers: Answer[];
}
