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
  // Attached and --flag=value forms of read flags.
  ['api', '-XGET', 'repos/o/r'],
  ['api', '-X=GET', 'repos/o/r'],
  ['api', '-iXGET', 'repos/o/r'],
  ['api', '-HAccept: x', 'repos/o/r'],
  ['api', '--header=Accept: x', '--jq=.title', 'repos/o/r'],
  ['api', '--paginate', '--slurp', 'repos/o/r/pulls'],
  ['api', '--hostname', 'github.com', 'repos/o/r'],
  ['api', 'graphql', '-fquery={ viewer { login } }'],
  ['api', 'graphql', '--raw-field=query={ viewer { login } }'],
  ['api', 'graphql', '-F', 'query={ viewer { login } }', '-F', 'n=1'],
  ['api', 'graphql', '-f', 'query=query { search(query: "mutation testing", type: ISSUE, first: 1) { issueCount } }'],
  ['api', 'graphql', '-f', 'query=query($mutation: String) { viewer { login } }'],
  ['api', 'graphql', '-f', 'query={ a } # mutation in a comment'],
  // Doctor's feature probe stays allowed through the pr allowlist.
  ['pr', 'checks', '--help'],
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
  // Attached short values and --flag=value forms.
  ['api', 'repos/o/r/issues', '-ftitle=x'],
  ['api', 'repos/o/r/issues', '-Ftitle=x'],
  ['api', 'repos/o/r/issues', '--field=title=x'],
  ['api', 'repos/o/r/issues', '--raw-field=title=x'],
  ['api', '-XPOST', 'repos/o/r/issues'],
  ['api', '-XDELETE', 'repos/o/r/git/refs/heads/x'],
  ['api', '-X=POST', 'repos/o/r/issues'],
  ['api', '-iXPOST', 'repos/o/r/issues'],
  ['api', '--method=DELETE', 'repos/o/r/git/refs/heads/x'],
  ['api', 'repos/o/r/pulls', '--input=body.json'],
  // GraphQL: --input in any form, @file queries, and a mutation anywhere in the document.
  ['api', 'graphql', '--input=m.json'],
  ['api', 'graphql', '--input', 'm.json'],
  ['api', 'graphql', '-f', 'query={ a }', '--input', '-'],
  ['api', 'graphql', '-F', 'query=@m.graphql'],
  ['api', 'graphql', '--field=query=@m.graphql'],
  ['api', 'graphql', '-F', 'query={ a }', '-F', 'v=@vars.json'],
  ['api', 'graphql', '-f', 'query={ a }', '-f', 'query=mutation { b }'],
  [
    'api',
    'graphql',
    '-f',
    'query=query Q { viewer { login } } mutation M { deleteRef(input: {refId: "x"}) { clientMutationId } }',
    '-f',
    'operationName=M',
  ],
  ['api', 'graphql', '-f', 'query={ a } subscription S { b }'],
  ['api', 'graphql', '-f', 'query={ a(s: "unterminated) }'],
  // --help no longer short-circuits the guard.
  ['pr', 'comment', '1', '--body', '--help'],
  ['pr', 'merge', '1', '-h'],
  ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/x', '--jq', '--help'],
  // Ambiguous parses are denied.
  ['api', '--help'],
  ['api'],
  ['api', '--frobnicate', 'repos/o/r'],
  ['api', '-Z', 'repos/o/r'],
  ['api', '-iZ', 'repos/o/r'],
  ['api', 'repos/o/r', 'repos/o/s'],
  ['api', '--', 'repos/o/r'],
  ['api', '-X'],
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
  assert.ok(isGraphqlMutation('query A { a } mutation B { b }'));
  assert.ok(isGraphqlMutation('"""doc""" mutation { b }'));
  assert.ok(!isGraphqlMutation('{ a(q: "mutation") }'));
  assert.ok(!isGraphqlMutation('{ a(q: """mutation \\""" x""") }'));
  assert.ok(!isGraphqlMutation('{ a } # mutation'));
});
