// ghx hook claude-pretooluse (03 M12.2): the run_in_background rewrite, CI polling loops, wrapped gh
// commands, modes, and fail-open, against PreToolUse events in the spike §3.6 shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fsRegistry } from '../../src/cli/registry.ts';
import { decideHook, type HookOutput, matchesPattern, REPLACES_TABLE } from '../../src/hook/rules.ts';
import { runInProcess, SRC_COMMANDS } from '../helpers/harness.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'hook');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const event = (name: string): Record<string, any> => JSON.parse(fixture(name));

async function hook(stdin: string, env: Record<string, string> = {}) {
  const r = await runInProcess(['hook', 'claude-pretooluse'], { stdin, env });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.calls, [], 'no gh or git calls');
  return { stdout: r.stdout, out: r.stdout === '' ? null : (JSON.parse(r.stdout) as HookOutput) };
}

const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command, ...extra },
});
const monitor = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Monitor',
  tool_input: { command, description: 'watch', timeout_ms: 60_000 },
});
const reason = (o: HookOutput | null): string => o?.hookSpecificOutput.permissionDecisionReason ?? '';

// --- the run_in_background rewrite ---

test('bash-ci-wait-foreground.json: updatedInput is the whole input plus run_in_background, with no decision', async () => {
  const ev = event('bash-ci-wait-foreground.json');
  const { out } = await hook(fixture('bash-ci-wait-foreground.json'));
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ev.tool_input, run_in_background: true } },
  });
  const updated = out?.hookSpecificOutput.updatedInput as Record<string, unknown>;
  assert.equal(updated.command, ev.tool_input.command);
  assert.equal(updated.description, ev.tool_input.description);
  assert.equal(updated.timeout, ev.tool_input.timeout);
  assert.ok(!('permissionDecision' in (out?.hookSpecificOutput ?? {})));
  assert.ok(!('permissionDecisionReason' in (out?.hookSpecificOutput ?? {})));
});

test('bash-ci-wait-background.json: already in the background, no output', async () => {
  assert.equal((await hook(fixture('bash-ci-wait-background.json'))).stdout, '');
});

test('the rewrite holds in deny mode and still carries no decision', async () => {
  const { out } = await hook(fixture('bash-ci-wait-foreground.json'), { GHX_HOOK_MODE: 'deny' });
  assert.equal(out?.hookSpecificOutput.updatedInput?.run_in_background, true);
  assert.equal(out?.hookSpecificOutput.permissionDecision, undefined);
});

test('leading whitespace and env prefixes are rewritten; anything before ghx is not', () => {
  for (const c of [
    '  ghx ci wait 1',
    'GHX_MAX_BYTES=9000 ghx ci wait 1',
    "A='x y' B=2 ghx ci wait 1 --until mergeable",
  ]) {
    assert.equal(decideHook(bash(c), 'ask')?.hookSpecificOutput.updatedInput?.run_in_background, true, c);
  }
  for (const c of ['cd x && ghx ci wait 1', 'ghx ci why 1', 'echo ghx ci wait 1', 'timeout 60 ghx ci wait 1']) {
    assert.equal(decideHook(bash(c), 'ask')?.hookSpecificOutput.updatedInput, undefined, c);
  }
  assert.equal(
    decideHook(bash('ghx ci wait 1', { run_in_background: false }), 'ask')?.hookSpecificOutput.updatedInput
      ?.run_in_background,
    true,
  );
});

test('GHX_HOOK_MODE=off: no output, not even the rewrite', async () => {
  for (const f of ['bash-ci-wait-foreground.json', 'monitor-gh-checks-loop.json', 'bash-gh-pr-view.json']) {
    assert.equal((await hook(fixture(f), { GHX_HOOK_MODE: 'off' })).stdout, '', f);
  }
});

// --- CI polling loops ---

test('monitor-gh-checks-loop.json: ask, naming ghx ci wait 3266 with run_in_background', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /`ghx ci wait 3266`/);
  assert.match(reason(out), /run_in_background: true/);
  assert.equal(out?.hookSpecificOutput.updatedInput, undefined);
});

