// ghx pr create exit codes through the real bin and the fake gh on PATH (03 §4.3, 02 §2.5). Writes
// never reach GitHub: every gh call replays a synthetic fixture, and a mutating call without one exits 99.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { INPUT } from '../commands/pr-create-scene.ts';
import { scratchDir } from '../helpers/harness.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const ARGV = ['pr', 'create', '-R', 'octo/demo', '--input', '-'];
let seq = 0;
const env = (scenario: string) => {
  const log = join(scratchDir(), `pr-create-contract-${process.pid}-${++seq}.ndjson`);
  return { log, env: { GHX_FAKE_SCENARIO: scenario, GHX_FAKE_LOG: log, GHX_FAKE_STATE: `${log}.state` } };
};
const loggedArgv = (log: string): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).argv as string[]);

const ROWS: { name: string; exit: number; code: string | null; scenario: string; argv?: string[]; input?: unknown }[] =
  [
    { name: 'dry run', exit: EXIT.OK, code: null, scenario: 'smoke/pr-create', argv: [...ARGV, '--dry-run'] },
    {
      name: 'missing --input',
      exit: EXIT.USAGE,
      code: 'USAGE_INPUT_MISSING',
      scenario: 'smoke/pr-create',
      argv: ['pr', 'create', '-R', 'octo/demo'],
    },
    {
      name: 'invalid input',
      exit: EXIT.USAGE,
      code: 'VALIDATION',
      scenario: 'smoke/pr-create',
      input: { ...INPUT, title: 'Add a banner.' },
    },
    { name: 'no config', exit: EXIT.CONFIG, code: 'CONFIG_MISSING', scenario: 'pr-create-config-missing' },
    { name: '422 already exists', exit: EXIT.POLICY, code: 'DUPLICATE_PR', scenario: 'pr-create-duplicate-422' },
    {
      name: 'title drift on read-back',
      exit: EXIT.GH_FAILED,
      code: 'READBACK_MISMATCH',
      scenario: 'pr-create-readback-mismatch',
    },
  ];

for (const row of ROWS) {
  test(`pr create exit ${row.exit}${row.code ? ` (${row.code})` : ''}: ${row.name}`, async () => {
    const { env: e } = env(row.scenario);
    const r = await spawnGhx(row.argv ?? ARGV, { fakeGh: true, env: e, stdin: JSON.stringify(row.input ?? INPUT) });
    assert.equal(r.exitCode, row.exit, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout);
    if (row.code) {
      assert.equal(doc.error.code, row.code);
      assert.deepEqual(Object.keys(doc.error), ['code', 'message', 'hint', 'details']);
    } else {
      assert.equal(doc.dryRun, true);
    }
  });
}

test('pr create: the POST goes through gh api --input -, never gh pr create', async () => {
  const { log, env: e } = env('pr-create-duplicate-422');
  const r = await spawnGhx(ARGV, { fakeGh: true, env: e, stdin: JSON.stringify(INPUT) });
  assert.equal(r.exitCode, EXIT.POLICY, r.stdout);
  const calls = loggedArgv(log);
  assert.ok(!calls.some((a) => a[0] === 'pr'), 'gh pr create is never used');
  const post = calls.find((a) => a.includes('POST'));
  assert.ok(post?.includes('--input') && post.includes('-'));
});
