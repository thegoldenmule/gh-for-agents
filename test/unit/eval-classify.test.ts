// ghx-eval M1: command, intent and result classification (scripts/eval/classify). Command strings and
// result texts follow real transcript shapes; repos, numbers and paths are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyCommand } from '../../scripts/eval/classify/command.ts';
import { classifyResult, nonExitErrorKind, type ResultInput } from '../../scripts/eval/classify/errors.ts';
import { commandIntent, ghIntent, type Intent } from '../../scripts/eval/classify/intent.ts';

const cmd = (c: string) => classifyCommand(c);
const intent = (c: string, ctx: { background?: boolean; monitor?: boolean } = {}): Intent | null =>
  commandIntent(classifyCommand(c), c, ctx)?.intent ?? null;

test('command: gh, ghx, mixed and other, with the subcommand after leading -R', () => {
  assert.equal(cmd('gh -R acme/widgets pr checks 12').subcommand, 'gh pr checks');
  assert.equal(cmd('ghx pr status 12 --brief').subcommand, 'ghx pr status');
  assert.equal(cmd('ghx pr status 12 && gh run view 99 --log-failed').cli, 'mixed');
  assert.equal(cmd('git push origin HEAD').cli, 'other');
  assert.equal(cmd('echo "gh pr merge 12"').cli, 'other', 'quoted text is not a call');
  assert.equal(cmd("git commit -m 'run gh pr checks'").cli, 'other');
  assert.equal(cmd('gh api repos/acme/widgets/pulls/12/comments').subcommand, 'gh api');
  assert.equal(cmd("gh api graphql -f query='{ viewer { login } }'").subcommand, 'gh api graphql');
  assert.equal(cmd('ghx --help').subcommand, 'ghx');
  assert.equal(cmd('cd /tmp/w && GH_PAGER= ghx ci why 12').cli, 'ghx');
});

test('command: a heredoc body is data unless a shell runs it', () => {
  const script = '#!/usr/bin/env bash\nfor pr in "$@"; do gh pr view $pr --json state; done\nEOF';
  assert.equal(cmd(`cat > /tmp/w/x.sh <<'EOF'\n${script}\nchmod +x /tmp/w/x.sh`).cli, 'other');
  assert.equal(cmd(`cat >> notes.md <<EOF\nmerged with gh pr merge 12\nEOF`).cli, 'other');
  assert.equal(cmd(`git commit -q -F - <<'EOF'\nfeat: wrap gh pr create\nEOF`).cli, 'other');
  assert.equal(cmd(`bash <<'EOF'\n${script}`).subcommand, 'gh pr view');
  const after = cmd("cat > /tmp/w/body.md <<'EOF'\nIt's done\nEOF\ngh pr create --body-file /tmp/w/body.md");
  assert.deepEqual(
    after.invocations.map((i) => i.subcommand),
    ['pr create'],
    'an apostrophe in the body does not hide the call after it',
  );
});

test('command: "$(gh …)" and "`gh …`" inside double quotes are calls, after the command that holds them', () => {
  assert.equal(cmd('for p in 1 2; do echo "$(gh pr view $p --json state)"; done').subcommand, 'gh pr view');
  assert.equal(cmd('X="$(gh pr checks 12)"').subcommand, 'gh pr checks');
  assert.equal(cmd('echo "sha `ghx pr status 12 --fields headSha`"').cli, 'ghx');
  const nested = cmd('echo "$(gh pr view "$p" --json state -q .state)"');
  assert.deepEqual(nested.invocations[0]?.args, ['pr', 'view', '$p', '--json', 'state', '-q', '.state']);
  const body = cmd('gh pr comment 12 --body "$(cat <<\'EOF\'\nRan "gh pr view 12" (it\'s red)\nEOF\n)"');
  assert.deepEqual(
    body.invocations.map((i) => i.subcommand),
    ['pr comment'],
    'the heredoc inside the substitution is still data',
  );
  assert.equal(cmd('echo "gh pr view $p"').cli, 'other', 'a variable alone is not a substitution');
});

