// GHX_HOOK_LOG (07 M5): off by default, one NDJSON line per Bash or Monitor command with the reply's
// decision and rule, and a failed write never changes the reply.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { HookLogLine } from '../../../src/hook/log.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { runInProcess } from '../../helpers/harness.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'hook');
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'ghx-hook-log-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function checkout(name: string, configured: boolean): string {
  const root = join(tmp, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  if (configured) {
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, '.github', 'ghx.json'), '{}\n');
  }
  return root;
}
const CONFIGURED = checkout('configured', true);
const PLAIN = checkout('plain', false);

let seq = 0;
const logPath = (): string => join(tmp, `hook-${++seq}.ndjson`);
const readLog = (p: string): HookLogLine[] =>
  readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

async function hook(event: unknown, env: Record<string, string> = {}): Promise<string> {
  const stdin = typeof event === 'string' ? event : JSON.stringify(event);
  const r = await runInProcess(['hook', 'claude-pretooluse'], { stdin, env, clock: new FakeClock() });
  assert.equal(r.exitCode, 0);
  return r.stdout;
}

const at = (name: string, cwd: string, extra: Record<string, unknown> = {}) => ({ ...fixture(name), cwd, ...extra });

test('off by default: no GHX_HOOK_LOG, no file, same reply', async () => {
  const dir = join(tmp, 'off');
  mkdirSync(dir);
  const ev = at('bash-gh-pr-view.json', CONFIGURED);
  const plain = await hook(ev);
  assert.notEqual(plain, '');
  assert.equal(await hook(ev, { GHX_HOOK_LOG: join(dir, 'h.ndjson') }), plain);
  rmSync(join(dir, 'h.ndjson'));
  await hook(ev);
  assert.deepEqual(readdirSync(dir), []);
});

test('a nudged raw gh read: the documented line shape', async () => {
  const p = logPath();
  const ev = at('bash-gh-pr-view.json', CONFIGURED, { agent_id: 'a1', agent_type: 'general-purpose' });
  const out = await hook(ev, { GHX_HOOK_LOG: p });
  const [line, ...rest] = readLog(p);
  assert.deepEqual(rest, []);
  assert.deepEqual(line, {
    v: 1,
    ts: '2026-10-22T12:00:00.000Z',
    session_id: '00000000-0000-4000-8000-000000000001',
    tool_use_id: 'toolu_synthetic_08',
    cwd: CONFIGURED,
    tool: 'Bash',
    command: 'gh pr view 3266 --json state,mergeable,statusCheckRollup',
    run_in_background: false,
    enforce: true,
    mode: 'deny',
    decision: 'deny',
    rule: 'replaces',
    transcript_path: '/tmp/ghx-synthetic/session.jsonl',
    agent_id: 'a1',
    agent_type: 'general-purpose',
    permission_mode: 'default',
    reason: JSON.parse(out).hookSpecificOutput.permissionDecisionReason,
  });
});

test('decision and rule for each branch; lines append in order', async () => {
  const p = logPath();
  const env = { GHX_HOOK_LOG: p };
  await hook(at('bash-ci-wait-foreground.json', CONFIGURED), env);
  await hook(at('bash-ci-wait-background.json', CONFIGURED), env);
  await hook(at('bash-until-gh-run-list.json', CONFIGURED), env);
  await hook(at('monitor-run-watch.json', CONFIGURED), env);
  await hook(at('monitor-unrelated.json', CONFIGURED), env);
  await hook({ ...at('bash-gh-pr-view.json', CONFIGURED), tool_input: { command: 'gh pr merge 12' } }, env);
  await hook(at('bash-gh-pr-view.json', PLAIN), env);
  await hook(at('bash-gh-pr-view.json', CONFIGURED), { ...env, GHX_HOOK_MODE: 'ask' });
  const got = readLog(p).map((l) => [l.tool, l.decision, l.rule, l.enforce, l.mode, l.run_in_background]);
  assert.deepEqual(got, [
    ['Bash', 'rewrite', 'ci-wait-background', true, 'deny', false],
    ['Bash', 'allow', null, true, 'deny', true],
    ['Bash', 'deny', 'poll-loop', true, 'deny', false],
    ['Monitor', 'deny', 'replaces', true, 'deny', false],
    ['Monitor', 'allow', null, true, 'deny', false],
    ['Bash', 'deny', 'wrapped-write', true, 'deny', false],
    ['Bash', 'allow', null, false, 'deny', false],
    ['Bash', 'ask', 'replaces', true, 'ask', false],
  ]);
  assert.equal(readLog(p)[0]?.reason, undefined, 'a rewrite has no reason');
});

test('events without a Bash or Monitor command are not logged', async () => {
  const p = logPath();
  const env = { GHX_HOOK_LOG: p };
  await hook('not json', env);
  await hook(readFileSync(join(FIX, 'invalid-json-hook-event.json'), 'utf8'), env);
  await hook({ ...at('bash-gh-pr-view.json', CONFIGURED), tool_name: 'Read' }, env);
  await hook({ ...at('bash-gh-pr-view.json', CONFIGURED), tool_input: { command: 3 } }, env);
  assert.equal(existsSync(p), false);
});

test('a failed write changes neither the reply nor the exit code', async () => {
  const ev = at('bash-gh-pr-view.json', CONFIGURED);
  const plain = await hook(ev);
  for (const bad of [join(tmp, 'missing', 'dir', 'h.ndjson'), tmp]) {
    assert.equal(await hook(ev, { GHX_HOOK_LOG: bad }), plain);
  }
  assert.equal(await hook(at('monitor-unrelated.json', CONFIGURED), { GHX_HOOK_LOG: tmp }), '');
});
