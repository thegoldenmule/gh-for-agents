// gh-shaped input on ghx commands: a gh flag that is a field of the JSON input names the field and the
// JSON fragment to write, instead of an edit-distance guess (`--head` read as `--help`).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { runInProcess, scratchDir } from '../helpers/harness.ts';
import { install as installWhy, sha, vitestLog, type World as WhyWorld } from './ci-why-world.ts';
import { install as installStatus, REF, run as statusRun } from './pr-status-world.ts';

test('a gh flag that is a JSON input field names the field and the fragment to write', async () => {
  const rows: [argv: string[], field: string, json: unknown, hint: RegExp][] = [
    [
      ['pr', 'create', '--head', 'feat/x'],
      'head',
      { head: 'feat/x' },
      /^'head' is a field of the JSON input, not a flag: put \{"head": "feat\/x"\} in the file, then run ghx pr create --input pr\.json/,
    ],
    [
      ['pr', 'create', '--title=Fix it'],
      'title',
      { title: 'Fix it' },
      /^'title' is a field of the JSON input, not a flag: put \{"title": "Fix it"\}/,
    ],
    [
      ['pr', 'create', '--body', 'why'],
      'description',
      { description: 'why' },
      /^gh's --body is the 'description' field of the JSON input in ghx: put \{"description": "why"\}/,
    ],
    [['pr', 'create', '-B', 'main'], 'base', { base: 'main' }, /gh's -B is the 'base' field/],
    [['pr', 'create', '--draft'], 'draft', { draft: true }, /put \{"draft": true\}/],
    [
      ['pr', 'create', '--body-file', 'b.md'],
      'description',
      { description: '<the text of the file>' },
      /\{"description": "<the text of the file>"\}/,
    ],
    [
      ['pr', 'edit', '12', '-t', 'New title'],
      'title',
      { title: 'New title' },
      /then run ghx pr edit <pr> --input patch\.json/,
    ],
    [['pr', 'comment', '12', '--body', 'hi'], 'body', { body: 'hi' }, /ghx pr comment <pr> --input comment\.json/],
    [['pr', 'review', '12', '--approve'], 'verdict', { verdict: 'approve' }, /\{"verdict": "approve"\}/],
  ];
  for (const [argv, field, json, hint] of rows) {
    const r = await runInProcess(argv);
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
    assert.deepEqual(r.json.error.details, {
      flag: argv.find((a) => a.startsWith('-'))?.split('=')[0],
      suggestions: [],
      field,
      json,
    });
    assert.match(r.json.error.hint, hint);
    assert.equal(r.calls.length, 0);
  }
});

test('gh pr flags ghx has no home for say so; other commands keep the edit-distance hint', async () => {
  const label = await runInProcess(['pr', 'create', '--label', 'bug']);
  assert.match(label.json.error.hint, /^gh's --label has no ghx flag; ghx sets no labels, reviewers/);
  const fill = await runInProcess(['pr', 'create', '--fill']);
  assert.match(fill.json.error.hint, /ghx does not fill from commits/);
  const addLabel = await runInProcess(['pr', 'edit', '1', '--add-label', 'x']);
  assert.match(addLabel.json.error.hint, /ghx sets no labels/);
  const status = await runInProcess(['pr', 'status', '1', '--title', 'x']);
  assert.match(status.json.error.hint, /^Run 'ghx pr status --help'/, 'pr status has no JSON fields');
});

test('group help: ghx ci --help, ghx pr -h, a bare ghx ci and ghx help pr list the commands with summaries', async () => {
  for (const argv of [['ci', '--help'], ['ci'], ['help', 'ci']]) {
    const r = await runInProcess(argv);
    assert.equal(r.exitCode, EXIT.OK, r.stdout);
    assert.equal(r.json.name, 'ci');
    assert.deepEqual(Object.keys(r.json.commands), ['ci rerun', 'ci retrigger', 'ci wait', 'ci why']);
    assert.match(r.json.commands['ci why'], /^read: Why CI is red/);
    assert.equal(r.calls.length, 0);
  }
  const pr = await runInProcess(['pr', '-h']);
  assert.equal(pr.exitCode, EXIT.OK, pr.stdout);
  assert.ok(pr.json.commands['pr status'] && pr.json.commands['pr create']);
  assert.ok(!('ci wait' in pr.json.commands));
  const none = await runInProcess(['nope', '--help']);
  assert.equal(none.json.error.code, 'USAGE_UNKNOWN_COMMAND', 'not a group: still unknown');
  const sub = await runInProcess(['ci', 'nope', '--help']);
  assert.equal(sub.json.error.code, 'USAGE_UNKNOWN_COMMAND', 'an unknown command in a group: still unknown');
});

// ── gh-shaped reads are answered: the ghx equivalent runs, with a REDIRECTED warning naming it ──

test('pr view N --json body,title,headRefOid runs pr status with the mapped --fields, and says so', async () => {
  const fake = installStatus();
  const r = await statusRun(['pr', 'view', REF, '--json', 'body,title,headRefOid,labels'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['description', 'head', 'title', 'warnings']);
  assert.equal(typeof r.json.description.text, 'string');
  assert.match(r.json.head.sha, /^[0-9a-f]{40}$/);
  const w = r.json.warnings[0];
  assert.equal(w.code, 'REDIRECTED');
  assert.equal(w.details.ran, `ghx pr status ${REF} --fields 'description.text,title,head.sha'`);
  assert.deepEqual(w.details.fields, { body: 'description.text', title: 'title', headRefOid: 'head.sha' });
  assert.match(w.message, /^'ghx pr view' is not a ghx command, so this ran ghx pr status /);
  assert.match(w.message, /labels: not in ghx pr status; ghx api repos\/\{owner\}\/\{repo\}\/pulls\/3301 has them/);
  fake.expectNoMutations();
});

test('pr view N (no --json) is the whole pr status; pr show and --fields passthrough.json.body map too', async () => {
  const whole = await statusRun(['pr', 'view', REF], installStatus());
  assert.equal(whole.exitCode, EXIT.OK, whole.stdout);
  assert.ok(whole.json.merge && whole.json.ci && whole.json.description);
  assert.equal(whole.json.warnings[0].code, 'REDIRECTED');
  const show = await statusRun(['pr', 'show', REF, '--fields', 'passthrough.json.body'], installStatus());
  assert.equal(show.exitCode, EXIT.OK, show.stdout);
  assert.deepEqual(Object.keys(show.json).sort(), ['description', 'warnings']);
  assert.match(show.json.warnings[0].message, /^'ghx pr show' is not a ghx command/);
});

test('pr checks N is the pr status CI snapshot; with --watch it stays a refusal naming ci wait', async () => {
  const r = await statusRun(['pr', 'checks', REF], installStatus());
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['ci', 'head', 'ref', 'warnings']);
  assert.equal(r.json.warnings[0].details.ran, `ghx pr status ${REF} --fields 'ref,head.sha,ci'`);
  const watch = await runInProcess(['pr', 'checks', '12', '--watch']);
  assert.equal(watch.json.error.code, 'USAGE_UNKNOWN_COMMAND');
  assert.match(watch.json.error.hint, /^Use: ghx ci wait 12 /);
  assert.equal(watch.calls.length, 0);
});

test('no faithful equivalent keeps the refusal: no selector, a branch, --web, only unmapped fields, help', async () => {
  for (const argv of [
    ['pr', 'view'],
    ['pr', 'view', 'feat/x'],
    ['pr', 'view', '12', '--web'],
    ['pr', 'view', '12', '--json', 'labels'],
    ['pr', 'view', '12', '--help'],
    ['run', 'view', '9', '--log'],
    ['help', 'pr', 'view'],
  ]) {
    const r = await runInProcess(argv);
    assert.equal(r.exitCode, EXIT.USAGE, `${argv.join(' ')}: ${r.stdout}`);
    assert.equal(r.json.error.code, 'USAGE_UNKNOWN_COMMAND', argv.join(' '));
    assert.equal(r.calls.length, 0, argv.join(' '));
  }
});

test('run view <id> --log-failed runs ci why run:<id>; --job <id> --log-failed runs ci why job:<id>', async () => {
  const RUN = 37948190914;
  const w: WhyWorld = {
    slug: 'o/run',
    number: 1,
    headSha: sha('e'),
    defaultBranch: 'trunk',
    jobs: [{ id: 7, runId: RUN, name: 'test', conclusion: 'failure', log: { text: vitestLog(['src/a.test.ts > a']) } }],
  };
  const env = { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'redirect-')) };
  const run = await runInProcess(['run', 'view', String(RUN), '--log-failed', '-R', 'o/run'], {
    gh: installWhy(new FakeGh(), w),
    env,
  });
  assert.equal(run.exitCode, EXIT.OK, run.stdout);
  assert.equal(run.json.target, `run:${RUN}`);
  assert.deepEqual(run.json.failing[0].tests, ['src/a.test.ts > a']);
  assert.equal(run.json.warnings[0].details.ran, `ghx ci why run:${RUN} -R o/run`);
  const job = await runInProcess(['run', 'view', '--job', '7', '--log-failed', '-R', 'o/run'], {
    gh: installWhy(new FakeGh(), w),
    env,
  });
  assert.equal(job.exitCode, EXIT.OK, job.stdout);
  assert.equal(job.json.target, 'job:7');
  assert.equal(job.json.warnings[0].details.ran, 'ghx ci why job:7 -R o/run');
});