test('command: dogfood launchers count as ghx (npx, pnpm exec, node bin/ghx.js)', () => {
  for (const c of [
    'npx -y @thegoldenmule/ghx pr status 12',
    'pnpm exec ghx ci wait 12',
    'node bin/ghx.js pr feedback 12',
    'node /Users/dev/projects/ghx/bin/ghx.js ci why 12',
    './bin/ghx.js doctor',
  ]) {
    assert.equal(cmd(c).cli, 'ghx', c);
  }
  assert.equal(cmd('node scripts/build.js').cli, 'other');
  assert.equal(cmd('npx prettier --write .').cli, 'other');
});

test('command glue: pipes, jq, sleep loops, --watch, timeouts, redirect targets and input files', () => {
  const g = (c: string) => cmd(c).glue;
  assert.deepEqual([g('ghx pr status 12 | tail -50').pipe, g('ghx pr status 12').pipe], [true, false]);
  assert.equal(g('gh pr view 12 --json state --jq .state').jq, true);
  assert.equal(g('gh pr view 12 --json state | jq -r .state').jq, true);
  assert.equal(g('gh pr view 12 --json state -q .state').jq, true);
  const loop = g('while true; do gh pr checks 12 && break; sleep 30; done');
  assert.deepEqual([loop.loop, loop.sleep], [true, true]);
  assert.equal(g('gh pr checks 12 --watch').watch, true);
  assert.equal(g('gh run watch 99').watch, true);
  assert.equal(g("watch -n 30 'gh pr checks 12'").watch, true);
  assert.equal(g('timeout 600 gh run watch 99').timeout, true);
  assert.deepEqual(
    g('gh run view 99 --log-failed > /private/tmp/w/run.log 2>&1').redirects,
    ['run.log'],
    '2>&1 and fd duplications are not targets',
  );
  assert.deepEqual(g('gh pr diff 12 2>/dev/null | tee /tmp/w/diff.txt | head').redirects, ['diff.txt']);
  assert.deepEqual(g('gh pr view 12 >> "/tmp/w/out file.txt"').redirects, [], 'quoted targets are blanked');
  assert.deepEqual(g('ghx pr create --input /tmp/w/pr.json').inputFiles, ['pr.json']);
  assert.deepEqual(g('gh pr create --title T --body-file=/tmp/w/body.md').inputFiles, ['body.md']);
  assert.deepEqual(g('gh pr comment 12 -F /tmp/w/reply.md').inputFiles, ['reply.md']);
  assert.deepEqual(g("gh api repos/a/b/issues -F title='x'").inputFiles, [], '-F on gh api is a field');
  assert.deepEqual(g('ghx pr review 12 --input -').inputFiles, [], 'stdin is not a file');
});

test('intent: priority across invocations (merge > create > … > status > other_read > meta)', () => {
  assert.equal(intent('ghx pr status 12 && ghx pr merge 12'), 'merge');
  assert.equal(intent('gh pr create --fill'), 'create');
  assert.equal(intent('gh pr ready 12'), 'edit');
  assert.equal(intent('ghx pr comment 12 --input r.json'), 'reply');
  assert.equal(intent('gh issue create --title x'), 'other_write');
  assert.equal(intent('gh run view 99 --log-failed'), 'diagnose');
  assert.equal(intent('ghx ci why 12'), 'diagnose');
  assert.equal(intent('gh run rerun 99 --failed'), 'rerun');
  assert.equal(intent('ghx ci wait 12'), 'wait');
  assert.equal(intent('ghx pr feedback 12'), 'feedback');
  assert.equal(intent('gh pr view 12 --json comments,reviews'), 'feedback');
  assert.equal(intent('gh pr view 12 --json state,statusCheckRollup'), 'status');
  assert.equal(intent('gh pr view 12'), 'other_read');
  assert.equal(intent('ghx schema pr create'), 'meta');
  assert.equal(intent('ghx pr create --help'), 'meta');
  assert.equal(intent('git status'), null);
  const r = commandIntent(cmd('ghx run list -L 5'), 'ghx run list -L 5');
  assert.deepEqual([r?.intent, r?.passthrough], ['status', true], 'ghx passthrough uses the gh rules');
  assert.equal(commandIntent(cmd('ghx doctor'), 'ghx doctor')?.metaOnly, true);
});

