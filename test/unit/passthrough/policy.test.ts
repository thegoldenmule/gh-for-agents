// 02 §10 as a table (03 M7.1): every allowlisted read runs, every wrapped command is refused with its
// replacement argv, every write and guard bypass form is refused, and nothing refused ever reaches gh.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { onUnknown } from '../../../src/cli/unknown.ts';
import { isReadAllowed } from '../../../src/gh/guard.ts';
import { ALLOWED_READS, type Decision, decide } from '../../../src/passthrough/policy.ts';
import { readRedirect } from '../../../src/passthrough/redirect.ts';
import { finalArgs } from '../../../src/passthrough/run.ts';
import { EXIT } from '../../contract/exit-table.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';
import { defaultRegistry, runInProcess } from '../../helpers/harness.ts';

const REPO = { host: 'github.com', owner: 'octo', name: 'demo' };

function run(d: Decision) {
  assert.equal(d.kind, 'run', JSON.stringify(d));
  return d as Extract<Decision, { kind: 'run' }>;
}

function refused(d: Decision) {
  assert.equal(d.kind, 'refuse', JSON.stringify(d));
  return (d as Extract<Decision, { kind: 'refuse' }>).error;
}

type AllowRow = [argv: string[], args: string[], inject: string, repo?: string];

const ALLOWED: AllowRow[] = [
  [['pr', 'diff', '3169'], ['pr', 'diff', '3169'], 'flag'],
  [['pr', 'diff', '3169', '-R', 'o/r'], ['pr', 'diff', '3169'], 'flag', 'o/r'],
  [['pr', 'diff', '-Ro/r', '3169'], ['pr', 'diff', '3169'], 'flag', 'o/r'],
  [['pr', 'diff', '--repo=o/r', '1', '--name-only'], ['pr', 'diff', '1', '--name-only'], 'flag', 'o/r'],
  [['pr', '-R', 'o/r', 'diff', '1'], ['pr', 'diff', '1'], 'flag', 'o/r'],
  [['pr', 'list', '--json', 'number'], ['pr', 'list', '--json', 'number'], 'flag'],
  [['pr', 'ls'], ['pr', 'list'], 'flag'],
  [['issue', 'view', '12', '--comments'], ['issue', 'view', '12', '--comments'], 'flag'],
  [['issue', 'list'], ['issue', 'list'], 'flag'],
  [['issue', 'ls', '-R', 'o/r'], ['issue', 'list'], 'flag', 'o/r'],
  [['search', 'issues', 'bug', '-R', 'o/r'], ['search', 'issues', 'bug', '-R', 'o/r'], 'none'],
  [['search', 'prs', '--author', '@me'], ['search', 'prs', '--author', '@me'], 'none'],
  [['search', 'code', 'foo'], ['search', 'code', 'foo'], 'none'],
  [['search', 'repos', 'ghx'], ['search', 'repos', 'ghx'], 'none'],
  [['search', 'commits', 'fix'], ['search', 'commits', 'fix'], 'none'],
  [['release', 'list'], ['release', 'list'], 'flag'],
  [['release', 'ls'], ['release', 'list'], 'flag'],
  [['release', 'view', 'v1.0.0'], ['release', 'view', 'v1.0.0'], 'flag'],
  [['repo', 'view'], ['repo', 'view'], 'positional'],
  [['repo', 'view', '-R', 'o/r', '--json', 'name'], ['repo', 'view', '--json', 'name'], 'positional', 'o/r'],
  [['repo', 'view', 'cli/cli'], ['repo', 'view', 'cli/cli'], 'none'],
  [['workflow', 'list'], ['workflow', 'list'], 'flag'],
  [['workflow', 'ls'], ['workflow', 'list'], 'flag'],
  [['workflow', 'view', 'ci.yml', '--yaml'], ['workflow', 'view', 'ci.yml', '--yaml'], 'flag'],
  [['run', 'list', '-w', 'ci.yml'], ['run', 'list', '-w', 'ci.yml'], 'flag'],
  [['run', 'ls'], ['run', 'list'], 'flag'],
  [['run', 'view', '123'], ['run', 'view', '123'], 'flag'],
  [['run', 'view', '123', '--job', '456'], ['run', 'view', '123', '--job', '456'], 'flag'],
  [['run', 'download', '123', '-D', 'out'], ['run', 'download', '123', '-D', 'out'], 'flag'],
  [['run', 'download', '123', '-Dout'], ['run', 'download', '123', '-Dout'], 'flag'],
  [['run', 'download', '123', '--dir=out'], ['run', 'download', '123', '--dir=out'], 'flag'],
  [
    ['run', 'download', '123', '--dir', 'out', '-n', 'a'],
    ['run', 'download', '123', '--dir', 'out', '-n', 'a'],
    'flag',
  ],
  [['label', 'list'], ['label', 'list'], 'flag'],
  [['label', 'ls'], ['label', 'list'], 'flag'],
  [['api', 'repos/o/r/pulls'], ['api', 'repos/o/r/pulls'], 'placeholders'],
  [
    ['api', 'repos/{owner}/{repo}/pulls', '--paginate', '--slurp'],
    ['api', 'repos/{owner}/{repo}/pulls', '--paginate', '--slurp'],
    'placeholders',
  ],
  [['api', '-XGET', 'repos/o/r'], ['api', '-XGET', 'repos/o/r'], 'placeholders'],
  [['api', '--method=GET', 'repos/o/r'], ['api', '--method=GET', 'repos/o/r'], 'placeholders'],
  [
    ['api', 'repos/o/r', '-H', 'Accept: application/vnd.github.raw', '-q', '.name'],
    ['api', 'repos/o/r', '-H', 'Accept: application/vnd.github.raw', '-q', '.name'],
    'placeholders',
  ],
  [['api', '"repos/o/r/pulls?state=open"'], ['api', '"repos/o/r/pulls?state=open"'], 'placeholders'],
];

