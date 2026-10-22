import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import { isGhxError } from '../../../src/core/errors.ts';
import { seededRandom } from '../../../src/core/random.ts';
import { buildApiArgs, fillPath, mergePages, nextLink, parseIncludeOutput } from '../../../src/gh/api.ts';
import { isMutating } from '../../../src/gh/guard.ts';
import { createGh, GhFailure } from '../../../src/gh/index.ts';
import { FakeClock } from '../../helpers/fake-clock.ts';
import { FakeProc } from '../../helpers/fake-proc.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ghx-api-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = { host: 'github.com', owner: 'o', name: 'r' };

const resp = (status: string, headers: Record<string, string>, body: string, crlf = false): string => {
  const nl = crlf ? '\r\n' : '\n';
  return [status, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join(nl);
};

function setup(mode: 'read' | 'write' = 'read') {
  const clock = new FakeClock(Date.UTC(2026, 9, 22, 12));
  const fake = new FakeProc({ clock });
  const gh = createGh({
    proc: fake.runner(),
    clock,
    signal: new AbortController().signal,
    mode,
    random: seededRandom(2),
  });
  return { clock, fake, gh };
}

test('parseIncludeOutput: HTTP/2.0 + LF, HTTP/1.1 + CRLF, duplicates keep the last', () => {
  const a = parseIncludeOutput(
    resp(
      'HTTP/2.0 200 OK',
      { ETag: 'W/"x"', 'X-Ratelimit-Resource': 'core', 'x-ratelimit-resource': 'graphql' },
      '{"a":1}',
    ),
  );
  assert.equal(a.status, 200);
  assert.equal(a.headers.etag, 'W/"x"');
  assert.equal(a.headers['x-ratelimit-resource'], 'graphql');
  assert.equal(a.body, '{"a":1}');
  const b = parseIncludeOutput(
    resp('HTTP/1.1 404 The specified blob does not exist.', { Server: 'Windows-Azure-Blob/1.0' }, '<Error/>', true),
  );
  assert.equal(b.status, 404);
  assert.equal(b.statusLine, 'HTTP/1.1 404 The specified blob does not exist.');
  assert.equal(b.headers.server, 'Windows-Azure-Blob/1.0');
  assert.equal(b.body, '<Error/>');
  assert.deepEqual(parseIncludeOutput('plain'), { statusLine: null, status: null, headers: {}, body: 'plain' });
});

test('nextLink, fillPath, mergePages', () => {
  assert.equal(
    nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    'https://api.github.com/x?page=2',
  );
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), undefined);
  assert.equal(fillPath('repos/{owner}/{repo}/pulls', repo), 'repos/o/r/pulls');
  assert.throws(() => fillPath('repos/{owner}/{repo}', undefined), /placeholders/);
  assert.deepEqual(mergePages([[1], [2, 3]]), [1, 2, 3]);
  assert.deepEqual(
    mergePages([
      { total_count: 3, jobs: [1] },
      { total_count: 3, jobs: [2, 3] },
    ]),
    { total_count: 3, jobs: [1, 2, 3] },
  );
});

test('buildApiArgs: GET fields become a query string, so the call stays a read', () => {
  const { args, stdin } = buildApiArgs({
    path: 'repos/{owner}/{repo}/actions/runs',
    repo,
    fields: { branch: 'main', per_page: 10 },
  });
  assert.deepEqual(args, [
    'api',
    '--include',
    '-X',
    'GET',
    '--hostname',
    'github.com',
    'repos/o/r/actions/runs?branch=main&per_page=10',
  ]);
  assert.equal(stdin, undefined);
  assert.equal(isMutating(args), false);
});