test('monitor-run-watch.json: ask, naming ghx ci wait with run_in_background', async () => {
  const { out } = await hook(fixture('monitor-run-watch.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /ghx ci wait <pr>/);
  assert.match(reason(out), /run_in_background/);
});

test('bash-until-gh-run-list.json: ask; no PR in the command, so <pr>', async () => {
  const { out } = await hook(fixture('bash-until-gh-run-list.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /`ghx ci wait <pr>` with the Bash tool and run_in_background: true/);
});

test('deny mode denies with the same reason', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'), { GHX_HOOK_MODE: 'deny' });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /ghx ci wait 3266/);
});

test('an unrecognised GHX_HOOK_MODE behaves as ask', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'), { GHX_HOOK_MODE: 'loud' });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
});

test('loops and sleeps around gh CI reads, in Bash or Monitor, name ghx ci wait', () => {
  const cases: [string, RegExp][] = [
    ['for i in $(seq 1 20); do gh pr checks 12 -R o/r; sleep 60; done', /`ghx ci wait 12 -R o\/r`/],
    ['watch -n 30 gh pr checks 12', /`ghx ci wait 12`/],
    ["watch -n 30 'gh pr checks octo/demo#12'", /`ghx ci wait octo\/demo#12`/],
    ['sleep 300 && gh pr checks 12', /`ghx ci wait 12`/],
    ['sleep 120; gh run list --limit 3', /`ghx ci wait <pr>`/],
    ['while gh run view 99 --json status | grep -q in_progress; do sleep 15; done', /`ghx ci wait <pr>`/],
    ["bash -c 'while true; do gh api repos/o/r/commits/abc/check-runs; sleep 10; done'", /ghx ci wait <pr>/],
    ['while true; do ghx pr status 12; sleep 60; done', /`ghx ci wait 12`/],
    ['sleep 600; ghx ci wait 12', /`ghx ci wait 12`/],
  ];
  for (const [c, re] of cases) {
    for (const ev of [bash(c), monitor(c)]) {
      const out = decideHook(ev, 'ask');
      assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask', c);
      assert.match(reason(out), re, c);
      assert.match(reason(out), /run_in_background/, c);
    }
  }
});

test('Monitor running ghx ci wait is redirected to Bash with run_in_background', () => {
  const out = decideHook(monitor('ghx ci wait 12'), 'ask');
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /Bash tool and run_in_background: true/);
  assert.match(reason(out), /ghx ci wait 12/);
});

test('monitor-unrelated.json and a single gh run view in Monitor get no ci wait response', async () => {
  assert.equal((await hook(fixture('monitor-unrelated.json'))).stdout, '');
  const { out } = await hook(fixture('monitor-run-view-single.json'));
  assert.doesNotMatch(reason(out), /ghx ci wait/);
});

// --- wrapped gh commands ---

test('bash-gh-pr-view.json: ask, quoting the exact replacement', async () => {
  const { out } = await hook(fixture('bash-gh-pr-view.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /Use: ghx pr status 3266/);
});

/** The wrapped gh writes (hooks.md deny list) and gh api writes to a wrapped endpoint. */
const WRITE = /gh (pr (create|edit|ready|merge|comment|review|close)|run rerun|api -X PUT)\b/;

test('wrapped gh commands, including piped and chained ones, name their replacement', () => {
  const cases: [string, RegExp][] = [
    ["gh pr checks 3198 | awk '{print $2}'", /ghx ci wait 3198/],
    ['gh pr view 12 --comments', /ghx pr feedback 12/],
    ['gh run view 123 --log-failed | tail -50', /ghx ci why --run 123/],
    ['gh run view --log 123', /ghx ci why --run 123/],
    ['cd repo && gh pr merge 12 --merge', /ghx pr merge 12/],
    ['gh pr create --title x --body y', /ghx pr create --input pr\.json/],
    ['gh pr ready 12', /ghx pr edit 12 --input ready\.json/],
    ['gh run rerun 99 --failed', /ghx ci rerun/],
    ['X=$(gh pr view 12 --json headRefOid --jq .headRefOid)', /ghx pr status 12/],
    ['gh api repos/o/r/actions/jobs/123/logs', /ghx ci why/],
    ['gh api -X PUT repos/o/r/pulls/12/merge', /ghx pr merge/],
    ['gh pr close 12 && gh pr reopen 12', /ghx ci retrigger/],
  ];
  for (const [c, re] of cases) {
    const out = decideHook(bash(c), 'ask');
    // Wrapped writes are denied in every mode; reads follow the mode.
    assert.equal(out?.hookSpecificOutput.permissionDecision, WRITE.test(c) ? 'deny' : 'ask', c);
    assert.match(reason(out), re, c);
  }
});

test('allowlisted reads, a single gh run list and non-gh commands pass silently', () => {
  for (const c of [
    'gh pr diff 12',
    'gh pr list --author @me',
    'gh run list --limit 5',
    'gh api repos/o/r/pulls/12',
    'git push origin HEAD',
    'echo "gh pr view 12"',
    'ghx pr status 12',
    'ghx ci wait 12',
  ]) {
    assert.equal(decideHook(bash(c, { run_in_background: true }), 'ask'), null, c);
  }
});

test('every spec replaces entry matches its own example; bare allowlisted reads only in a loop', async () => {
  const specs = await fsRegistry([SRC_COMMANDS]).list();
  const fromSpecs = specs.flatMap((s) => (s.replaces ?? []).map((pattern) => ({ pattern, command: s.name.join(' ') })));
  assert.deepEqual(
    [...REPLACES_TABLE].sort((a, b) => a.pattern.localeCompare(b.pattern) || a.command.localeCompare(b.command)),
    fromSpecs.sort((a, b) => a.pattern.localeCompare(b.pattern) || a.command.localeCompare(b.command)),
    'replaces.generated.json is in sync (pnpm docs:gen)',
  );
  for (const { pattern } of REPLACES_TABLE) {
    const concrete = pattern.replace(/\{[^}]*\}|<[^>]*>/g, '7');
    if (!pattern.includes('&&')) assert.ok(matchesPattern(pattern, concrete.split(/\s+/)), pattern);
    const out = decideHook(bash(concrete), 'ask');
    if (pattern === 'gh run list') {
      assert.equal(out, null, 'a single gh run list is an allowlisted read');
      assert.ok(decideHook(bash(`while true; do ${concrete}; sleep 9; done`), 'ask'), 'gh run list in a loop');
      continue;
    }
    assert.equal(out?.hookSpecificOutput.permissionDecision, WRITE.test(concrete) ? 'deny' : 'ask', pattern);
    assert.match(reason(out), /ghx /, pattern);
  }
});

// --- fail open ---

test('fail open: bad JSON, empty stdin, unknown tool, missing tool_input or command exit 0 with no output', async () => {
  for (const stdin of [
    fixture('invalid-json-hook-event.json'),
    '',
    'null',
    '[]',
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }),
    JSON.stringify({ tool_name: 'Bash' }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } }),
    JSON.stringify({ tool_name: 'Monitor', tool_input: 'gh pr checks 1' }),
  ]) {
    assert.equal((await hook(stdin)).stdout, '', stdin);
  }
});