test('intent: a status read in a sleep loop, a background call or a Monitor is a wait', () => {
  assert.equal(intent('gh pr checks 12'), 'status');
  assert.equal(intent('sleep 60; gh pr checks 12'), 'wait');
  assert.equal(intent('until gh run view 99 --json status | grep -q completed; do sleep 20; done'), 'wait');
  assert.equal(intent('ghx pr status 12', { background: true }), 'wait');
  assert.equal(intent('gh run list -b main -L 1', { monitor: true }), 'wait');
  assert.equal(intent('sleep 30; gh pr merge 12'), 'merge', 'a write outranks the wait');
  assert.equal(intent('gh pr checks 12 --watch'), 'wait');
});

test('intent: gh api by path and method, graphql by body', () => {
  const api = (args: string[], raw = '') => ghIntent(args, ['api', args[1] ?? ''], raw);
  assert.equal(api(['api', 'repos/a/b/actions/jobs/1/logs']), 'diagnose');
  assert.equal(api(['api', 'repos/a/b/actions/runs/1/rerun', '-X', 'POST']), 'rerun');
  assert.equal(api(['api', 'repos/a/b/pulls/12/comments']), 'feedback');
  assert.equal(api(['api', 'repos/a/b/pulls/12/comments/5/replies', '-f', 'body=x']), 'reply');
  assert.equal(api(['api', 'repos/a/b/commits/abc/check-runs']), 'status');
  assert.equal(api(['api', 'repos/a/b/pulls/12']), 'status');
  assert.equal(api(['api', 'repos/a/b/labels', '-X', 'POST']), 'other_write');
  assert.equal(
    intent("gh api graphql -f query='mutation { resolveReviewThread(input:{}) { thread { id } } }'"),
    'reply',
  );
  assert.equal(
    intent("gh api graphql -f query='{ repository { pullRequest { reviewThreads { nodes { id } } } } }'"),
    'feedback',
  );
});

const result = (r: Partial<ResultInput>) =>
  classifyResult({ toolName: 'Bash', isError: false, text: '', cli: 'other', ...r });

test('errors: exit codes from is_error + `Exit code N`; a clean foreground Bash call is exit 0', () => {
  assert.deepEqual([result({ isError: true, text: 'Exit code 2\nusage: …' }).exitCode, result({}).exitCode], [2, 0]);
  const r = result({ isError: true, text: 'Exit code 1\nfatal: not a git repository', cli: 'other' });
  assert.deepEqual([r.errorKind, r.refusal], ['command', null]);
  assert.equal(result({ toolName: 'Read', text: 'file' }).exitCode, null);
  const bg = result({ text: 'Command running in background with ID: b1', background: true, notifExit: 1, cli: 'gh' });
  assert.deepEqual([bg.exitCode, bg.effectiveExit, bg.errorKind], [null, 1, 'command']);
});

test('errors: hook blocks, permission denials, validation and harness refusals are their own kinds', () => {
  const k = (text: string, kind?: string) => nonExitErrorKind(text, kind);
  assert.equal(k('PreToolUse:Bash hook error: ghx replaces `gh pr checks 12`.', 'permission-rule'), 'hook_block');
  assert.equal(
    k('Permission for this action was denied by the Claude Code auto mode classifier.', 'automode-blocked'),
    'permission_denied',
  );
  assert.equal(
    k("The user doesn't want to proceed with this tool use. The tool use was rejected.", 'user-rejected'),
    'permission_denied',
  );
  assert.equal(
    k('Permission to use Bash with command touch /tmp/x has been denied.', 'permission-rule'),
    'permission_denied',
  );
  assert.equal(
    k(
      '<tool_use_error>InputValidationError: Bash failed due to the following issues:\nAn unexpected parameter `x` was provided</tool_use_error>',
    ),
    'input_validation',
  );
  assert.equal(k('<tool_use_error>Missing required parameter: task_id</tool_use_error>'), 'input_validation');
  assert.equal(
    k(
      '<tool_use_error>Blocked: sleep 60 followed by: tail -5 /tmp/x. To wait for a condition, use Monitor.</tool_use_error>',
    ),
    'harness_block',
  );
  assert.equal(
    k('This agent is isolated in the worktree /w/agent-1, but this command is too complex to verify.'),
    'harness_block',
  );
  assert.equal(k('Error: Runtime.callFunctionOn timed out.'), 'tool_error');
  const hook = result({ isError: true, text: 'PreToolUse:Bash hook error: ghx replaces `gh run rerun 9`.', cli: 'gh' });
  assert.deepEqual([hook.exitCode, hook.errorKind, hook.refusal], [null, 'hook_block', 'hook']);
});

