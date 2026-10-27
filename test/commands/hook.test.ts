// ghx hook claude-pretooluse (03 M12.2): the run_in_background rewrite, CI polling loops, wrapped gh
// commands, modes, and fail-open, against PreToolUse events in the spike §3.6 shape.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fsRegistry } from '../../src/cli/registry.ts';
import { decideHook, type HookOutput, matchesPattern, REPLACES_TABLE } from '../../src/hook/rules.ts';
import { runInProcess, SRC_COMMANDS } from '../helpers/harness.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'hook');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const event = (name: string): Record<string, any> => JSON.parse(fixture(name));

const tmp = mkdtempSync(join(tmpdir(), 'ghx-hook-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A checkout under tmp: `.git` as a dir (or a worktree's file), optionally with .github/ghx.json. */
function checkout(name: string, o: { configured: boolean; gitFile?: boolean }): string {
  const root = join(tmp, name);
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  if (o.gitFile) writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  else mkdirSync(join(root, '.git'));
  if (o.configured) {
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github', 'ghx.json'), '{}\n');
  }
  return root;
}

/** The repo the fixture events run in: configured, so the hook enforces. */
const CONFIGURED = checkout('configured', { configured: true });

/** Run the hook binary in process. A JSON-object event gets `cwd` set to CONFIGURED unless it names one. */
async function hook(stdin: string, env: Record<string, string> = {}, cwd: string = CONFIGURED) {
  try {
    const ev = JSON.parse(stdin);
    if (ev && typeof ev === 'object' && !Array.isArray(ev)) stdin = JSON.stringify({ ...ev, cwd });
  } catch {
    // not JSON: sent as is
  }
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

test('monitor-gh-checks-loop.json: deny, naming ghx ci wait 3266 with run_in_background', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /`ghx ci wait 3266`/);
  assert.match(reason(out), /run_in_background: true/);
  assert.equal(out?.hookSpecificOutput.updatedInput, undefined);
});