test('buildApiArgs: hostname, sorted headers, body on stdin for writes', () => {
  const ghe = { host: 'ghe.example.com', owner: 'o', name: 'r' };
  const { args, stdin } = buildApiArgs({
    path: 'repos/{owner}/{repo}/pulls/1/merge',
    repo: ghe,
    method: 'PUT',
    headers: { 'X-B': '2', Accept: 'application/json' },
    body: { sha: 'abc', merge_method: 'merge' },
  });
  assert.deepEqual(args, [
    'api',
    '--include',
    '-X',
    'PUT',
    '--hostname',
    'ghe.example.com',
    '-H',
    'Accept: application/json',
    '-H',
    'X-B: 2',
    'repos/o/r/pulls/1/merge',
    '--input',
    '-',
  ]);
  assert.equal(stdin, '{"sha":"abc","merge_method":"merge"}');
  assert.equal(isMutating(args), true);
});

test('api(): parses JSON, validates, records the rate budget and ETag', async () => {
  const { fake, gh } = setup();
  fake.on(
    { cmd: 'gh', args: ['api'] },
    {
      stdout: resp(
        'HTTP/2.0 200 OK',
        {
          Etag: 'W/"abc"',
          'X-Ratelimit-Limit': '5000',
          'X-Ratelimit-Remaining': '4900',
          'X-Ratelimit-Used': '100',
          'X-Ratelimit-Reset': '1792670400',
          'X-Ratelimit-Resource': 'core',
        },
        '{"number":12}',
      ),
    },
  );
  const r = await gh.api({ path: 'repos/{owner}/{repo}/pulls/12', repo }, z.object({ number: z.number() }));
  assert.equal(r.notModified, false);
  assert.deepEqual(r.data, { number: 12 });
  assert.equal(r.etag, 'W/"abc"');
  assert.deepEqual(gh.rateBudget('core'), {
    resource: 'core',
    limit: 5000,
    remaining: 4900,
    used: 100,
    resetAt: 1_792_670_400_000,
    observedAt: Date.UTC(2026, 9, 22, 12),
  });
});

test('api(): exit 1 + 304 + If-None-Match = notModified, never retried (03 §3.1)', async () => {
  const { fake, gh } = setup();
  fake.on(
    { cmd: 'gh', args: ['api'] },
    { exitCode: 1, stderr: 'gh: HTTP 304', stdout: resp('HTTP/2.0 304 Not Modified', { Etag: '"abc"' }, '') },
  );
  const r = await gh.api(
    { path: 'repos/o/r/commits/sha/check-runs', headers: { 'If-None-Match': 'W/"abc"' } },
    z.unknown(),
  );
  assert.equal(r.notModified, true);
  assert.equal(r.data, undefined);
  assert.equal(r.etag, '"abc"');
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0]?.args.includes('If-None-Match: W/"abc"'));
});

test('api(): bounded Link pagination reports truncated', async () => {
  const { fake, gh } = setup();
  const page = (n: number, next: boolean) =>
    resp(
      'HTTP/2.0 200 OK',
      next ? { Link: `<https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=${n + 1}>; rel="next"` } : {},
      JSON.stringify([n]),
    );
  fake.on({ cmd: 'gh', args: ['api'] }, [
    { stdout: page(1, true) },
    { stdout: page(2, true) },
    { stdout: page(3, false) },
  ]);
  const r = await gh.api({ path: 'repos/o/r/pulls/1/files', paginate: { maxPages: 2 } }, z.array(z.number()));
  assert.deepEqual(r.data, [1, 2]);
  assert.equal(r.pages, 2);
  assert.equal(r.truncated, true);
  assert.equal(fake.calls[0]?.args.at(-1), 'repos/o/r/pulls/1/files?per_page=100');
  assert.equal(fake.calls[1]?.args.at(-1), 'https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=2');
});

test('api(): 404 maps to the call-site not-found code with the status', async () => {
  const { fake, gh } = setup();
  fake.on(
    { cmd: 'gh' },
    {
      exitCode: 1,
      stderr: 'gh: Not Found (HTTP 404)',
      stdout: resp('HTTP/2.0 404 Not Found', {}, '{"message":"Not Found"}'),
    },
  );
  await assert.rejects(
    gh.api({ path: 'repos/o/r/actions/runs/1' }, z.unknown(), { notFound: 'RUN_NOT_FOUND' }),
    (e) => {
      assert.ok(e instanceof GhFailure);
      assert.equal(e.code, 'RUN_NOT_FOUND');
      assert.equal(e.details?.status, 404);
      return true;
    },
  );
});