test('errors: ghx outcomes (10, 11, 15) are not errors; error bodies are, piped or not; exit 6 is a refusal', () => {
  const ghx = (r: Partial<ResultInput>) => result({ cli: 'ghx', ...r });
  for (const [code, outcome] of [
    [10, 'ci_red'],
    [11, 'ci_red_on_main'],
    [15, 'handed_back'],
  ] as const) {
    const r = ghx({ isError: true, text: `Exit code ${code}\n{"outcome":"x"}` });
    assert.deepEqual([r.errorKind, r.ghxOutcome, r.exitCode], [null, outcome, code]);
  }
  const bg = ghx({ background: true, notifExit: 15, text: 'Command running in background with ID: b1' });
  assert.deepEqual([bg.errorKind, bg.ghxOutcome], [null, 'handed_back'], 'background exit from the notification');
  const piped = ghx({ text: '{"error":{"code":"USAGE_UNKNOWN_COMMAND","message":"unknown command pr view"}}' });
  assert.deepEqual([piped.exitCode, piped.errorKind, piped.ghxErrorCode], [0, 'command', 'USAGE_UNKNOWN_COMMAND']);
  const policy = ghx({ isError: true, text: 'Exit code 6\n{"error":{"code":"POLICY_DENIED","message":"x"}}' });
  assert.deepEqual([policy.errorKind, policy.refusal], ['command', 'ghx_policy']);
  const other = ghx({ isError: true, text: 'Exit code 9\nhead moved' });
  assert.deepEqual([other.errorKind, other.ghxOutcome], ['command', null]);
  const mixed = result({ cli: 'mixed', isError: true, text: 'Exit code 10\n' });
  assert.equal(mixed.errorKind, 'command', 'exit 10 is an outcome only for a pure ghx call');
  assert.equal(result({ cli: 'gh', isError: true, text: 'Exit code 10' }).errorKind, 'command');
});