describe('allowlisted reads run', () => {
  for (const [argv, args, inject, repo] of ALLOWED) {
    test(argv.join(' '), () => {
      const d = run(decide(argv));
      assert.deepEqual(d.plan.args, args);
      assert.equal(d.plan.inject, inject);
      assert.equal(d.globals.repo, repo);
      // Policy-allows ⇒ guard-allows, before and after the repo is injected.
      assert.ok(isReadAllowed(d.plan.args));
      assert.ok(isReadAllowed(finalArgs(d.plan, REPO)));
    });
  }

  test('ghx output flags are taken out of the gh argv', () => {
    const d = run(decide(['pr', 'list', '--pretty', '--max-bytes', '20000', '--timeout=5m']));
    assert.deepEqual(d.plan.args, ['pr', 'list']);
    assert.deepEqual(d.globals, { pretty: true, maxBytes: '20000', timeout: '5m' });
    assert.equal(d.plan.maxBytes, 20000);
  });

  test('--fields (spaced, =, repeated) and --brief are ghx flags: never in the gh argv', () => {
    const d = run(
      decide([
        'run',
        'list',
        '--json',
        'headSha,status',
        '--fields',
        'passthrough.json[].headSha',
        '--brief',
        '--fields=passthrough.exitCode',
      ]),
    );
    assert.deepEqual(d.plan.args, ['run', 'list', '--json', 'headSha,status']);
    assert.deepEqual(d.globals, { fields: ['passthrough.json[].headSha', 'passthrough.exitCode'], brief: true });
    assert.equal(d.plan.projected, true);
    const api = run(decide(['api', 'repos/{owner}/{repo}/pulls', '--fields', 'passthrough.json[].number']));
    assert.deepEqual(api.plan.args, ['api', 'repos/{owner}/{repo}/pulls']);
    assert.deepEqual(api.globals.fields, ['passthrough.json[].number']);
    assert.equal(run(decide(['run', 'list'])).plan.projected, undefined);
  });

  test('after a bare --, every token is gh’s, ghx-looking flags included', () => {
    const d = run(decide(['search', 'issues', '--pretty', '--', '--fields', '-label:bug']));
    assert.deepEqual(d.plan.args, ['search', 'issues', '--', '--fields', '-label:bug']);
    assert.deepEqual(d.globals, { pretty: true });
  });

  test('every 02 §10 read is in the guard allowlist', () => {
    for (const [group, subs] of Object.entries(ALLOWED_READS)) {
      for (const sub of subs) assert.ok(isReadAllowed([group, sub]), `${group} ${sub}`);
    }
  });
});

