// ghx ci why end to end (03 M3.1): the real bin against the fake gh on PATH. The red scenario is also
// the registry smoke scenario (test/fixtures/gh/smoke/ci-why, the worked example's #3301).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import whySpec from '../../src/commands/ci/why.ts';
import { Warning } from '../../src/core/command.ts';
import { scratchDir } from '../helpers/harness.ts';
import { spawnGhx } from '../helpers/spawn.ts';
import { EXIT } from './exit-table.ts';

const Output = whySpec.output.extend({ warnings: Warning.array().optional() }).strict();

function run(scenario: string, args: string[]) {
  const dir = mkdtempSync(join(scratchDir(), 'why-contract-'));
  const log = join(dir, 'calls.ndjson');
  return spawnGhx(['ci', 'why', ...args], {
    fakeGh: true,
    env: {
      GHX_FAKE_SCENARIO: scenario,
      GHX_FAKE_LOG: log,
      GHX_FAKE_STATE: join(dir, 'state'),
      GHX_ARTIFACT_DIR: join(dir, 'artifacts'),
    },
  }).then((r) => ({
    ...r,
    calls: existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [],
  }));
}

test('red (smoke/ci-why): stdout parses with the output schema, logPath exists, exit 0, no run view', async () => {
  const r = await run('smoke/ci-why', ['3301', '-R', 'powerhouse-inc/powerhouse']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  const out = Output.parse(JSON.parse(r.stdout));
  assert.equal(out.ref, 'powerhouse-inc/powerhouse#3301');
  assert.equal(out.failing.length, 1);
  const f = out.failing[0];
  assert.ok(f?.logPath && existsSync(f.logPath), `logPath ${f?.logPath} exists`);
  assert.deepEqual(f?.tests, ['packages/reactor/test/reactor-api.test.ts > should converge after reshuffle']);
  assert.equal(f?.sameOnMain.verdict, 'same-tests');
  assert.deepEqual(out.warnings ?? [], [], 'every stage completed');
  assert.equal(f?.step?.name, 'Run tests');
  assert.ok(r.calls.length > 0, 'the fake gh logged its calls');
  assert.ok(!r.calls.some((c: { argv: string[] }) => c.argv[0] === 'run'), 'gh run … is never called');
});

test('green (ci-why/green): exit 0 with failing: []', async () => {
  const r = await run('ci-why/green', ['3302', '-R', 'powerhouse-inc/powerhouse']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  const out = Output.parse(JSON.parse(r.stdout));
  assert.equal(out.ci.state, 'green');
  assert.deepEqual(out.failing, []);
});

test('a workflow GitHub rejected (ci-why/workflow-invalid, recorded run 40518894617): red, named, with the fix', async () => {
  const r = await run('ci-why/workflow-invalid', ['run:40518894617', '-R', 'thegoldenmule/gh-for-agents']);
  assert.equal(r.exitCode, EXIT.OK, r.stdout + r.stderr);
  const out = Output.parse(JSON.parse(r.stdout));
  const url = 'https://github.com/thegoldenmule/gh-for-agents/actions/runs/40518894617';
  assert.equal(out.ci.state, 'red');
  assert.deepEqual(
    out.ci.failing.map((c) => [c.name, c.runId, c.jobId, c.conclusion, c.url]),
    [['.github/workflows/ci.yml', 40518894617, null, 'failure', url]],
  );
  assert.deepEqual(out.failing, [], 'no job, so no job log to diagnose');
  assert.deepEqual(
    out.nonActionsFailing.map((c) => c.name),
    ['.github/workflows/ci.yml'],
  );
  assert.deepEqual(out.next, [
    `Fix .github/workflows/ci.yml: GitHub rejected it before any job ran. Read the error on ${url}, then commit and push.`,
  ]);
  assert.deepEqual(
    out.warnings?.map((w) => w.code),
    ['WORKFLOW_INVALID'],
  );
});