test('failures: ghx codes by their exit class, gh by its own messages, unexplained exits are not mistakes', () => {
  const f = (r: Partial<ResultInput>) => {
    const x = result(r);
    return [x.failure, x.failureReason];
  };
  const body = (code: string) => `{"error":{"code":"${code}","message":"m","hint":null,"details":null}}`;
  const ghx = (text: string, exit = 0) =>
    f({ cli: 'ghx', isError: exit !== 0, text: exit ? `Exit code ${exit}\n${text}` : text });
  assert.deepEqual(ghx(body('VALIDATION'), 2), ['mistake', 'VALIDATION']);
  assert.deepEqual(ghx(body('USAGE_UNKNOWN_COMMAND')), ['mistake', 'USAGE_UNKNOWN_COMMAND'], 'piped to exit 0');
  assert.deepEqual(ghx(body('PR_NOT_FOUND'), 5), ['mistake', 'PR_NOT_FOUND']);
  assert.deepEqual(ghx(body('RUN_IN_PROGRESS'), 9), ['outcome', 'RUN_IN_PROGRESS']);
  assert.deepEqual(ghx(body('CONFIG_MISSING'), 3), ['outcome', 'CONFIG_MISSING']);
  assert.deepEqual(ghx(body('DIFF_TOO_LARGE'), 7), ['outcome', 'DIFF_TOO_LARGE']);
  assert.deepEqual(ghx(body('MERGE_BLOCKED'), 6), ['outcome', 'MERGE_BLOCKED'], 'the PR blocks it, not the agent');
  assert.deepEqual(ghx(body('PASSTHROUGH_WRITE_REFUSED'), 6), ['denial', 'PASSTHROUGH_WRITE_REFUSED']);
  assert.deepEqual(ghx(body('RETIRED_CODE'), 6), ['denial', 'RETIRED_CODE'], 'an unknown code falls back to its exit');
  // ci wait in the background: the exit comes from the notification.
  const bg = (exit: number) =>
    f({ cli: 'ghx', background: true, notifExit: exit, text: 'Command running in background with ID: b1' });
  for (const exit of [12, 13, 14]) assert.deepEqual(bg(exit), ['outcome', `exit:${exit}`]);
  assert.deepEqual(bg(2), ['mistake', 'exit:2'], 'ghx ci wait main: a bad selector');
  assert.deepEqual(bg(10), [null, null], 'red CI is not a failure at all');
  // raw gh: its usage and lookup messages are mistakes; its state messages and pr checks exits are outcomes.
  const gh = (text: string, subcommands: string[] = ['gh pr view']) =>
    f({ cli: 'gh', isError: true, text: `Exit code 1\n${text}`, subcommands });
  assert.deepEqual(gh('unknown flag: --foo\n\nUsage:  gh pr view'), ['mistake', 'gh:unknown_flag']);
  assert.deepEqual(gh('unknown command "show" for "gh pr"'), ['mistake', 'gh:unknown_command']);
  assert.deepEqual(gh('Unknown JSON field: "checks"\nAvailable fields:'), ['mistake', 'gh:unknown_field']);
  assert.deepEqual(
    gh('GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)'),
    ['mistake', 'gh:not_found'],
  );
  assert.deepEqual(gh('X Pull request acme/widgets#12 is not mergeable: the base branch policy prohibits the merge.'), [
    'outcome',
    'gh:state',
  ]);
  assert.deepEqual(
    f({ cli: 'gh', isError: true, text: 'Exit code 8\nbuild\tpending', subcommands: ['gh pr checks'] }),
    ['outcome', 'exit:8'],
    'checks pending',
  );
  assert.deepEqual(
    gh('2026-10-05T21:23:21Z [reactor] module not found: x\n##[error]Process completed with exit code 1.', [
      'gh run view',
    ]),
    ['outcome', 'exit:1'],
    'a CI log that says "not found" is the log, not gh; the exit is the trailing grep',
  );
  assert.deepEqual(gh('Traceback (most recent call last):\n  File "<string>", line 1\nKeyError: \'x\''), [
    'mistake',
    'glue:python',
  ]);
  assert.deepEqual(
    ghx('(eval):1: no matches found: passthrough.json.jobs[].id', 1),
    ['mistake', 'glue:shell'],
    'an unquoted --fields glob',
  );
  assert.deepEqual(gh('', ['gh run watch']), ['outcome', 'exit:1']);
  assert.deepEqual(f({ cli: 'gh', isError: true, text: 'Exit code 143\n' }), ['outcome', 'exit:143'], 'killed');
  // errors without an exit code
  assert.deepEqual(
    f({ cli: 'gh', isError: true, text: 'PreToolUse:Bash hook error: ghx replaces `gh pr checks 1`.' }),
    ['denial', 'hook_block'],
  );
  assert.deepEqual(
    f({
      cli: 'gh',
      isError: true,
      text: 'Permission for this action was denied by the Claude Code auto mode classifier.',
    }),
    ['denial', 'permission_denied'],
  );
  assert.deepEqual(
    f({ cli: 'gh', isError: true, text: '<tool_use_error>Blocked: sleep 60 followed by: gh pr checks 1' }),
    ['denial', 'harness_block'],
  );
  assert.deepEqual(f({ cli: 'gh', isError: true, text: '<tool_use_error>InputValidationError: x</tool_use_error>' }), [
    'mistake',
    'input_validation',
  ]);
  assert.deepEqual(f({ cli: 'gh' }), [null, null], 'a call that did not fail has no failure class');
});
