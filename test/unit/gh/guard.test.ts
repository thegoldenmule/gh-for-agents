import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiShape, isGraphqlMutation, isMutating, isReadAllowed } from '../../../src/gh/guard.ts';

const READS: string[][] = [
  ['pr', 'view', '1', '--json', 'title'],
  ['pr', 'checks', '1'],
  ['pr', 'diff', '1'],
  ['pr', 'list'],
  ['run', 'view', '123'],
  ['run', 'list'],
  ['run', 'download', '1', '-D', 'x'],
  ['api', 'repos/o/r/pulls/1'],
  ['api', '-i', 'repos/o/r/pulls/1'],
  ['api', '--include', '-H', 'If-None-Match: W/"abc"', 'repos/o/r/commits/sha/check-runs'],
  ['api', '-X', 'GET', 'repos/o/r'],
  ['api', '--method=GET', 'repos/o/r'],
  ['api', 'graphql', '-f', 'query={ viewer { login } }'],
  ['api', 'graphql', '-f', 'query=query Q { viewer { login } }', '-F', 'n=1'],
  ['auth', 'status'],
  ['repo', 'view'],
  ['--version'],
  ['pr', 'checks', '--help'],
  ['issue', 'view', '1'],
  ['search', 'prs', 'x'],
  ['release', 'list'],
  ['workflow', 'view', 'ci.yml'],
  ['label', 'list'],
];

const WRITES: string[][] = [
  ['pr', 'merge', '1'],
  ['pr', 'create'],
  ['pr', 'edit', '1'],
  ['pr', 'comment', '1'],
  ['pr', 'close', '1'],
  ['run', 'rerun', '1'],
  ['api', '-X', 'POST', 'repos/o/r/pulls'],
  ['api', '--method', 'PUT', 'repos/o/r/pulls/1/merge'],
  ['api', 'repos/o/r/issues/1/comments', '-f', 'body=x'],
  ['api', 'repos/o/r/issues/1/comments', '-F', 'n=1'],
  ['api', 'repos/o/r/pulls', '--input', '-'],
  ['api', 'graphql', '-f', 'query=mutation { resolveReviewThread(input:{}) { clientMutationId } }'],
  ['api', 'graphql', '-f', 'query=# c\n  mutation M { x }'],
  ['issue', 'create'],
  ['frobnicate'],
  [],
];

for (const a of READS) test(`read: gh ${a.join(' ')}`, () => assert.ok(isReadAllowed(a) && !isMutating(a)));
for (const a of WRITES) test(`mutating: gh ${a.join(' ')}`, () => assert.ok(isMutating(a)));

test('apiShape finds endpoint, method, fields and headers', () => {
  const s = apiShape(['api', '-H', 'Accept: x', '-X', 'patch', 'repos/o/r/pulls/1', '-f', 'title=t']);
  assert.equal(s.endpoint, 'repos/o/r/pulls/1');
  assert.equal(s.method, 'PATCH');
  assert.deepEqual(s.fields, { title: 't' });
  assert.deepEqual(s.headers, ['Accept: x']);
  assert.equal(apiShape(['api', 'x', '-f', 'a=b']).method, 'POST');
});

test('isGraphqlMutation', () => {
  assert.ok(isGraphqlMutation('mutation { a }'));
  assert.ok(!isGraphqlMutation('{ a }'));
  assert.ok(!isGraphqlMutation('query { mutationCount }'));
});