describe('the repo goes where each verb takes it', () => {
  test('-R host/owner/name, before any --', () => {
    assert.deepEqual(finalArgs({ args: ['pr', 'list'], inject: 'flag' }, REPO), [
      'pr',
      'list',
      '-R',
      'github.com/octo/demo',
    ]);
    assert.deepEqual(finalArgs({ args: ['issue', 'list', '--', '-x'], inject: 'flag' }, REPO), [
      'issue',
      'list',
      '-R',
      'github.com/octo/demo',
      '--',
      '-x',
    ]);
  });

  test('repo view takes it as the positional; search never gets one', () => {
    assert.deepEqual(finalArgs({ args: ['repo', 'view', '--json', 'name'], inject: 'positional' }, REPO), [
      'repo',
      'view',
      'github.com/octo/demo',
      '--json',
      'name',
    ]);
    assert.deepEqual(finalArgs({ args: ['search', 'issues', 'x'], inject: 'none' }, REPO), ['search', 'issues', 'x']);
  });

  test('api fills {owner}/{repo} in the endpoint only, not in a --jq value', () => {
    assert.deepEqual(
      finalArgs({ args: ['api', '-q', '{repo}', 'repos/{owner}/{repo}/pulls'], inject: 'placeholders' }, REPO),
      ['api', '-q', '{repo}', 'repos/octo/demo/pulls'],
    );
    assert.deepEqual(
      finalArgs(
        { args: ['api', 'repos/{owner}/{repo}'], inject: 'placeholders' },
        { host: 'ghe.example.com', owner: 'o', name: 'r' },
      ),
      ['api', 'repos/o/r', '--hostname', 'ghe.example.com'],
    );
    assert.deepEqual(finalArgs({ args: ['api', 'user'], inject: 'placeholders' }, REPO), ['api', 'user']);
  });
});

type WrapRow = [argv: string[], suggestion: string[]];

const WRAPPED: WrapRow[] = [
  [
    ['pr', 'view', '3198', '-R', 'powerhouse-inc/powerhouse'],
    ['ghx', 'pr', 'status', '3198', '-R', 'powerhouse-inc/powerhouse'],
  ],
  [
    ['pr', 'view'],
    ['ghx', 'pr', 'status', '<pr>'],
  ],
  [
    ['pr', 'view', '--json', 'title,body', '12'],
    ['ghx', 'pr', 'status', '12', '--fields', "'title,description.text'"],
  ],
  [
    ['pr', 'view', '12', '--comments'],
    ['ghx', 'pr', 'feedback', '12'],
  ],
  [
    ['pr', 'checks', '12'],
    ['ghx', 'ci', 'wait', '12'],
  ],
  [
    ['pr', 'checks', '12', '--watch', '--fail-fast'],
    ['ghx', 'ci', 'wait', '12'],
  ],
  [
    ['pr', 'checks', '--help'],
    ['ghx', 'ci', 'wait', '<pr>'],
  ],
  [
    ['run', 'view', '123', '--log'],
    ['ghx', 'ci', 'why', 'run:123'],
  ],
  [
    ['run', 'view', '123', '--log-failed', '-R', 'o/r'],
    ['ghx', 'ci', 'why', 'run:123', '-R', 'o/r'],
  ],
  [
    ['run', 'view', '--log-failed', '--job', '456'],
    ['ghx', 'ci', 'why', 'job:456'],
  ],
  [
    ['run', 'view', '--job', '456', '--log'],
    ['ghx', 'ci', 'why', 'job:456'],
  ],
  [
    ['run', 'watch', '123'],
    ['ghx', 'ci', 'wait', 'run:123'],
  ],
  [
    ['run', 'rerun', '123', '--failed'],
    ['ghx', 'ci', 'rerun', 'run:123'],
  ],
  [
    ['run', 'rerun', '123', '--job', '456'],
    ['ghx', 'ci', 'rerun', 'run:123', '--job', "'<job name>'"],
  ],
  [
    ['run', 'rerun'],
    ['ghx', 'ci', 'rerun', '<pr|run:<run-id>>'],
  ],
  [
    ['pr', 'create', '--title', 'x', '--body', 'y'],
    ['ghx', 'pr', 'create', '--input', 'pr.json'],
  ],
  [
    ['pr', 'new'],
    ['ghx', 'pr', 'create', '--input', 'pr.json'],
  ],
  [
    ['pr', 'create', '--help'],
    ['ghx', 'pr', 'create', '--input', 'pr.json'],
  ],
  [
    ['pr', 'edit', '12', '--add-label', 'x'],
    ['ghx', 'pr', 'edit', '12', '--input', 'patch.json'],
  ],
  [
    ['pr', 'merge', '12', '--squash'],
    ['ghx', 'pr', 'merge', '12'],
  ],
  [
    ['pr', 'merge', '--squash', '12', '-R', 'o/r'],
    ['ghx', 'pr', 'merge', '12', '-R', 'o/r'],
  ],
  [
    ['pr', 'comment', '12', '-b', 'hi'],
    ['ghx', 'pr', 'comment', '12', '--input', 'comment.json'],
  ],
  [
    ['pr', 'review', '12', '--approve'],
    ['ghx', 'pr', 'review', '12', '--input', 'review.json'],
  ],
  [
    ['pr', 'ready', '12'],
    ['ghx', 'pr', 'edit', '12', '--input', 'ready.json'],
  ],
  [
    ['pr', 'close', '12', '--comment', 'dup'],
    ['ghx', 'pr', 'comment', '12', '--close', '--input', 'comment.json'],
  ],
  [
    ['pr', 'reopen', '12'],
    ['ghx', 'ci', 'retrigger', '12'],
  ],
];

