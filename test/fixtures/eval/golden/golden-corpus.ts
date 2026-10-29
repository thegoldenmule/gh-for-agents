// The golden ghx-eval projects directory (plan 07, golden test): synthetic transcripts in real record shapes
// (the builders in ../model/shapes.ts), small enough to read and rich enough to exercise every report path.
// One adopted repo with sessions before and after adoption (main threads and subagents, opus and fable), a
// repo that never adopted, a dev-marker repo, a <synthetic> record, a bad JSON line, a partial last line and a
// file that is not a session file. All ids, paths, slugs and text are made up.
//
// goldenFiles() is deterministic; the golden test checks the files on disk equal it, and UPDATE_GOLDEN=1
// rewrites them.
import * as S from '../model/shapes.ts';

export const ADOPTED = '-tmp-golden-acme';
export const NEVER = '-tmp-golden-widgets';
export const DEV = '-tmp-golden-gh-for-agents';
export const ADOPTED_AT = '2026-10-20T12:00:00.000Z';

/** The era config the golden report runs with. */
export const GOLDEN_ERA = { adoptions: { [ADOPTED]: ADOPTED_AT }, devProjectMarkers: ['gh-for-agents'] };

export interface GoldenFile {
  path: string;
  text: string;
}

type Rec = Record<string, unknown>;

/** Rewrites shapes.ts's fixed session, project and cwd into this transcript's. */
function relocate(r: Rec, session: string, project: string, cwd: string): Rec {
  const text = JSON.stringify(r)
    .replaceAll(S.SESSION, session)
    .replaceAll(S.PROJECT, project)
    .replaceAll(S.CWD, cwd);
  return JSON.parse(text) as Rec;
}

const sha = (n: number): string => n.toString(16).padStart(8, '0').repeat(5);

interface CallOpts {
  bg?: { taskId: string };
  /** Exit code: a non-zero exit is an error result `Exit code N`. */
  exit?: number;
  model?: string;
}

/** One transcript file: a main thread or a subagent. Time is seconds since the session's day starts. */
class Transcript {
  readonly records: Rec[] = [];
  readonly key: string;
  readonly agentId: string | undefined;
  readonly model: string;
  readonly day: string;
  t: number;
  ctx: number;
  n = 0;
  promptId = '';
  prompts = 0;

  constructor(key: string, day: string, model: string, agentId?: string, start = 9 * 3600) {
    this.key = key;
    this.day = day;
    this.model = model;
    this.agentId = agentId;
    this.t = start;
    this.ctx = agentId ? 9_000 : 20_000;
  }

  ts(): string {
    return new Date(Date.parse(`${this.day}T00:00:00.000Z`) + this.t * 1000).toISOString();
  }

  private ctxArgs(): { agentId?: string; ts: string } {
    return this.agentId ? { agentId: this.agentId, ts: this.ts() } : { ts: this.ts() };
  }

  private id(prefix: string): string {
    this.n++;
    return `${prefix}_${this.key}_${String(this.n).padStart(3, '0')}`;
  }

  /** The usage of the next call: the context so far read from cache, `added` tokens written. */
  private usage(added: number, output: number, rewrite = false): Rec {
    const read = rewrite ? 0 : this.ctx;
    const written = rewrite ? this.ctx + added : added;
    this.ctx += added + output;
    return S.usage({
      input: 3,
      cacheRead: read,
      ...(this.agentId ? { write5m: written } : { write1h: written }),
      output,
    });
  }

  prompt(text: string): void {
    this.prompts++;
    this.promptId = `${this.key}-p${this.prompts}`;
    this.t += 60;
    if (this.agentId) this.records.push(S.prompt(text, { ...this.ctxArgs(), promptId: this.promptId }));
    else this.records.push(S.humanPrompt(text, this.promptId, this.ctxArgs()));
  }

