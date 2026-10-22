// Exit codes through the real bin, table-driven from exit-table.ts. The bootstrap covers the rows
// producible before any pr/ci command exists; later milestones add rows 5–7 and 9–15 here or in
// their own contract files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readyPath, spawnGhx, waitForFile } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const HOOKS = { GHX_TEST_HOOKS: '1' };

const ROWS: { exit: number; code: string | null; argv: string[]; env?: Record<string, string> }[] = [
  { exit: EXIT.OK, code: null, argv: ['version'] },
  { exit: EXIT.INTERNAL, code: 'INTERNAL_OUTPUT_CONTRACT', argv: ['test', 'contract-bug'], env: HOOKS },
  { exit: EXIT.USAGE, code: 'USAGE_UNKNOWN_COMMAND', argv: ['pr', 'frobnicate'] },
  { exit: EXIT.USAGE, code: 'USAGE_UNKNOWN_FLAG', argv: ['version', '--json'] },
  {
    exit: EXIT.ENV,
    code: 'ENV_GH_MISSING',
    argv: ['test', 'needs-input', '--input', '-'],
    env: { ...HOOKS, GHX_GH_PATH: '/nonexistent/gh' },
  },
  { exit: EXIT.TIMEOUT, code: 'TIMEOUT', argv: ['test', 'sleep', '--timeout', '1s'], env: HOOKS },
];

for (const row of ROWS) {
  test(`exit ${row.exit}${row.code ? ` (${row.code})` : ''}: ghx ${row.argv.join(' ')}`, async () => {
    const r = await spawnGhx(row.argv, { ...(row.env ? { env: row.env } : {}), stdin: '{"title":"t"}' });
    assert.equal(r.exitCode, row.exit, r.stdout);
    const doc = JSON.parse(r.stdout);
    if (row.code) {
      assert.equal(doc.error.code, row.code);
      assert.deepEqual(Object.keys(doc.error), ['code', 'message', 'hint', 'details']);
    }
  });
}

test('exit 3 (CONFIG): see doctor.contract.test.ts; exit 130 and 143 (signals)', async () => {
  for (const [signal, exit] of [
    ['SIGINT', EXIT.SIGINT],
    ['SIGTERM', EXIT.SIGTERM],
  ] as const) {
    let child: import('node:child_process').ChildProcess | undefined;
    const ready = readyPath();
    const p = spawnGhx(['test', 'sleep', '--ready-file', ready], { env: HOOKS, onSpawn: (c) => (child = c) });
    await waitForFile(ready);
    child?.kill(signal);
    const r = await p;
    assert.equal(r.exitCode, exit);
    assert.equal(JSON.parse(r.stdout).error.code, 'INTERRUPTED');
  }
});