test('run view --job <id> --log reads the raw job log through ghx api', async () => {
  const fake = new FakeGh();
  fake.on((a) => a[0] === 'api' && a.includes('repos/o/r/actions/jobs/7/logs'), {
    exitCode: 0,
    stdout: 'line 1\nline 2\n',
    stderr: '',
  });
  const r = await runInProcess(['run', 'view', '--job', '7', '--log', '-R', 'o/r'], {
    gh: fake,
    env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'redirect-')) },
  });
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.equal(r.json.passthrough.text, 'line 1\nline 2\n');
  assert.equal(r.json.warnings[0].details.ran, 'ghx api repos/o/r/actions/jobs/7/logs');
  assert.match(r.json.warnings[0].message, /ghx ci why job:7/);
  fake.expectNoMutations();
});

test('a redirected command that fails still names the redirect in error.details.warnings', async () => {
  const fake = new FakeGh();
  const r = await runInProcess(['ci', 'logs', 'job:abc', '-R', 'o/r'], { gh: fake });
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR');
  assert.equal(r.json.error.details?.warnings?.[0]?.code, 'REDIRECTED');
  assert.equal(r.json.error.details.warnings[0].details.ran, 'ghx ci why job:abc -R o/r');
});

test('selector hints: a bare branch names branch:<name>, a malformed one shows an example, pr status names both', async () => {
  const wait = await runInProcess(['ci', 'why', 'main']);
  assert.match(wait.json.error.hint, /ghx ci why branch:main/);
  const empty = await runInProcess(['ci', 'why', 'branch:']);
  assert.equal(empty.json.error.code, 'USAGE_BAD_SELECTOR');
  assert.equal(empty.json.error.hint, 'Use branch:<name> (branch:main) or branch:<name>@<sha> (branch:main@1a2b3c4).');
  for (const sel of ['branch:feat/x', 'feat/x']) {
    const r = await runInProcess(['pr', 'status', sel]);
    assert.equal(r.json.error.code, 'USAGE_BAD_SELECTOR', r.stdout);
    assert.match(
      r.json.error.hint,
      /For branch feat\/x: ghx pr list --head feat\/x names its PR; ghx ci why branch:feat\/x/,
    );
    assert.equal(r.calls.length, 0);
  }
});

test('--fields passthrough.json.<key> without gh --json adds --json <keys>, with a JSON_ADDED warning', async () => {
  const fake = new FakeGh();
  fake.on((a) => a[0] === 'pr' && a[1] === 'list' && a.includes('--json') && a.includes('number,title'), {
    exitCode: 0,
    stdout: JSON.stringify([{ number: 3, title: 'x' }]),
    stderr: '',
  });
  const r = await runInProcess(
    ['pr', 'list', '--author', '@me', '-R', 'o/r', '--fields', 'passthrough.json.number,passthrough.json[].title'],
    { gh: fake, env: { GHX_ARTIFACT_DIR: mkdtempSync(join(scratchDir(), 'json-added-')) } },
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.passthrough.json, [{ number: 3, title: 'x' }]);
  assert.equal(r.json.warnings[0].code, 'JSON_ADDED');
  assert.match(r.json.warnings[0].message, /added --json number,title/);
  fake.expectNoMutations();
});