  /** One API call emitting one tool_use, then its result. Returns the tool_use id. */
  tool(name: string, input: Rec, result: string, o: CallOpts & { rewrite?: boolean; toolUseResult?: unknown } = {}) {
    this.t += 7;
    const toolId = this.id('toolu');
    const msg = this.id('msg');
    this.records.push(
      ...S.response({
        id: msg,
        ...this.ctxArgs(),
        model: o.model ?? this.model,
        content: [S.thinking(), S.toolUse(toolId, name, input)],
        usage: this.usage(Math.ceil(result.length / 2.2) + 70, 120 + (input.command ? 40 : 10), o.rewrite),
      }),
    );
    this.t += 3;
    const isError = (o.exit ?? 0) !== 0;
    const content = isError ? `Exit code ${o.exit}\n${result}` : result;
    this.records.push(
      S.toolResult(toolId, content, {
        ...this.ctxArgs(),
        promptId: this.promptId,
        isError,
        toolUseResult: o.toolUseResult ?? (name === 'Bash' ? S.bashResult(isError ? '' : result) : { ok: true }),
      }),
    );
    return toolId;
  }

  bash(command: string, result: string, o: CallOpts & { rewrite?: boolean } = {}): string {
    if (o.bg) {
      const placeholder =
        `Command running in background with ID: ${o.bg.taskId}. Output is being written to: ` +
        `/private/tmp/claude-501/${S.PROJECT}/${S.SESSION}/tasks/${o.bg.taskId}.output`;
      return this.tool('Bash', { command, description: 'Wait for CI', run_in_background: true }, placeholder, {
        ...o,
        toolUseResult: { ...S.bashResult(''), backgroundTaskId: o.bg.taskId },
      });
    }
    return this.tool('Bash', { command, description: 'Run a command' }, result, o);
  }

  read(path: string, content: string, o: { rewrite?: boolean } = {}): string {
    return this.tool('Read', { file_path: path }, content, o);
  }

  write(path: string, content: string): string {
    return this.tool('Write', { file_path: path, content }, `File created successfully at: ${path}`);
  }

  /** The end of a turn: a text-only call. */
  say(text: string): void {
    this.t += 5;
    this.records.push(
      ...S.response({
        id: this.id('msg'),
        ...this.ctxArgs(),
        model: this.model,
        stop: 'end_turn',
        content: [S.text(text)],
        usage: this.usage(0, 60),
      }),
    );
  }

  /** A background task's notification, `minutes` later: queued, attached and delivered as a turn. */
  notify(toolUseId: string, taskId: string, status: string, summary: string, minutes: number): void {
    this.t += minutes * 60;
    const note = S.notificationText({ taskId, toolUseId, status, summary });
    this.prompts++;
    this.promptId = `${this.key}-p${this.prompts}`;
    if (!this.agentId) this.records.push(S.queueOperation('enqueue', note, this.ts()));
    this.records.push(S.queuedCommand(note, this.ctxArgs()));
    this.t += 1;
    this.records.push(
      S.prompt(note, {
        ...this.ctxArgs(),
        promptId: this.promptId,
        origin: 'task-notification',
        turnOrigin: 'task_notification',
      }),
    );
  }

  /** Non-GitHub work between GitHub tasks. */
  chores(k: number): void {
    for (let i = 0; i < k; i++) this.bash(`git status --short && ls src | wc -l`, ` M src/app.ts\n${10 + i}`);
  }

  outputFile(taskId: string): string {
    return `/private/tmp/claude-501/${S.PROJECT}/${S.SESSION}/tasks/${taskId}.output`;
  }
}

interface SessionSpec {
  project: string;
  session: string;
  cwd: string;
  day: string;
  model?: string;
}

/** A session: its main transcript, subagents and their meta files. */
class Session {
  readonly spec: SessionSpec;
  readonly main: Transcript;
  readonly agents: { id: string; tx: Transcript; spawn: string }[] = [];

  constructor(spec: SessionSpec) {
    this.spec = spec;
    this.main = new Transcript(`s${spec.session.slice(4, 8)}`, spec.day, spec.model ?? 'claude-opus-5-5');
  }