describe('wrapped commands are refused with the replacement argv', () => {
  for (const [argv, suggestion] of WRAPPED) {
    test(argv.join(' '), () => {
      const e = refused(decide(argv));
      assert.equal(e.code, 'USAGE_UNKNOWN_COMMAND');
      assert.equal(e.exitCode, EXIT.USAGE);
      assert.deepEqual(e.details?.suggestion, suggestion);
      assert.ok(e.hint?.startsWith(`Use: ${suggestion.join(' ')} (`), e.hint);
    });
  }

  test('pr checks says to run ci wait in the background and offers pr status', () => {
    const e = refused(decide(['pr', 'checks', '12']));
    assert.match(e.hint ?? '', /run_in_background: true/);
    assert.deepEqual(e.details?.alternatives, [['ghx', 'pr', 'status', '12']]);
  });

  test('pr ready names the patch; --undo flips it; a PR without a block needs adopt', () => {
    const hint = refused(decide(['pr', 'ready', '1'])).hint ?? '';
    assert.match(hint, /\{"draft": false\}/);
    assert.match(hint, /"adopt": true/);
    assert.match(refused(decide(['pr', 'ready', '1', '--undo'])).hint ?? '', /\{"draft": true\}/);
  });

  test('a wrapped refusal also lists the ghx command in details.suggestions', () => {
    assert.deepEqual(refused(decide(['pr', 'view', '12'])).details?.suggestions, ['pr status']);
    assert.deepEqual(refused(decide(['run', 'watch', '9'])).details?.suggestions, ['ci wait']);
  });

  test('the 02 §6.2 example, naming description.text as the body', () => {
    const e = refused(decide(['pr', 'view', '3198', '-R', 'powerhouse-inc/powerhouse']));
    assert.equal(e.message, "'ghx pr view' is not a ghx command.");
    assert.equal(
      e.hint,
      'Use: ghx pr status 3198 -R powerhouse-inc/powerhouse (state, title, description.text (the body), mergeable, CI for the head SHA and feedback in one object).',
    );
  });

  test('pr view --json names the pr status --fields; a field pr status lacks names the REST read', () => {
    const e = refused(decide(['pr', 'view', '12', '--json', 'body,isDraft,labels']));
    assert.deepEqual(e.details?.suggestion, ['ghx', 'pr', 'status', '12', '--fields', "'description.text,draft'"]);
    assert.match(e.hint ?? '', /labels is not in pr status: ghx api repos\/\{owner\}\/\{repo\}\/pulls\/12 has it\)\.$/);
  });

  test('run view --log is not "not a ghx command": run view without --log is passed through', () => {
    const e = refused(decide(['run', 'view', '--job', '456', '--log']));
    assert.equal(e.message, "'ghx run view --log' is not passed through.");
    assert.deepEqual(e.details?.alternatives, [['ghx', 'api', 'repos/{owner}/{repo}/actions/jobs/456/logs']]);
    const run = refused(decide(['run', 'view', '123', '--log']));
    assert.match(
      run.hint ?? '',
      /one job's raw log is ghx api repos\/\{owner\}\/\{repo\}\/actions\/jobs\/<job-id>\/logs \(job ids: ghx run view 123 --json jobs\)/,
    );
  });
});

