// readRedirect (src/passthrough/redirect.ts): which gh-shaped reads run a ghx equivalent, and which keep
// the refusal because nothing answers them faithfully.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GH_PR_FIELDS } from '../../../src/passthrough/gh-fields.ts';
import { readRedirect } from '../../../src/passthrough/redirect.ts';
import { PrStatusOutput } from '../../../src/pr/status/schema.ts';

type Row = [argv: string[], command: string[], args: string[], fields?: string[] | undefined, repo?: string];

const REDIRECTED: Row[] = [
  [['pr', 'view', '12'], ['pr', 'status'], ['12']],
  [['pr', 'view', '#12', '-R', 'o/r'], ['pr', 'status'], ['#12'], undefined, 'o/r'],
  [['pr', 'view', '12', '--json', 'body,title'], ['pr', 'status'], ['12'], ['description.text,title']],
  [['pr', 'view', '--json=isDraft,statusCheckRollup', 'o/r#3'], ['pr', 'status'], ['o/r#3'], ['draft,ci']],
  [['pr', 'view', '12', '--json', 'state', '-q', '.state'], ['pr', 'status'], ['12'], ['state']],
  [['pr', 'view', '12', '--fields', 'passthrough.json.body'], ['pr', 'status'], ['12'], ['description.text']],
  [['pr', 'view', '12', '--comments'], ['pr', 'feedback'], ['12']],
  [['pr', 'get', '12'], ['pr', 'status'], ['12']],
  [['pr', 'checks', '12'], ['pr', 'status'], ['12'], ['ref,head.sha,ci']],
  [['run', 'view', '9', '--log-failed'], ['ci', 'why'], ['run:9']],
  [['run', 'view', '--log-failed', '--job', '5'], ['ci', 'why'], ['job:5']],
  [['run', 'view', '-j', '5', '--log'], ['api'], ['repos/{owner}/{repo}/actions/jobs/5/logs']],
  [
    ['ci', 'logs', '12', '--job', 'Test*'],
    ['ci', 'why'],
    ['12', '--job', 'Test*'],
  ],
  [['ci', 'failures', 'run:9'], ['ci', 'why'], ['run:9']],
  [
    ['pr', 'threads', '12', '--open'],
    ['pr', 'feedback'],
    ['12', '--open'],
  ],
];

for (const [argv, command, args, fields, repo] of REDIRECTED) {
  test(`redirected: ${argv.join(' ')}`, () => {
    const r = readRedirect(argv);
    assert.ok(r, 'a redirect');
    assert.deepEqual(r.command, command);
    assert.deepEqual(r.args, args);
    assert.deepEqual(r.globals.fields, fields);
    assert.equal(r.globals.repo, repo);
  });
}

const KEPT: string[][] = [
  ['pr', 'view'],
  ['pr', 'view', 'feat/x'],
  ['pr', 'view', '12', '13'],
  ['pr', 'view', '12', '--web'],
  ['pr', 'view', '12', '--json', 'labels,assignees'],
  ['pr', 'checks', '12', '--watch'],
  ['pr', 'checks', '12', '-i', '5'],
  ['run', 'view', '9', '--log'],
  ['run', 'view', '9'],
  ['run', 'view', '9', '--json', 'jobs'],
  ['run', 'view', '--job', 'abc', '--log'],
  ['run', 'watch', '9'],
  ['pr', 'ready', '12'],
  ['pr', 'update', '12'],
  ['ci', 'logs'],
  ['pr', 'threads'],
  ['api', 'repos/o/r/pulls/1'],
];

for (const argv of KEPT) {
  test(`kept as a refusal or passthrough: ${argv.join(' ')}`, () => assert.equal(readRedirect(argv), undefined));
}

test('every mapped gh field is a pr status path', () => {
  const shape = PrStatusOutput.shape as Record<string, unknown>;
  for (const [gh, path] of Object.entries(GH_PR_FIELDS)) {
    if (path === null) continue;
    assert.ok((path.split('.')[0] as string) in shape, `${gh} → ${path}`);
  }
});

test('unmapped fields beside mapped ones are a note naming the REST read; commits says it is a count', () => {
  const r = readRedirect(['pr', 'view', '12', '--json', 'body,labels,commits']);
  assert.deepEqual(r?.globals.fields, ['description.text,changes.commits']);
  assert.deepEqual(r?.mapped, { body: 'description.text', commits: 'changes.commits' });
  assert.ok(
    r?.notes.some((n) => /^labels: not in ghx pr status; ghx api repos\/\{owner\}\/\{repo\}\/pulls\/12/.test(n)),
  );
  assert.ok(r?.notes.some((n) => /commits is a count/.test(n)));
});