  /** Spawn a foreground subagent from the main thread; `body` drives it; its hand-back closes the call. */
  agent(id: string, description: string, body: (tx: Transcript) => void, model?: string): void {
    const m = this.main;
    m.t += 7;
    const spawn = `toolu_${m.key}_agent_${id.slice(-3)}`;
    m.records.push(
      ...S.response({
        id: `msg_${m.key}_agent_${id.slice(-3)}`,
        ts: m.ts(),
        model: m.model,
        content: [S.toolUse(spawn, 'Agent', { description, prompt: description, subagent_type: 'general-purpose' })],
        usage: S.usage({ input: 3, cacheRead: m.ctx, write1h: 300, output: 200 }),
      }),
    );
    m.ctx += 500;
    const tx = new Transcript(`${m.key}${id.slice(-3)}`, m.day, model ?? m.model, id, m.t);
    tx.prompt(description);
    body(tx);
    tx.say('Done.');
    m.t = tx.t + 5;
    m.records.push(
      S.toolResult(spawn, [{ type: 'text', text: 'Done.' }], {
        ts: m.ts(),
        promptId: m.promptId,
        toolUseResult: { status: 'completed', agentId: id, content: [{ type: 'text', text: 'Done.' }] },
      }),
    );
    this.agents.push({ id, tx, spawn });
  }

  files(extra: { mainSuffix?: string; mainInsert?: { at: number; line: string } } = {}): GoldenFile[] {
    const { project, session, cwd } = this.spec;
    const lines = (recs: Rec[]): string[] => recs.map((r) => JSON.stringify(relocate(r, session, project, cwd)));
    const main = lines(this.main.records);
    if (extra.mainInsert) main.splice(extra.mainInsert.at, 0, extra.mainInsert.line);
    const out: GoldenFile[] = [
      { path: `${project}/${session}.jsonl`, text: `${main.join('\n')}\n${extra.mainSuffix ?? ''}` },
    ];
    for (const a of this.agents) {
      const dir = `${project}/${session}/subagents/agent-${a.id}`;
      out.push({ path: `${dir}.jsonl`, text: `${lines(a.tx.records).join('\n')}\n` });
      const meta = S.agentMeta({ toolUseId: a.spawn, description: 'Subagent', model: a.tx.model });
      out.push({ path: `${dir}.meta.json`, text: `${JSON.stringify(meta)}\n` });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------- results

const REPO = 'golden/acme';
const ghView = (pr: number, n: number, state = 'OPEN'): string =>
  JSON.stringify({
    number: pr,
    state,
    mergeable: 'MERGEABLE',
    headRefOid: sha(n),
    statusCheckRollup: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', status: 'COMPLETED', conclusion: n % 2 ? 'FAILURE' : 'SUCCESS' },
    ],
  });
const ghChecks = (n: number): string => `build\tpass\t1m2s\ntest\t${n % 2 ? 'fail' : 'pass'}\t3m${n}s\n`;
const ghLog = (n: number): string =>
  Array.from({ length: 12 + n }, (_, i) => `test\tRun tests\t2026-10-18T09:0${i % 10}:00Z FAIL src/case${i}.test.ts`).join('\n');
const ghxStatus = (pr: number, n: number): string =>
  JSON.stringify({
    pr: { number: pr, state: 'OPEN', mergeable: 'MERGEABLE', headSha: sha(n) },
    ci: { headSha: sha(n), state: n % 2 ? 'red' : 'green', checks: [{ name: 'build', state: 'success' }] },
    feedback: { unresolved: n % 3 },
  });
const ghxWhy = (pr: number, n: number): string =>
  JSON.stringify({
    pr,
    headSha: sha(n),
    failures: [{ job: 'test', step: 'Run tests', excerpt: `FAIL src/case${n}.test.ts\nexpected 1, got ${n}` }],
  });
const ghxWait = (pr: number, n: number): string =>
  JSON.stringify({ pr, headSha: sha(n), outcome: n % 2 ? 'red' : 'green', results: [{ name: 'test' }] });
const validation = JSON.stringify({
  error: { code: 'VALIDATION', message: 'body: Required', hint: 'Run ghx schema pr create', details: {} },
});

// ---------------------------------------------------------------------------------------------- sessions

const sid = (n: number): string => `c01d${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

function preSession(i: number, day: string, model?: string): Session {
  const pr = 100 + i;
  const s = new Session({ project: ADOPTED, session: sid(i), cwd: '/tmp/golden/acme', day, ...(model ? { model } : {}) });
  const m = s.main;
  if (i === 1) {
    m.prompt('Open a PR for the parser fix');
    m.bash(`git push -u origin fix-${pr}`, 'branch set up');
    m.bash(`gh pr create --title "Fix parser" --body "Fixes the parser."`, `https://github.com/${REPO}/pull/${pr}`);
    m.say('Opened.');
  }
  m.prompt(`Check PR ${pr}`);
  m.bash(`gh pr view ${pr} --json state,mergeable,headRefOid,statusCheckRollup`, ghView(pr, i));
  m.say('CI is red.');
  m.prompt('Why did CI fail?');
  m.bash(`gh run list --branch fix-${pr} --limit 3`, `completed\tfailure\tCI\tfix-${pr}\t9${i}01`);
  m.bash(`gh run view 9${i}01 --log-failed | tail -50`, ghLog(i));
  m.bash(`gh run view 9${i}01 --log-failed | grep FAIL | head -5`, ghLog(1).slice(0, 300));
  m.say('A test fails.');
  m.prompt('Fix it and wait for CI');
  m.chores(4);
  m.bash(`git commit -am fix && git push`, 'pushed');
  const task = `bgl${i}0001`;
  const w = m.bash(
    `while gh pr checks ${pr} | grep -q pending; do sleep 30; done; gh pr checks ${pr}`,
    '',
    { bg: { taskId: task } },
  );
  m.say('Waiting.');
  m.notify(w, task, 'completed', `Background command "Wait for CI" completed (exit code 0)`, 14);
  m.read(m.outputFile(task), ghChecks(i + 1));
  m.say('Green.');
  m.prompt(`Check PR ${pr} again`);
  m.bash(`gh pr checks ${pr}`, ghChecks(i + 1));
  m.say('All green.');
  m.prompt('Merge it');
  m.bash(`gh pr merge ${pr} --squash --delete-branch`, `✓ Squashed and merged pull request #${pr}`);
  m.bash(`gh pr view ${pr} --json state,headRefOid`, ghView(pr, i + 1, 'MERGED'));
  m.say('Merged.');
  if (i === 2) {
    m.prompt('Have a subagent look at the flaky test');
    s.agent(`a${'0'.repeat(14)}21`, 'Investigate the flaky test', (a) => {
      a.bash(`gh pr checks ${pr}`, ghChecks(3));
      a.bash(`gh run view 9${i}02 --log-failed | grep -n FAIL`, ghLog(2));
      a.bash(`gh run view 9${i}02 --log-failed | tail -20`, ghLog(3));
      a.chores(4);
      a.bash(`gh pr view ${pr} --json headRefOid,statusCheckRollup`, ghView(pr, 7));
    });
    m.say('It was a timing issue.');
  }
  return s;
}

