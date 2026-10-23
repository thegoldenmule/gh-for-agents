// ghx pr feedback <pr> (02 §5; 03 M6.7), in-process over the worked-example world (pr-status-world.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Feedback } from '../../src/feedback/schemas.ts';
import { filterFeedback } from '../../src/pr/status/feedback.ts';
import { PrFeedbackOutput } from '../../src/pr/status/schema.ts';
import { EXIT } from '../contract/exit-table.ts';
import { FakeGh } from '../helpers/fake-gh.ts';
import { readJson } from '../unit/feedback/_fixture.ts';
import { HEAD, isPrCommits } from '../unit/pr/snapshot-fixture.ts';
import { okJson } from './ci-why-world.ts';
import { at, install, REF, run, workedPr } from './pr-status-world.ts';

const GOLDEN = readJson('worked-example-3301.golden.json') as {
  feedback: Feedback;
  openFindings: string[];
  preconditions: [];
};
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

test('everything from all three sources, as folded; the full document is at artifactPath', async () => {
  const fake = install();
  const r = await run(['pr', 'feedback', REF], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  PrFeedbackOutput.parse(r.json);
  assert.equal(r.json.ref, REF);
  assert.equal(r.json.headSha, HEAD);
  assert.deepEqual(r.json.feedback, GOLDEN.feedback);
  assert.deepEqual(r.json.openFindings, ['f_n2c6rv']);
  assert.deepEqual(r.json.warnings, []);
  const artifact = JSON.parse(readFileSync(r.json.artifactPath, 'utf8'));
  assert.deepEqual(artifact.feedback, r.json.feedback);
  fake.expectNoMutations();
  assert.ok(!fake.calls.some((c) => c.argv.some((a) => a.includes('/actions/'))), 'no CI reads');
});

test('--open: open findings, standing change requests; resolved threads, issue comments and bots go', async () => {
  const r = await run(['pr', 'feedback', REF, '--open'], install());
  const fb = r.json.feedback;
  assert.deepEqual(ids(fb.findings), ['f_n2c6rv']);
  assert.deepEqual(ids(fb.reviews), ['r_7tq2wd'], 'a downgraded request-changes verdict still stands');
  assert.deepEqual(fb.comments, []);
  assert.deepEqual(fb.bots, []);
  assert.deepEqual(r.json.openFindings, ['f_n2c6rv']);
  assert.deepEqual([fb.counts.findingsTotal, fb.counts.comments, fb.counts.bots], [1, 0, 0]);
});

test('--open drops outdated open findings unless --include-outdated; a later approval clears a change request', () => {
  const findings = GOLDEN.feedback.findings.map((f) => (f.id === 'f_n2c6rv' ? { ...f, outdated: true } : f));
  const v = { ...GOLDEN, feedback: { ...GOLDEN.feedback, findings } };
  assert.deepEqual(ids(filterFeedback(v, { open: true }).feedback.findings), []);
  assert.deepEqual(ids(filterFeedback(v, { open: true, includeOutdated: true }).feedback.findings), ['f_n2c6rv']);
  assert.deepEqual(ids(filterFeedback(v, {}).feedback.findings), ['f_h4x8pz', 'f_n2c6rv'], 'kept without --open');

  const r0 = GOLDEN.feedback.reviews[0] as Feedback['reviews'][number];
  const approved = { ...r0, id: 'rv:2', structured: false, verdict: null, verdictDowngraded: false };
  const reviews = [
    { ...approved, id: 'rv:1', githubState: 'CHANGES_REQUESTED' as const, submittedAt: '2026-10-21T10:00:00Z' },
    { ...approved, githubState: 'APPROVED' as const, submittedAt: '2026-10-21T17:00:00Z' },
  ];
  const w = { ...GOLDEN, feedback: { ...GOLDEN.feedback, reviews } };
  assert.deepEqual(ids(filterFeedback(w, { open: true }).feedback.reviews), []);
});

test("--open agrees with merge policy: a dismissed latest review clears that reviewer's change request", () => {
  const r0 = GOLDEN.feedback.reviews[0] as Feedback['reviews'][number];
  const base = { ...r0, structured: false, verdict: null, verdictDowngraded: false };
  const reviews = [
    { ...base, id: 'rv:1', githubState: 'CHANGES_REQUESTED' as const, submittedAt: '2026-10-21T10:00:00Z' },
    { ...base, id: 'rv:2', githubState: 'DISMISSED' as const, submittedAt: '2026-10-21T12:00:00Z' },
  ];
  const v = { ...GOLDEN, feedback: { ...GOLDEN.feedback, reviews } };
  assert.deepEqual(ids(filterFeedback(v, { open: true }).feedback.reviews), []);
});

test('--open agrees with merge policy: an addressed finding with an unverified commit counts as open', () => {
  const unverified = GOLDEN.feedback.findings.map((f) =>
    f.id === 'f_h4x8pz' && f.statusEvent
      ? { ...f, outdated: false, statusEvent: { ...f.statusEvent, verified: null } }
      : f,
  );
  const v = { ...GOLDEN, feedback: { ...GOLDEN.feedback, findings: unverified } };
  const open = filterFeedback(v, { open: true, blockOnSeverity: 'high' }).feedback;
  assert.deepEqual(ids(open.findings), ['f_h4x8pz', 'f_n2c6rv']);
  assert.equal(open.counts.findingsOpen, 2);
  // Below merge.blockOnSeverity the policy does not count it, so neither does --open.
  const lowOnly = unverified.map((f) => (f.id === 'f_h4x8pz' ? { ...f, severity: 'low' as const } : f));
  const w = { ...GOLDEN, feedback: { ...GOLDEN.feedback, findings: lowOnly } };
  assert.deepEqual(ids(filterFeedback(w, { open: true, blockOnSeverity: 'high' }).feedback.findings), ['f_n2c6rv']);
  // Verified stays settled.
  assert.deepEqual(ids(filterFeedback(GOLDEN, { open: true, blockOnSeverity: 'high' }).feedback.findings), [
    'f_n2c6rv',
  ]);
});

test('--source human keeps unstructured human items; --source bot only bots; --source ghx no humans', async () => {
  const human = await run(['pr', 'feedback', REF, '--source', 'human'], install());
  assert.deepEqual(ids(human.json.feedback.comments), ['ic:2412345678']);
  assert.deepEqual([human.json.feedback.reviews, human.json.feedback.findings, human.json.feedback.bots], [[], [], []]);
  const bot = await run(['pr', 'feedback', REF, '--source', 'bot'], install());
  assert.deepEqual(ids(bot.json.feedback.bots), ['ic:2412399001']);
  assert.deepEqual(bot.json.feedback.comments, []);
  const ghx = await run(['pr', 'feedback', REF, '--source', 'ghx'], install());
  assert.deepEqual(ids(ghx.json.feedback.comments), ['c_w5j1ve']);
  assert.deepEqual(ids(ghx.json.feedback.findings), ['f_h4x8pz', 'f_n2c6rv']);
});

test('--since <iso> keeps newer items; a finding counts as new when its status event is', async () => {
  const r = await run(['pr', 'feedback', REF, '--since', '2026-10-21T16:10:00Z'], install());
  const fb = r.json.feedback;
  assert.deepEqual(fb.reviews, []);
  assert.deepEqual(ids(fb.findings), ['f_h4x8pz']);
  assert.deepEqual(ids(fb.comments), ['c_w5j1ve']);
  assert.deepEqual(ids(fb.bots), ['ic:2412399001']);
});

test("--since <sha> uses that commit's date (one GET commits/{sha})", async () => {
  const fake = install().on(
    at('/commits/4b1e7d2'),
    okJson({ commit: { committer: { date: '2026-10-21T16:00:00Z' }, author: null } }),
  );
  const r = await run(['pr', 'feedback', REF, '--since', '4b1e7d2'], fake);
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(ids(r.json.feedback.comments), ['c_w5j1ve', 'ic:2412345678']);
  assert.deepEqual(r.json.feedback.reviews, []);
});

test('--since that is neither a time nor a SHA is VALIDATION before any gh call', async () => {
  const fake = new FakeGh();
  const r = await run(['pr', 'feedback', REF, '--since', 'yesterday'], fake);
  assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
  assert.equal(r.json.error.code, 'VALIDATION');
  assert.deepEqual(fake.calls, []);
});

test('bodies are capped at 2,000 chars inline; artifactPath has them in full', async () => {
  const long = 'x'.repeat(5000);
  const comment = {
    databaseId: 77,
    author: { __typename: 'User', login: 'maria-dev' },
    authorAssociation: 'MEMBER',
    body: long,
    createdAt: '2026-10-21T16:06:00Z',
    lastEditedAt: null,
    url: 'https://github.com/powerhouse-inc/powerhouse/pull/3301#issuecomment-77',
  };
  const r = await run(
    ['pr', 'feedback', REF, '--source', 'human'],
    install(undefined, { pr: workedPr({ comments: page([comment]) }) }),
  );
  const c = r.json.feedback.comments.find((x: { id: string }) => x.id === 'ic:77');
  assert.equal([...c.body].length, 2000);
  assert.equal(c.truncated, true);
  const artifact = JSON.parse(readFileSync(r.json.artifactPath, 'utf8'));
  const full = artifact.feedback.comments.find((x: { id: string }) => x.id === 'ic:77');
  assert.deepEqual([full.body, full.truncated], [long, false]);
});

test('the smoke scenario (test/fixtures/gh/smoke/pr-feedback) replays the worked example', async () => {
  const r = await run(
    ['pr', 'feedback', '3301', '-R', 'powerhouse-inc/powerhouse', '--open'],
    FakeGh.fromScenario('smoke/pr-feedback'),
  );
  assert.equal(r.exitCode, EXIT.OK, r.stdout);
  assert.deepEqual(r.json.openFindings, ['f_n2c6rv']);
});

test('openFindings means "blocks merge": pr status and pr feedback both list an unverified addressed high finding', async () => {
  // The PR's commit list cannot be read, so f_h4x8pz's addressed commit stays verified:null.
  const unverified = () => {
    const fake = install();
    fake.on(isPrCommits, { exitCode: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)\n' });
    return fake;
  };
  const status = await run(['pr', 'status', REF], unverified());
  assert.equal(status.exitCode, EXIT.OK, status.stdout.slice(0, 500));
  const blocker = status.json.merge.blockers.find((b: { code: string }) => b.code === 'FINDINGS_OPEN');
  assert.match(blocker?.message ?? '', /f_h4x8pz/, 'the policy engine blocks on it');
  assert.deepEqual(status.json.openFindings, ['f_h4x8pz', 'f_n2c6rv']);
  assert.equal(status.json.feedback.counts.findingsOpen, 2);
  // f_h4x8pz is outdated, which --open drops unless --include-outdated (pre-existing --open rule).
  for (const args of [[], ['--open', '--include-outdated']]) {
    const fb = await run(['pr', 'feedback', REF, ...args], unverified());
    assert.equal(fb.exitCode, EXIT.OK, fb.stdout.slice(0, 500));
    assert.deepEqual(fb.json.openFindings, ['f_h4x8pz', 'f_n2c6rv'], args.join(' '));
    assert.equal(fb.json.feedback.counts.findingsOpen, 2, args.join(' '));
  }
});