const WRITES: string[][] = [
  ['issue', 'create', '--title', 'x'],
  ['issue', 'new'],
  ['issue', 'comment', '1', '-b', 'x'],
  ['issue', 'edit', '1'],
  ['issue', 'close', '1'],
  ['release', 'create', 'v1'],
  ['release', 'upload', 'v1', 'a.zip'],
  ['repo', 'create', 'x'],
  ['repo', 'edit', '--visibility', 'public'],
  ['repo', 'delete', 'o/r', '--yes'],
  ['repo', 'fork'],
  ['repo', 'deploy-key', 'add', 'k.pub'],
  ['secret', 'set', 'X'],
  ['variable', 'set', 'X'],
  ['label', 'create', 'bug'],
  ['workflow', 'run', 'ci.yml'],
  ['workflow', 'enable', 'ci.yml'],
  ['gist', 'create', 'a.txt'],
  ['pr', 'checkout', '12'],
  ['co', '12'],
  ['pr', 'update-branch', '12'],
  ['run', 'cancel', '123'],
  ['run', 'delete', '123'],
  ['cache', 'delete', '--all'],
  ['auth', 'login'],
  ['auth', 'setup-git'],
  ['extension', 'install', 'x/gh-y'],
  ['config', 'set', 'pager', 'less'],
];

/** gh api forms that write (or might): each must be refused, and the guard agrees. */
const API_WRITES: string[][] = [
  ['api', 'repos/o/r/issues', '-X', 'POST'],
  ['api', '-XPOST', 'repos/o/r/issues'],
  ['api', '-X=POST', 'repos/o/r/issues'],
  ['api', '-iXPOST', 'repos/o/r/issues'],
  ['api', '--method', 'POST', 'repos/o/r/issues'],
  ['api', '--method=PATCH', 'repos/o/r/pulls/1'],
  ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/x'],
  ['api', 'repos/o/r/issues', '-f', 'title=x'],
  ['api', 'repos/o/r/issues', '-ftitle=x'],
  ['api', 'repos/o/r/issues', '-F', 'title=x'],
  ['api', 'repos/o/r/issues', '--field', 'title=x'],
  ['api', 'repos/o/r/issues', '--raw-field', 'title=x'],
  ['api', 'repos/o/r/issues', '--raw-field=title=x'],
  ['api', 'repos/o/r/issues', '--input', 'body.json'],
  ['api', 'repos/o/r/issues', '--input=body.json'],
  ['api', '-XGET', 'repos/o/r/issues', '-f', 'state=open'],
  ['api', 'graphql', '-F', 'query=@q.graphql'],
  ['api', 'graphql', '-f', 'query=mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }'],
  ['api', 'repos/o/r', '--', '-XPOST'],
  ['api', 'repos/o/r', '--frobnicate'],
  ['api', 'repos/o/r', 'extra'],
  ['api', 'repos/o/r', '-X'],
  ['api', 'repos/o/r', '--help'],
  ['api'],
];

