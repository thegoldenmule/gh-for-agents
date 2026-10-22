import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { buildGraphqlArgs } from '../../../src/gh/graphql.ts';
import { isMutating } from '../../../src/gh/guard.ts';
import { createGh, DryRunHalt, GhFailure } from '../../../src/gh/index.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const ok = (body: unknown, extraHeaders = '') =>
  `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 4999\nX-Ratelimit-Reset: 1792670400\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Resource: graphql${extraHeaders}\n\n${JSON.stringify(body)}`;

function setup(mode: 'read' | 'write' = 'read', dryRun = false) {
  const clock = new FakeClock(0);
  const fake = new FakeProc({ clock });
  const gh = createGh({
    proc: fake.runner(),
    clock,
    signal: new AbortController().signal,
    mode,
    dryRun,
    random: seededRandom(5),
  });
  return { clock, fake, gh };
}

const PR = z.object({ repository: z.object({ pullRequest: z.object({ number: z.number() }).nullable() }) });

test('read queries send the query and scalar vars as fields and stay reads', () => {
  const { args, stdin, mutation } = buildGraphqlArgs('query($n:Int!,$o:String!){ x }', {
    n: 3,
    o: 'cli',
    skip: undefined,
  });
  assert.deepEqual(args, [
    'api',
    'graphql',
    '--include',
    '-f',
    'query=query($n:Int!,$o:String!){ x }',
    '-F',
    'n=3',
    '-f',
    'o=cli',
  ]);
  assert.equal(stdin, undefined);
  assert.equal(mutation, false);
  assert.equal(isMutating(args), false);
});

test('mutations send a JSON body and are mutating', () => {
  const { args, stdin, mutation } = buildGraphqlArgs(
    'mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ clientMutationId } }',
    { id: 'T_1' },
  );
  assert.ok(mutation);
  assert.deepEqual(args, ['api', 'graphql', '--include', '--input', '-']);
  assert.deepEqual(JSON.parse(stdin ?? ''), {
    query: 'mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ clientMutationId } }',
    variables: { id: 'T_1' },
  });
  assert.ok(isMutating(args));
});

test('graphql(): validates data and feeds the graphql budget (duplicate headers tolerated)', async () => {
  const { fake, gh } = setup();
  fake.on({ cmd: 'gh' }, { stdout: ok({ data: { repository: { pullRequest: { number: 1 } } } }) });
  const data = await gh.graphql('{ repository(owner:"o",name:"r"){ pullRequest(number:1){ number } } }', {}, PR);
  assert.equal(data.repository.pullRequest?.number, 1);
  assert.equal(gh.rateBudget('graphql')?.remaining, 4999);
});

test('stdout is parsed before the exit code: partial NOT_FOUND keeps data (03 §3.4)', async () => {
  const { fake, gh } = setup();
  const body = {
    data: { repository: { pullRequest: null } },
    errors: [
      {
        type: 'NOT_FOUND',
        path: ['repository', 'pullRequest'],
        message: 'Could not resolve to a PullRequest with the number of 99999999.',
      },
    ],
  };
  fake.on(
    { cmd: 'gh' },
    {
      exitCode: 1,
      stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99999999. (repository.pullRequest)',
      stdout: ok(body),
    },
  );
  const r = await gh.graphqlPartial('{ x }', {}, PR);
  assert.equal(r.data.repository.pullRequest, null);
  assert.equal(r.errors[0]?.type, 'NOT_FOUND');
  await assert.rejects(gh.graphql('{ x }', {}, PR, { notFound: 'PR_NOT_FOUND' }), (e) => {
    assert.ok(e instanceof GhFailure);
    assert.equal(e.code, 'PR_NOT_FOUND');
    assert.equal(e.exitCode, 5);
    return true;
  });
});

test('transient GraphQL errors are retried', async () => {
  const { clock, fake, gh } = setup();
  fake.on({ cmd: 'gh' }, [
    {
      exitCode: 1,
      stderr: 'GraphQL: Something went wrong while executing your query. This may be the result of a timeout.',
      stdout: ok({ errors: [{ message: 'Something went wrong while executing your query.' }] }),
    },
    { stdout: ok({ data: { repository: { pullRequest: { number: 2 } } } }) },
  ]);
  const p = gh.graphql('{ x }', {}, PR);
  await clock.advance(10_000);
  assert.equal((await p).repository.pullRequest?.number, 2);
  assert.equal(fake.calls.length, 2);
});

test('a read client refuses a mutation; a dry-run write client halts on it', async () => {
  const read = setup('read');
  await assert.rejects(read.gh.graphql('mutation { x }', {}, z.unknown()), (e) =>
    isGhxError(e, 'INTERNAL_READ_MUTATION'),
  );
  const dry = setup('write', true);
  await assert.rejects(
    dry.gh.graphql('mutation { x }', { a: 1 }, z.unknown()),
    (e) => e instanceof DryRunHalt && e.stdin !== undefined,
  );
  assert.equal(read.fake.calls.length + dry.fake.calls.length, 0);
});

test('intent mismatch on graphql is INTERNAL', async () => {
  const { gh } = setup('write');
  await assert.rejects(gh.graphql('{ x }', {}, z.unknown(), { mutates: true }), (e) => isGhxError(e, 'INTERNAL'));
});