function postSession(i: number, day: string): Session {
  const pr = 200 + i;
  const s = new Session({ project: ADOPTED, session: sid(10 + i), cwd: '/tmp/golden/acme', day });
  const m = s.main;
  m.prompt('Open a PR for the cache fix');
  m.bash(`git push -u origin cache-${pr}`, 'branch set up');
  m.write('/tmp/golden/acme/pr.json', JSON.stringify({ title: 'Fix cache', body: 'Fixes the cache.' }));
  if (i === 1) {
    m.bash('ghx pr create --input /tmp/golden/acme/pr.json', validation, { exit: 2 });
    m.bash('ghx schema pr create', JSON.stringify({ fields: { title: 'string', body: 'string', base: 'string' } }));
  }
  m.bash('ghx pr create --input /tmp/golden/acme/pr.json', JSON.stringify({ number: pr, url: `https://github.com/${REPO}/pull/${pr}` }));
  m.say('Opened.');
  m.prompt(`Check PR ${pr}`);
  m.bash(`ghx pr status ${pr}`, ghxStatus(pr, i));
  m.say('CI is red.');
  m.prompt('Why did CI fail?');
  m.bash(`ghx ci why ${pr}`, ghxWhy(pr, i));
  m.say('One test.');
  m.prompt('Fix it and wait for CI');
  m.chores(4);
  m.bash('git commit -am fix && git push', 'pushed');
  const task = `bgx${i}0001`;
  const w = m.bash(`ghx ci wait ${pr}`, '', { bg: { taskId: task } });
  m.say('Waiting.');
  m.notify(w, task, 'completed', `Background command "Wait for CI" completed (exit code 0)`, 18);
  m.read(m.outputFile(task), ghxWait(pr, i + 1));
  m.say('Green.');
  m.prompt('Merge it');
  m.bash(`ghx pr merge ${pr} --squash`, JSON.stringify({ merged: true, pr, headSha: sha(i + 1) }));
  m.say('Merged.');
  if (i === 1) {
    // Five more status reads in one session: this session dominates the ghx-post bucket.
    for (let k = 0; k < 5; k++) {
      m.prompt(`Status of PR ${pr + 10 + k}?`);
      m.bash(`ghx pr status ${pr + 10 + k}`, ghxStatus(pr + 10 + k, k));
      m.say('Fine.');
    }
  }
  if (i === 2) {
    // Five feedback reads from one session: a full cell whose CI collapses to a point.
    for (let k = 0; k < 5; k++) {
      m.prompt(`Any review comments on PR ${pr}?`);
      m.bash(`ghx pr feedback ${pr}`, JSON.stringify({ threads: Array.from({ length: k + 1 }, (_, j) => ({ id: j })) }));
      m.say('Addressed.');
    }
    m.prompt('Have a subagent babysit CI on the follow-up');
    s.agent(`a${'0'.repeat(14)}42`, 'Babysit CI on the follow-up', (a) => {
      a.bash(`ghx ci why ${pr + 50}`, ghxWhy(pr + 50, 3));
      a.chores(4);
      const t2 = 'bgxa20001';
      const w2 = a.bash(`ghx ci wait ${pr + 50}`, '', { bg: { taskId: t2 } });
      a.say('Waiting.');
      a.notify(w2, t2, 'failed', 'Background command "Wait for CI" failed with exit code 10', 12);
      a.read(a.outputFile(t2), ghxWait(pr + 50, 3), { rewrite: true });
      a.bash(`ghx ci rerun ${pr + 50} --flaky`, JSON.stringify({ rerun: ['test'] }));
    });
    m.say('Rerun started.');
  }
  if (i === 3) {
    m.prompt('Look at the other repo');
    m.bash('gh api repos/golden/other/pulls --jq ".[].number"', '1\n2\n3');
    m.say('Three open.');
    m.records.push(S.synthetic({ ts: m.ts() }));
  }
  return s;
}