describe('writes are refused (PASSTHROUGH_WRITE_REFUSED, exit 6)', () => {
  for (const argv of [...WRITES, ...API_WRITES]) {
    test(argv.join(' '), () => {
      const e = refused(decide(argv));
      assert.equal(e.code, 'PASSTHROUGH_WRITE_REFUSED');
      assert.equal(e.exitCode, EXIT.POLICY);
    });
  }

  test('the guard agrees on every gh api write form', () => {
    for (const argv of API_WRITES) assert.ok(!isReadAllowed(argv), argv.join(' '));
  });

  test('a graphql query is a read to the guard but refused by passthrough (always a POST)', () => {
    const argv = ['api', 'graphql', '-f', 'query={ viewer { login } }'];
    assert.ok(isReadAllowed(argv));
    assert.match(refused(decide(argv)).message, /always a POST/);
  });

  test('-f gets the "gh switches to POST" reason, an explicit -X the method', () => {
    assert.match(refused(decide(['api', 'x', '-f', 'a=b'])).message, /switches/);
    assert.match(refused(decide(['api', 'x', '-X', 'PUT'])).message, /method PUT/);
  });
});

describe('the guard is wider than passthrough on purpose', () => {
  for (const argv of [
    ['pr', 'view', '1'],
    ['pr', 'checks', '1'],
    ['run', 'view', '1', '--log'],
  ]) {
    test(argv.join(' '), () => {
      assert.ok(isReadAllowed(argv));
      assert.equal(refused(decide(argv)).code, 'USAGE_UNKNOWN_COMMAND');
    });
  }
  test('auth status', () => {
    assert.ok(isReadAllowed(['auth', 'status']));
    assert.equal(decide(['auth', 'status']).kind, 'unknown');
  });
});

describe('usage refusals (exit 2)', () => {
  for (const argv of [
    ['pr', 'list', '--web'],
    ['issue', 'view', '1', '-w'],
    ['repo', 'view', '--web=true'],
    ['run', 'view', '1', '-w'],
  ]) {
    test(`${argv.join(' ')}: no browser`, () => {
      const e = refused(decide(argv));
      assert.equal(e.code, 'USAGE_UNKNOWN_FLAG');
      assert.equal(e.exitCode, EXIT.USAGE);
    });
  }

  test('run download without -D is VALIDATION', () => {
    for (const argv of [
      ['run', 'download', '123'],
      ['run', 'download', '123', '-D'],
      ['run', 'download', '123', '-n', 'logs'],
    ]) {
      const e = refused(decide(argv));
      assert.equal(e.code, 'VALIDATION', argv.join(' '));
      assert.equal(e.exitCode, EXIT.USAGE);
    }
  });

  test('gh api has no -R', () => {
    for (const argv of [
      ['api', '-R', 'o/r', 'repos/{owner}/{repo}'],
      ['api', 'repos/{owner}/{repo}', '--repo=o/r'],
    ]) {
      const e = refused(decide(argv));
      assert.equal(e.code, 'USAGE_UNKNOWN_FLAG', argv.join(' '));
      assert.match(e.hint ?? '', /\{owner\}\/\{repo\}/);
    }
  });
});