test('monitor-run-watch.json: deny, naming ghx ci wait run:<id> with run_in_background', async () => {
  const { out } = await hook(fixture('monitor-run-watch.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /ghx ci wait run:18234567890/);
  assert.match(reason(out), /run_in_background/);
});

test('bash-until-gh-run-list.json: deny; no PR in the command, so <pr>', async () => {
  const { out } = await hook(fixture('bash-until-gh-run-list.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /`ghx ci wait <pr>` with the Bash tool and run_in_background: true/);
});

test('ask mode asks with the same reason', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'), { GHX_HOOK_MODE: 'ask' });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(reason(out), /ghx ci wait 3266/);
});

test('an unrecognised GHX_HOOK_MODE behaves as deny, the default', async () => {
  const { out } = await hook(fixture('monitor-gh-checks-loop.json'), { GHX_HOOK_MODE: 'loud' });
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
});

test('loops and sleeps around gh CI reads, in Bash or Monitor, name ghx ci wait', () => {
  const cases: [string, RegExp][] = [
    ['for i in $(seq 1 20); do gh pr checks 12 -R o/r; sleep 60; done', /`ghx ci wait 12 -R o\/r`/],
    ['watch -n 30 gh pr checks 12', /`ghx ci wait 12`/],
    ["watch -n 30 'gh pr checks octo/demo#12'", /`ghx ci wait octo\/demo#12`/],
    ['sleep 300 && gh pr checks 12', /`ghx ci wait 12`/],
    ['sleep 120; gh run list --limit 3', /`ghx ci wait <pr>`/],
    ['while gh run view 99 --json status | grep -q in_progress; do sleep 15; done', /`ghx ci wait run:99`/],
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

test('a for over a fixed list of PRs is not polling; one with a sleep is', () => {
  for (const c of [
    'for n in 3296 3297; do ghx pr status $n > /tmp/status-$n.json; done',
    'for pr in 12 13; do gh pr checks $pr; done',
  ]) {
    const out = decideHook(bash(c), 'deny');
    assert.doesNotMatch(out ? reason(out) : '', /Don't poll CI/, c);
  }
  assert.match(
    reason(decideHook(bash('for i in 1 2 3; do ghx pr status 12; sleep 60; done'), 'deny')),
    /ghx ci wait 12/,
  );
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

test('bash-gh-pr-view.json: deny, quoting the exact replacement', async () => {
  const { out } = await hook(fixture('bash-gh-pr-view.json'));
  assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /Use: ghx pr status 3266/);
});

/** The wrapped gh writes (hooks.md deny list) and gh api writes to a wrapped endpoint. */
const WRITE = /gh (pr (create|edit|ready|merge|comment|review|close)|run rerun|api -X PUT)\b/;

test('wrapped gh commands, including piped and chained ones, name their replacement', () => {
  const cases: [string, RegExp][] = [
    ["gh pr checks 3198 | awk '{print $2}'", /ghx ci wait 3198/],
    ['gh pr view 12 --comments', /ghx pr feedback 12/],
    ['gh run view 123 --log-failed | tail -50', /ghx ci why run:123/],
    ['gh run view --log 123', /ghx ci why run:123/],
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

// --- enforcement only in repos with .github/ghx.json (04 "enforcement scope") ---

const raw = async (ev: Record<string, unknown>, env: Record<string, string> = {}) => {
  const r = await runInProcess(['hook', 'claude-pretooluse'], { stdin: JSON.stringify(ev), env });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.calls, [], 'no gh or git calls');
  return r.stdout === '' ? null : (JSON.parse(r.stdout) as HookOutput);
};
const at = (cwd: string | undefined, command: string, extra: Record<string, unknown> = {}) => ({
  ...bash(command, extra),
  ...(cwd === undefined ? {} : { cwd }),
});

test('a configured repo enforces: wrapped writes denied, reads suggested', async () => {
  assert.equal((await raw(at(CONFIGURED, 'gh pr merge 12')))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await raw(at(CONFIGURED, 'gh pr view 12')))?.hookSpecificOutput.permissionDecision, 'deny');
});

test('an unconfigured repo is silent for gh reads and writes, in every mode', async () => {
  const plain = checkout('plain', { configured: false });
  for (const mode of ['ask', 'deny', 'off']) {
    for (const c of [
      'gh pr merge 12',
      'gh -R o/r pr merge 1',
      'gh pr view 12',
      'while true; do gh pr checks 1; sleep 9; done',
    ]) {
      assert.equal(await raw(at(plain, c), { GHX_HOOK_MODE: mode }), null, `${mode}: ${c}`);
    }
  }
});

test('a worktree (.git file) and a subdirectory cwd find the configured root', async () => {
  const wt = checkout('worktree', { configured: true, gitFile: true });
  assert.equal((await raw(at(wt, 'gh pr merge 1')))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    (await raw(at(join(wt, 'src', 'deep'), 'gh pr merge 1')))?.hookSpecificOutput.permissionDecision,
    'deny',
  );
  assert.equal(
    (await raw(at(join(CONFIGURED, 'src', 'deep'), 'gh pr view 1')))?.hookSpecificOutput.permissionDecision,
    'deny',
  );
  // The nearest .git wins: an unconfigured checkout nested in a configured one is silent.
  const nested = join(CONFIGURED, 'src', 'vendored');
  mkdirSync(join(nested, '.git'), { recursive: true });
  assert.equal(await raw(at(nested, 'gh pr merge 1')), null);
});

test('missing cwd, a cwd that does not exist, or no checkout above it: fail open, silent for gh', async () => {
  for (const cwd of [undefined, '', join(tmp, 'nope', 'gone'), tmpdir()]) {
    assert.equal(await raw(at(cwd, 'gh pr merge 12')), null, String(cwd));
    assert.equal(await raw(at(cwd, 'gh pr view 12')), null, String(cwd));
  }
  assert.equal(await raw({ ...bash('gh pr merge 1'), cwd: 42 }), null);
});

test('the ghx ci wait rewrite applies everywhere (but not under GHX_HOOK_MODE=off)', async () => {
  const plain = checkout('plain-rewrite', { configured: false });
  for (const cwd of [undefined, plain, CONFIGURED]) {
    const out = await raw(at(cwd, 'ghx ci wait 12', { description: 'Wait' }));
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'ghx ci wait 12', description: 'Wait', run_in_background: true },
      },
    });
  }
  assert.equal(await raw(at(plain, 'ghx ci wait 12'), { GHX_HOOK_MODE: 'off' }), null);
  assert.equal(await raw(at(plain, 'ghx ci wait 12', { run_in_background: true })), null);
  assert.equal(decideHook(monitor('ghx ci wait 12'), 'ask', false), null, 'Monitor nudges are enforcement too');
});

test('the repo walk is fast: 200 events from a deep cwd well under 100 ms each', async () => {
  const deep = join(CONFIGURED, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
  mkdirSync(deep, { recursive: true });
  const { ghxConfigured } = await import('../../src/hook/repo.ts');
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) assert.equal(ghxConfigured(deep), true);
  assert.ok((performance.now() - t0) / 200 < 10, 'under 10 ms per walk');
});