test('--help and --schema still describe the hook as JSON', async () => {
  const help = await runInProcess(['hook', 'claude-pretooluse', '--help']);
  assert.equal(help.json.name, 'hook claude-pretooluse');
  assert.match(help.json.description, /stdin/);
  const schema = await runInProcess(['hook', 'claude-pretooluse', '--schema']);
  assert.ok(schema.json.output.properties.hookSpecificOutput);
});

// --- wrapped writes are always denied ---

test('wrapped gh writes are denied in every mode, wherever -R/--repo sits', async () => {
  const writes: [string, RegExp][] = [
    ['gh -R o/r pr merge 1', /ghx pr merge 1 -R o\/r/],
    ['gh --repo=o/r pr create --title x', /ghx pr create --input pr\.json -R o\/r/],
    ['gh pr merge -R o/r 1', /ghx pr merge 1 -R o\/r/],
    ['gh --repo o/r pr comment 3 --body hi', /ghx pr comment 3/],
    ['cd repo && gh pr merge 12 --merge', /ghx pr merge 12/],
    ['gh run rerun 99 --failed', /ghx ci rerun/],
    ['gh api -X PUT repos/o/r/pulls/12/merge', /ghx pr merge/],
  ];
  for (const mode of ['ask', 'deny', 'off'] as const) {
    for (const [c, re] of writes) {
      for (const make of [bash, monitor]) {
        const out = decideHook(make(c), mode);
        assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny', `${mode}: ${c}`);
        assert.match(reason(out), re, `${mode}: ${c}`);
      }
    }
  }
  const { out } = await hook(JSON.stringify(bash('gh -R o/r pr merge 1')), { GHX_HOOK_MODE: 'off' });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
});

test('a foreground ghx ci wait chained with a raw write is denied, not rewritten', () => {
  const out = decideHook(bash('ghx ci wait 1 && gh pr merge 1'), 'ask');
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
});

test('wrapped reads and pr reopen follow GHX_HOOK_MODE, with a leading -R too', () => {
  for (const c of ['gh -R o/r pr view 1', 'gh pr reopen 1', 'gh -R o/r pr checks 1']) {
    assert.equal(decideHook(bash(c), 'ask')?.hookSpecificOutput.permissionDecision, 'ask', c);
    assert.equal(decideHook(bash(c), 'deny')?.hookSpecificOutput.permissionDecision, 'deny', c);
    assert.equal(decideHook(bash(c), 'off'), null, c);
  }
  assert.match(reason(decideHook(bash('gh -R o/r pr view 1'), 'ask')), /ghx pr status 1 -R o\/r/);
  const loop = decideHook(bash('while true; do gh -R o/r pr checks 7; sleep 30; done'), 'ask');
  assert.match(reason(loop), /ghx ci wait 7 -R o\/r/);
});
