// The gh layer against bytes recorded from GitHub (03 §3, M1.6/M1.7 fixtures): logs-api, graphql,
// rest-checks. These pin the parser to real responses, not only to synthetic strings.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import { PARTIAL_QUERY, RATE_QUERY } from '../../../scripts/fixtures/scenarios/spike-graphql.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { createGh, GhFailure } from '../../../src/gh/index.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeGh } from '../../helpers/fake-gh.ts';
import { GH_FIXTURE_ROOT } from '../../helpers/fixture-match.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-recorded-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function client(scenario: string) {
  const fake = FakeGh.fromScenario(scenario);
  const gh = createGh({
    proc: fake.runner(),
    clock: new FakeClock(),
    signal: new AbortController().signal,
    mode: 'read',
    random: seededRandom(1),
  });
  return { fake, gh };
}
const pathOf = (scenario: string, file: string): string =>
  (JSON.parse(readFileSync(join(GH_FIXTURE_ROOT, scenario, `${file}.json`), 'utf8')) as { argv: string[] }).argv.at(
    -1,
  ) as string;

test('logs-api ok-200-azure: the body streams to the file with headers split off and the BOM stripped', async () => {
  const { fake, gh } = client('logs-api');
  const file = join(tmp, 'job.log');
  const r = await gh.apiText({ path: 'repos/cli/cli/actions/jobs/119137909038/logs', toFile: file });
  assert.equal(r.status, 200);
  assert.match(r.headers.server ?? '', /Windows-Azure-Blob/);
  const body = readFileSync(file, 'utf8');
  assert.notEqual(body.charCodeAt(0), 0xfeff);
  assert.match(body, /##\[error\]Process completed with exit code 1\./);
  assert.equal(gh.rateBudget('core'), undefined, 'blob responses carry no rate headers');
  fake.expectNoMutations();
});

test('logs-api gone-410: logs-gone, never transient, one call', async () => {
  const { fake, gh } = client('logs-api');
  await assert.rejects(
    gh.apiText({ path: 'repos/cli/cli/actions/jobs/73871539329/logs', toFile: join(tmp, 'gone.log') }),
    (e) => {
      assert.ok(e instanceof GhFailure);
      assert.equal(e.failure.code, 'GH_LOGS_GONE');
      assert.equal(e.failure.transient, false);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1);
});

test('logs-api blob-404-in-progress: logs-not-ready', async () => {
  const { gh } = client('logs-api');
  await assert.rejects(
    gh.apiText({
      path: pathOf('logs-api', 'blob-404-in-progress').replace(/^repos\//, 'repos/'),
      toFile: join(tmp, 'running.log'),
    }),
    (e) => {
      assert.ok(e instanceof GhFailure);
      assert.equal(e.failure.code, 'GH_LOGS_NOT_READY');
      return true;
    },
  );
});

test('graphql partial-not-found: data kept beside errors, budget read from duplicate headers', async () => {
  const { gh } = client('graphql');
  const S = z.object({
    repository: z.object({ pullRequest: z.object({ number: z.number() }).nullable() }),
    rateLimit: z.object({ remaining: z.number(), cost: z.number() }),
  });
  const r = await gh.graphqlPartial(PARTIAL_QUERY, {}, S);
  assert.equal(r.data.repository.pullRequest, null);
  assert.equal(r.errors[0]?.type, 'NOT_FOUND');
  assert.ok(gh.rateBudget('graphql'));
  const rate = await gh.graphql(RATE_QUERY, {}, z.object({ rateLimit: z.object({ remaining: z.number() }) }));
  assert.ok(rate.rateLimit.remaining >= 0);
});

for (const name of ['pulls', 'check-runs', 'status']) {
  test(`rest-checks ${name}: 200 with an ETag, then the conditional GET is a free 304`, async () => {
    const { fake, gh } = client('rest-checks');
    const path = pathOf('rest-checks', `${name}-200`);
    const first = await gh.api({ path }, z.unknown());
    assert.equal(first.notModified, false);
    assert.ok(first.etag, 'the 200 carries an ETag');
    assert.equal(gh.rateBudget('core')?.resource, 'core');
    const second = await gh.api({ path, headers: { 'If-None-Match': first.etag as string } }, z.unknown());
    assert.equal(second.notModified, true);
    assert.equal(second.status, 304);
    assert.equal(fake.calls.length, 2);
    fake.expectNoMutations();
  });
}
