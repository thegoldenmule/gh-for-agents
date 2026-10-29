// Run a question's answers against the fake gh and measure them (plan 07, tier 2).
//
// Every answer gets its own directory: a composed scenario, a `git init` checkout whose origin is the world's
// repo (the cwd of every step), HOME, GHX_ARTIFACT_DIR and the fake gh's reply counters, so successive replies
// (pending, pending, done) advance across the answer's steps and never leak into another answer. Steps run
// through `bash -c` with an environment built from scratch: PATH is the fake gh, a `ghx` shim for this
// checkout's bin/ghx.js, node, /usr/bin and /bin. Pipes, `tail` and `grep` in a script are real.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SCRUB_ROOT, scrub } from './scrub.ts';
import { charCount, estimateResultTokens } from './tokens.ts';
import { type Answer, ARMS, type Arm, type Fact, type GhCall, type Question, type Step } from './types.ts';
import { composeWorld } from './world.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const GHX_BIN = join(ROOT, 'bin', 'ghx.js');
const FAKE_GH_DIR = join(ROOT, 'test', 'fixtures', 'bin');
const STEP_TIMEOUT_MS = 120_000;

export interface StepResult {
  tool: Step['tool'];
  /** The command, or `Write <path>` / `Read <task output>`. */
  call: string;
  /** null for the steps that run nothing (write, read-output). */
  exitCode: number | null;
  apiCalls: number;
  bytes: number;
  chars: number;
  tokens: number;
}

export interface FactResult {
  id: string;
  kind: Fact['kind'];
  ok: boolean;
}

export interface AnswerResult {
  arm: Arm;
  source: string;
  steps: StepResult[];
  toolCalls: number;
  apiCalls: number;
  bytes: number;
  tokens: number;
  correct: boolean;
  facts: FactResult[];
  /** Ids of the facts that failed. */
  missing: string[];
  /** Every tool result as the agent saw it, scrubbed (kept out of the report). */
  seen: string[];
  /** Every gh invocation, in order (kept out of the report). */
  calls: GhCall[];
}

export interface QuestionResult {
  id: string;
  ask: string;
  repo: string;
  answers: AnswerResult[];
}

export interface RunOptions {
  /** Parent for the per-run directory (default: the OS temp dir). Removed afterwards unless `keep`. */
  workDir?: string;
  keep?: boolean;
  /** Answers run at once (default 4). */
  concurrency?: number;
}

/** The harness acknowledgement a background Bash call returns. */
export function backgroundAck(task: string): string {
  return `Command running in background with ID: ${task}. Output is being written to: ${SCRUB_ROOT}/tasks/${task}.output`;
}

function stepCall(s: Step): string {
  switch (s.tool) {
    case 'bash':
    case 'bash-background':
      return s.command;
    case 'read-output':
      return `Read ${SCRUB_ROOT}/tasks/${s.task}.output`;
    case 'write':
      return `Write ${s.path}`;
  }
}

/** A directory with `ghx` (this checkout's bin) and `node`, shared by every answer of a run. */
function makeBinDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const ghx = join(dir, 'ghx');
  writeFileSync(ghx, `#!/bin/sh\nexec '${process.execPath}' '${GHX_BIN}' "$@"\n`);
  chmodSync(ghx, 0o755);
  if (!existsSync(join(dir, 'node'))) symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
}