function neverSession(): Session {
  const s = new Session({ project: NEVER, session: sid(21), cwd: '/tmp/golden/widgets', day: '2026-10-19' });
  const m = s.main;
  for (let k = 0; k < 3; k++) {
    m.prompt(`Check PR ${30 + k}`);
    m.bash(`gh pr view ${30 + k} --json state,headRefOid`, ghView(30 + k, k));
    m.say('Open.');
  }
  return s;
}

function devSession(): Session {
  const s = new Session({ project: DEV, session: sid(31), cwd: '/tmp/golden/gh-for-agents', day: '2026-10-22' });
  const m = s.main;
  m.prompt('Dogfood status');
  m.bash('ghx pr status 7', ghxStatus(7, 1));
  m.bash('ghx ci why 7', ghxWhy(7, 1));
  m.say('Done.');
  return s;
}

/** Every golden corpus file, in path order. */
export function goldenFiles(): GoldenFile[] {
  S.resetIds();
  const files: GoldenFile[] = [
    ...preSession(1, '2026-10-17').files(),
    ...preSession(2, '2026-10-18').files(),
    ...preSession(3, '2026-10-19').files(),
    ...preSession(4, '2026-10-19', 'claude-fable-5-1').files(),
    ...postSession(1, '2026-10-21').files(),
    ...postSession(2, '2026-10-22').files(),
    ...postSession(3, '2026-10-23').files(),
    // A line that is not JSON (counted as a parse error).
    ...neverSession().files({ mainInsert: { at: 2, line: '{"type":"user","message":' } }),
    // A partial last line, as in a live file (never parsed).
    ...devSession().files({ mainSuffix: '{"type":"assistant","message":{"id":"msg_partial"' }),
    // A persisted tool result: not a session file, so it is counted and not read.
    { path: `${ADOPTED}/${sid(1)}/tool-results/toolu_persisted.txt`, text: 'persisted output\n' },
  ];
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