test('api(): 502 is retried for reads', async () => {
  const { clock, fake, gh } = setup();
  fake.on({ cmd: 'gh' }, [
    { exitCode: 1, stderr: 'gh: Server Error (HTTP 502)', stdout: resp('HTTP/2.0 502 Bad Gateway', {}, '') },
    { stdout: resp('HTTP/2.0 200 OK', {}, '[]') },
  ]);
  const p = gh.api({ path: 'repos/o/r/pulls' }, z.array(z.unknown()));
  await clock.advance(10_000);
  assert.deepEqual((await p).data, []);
  assert.equal(fake.calls.length, 2);
});

test('api(): drift is GH_OUTPUT_UNEXPECTED', async () => {
  const { fake, gh } = setup();
  fake.on({ cmd: 'gh' }, { stdout: resp('HTTP/2.0 200 OK', {}, '{"number":"x"}') });
  await assert.rejects(gh.api({ path: 'x' }, z.object({ number: z.number() })), (e) =>
    isGhxError(e, 'GH_OUTPUT_UNEXPECTED'),
  );
});

test('apiText(): strips the BOM from an inline body', async () => {
  const { fake, gh } = setup();
  fake.on(
    { cmd: 'gh' },
    { stdout: resp('HTTP/1.1 200 OK', { Server: 'Windows-Azure-Blob/1.0' }, '﻿##[group]Run tests', true) },
  );
  const r = await gh.apiText({ path: 'repos/o/r/actions/jobs/1/logs' });
  assert.equal(r.data, '##[group]Run tests');
  assert.equal(gh.rateBudget('core'), undefined);
});

test('apiText(toFile): headers are split off the file and the BOM is stripped', async () => {
  const { fake, gh } = setup();
  const file = join(tmp, 'job-1.log');
  fake.on({ cmd: 'gh' }, (req) => {
    writeFileSync(
      req.stdoutFile as string,
      resp(
        'HTTP/1.1 200 OK',
        { Server: 'Windows-Azure-Blob/1.0' },
        '﻿2026-10-22T10:00:00Z ##[error]Process completed with exit code 1.\n',
        true,
      ),
    );
    return {};
  });
  const r = await gh.apiText({ path: 'repos/o/r/actions/jobs/1/logs', toFile: file });
  assert.equal(r.data, file);
  assert.equal(readFileSync(file, 'utf8'), '2026-10-22T10:00:00Z ##[error]Process completed with exit code 1.\n');
});

test('apiText(toFile): blob 404 is logs-not-ready and leaves no file', async () => {
  const { fake, gh } = setup();
  const file = join(tmp, 'job-2.log');
  fake.on({ cmd: 'gh' }, (req) => {
    writeFileSync(
      req.stdoutFile as string,
      resp('HTTP/1.1 404 The specified blob does not exist.', {}, '<Code>BlobNotFound</Code>', true),
    );
    return { exitCode: 1, stderr: 'gh: HTTP 404' };
  });
  await assert.rejects(gh.apiText({ path: 'repos/o/r/actions/jobs/2/logs', toFile: file }), (e) => {
    assert.ok(e instanceof GhFailure);
    assert.equal(e.failure.code, 'GH_LOGS_NOT_READY');
    return true;
  });
  assert.equal(existsSync(file), false);
});

test('apiText(toFile): 410 is logs-gone, not transient', async () => {
  const { fake, gh } = setup();
  const file = join(tmp, 'job-3.log');
  fake.on({ cmd: 'gh' }, (req) => {
    writeFileSync(req.stdoutFile as string, resp('HTTP/2.0 410 Gone', {}, ''));
    return { exitCode: 1, stderr: 'gh: Server Error (HTTP 410)' };
  });
  await assert.rejects(gh.apiText({ path: 'repos/o/r/actions/jobs/3/logs', toFile: file }), (e) => {
    assert.ok(e instanceof GhFailure);
    assert.equal(e.failure.code, 'GH_LOGS_GONE');
    assert.equal(e.failure.transient, false);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});