function initCheckout(repoDir: string, repo: string): void {
  mkdirSync(repoDir, { recursive: true });
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['remote', 'add', 'origin', `https://github.com/${repo}.git`],
  ]) {
    const r = spawnSync('git', args, { cwd: repoDir, env: { PATH: '/usr/bin:/bin', HOME: repoDir } });
    if (r.status !== 0) throw new Error(`oracle: git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

function runShell(command: string, cwd: string, env: Record<string, string>, outFile: string): Promise<number> {
  const fd = openSync(outFile, 'w');
  return new Promise<number>((res, rej) => {
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS);
    child.on('error', rej);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      closeSync(fd);
      if (signal) rej(new Error(`oracle: '${command}' was killed (${signal})`));
      else res(code ?? 0);
    });
  });
}

function readCalls(log: string): GhCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => ({ argv: (JSON.parse(l) as { argv: string[] }).argv }));
}

/** Check the truth against what the agent saw and the gh calls it made. */
export function judge(truth: readonly Fact[], seen: readonly string[], calls: readonly GhCall[]): FactResult[] {
  const text = seen.join('\n');
  const argvs = calls.map((c) => c.argv.join(' '));
  return truth.map((f) => {
    const ok =
      f.kind === 'seen'
        ? f.pattern.test(text)
        : f.kind === 'call'
          ? argvs.some((a) => f.pattern.test(a))
          : !argvs.some((a) => f.pattern.test(a));
    return { id: f.id, kind: f.kind, ok };
  });
}

export async function runAnswer(q: Question, a: Answer, dir: string, binDir: string): Promise<AnswerResult> {
  const scenario = join(dir, 'scenario');
  const repo = join(dir, 'repo');
  composeWorld(q.world, scenario);
  initCheckout(repo, q.world.repo);
  for (const d of ['home', 'artifacts', 'state', 'logs', 'tasks']) mkdirSync(join(dir, d), { recursive: true });

  const outputs = new Map<string, string>();
  const steps: StepResult[] = [];
  const seen: string[] = [];
  const calls: GhCall[] = [];
  for (const [i, s] of a.steps.entries()) {
    let result: string;
    let exitCode: number | null = null;
    let stepCalls: GhCall[] = [];
    if (s.tool === 'bash' || s.tool === 'bash-background') {
      const log = join(dir, 'logs', `${i}.ndjson`);
      const env: Record<string, string> = {
        PATH: [FAKE_GH_DIR, binDir, '/usr/bin', '/bin'].join(':'),
        HOME: join(dir, 'home'),
        TZ: 'UTC',
        LC_ALL: 'C',
        GHX_ARTIFACT_DIR: join(dir, 'artifacts'),
        GHX_FAKE_SCENARIO: scenario,
        GHX_FAKE_STATE: join(dir, 'state'),
        GHX_FAKE_LOG: log,
      };
      const outFile = join(dir, 'tasks', `${i}.output`);
      exitCode = await runShell(s.command, repo, env, outFile);
      const out = scrub(readFileSync(outFile, 'utf8'), dir);
      stepCalls = readCalls(log);
      if (s.tool === 'bash-background') {
        outputs.set(s.task, exitCode === 0 ? out : `${out}\n[exit ${exitCode}]`);
        result = backgroundAck(s.task);
      } else {
        result = exitCode === 0 ? out : `Exit code ${exitCode}\n${out}`;
      }
    } else if (s.tool === 'read-output') {
      const out = outputs.get(s.task);
      if (out === undefined) throw new Error(`oracle: ${q.id}/${a.arm} reads task ${s.task} before it ran`);
      result = out;
    } else {
      const path = join(repo, s.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, s.content);
      result = `File created successfully at: ${scrub(path, dir)}`;
    }
    const chars = charCount(result);
    steps.push({
      tool: s.tool,
      call: stepCall(s),
      exitCode,
      apiCalls: stepCalls.length,
      bytes: Buffer.byteLength(result),
      chars,
      tokens: estimateResultTokens(chars),
    });
    seen.push(result);
    calls.push(...stepCalls);
  }
  const facts = judge(q.truth, seen, calls);
  const missing = facts.filter((f) => !f.ok).map((f) => f.id);
  return {
    arm: a.arm,
    source: a.source,
    steps,
    toolCalls: steps.length,
    apiCalls: calls.length,
    bytes: steps.reduce((n, s) => n + s.bytes, 0),
    tokens: steps.reduce((n, s) => n + s.tokens, 0),
    correct: missing.length === 0,
    facts,
    missing,
    seen,
    calls,
  };
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await (jobs[i] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return out;
}

function checkQuestion(q: Question): void {
  const arms = q.answers.map((a) => a.arm);
  if (arms.length !== ARMS.length || ARMS.some((arm) => !arms.includes(arm))) {
    throw new Error(`oracle: ${q.id} must answer once per arm (${ARMS.join(', ')}); has ${arms.join(', ')}`);
  }
  if (!/^[a-z0-9-]+$/.test(q.id)) throw new Error(`oracle: bad question id ${JSON.stringify(q.id)}`);
}

/** Run every question's three answers; results sorted by question id, answers in ARMS order. */
export async function runQuestions(questions: readonly Question[], o: RunOptions = {}): Promise<QuestionResult[]> {
  const sorted = [...questions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  sorted.forEach(checkQuestion);
  const base = o.workDir ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, 'ghx-oracle-')));
  try {
    const binDir = makeBinDir(join(root, 'bin'));
    const jobs = sorted.flatMap((q) =>
      ARMS.map((arm) => () => {
        const a = q.answers.find((x) => x.arm === arm) as Answer;
        return runAnswer(q, a, join(root, q.id, arm), binDir);
      }),
    );
    const results = await pool(jobs, o.concurrency ?? 4);
    return sorted.map((q, i) => ({
      id: q.id,
      ask: q.ask,
      repo: q.world.repo,
      answers: results.slice(i * ARMS.length, (i + 1) * ARMS.length),
    }));
  } finally {
    if (!o.keep) rmSync(root, { recursive: true, force: true });
  }
}