describe('guessed ghx commands point at the command that exists', () => {
  const GUESSED: [argv: string[], suggestion: string[], alternatives?: string[][]][] = [
    [
      ['ci', 'logs'],
      ['ghx', 'ci', 'why', '<pr|run:<id>>'],
    ],
    [
      ['ci', 'logs', '--help'],
      ['ghx', 'ci', 'why', '<pr|run:<id>>'],
    ],
    [
      ['ci', 'log', '12', '-R', 'o/r'],
      ['ghx', 'ci', 'why', '12', '-R', 'o/r'],
      [['ghx', 'ci', 'why', 'run:12', '-R', 'o/r']],
    ],
    [
      ['ci', 'view', 'o/r#3'],
      ['ghx', 'ci', 'why', 'o/r#3'],
    ],
    [['ci', 'watch', '12'], ['ghx', 'ci', 'wait', '12'], [['ghx', 'pr', 'status', '12']]],
    [['ci', 'status'], ['ghx', 'ci', 'wait', '<pr>'], [['ghx', 'pr', 'status', '<pr>']]],
    // The fixed alias table: edit distance read these as pr create, pr diff, or nothing.
    [
      ['pr', 'show', '7'],
      ['ghx', 'pr', 'status', '7'],
    ],
    [
      ['pr', 'get', '7', '-R', 'o/r'],
      ['ghx', 'pr', 'status', '7', '-R', 'o/r'],
    ],
    [
      ['pr', 'info', '7'],
      ['ghx', 'pr', 'status', '7'],
    ],
    [
      ['pr', 'update', '7'],
      ['ghx', 'pr', 'edit', '7', '--input', 'patch.json'],
    ],
    [
      ['pr', 'threads', '7'],
      ['ghx', 'pr', 'feedback', '7'],
    ],
    [
      ['pr', 'review-comments', '7'],
      ['ghx', 'pr', 'feedback', '7'],
    ],
    [
      ['pr', 'comments', '7'],
      ['ghx', 'pr', 'feedback', '7'],
    ],
    [
      ['pr', 'reviews', '7'],
      ['ghx', 'pr', 'feedback', '7'],
    ],
    [
      ['pr', 'resolve-thread', '7'],
      ['ghx', 'pr', 'resolve', '7', '<finding-id>'],
    ],
    [['ci', 'failures', '7'], ['ghx', 'ci', 'why', '7'], [['ghx', 'ci', 'why', 'run:7']]],
    [
      ['ci', 'rerun-failed', 'run:9'],
      ['ghx', 'ci', 'rerun', 'run:9'],
    ],
  ];
  for (const [argv, suggestion, alternatives] of GUESSED) {
    test(argv.join(' '), () => {
      const d = decide(argv);
      const e = refused(d);
      assert.equal(e.code, 'USAGE_UNKNOWN_COMMAND');
      assert.equal(e.message, `'ghx ${argv.slice(0, 2).join(' ')}' is not a ghx command.`);
      assert.deepEqual(e.details?.suggestion, suggestion);
      assert.deepEqual(e.details?.suggestions, [suggestion.slice(1, 3).join(' ')]);
      assert.deepEqual(e.details?.alternatives, alternatives);
      assert.ok(e.hint?.startsWith(`Use: ${suggestion.join(' ')} (`), e.hint);
      assert.equal(d.kind === 'refuse' && d.wrapped, undefined, 'not a gh command: the hook never sees it');
    });
  }

  test('ghx ci logs without a target and ghx help ci logs refuse with the ci why hint, without calling gh', async () => {
    for (const argv of [
      ['ci', 'logs'],
      ['help', 'ci', 'logs'],
    ]) {
      const fake = new FakeGh();
      const r = await runInProcess(argv, { gh: fake });
      assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
      assert.equal(r.json.error.code, 'USAGE_UNKNOWN_COMMAND');
      assert.match(r.json.error.hint, /^Use: ghx ci why /);
      assert.equal(fake.calls.length, 0);
    }
  });
});

describe('unknown commands', () => {
  for (const argv of [['frobnicate'], ['--foo'], ['repo', 'list'], ['auth', 'token'], ['gist', 'list'], ['pr']]) {
    test(argv.join(' '), () => assert.equal(decide(argv).kind, 'unknown'));
  }

  test('edit-distance suggestions cover ghx commands and passthrough reads', async () => {
    const names = [
      ['ci', 'wait'],
      ['pr', 'status'],
    ];
    const r1 = await onUnknown(['pr', 'dif', '1'], { names });
    assert.equal(r1.kind, 'refuse');
    assert.deepEqual(r1.kind === 'refuse' && r1.error.details?.suggestions, ['pr diff']);
    const r2 = await onUnknown(['ci', 'wiat'], { names });
    assert.deepEqual(r2.kind === 'refuse' && r2.error.details?.suggestions, ['ci wait']);
    assert.equal(r2.kind === 'refuse' && r2.error.exitCode, EXIT.USAGE);
  });

  test('a real gh command off the allowlist says so', async () => {
    const r = await onUnknown(['repo', 'list'], { names: [] });
    assert.equal(r.kind === 'refuse' && r.error.code, 'USAGE_UNKNOWN_COMMAND');
    assert.match(r.kind === 'refuse' ? (r.error.hint ?? '') : '', /not on the passthrough allowlist/);
  });
});

