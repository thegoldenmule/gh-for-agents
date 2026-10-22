import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLogins, EMAIL, redactFixture, redactText, TOKEN } from '../../../scripts/fixtures/redact.ts';

test('tokens, bearer headers and emails are scrubbed', () => {
  const s = redactText(
    't=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gho_ABCDEFGHIJKLMNOPQRST github_pat_11ABCDEFG0123456789_abcdef Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 me@example.com 1234+octo@users.noreply.github.com',
  );
  assert.doesNotMatch(s, TOKEN);
  assert.doesNotMatch(s, /me@example\.com|octo@users/);
  assert.match(s, /Bearer <redacted-token>/);
  assert.equal((s.match(/user@example\.invalid/g) ?? []).length, 2);
});

test('git transport users are not emails', () => {
  assert.equal(redactText('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.ok(!'git@github.com:o/r.git'.match(EMAIL));
});

test('request ids, the blob RequestId, Date headers and SAS query strings are normalised', () => {
  const raw = [
    'HTTP/2.0 200 OK',
    'Date: Wed, 21 Oct 2026 09:13:44 GMT',
    'X-Github-Request-Id: D2A1:3F0C:1B2E4A:1C7F3B:6717A0B2',
    'x-ms-request-id: 7c1f8f3e-201e-0042-6b2f-1a2b3c4d5e6f',
    'Location: https://productionresultssa1.blob.core.windows.net/actions-results/x/logs.txt?rsct=text%2Fplain&se=2026-10-22T10%3A00%3A00Z&sig=abc%2Bdef%3D&sp=r&sv=2021-12-02',
    '',
    '<Error><Code>BlobNotFound</Code><Message>x\nRequestId:7c1f8f3e-201e-0042-6b2f-1a2b3c4d5e6f\nTime:2026-10-22T09:13:44Z</Message></Error>',
  ].join('\r\n');
  const out = redactText(raw);
  assert.match(out, /Date: Thu, 22 Oct 2026 12:00:00 GMT\r/);
  assert.match(out, /X-Github-Request-Id: 0000:0000:0000000:0000000:00000000/);
  assert.match(out, /x-ms-request-id: 00000000-0000-0000-0000-000000000000/);
  assert.match(out, /RequestId: 00000000-0000-0000-0000-000000000000/);
  assert.match(out, /logs\.txt\?<redacted-sas>/);
  assert.doesNotMatch(out, /sig=/);
  assert.match(out, /Time:2026-10-22T09:13:44Z/, 'timestamps are kept');
});

test('logins map to stable aliases; bots, SHAs and timestamps are kept', () => {
  const body = {
    user: { login: 'thegoldenmule' },
    reviews: [
      { author: { login: 'maria' } },
      { author: { login: 'github-actions[bot]' } },
      { author: { login: 'maria' } },
    ],
    head: { sha: '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d' },
    created_at: '2026-10-21T15:47:30Z',
    html_url: 'https://github.com/thegoldenmule',
  };
  const f = redactFixture(
    {
      argv: ['api', 'repos/o/r/pulls/1'],
      exitCode: 0,
      stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`,
      stderr: '',
      meta: { source: 'live:public', note: 'thegoldenmule' },
    },
    { aliases: { thegoldenmule: 'viewer-user' } },
  );
  const out = JSON.parse(f.stdout.slice(f.stdout.indexOf('{')));
  assert.equal(out.user.login, 'viewer-user');
  assert.equal(out.reviews[0].author.login, 'user-1');
  assert.equal(out.reviews[2].author.login, 'user-1');
  assert.equal(out.reviews[1].author.login, 'github-actions[bot]');
  assert.equal(out.head.sha, body.head.sha);
  assert.equal(out.created_at, body.created_at);
  assert.equal(out.html_url, 'https://github.com/viewer-user');
  assert.equal(f.meta.note, 'thegoldenmule', 'meta is not rewritten');
  const aliases: Record<string, string> = {};
  collectLogins([{ login: 'a' }, { login: 'b' }, { login: 'a' }, { login: 'cli', type: 'Organization' }], aliases);
  assert.deepEqual(aliases, { a: 'user-1', b: 'user-2' });
});

test('discovered logins never touch argv or request paths (org owners stay)', () => {
  const body = {
    owner: { login: 'cli', type: 'Organization' },
    user: { login: 'someone', type: 'User' },
    url: 'https://api.github.com/repos/cli/cli',
  };
  const f = redactFixture({
    argv: ['api', 'repos/cli/cli/pulls', 'someone'],
    exitCode: 0,
    stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(body)}`,
    stderr: '',
    meta: { source: 'live:public' },
  });
  assert.deepEqual(f.argv, ['api', 'repos/cli/cli/pulls', 'someone']);
  const out = JSON.parse(f.stdout.slice(f.stdout.indexOf('{')));
  assert.equal(out.owner.login, 'cli');
  assert.equal(out.user.login, 'user-1');
  assert.equal(out.url, 'https://api.github.com/repos/cli/cli');
});