describe('refused argv never reaches gh (through runCli)', () => {
  const rows: [string[], number][] = [
    ...WRAPPED.map(([argv]) => [argv, EXIT.USAGE] as [string[], number]),
    // `api … --help` is refused by decide() but answered by runCli with passthrough help: exit 0, no gh call.
    ...[...WRITES, ...API_WRITES].map(
      (argv) => [argv, argv[0] === 'api' && argv.includes('--help') ? EXIT.OK : EXIT.POLICY] as [string[], number],
    ),
    [['run', 'download', '1'], EXIT.USAGE],
    [['pr', 'list', '--web'], EXIT.USAGE],
    [['frobnicate'], EXIT.USAGE],
  ];
  const registry = defaultRegistry();
  for (const [argv, exit] of rows) {
    test(argv.join(' '), async (t) => {
      const words = argv.filter((a, i) => i < 3 && !a.startsWith('-'));
      if (await registry.resolve(words)) {
        t.skip(`ghx ${words.join(' ')} is a ghx command now`);
        return;
      }
      // A gh-shaped read with a faithful equivalent runs it (test/commands/gh-shaped.test.ts).
      if (readRedirect(argv)) {
        t.skip(`ghx ${words.join(' ')} runs its ghx equivalent`);
        return;
      }
      const fake = new FakeGh();
      const r = await runInProcess(argv, { gh: fake });
      assert.equal(r.exitCode, exit, r.stdout);
      assert.deepEqual(fake.calls, []);
    });
  }
});

describe('a leading -R/--repo is stripped before classifying (gh accepts it before the command words)', () => {
  test('wrapped commands are refused with the repo carried into the suggestion', () => {
    for (const argv of [
      ['-R', 'o/r', 'pr', 'merge', '1'],
      ['--repo=o/r', 'pr', 'merge', '1'],
      ['-Ro/r', 'pr', 'merge', '1'],
      ['pr', 'merge', '-R', 'o/r', '1'],
    ]) {
      const e = refused(decide(argv));
      assert.equal(e.code, 'USAGE_UNKNOWN_COMMAND', argv.join(' '));
      assert.deepEqual(e.details?.suggestion, ['ghx', 'pr', 'merge', '1', '-R', 'o/r'], argv.join(' '));
    }
  });

  test('reads run with the repo, writes are refused, api still has no -R', () => {
    const r = run(decide(['-R', 'o/r', 'pr', 'diff', '1']));
    assert.deepEqual([r.plan.args, r.globals.repo], [['pr', 'diff', '1'], 'o/r']);
    assert.equal(refused(decide(['--repo', 'o/r', 'issue', 'close', '1'])).code, 'PASSTHROUGH_WRITE_REFUSED');
    assert.equal(refused(decide(['-R', 'o/r', 'api', 'repos/{owner}/{repo}'])).code, 'USAGE_UNKNOWN_FLAG');
    const s = run(decide(['-R', 'o/r', 'search', 'prs', 'x']));
    assert.deepEqual(s.plan.args, ['search', 'prs', '-R', 'o/r', 'x']);
  });
});

describe('passthrough edge cases (final review)', () => {
  test('run download --name -D 123: -D is the value of --name, so -D <dir> is still missing', () => {
    for (const argv of [
      ['run', 'download', '--name', '-D', '123'],
      ['run', 'download', '-n', '-D', '123'],
      ['run', 'download', '123', '--name', '--dir'],
    ]) {
      assert.equal(refused(decide(argv)).code, 'VALIDATION', argv.join(' '));
    }
    run(decide(['run', 'download', '123', '--name', 'logs', '-D', 'out']));
    run(decide(['run', 'download', '123', '-Dout']));
  });

  test('-cw and -vw are --web in a short-flag cluster; a value flag ends the cluster', () => {
    for (const argv of [
      ['issue', 'view', '1', '-cw'],
      ['run', 'view', '1', '-vw'],
      ['pr', 'list', '-w'],
    ]) {
      assert.equal(refused(decide(argv)).code, 'USAGE_UNKNOWN_FLAG', argv.join(' '));
    }
    // -L takes the rest of the cluster as its value; run list's -w is --workflow.
    run(decide(['pr', 'list', '-Lw']));
    run(decide(['run', 'list', '-w', 'ci.yml']));
    run(decide(['issue', 'list', '-S', '-w']));
  });

  test('pr co is pr checkout: a refused write', () => {
    const e = refused(decide(['pr', 'co', '12']));
    assert.equal(e.code, 'PASSTHROUGH_WRITE_REFUSED');
    assert.equal(e.details?.command, 'gh pr checkout');
  });
});
