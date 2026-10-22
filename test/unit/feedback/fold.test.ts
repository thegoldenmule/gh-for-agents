import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFeedback, resolveFacts } from '../../../src/feedback/facts.ts';
import { conditionKey, effectiveSeverity, type FeedbackInput, foldFeedback } from '../../../src/feedback/fold.ts';
import * as raw from '../../../src/feedback/raw.ts';
import * as schemas from '../../../src/feedback/schemas.ts';
import { Feedback, Precondition } from '../../../src/feedback/schemas.ts';
import { encode } from '../../../src/meta/codec.ts';
import { assertExportable } from '../schemas/_exportable.ts';
import { assertConservation, configWith, loadInput, readJson } from './_fixture.ts';

const HEAD = '9f2c4e1a7b3d5f60812c9e4b7a1d3f5e6c8b0a2d';
const OLD = '4b1e7d20c9a35f8e61d24b07c3a9e5f1d8b62c47';
const FIXTURES = ['worked-example-3301.input.json', 'unstructured-and-bots.json', 'untrusted.json'];

const resolver = (reachable: Record<string, boolean | null> = {}, calls: string[] = []) => ({
  async commitInPr(sha: string) {
    calls.push(sha);
    return reachable[sha] ?? null;
  },
  async condition(c: { type: string; ref: string }) {
    calls.push(`${c.type}:${c.ref}`);
    return { status: 'met' as const, evidence: `${c.ref} merged` };
  },
});

let seq = 1000;
const user = (login: string) => ({ __typename: 'User', login });
function issue(body: string, o: { login?: string; assoc?: string; at?: string; bot?: boolean } = {}) {
  const id = seq++;
  return {
    databaseId: id,
    author: o.bot ? { __typename: 'Bot', login: o.login ?? 'some-app' } : user(o.login ?? 'viewer-user'),
    authorAssociation: o.assoc ?? 'OWNER',
    body,
    createdAt: o.at ?? `2026-10-20T12:${String(id % 60).padStart(2, '0')}:00Z`,
    url: `https://github.com/o/r/pull/1#issuecomment-${id}`,
  };
}
function input(over: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    issueComments: [],
    reviews: [],
    reviewThreads: [],
    viewerLogin: 'viewer-user',
    headSha: HEAD,
    config: configWith(),
    ...over,
  };
}
const finding = (o: Record<string, unknown> = {}) => ({
  t: 'finding',
  id: 'f_aaaaaa',
  gen: 'ghx/0.1.0',
  review: 'r_aaaaaa',
  severity: 'high',
  path: 'src/a.ts',
  line: 1,
  side: 'RIGHT',
  alsoAt: [],
  title: 'T',
  body: 'B',
  commit: OLD,
  ...o,
});
const review = (body: string, o: { state?: string; at?: string } = {}) => {
  const id = seq++;
  return {
    databaseId: id,
    author: user('viewer-user'),
    authorAssociation: 'OWNER',
    body,
    state: o.state ?? 'COMMENTED',
    submittedAt: o.at ?? '2026-10-20T10:00:00Z',
    createdAt: o.at ?? '2026-10-20T10:00:00Z',
    commit: { oid: OLD },
    url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  };
};

test('feedback and raw schemas export to JSON Schema (pr status embeds them)', () => {
  assert.ok(assertExportable(schemas) >= 8);
  assert.ok(assertExportable(raw) >= 5);
});

test('02 §14.5 golden: the worked example folds to the documented feedback', async () => {
  const inp = loadInput('worked-example-3301.input.json');
  const calls: string[] = [];
  const r = await loadFeedback(inp, resolver({ [HEAD]: true }, calls));
  assert.deepEqual(
    { feedback: r.feedback, openFindings: r.openFindings, preconditions: r.preconditions },
    readJson('worked-example-3301.golden.json'),
  );
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls, [HEAD], 'only the addressed commit is verified');
  assert.ok(Feedback.safeParse(r.feedback).success);
});

for (const name of FIXTURES) {
  test(`conservation: ${name}`, () => {
    const inp = loadInput(name);
    const r = foldFeedback(inp);
    assertConservation(inp, r);
    assert.ok(Feedback.safeParse(r.feedback).success, 'output matches the schema');
  });
}

test('a comment with no block is kept with structured:false and no blockError', () => {
  const r = foldFeedback(
    input({ issueComments: [issue('Is this backward compatible?', { login: 'maria-dev', assoc: 'MEMBER' })] }),
  );
  assert.equal(r.feedback.comments.length, 1);
  assert.deepEqual(
    { s: r.feedback.comments[0]?.structured, k: r.feedback.comments[0]?.kind, e: r.feedback.comments[0]?.blockError },
    { s: false, k: null, e: null },
  );
  assert.match(r.feedback.comments[0]?.id ?? '', /^ic:\d+$/);
});

test('bots are separated by Bot actor, [bot] login, bots.logins and bots.markers', () => {
  const r = foldFeedback(
    input({
      config: configWith({ bots: { logins: ['renovate'], markers: ['deploy-preview'] } }),
      issueComments: [
        issue('Coverage 91%', { login: 'codecov', bot: true }),
        issue('legacy app', { login: 'old-app[bot]' }),
        issue('Update dependency x', { login: 'renovate' }),
        issue('<!-- deploy-preview -->\nPreview ready at https://example.invalid', { login: 'ci-user' }),
        issue('<!-- just a note -->\nA human with an HTML comment', { login: 'maria-dev' }),
      ],
    }),
  );
  assert.deepEqual(
    r.feedback.bots.map((b) => [b.author, b.marker, b.summary]),
    [
      ['codecov[bot]', null, 'Coverage 91%'],
      ['old-app[bot]', null, 'legacy app'],
      ['renovate', null, 'Update dependency x'],
      ['ci-user', 'deploy-preview', 'Preview ready at https://example.invalid'],
    ],
  );
  assert.deepEqual(
    r.feedback.comments.map((c) => c.author.login),
    ['maria-dev'],
  );
});

test('an unknown severity is kept, warned UNKNOWN_ENUM, and fails closed as high', () => {
  const inp = input({
    reviewThreads: [
      {
        isResolved: false,
        isOutdated: false,
        path: 'src/a.ts',
        line: 1,
        comments: {
          nodes: [
            {
              ...issue(`**[critical] T**\n\n${encode(finding({ severity: 'critical' }))}`),
              path: 'src/a.ts',
              line: 1,
              replyTo: null,
            },
          ],
        },
      },
    ],
  });
  const r = foldFeedback(inp);
  assert.equal(r.feedback.findings[0]?.severity, 'critical');
  assert.equal(effectiveSeverity(r.feedback.findings[0]?.severity ?? ''), 'high');
  assert.deepEqual(r.openFindings, ['f_aaaaaa']);
  assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_ENUM' && /critical/.test(w.message)));
});

test('a ghx:v2 block gives structured:false, blockError "newer schema v2" and SCHEMA_NEWER', () => {
  const r = foldFeedback(
    input({ issueComments: [issue('From the future.\n\n<!-- ghx:v2 {"t":"comment","id":"c_aaaaaa"} -->')] }),
  );
  const c = r.feedback.comments[0];
  assert.deepEqual(
    { s: c?.structured, e: c?.blockError, body: c?.body },
    { s: false, e: 'newer schema v2', body: 'From the future.' },
  );
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ['SCHEMA_NEWER'],
  );
});

test('an invalid block keeps the item with structured:false and a blockError', () => {
  const r = foldFeedback(
    input({
      issueComments: [issue('<!-- ghx:v1 {"t":"comment","id":"c_aaaaaa","gen":"ghx/0.1.0","kind":"supersede"} -->')],
    }),
  );
  assert.equal(r.feedback.comments[0]?.structured, false);
  assert.match(r.feedback.comments[0]?.blockError ?? '', /^invalid comment block: by:/);
});

test('an unknown comment kind is structured with kind:null and UNKNOWN_BLOCK_TYPE', () => {
  const r = foldFeedback(
    input({ issueComments: [issue(encode({ t: 'comment', id: 'c_bbbbbb', gen: 'ghx/0.9.0', kind: 'vote' }))] }),
  );
  assert.deepEqual(
    [r.feedback.comments[0]?.id, r.feedback.comments[0]?.structured, r.feedback.comments[0]?.kind],
    ['c_bbbbbb', true, null],
  );
  assert.equal(r.warnings[0]?.code, 'UNKNOWN_BLOCK_TYPE');
});

test('body-only findings come from the review body, inline:false, with the review url', () => {
  const rb = {
    t: 'review',
    id: 'r_aaaaaa',
    gen: 'ghx/0.1.0',
    verdict: 'approve',
    summary: 'S',
    commit: OLD,
    findings: ['f_aaaaaa'],
  };
  const rv = review(`**ghx review**\n\n${encode(rb)}\n${encode(finding({ severity: 'low' }))}`, { state: 'APPROVED' });
  const r = foldFeedback(input({ reviews: [rv] }));
  assert.equal(r.feedback.reviews[0]?.verdictDowngraded, false);
  assert.deepEqual(
    r.feedback.findings.map((f) => [f.id, f.inline, f.url, f.outdated]),
    [['f_aaaaaa', false, rv.url, true]],
  );
  assertConservation(input({ reviews: [rv] }), r);
});

test('an empty COMMENTED review is a container; an empty APPROVED review is listed', () => {
  const r = foldFeedback(input({ reviews: [review(''), review('', { state: 'APPROVED' })] }));
  assert.deepEqual(
    r.feedback.reviews.map((x) => [x.githubState, x.structured, x.verdict]),
    [['APPROVED', false, null]],
  );
});

test('a reused block id is read as unstructured with DUPLICATE_BLOCK', () => {
  const note = encode({ t: 'comment', id: 'c_cccccc', gen: 'ghx/0.1.0', kind: 'note' });
  const r = foldFeedback(
    input({
      issueComments: [issue(note, { at: '2026-10-20T10:00:00Z' }), issue(note, { at: '2026-10-20T11:00:00Z' })],
    }),
  );
  assert.deepEqual(
    r.feedback.comments.map((c) => [c.structured, c.blockError]),
    [
      [true, null],
      [false, 'duplicate block id c_cccccc'],
    ],
  );
  assert.ok(r.warnings.some((w) => w.code === 'DUPLICATE_BLOCK'));
});

test('a block in the wrong place is unstructured: a finding in an issue comment', () => {
  const r = foldFeedback(input({ issueComments: [issue(encode(finding()))] }));
  assert.equal(r.feedback.findings.length, 0);
  assert.equal(r.feedback.comments[0]?.blockError, 'unexpected finding block in an issue comment');
});

test('preconditions: network conditions come from the resolver, manual waits, overrides win', async () => {
  const pre = (id: string, condition: unknown) =>
    encode({ t: 'comment', id, gen: 'ghx/0.1.0', kind: 'precondition', condition });
  const resolveBlock = (id: string, targets: unknown[]) =>
    encode({ t: 'comment', id, gen: 'ghx/0.1.0', kind: 'resolve', targets });
  const inp = input({
    issueComments: [
      issue(pre('c_pa0001', { type: 'pr-merged', ref: '#3184' }), { at: '2026-10-20T10:00:00Z' }),
      issue(pre('c_pa0002', { type: 'manual', text: 'Ship the switchboard release' }), { at: '2026-10-20T10:01:00Z' }),
      issue(pre('c_pa0003', { type: 'release-includes', ref: 'o/r#9' }), { at: '2026-10-20T10:02:00Z' }),
      issue(pre('c_pa0004', { type: 'ci-green' }), { at: '2026-10-20T10:03:00Z' }),
      issue(resolveBlock('c_ra0001', [{ id: 'c_pa0002', status: 'met', note: 'released 1.4.0' }]), {
        at: '2026-10-20T11:00:00Z',
      }),
      issue(resolveBlock('c_ra0002', [{ id: 'c_pa0003', status: 'withdrawn', note: 'no longer needed' }]), {
        at: '2026-10-20T11:01:00Z',
      }),
    ],
  });
  const first = foldFeedback(inp);
  assert.deepEqual(
    first.needs.conditions.map((c) => conditionKey(c)),
    ['pr-merged:#3184'],
    'overridden conditions are not evaluated',
  );
  assert.equal(first.preconditions[0]?.status, 'unknown');

  const r = await loadFeedback(inp, resolver());
  assert.deepEqual(
    r.preconditions.map((p) => [p.id, p.status, p.evidence]),
    [
      ['c_pa0001', 'met', '#3184 merged'],
      ['c_pa0002', 'met', 'met by viewer-user: released 1.4.0'],
      ['c_pa0003', 'withdrawn', 'withdrawn by viewer-user: no longer needed'],
      ['c_pa0004', 'unknown', 'unknown condition type "ci-green"'],
    ],
  );
  assert.equal(r.preconditions[1]?.override?.id, 'c_ra0001');
  for (const p of r.preconditions) assert.ok(Precondition.safeParse(p).success, p.id);
  assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_ENUM' && /ci-green/.test(w.message)));
});

test('verification is capped at 10 commits; the rest stay verified:null with EVENT_COMMIT_UNVERIFIED', async () => {
  const shas = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(40, 'a'));
  const threads = shas.map((sha, i) => {
    const id = `f_${String(i).padStart(2, '0')}aaaa`.replace(/\d/g, (d) => 'abcdefghjk'[Number(d)] ?? 'a');
    return {
      id,
      thread: {
        isResolved: true,
        isOutdated: false,
        path: 'src/a.ts',
        line: i + 1,
        comments: {
          nodes: [
            { ...issue(encode(finding({ id, line: i + 1 }))), path: 'src/a.ts', line: i + 1, replyTo: null },
            {
              ...issue(
                encode({
                  t: 'comment',
                  id: `c_${id.slice(2)}`,
                  gen: 'ghx/0.1.0',
                  kind: 'resolve',
                  targets: [{ id, status: 'addressed', commit: sha }],
                }),
              ),
              path: 'src/a.ts',
              line: i + 1,
            },
          ],
        },
      },
    };
  });
  const inp = input({ reviewThreads: threads.map((t) => t.thread) });
  const calls: string[] = [];
  const all = Object.fromEntries(shas.map((s) => [s, true]));
  const r = await loadFeedback(inp, resolver(all, calls));
  assert.equal(calls.length, 10);
  assert.equal(r.feedback.findings.filter((f) => f.statusEvent?.verified === true).length, 10);
  assert.equal(
    r.feedback.findings.filter((f) => f.statusEvent?.verified === null && f.status === 'addressed').length,
    2,
  );
  assert.equal(r.warnings.filter((w) => w.code === 'EVENT_COMMIT_UNVERIFIED').length, 2);
  assert.deepEqual(await resolveFacts({ commits: [], conditions: [] }, resolver()), {
    commits: new Map(),
    conditions: new Map(),
  });
});

test('trust.bots: a human named like a trusted app cannot mark a finding addressed', () => {
  const config = configWith({ trust: { bots: ['my-app[bot]'] } });
  const rv = review(
    encode({
      t: 'review',
      id: 'r_aaaaaa',
      gen: 'ghx/0.1.0',
      verdict: 'comment',
      summary: 'S',
      commit: OLD,
      findings: ['f_aaaaaa'],
    }) + encode(finding()),
  );
  const resolve = encode({
    t: 'comment',
    id: 'c_cccccc',
    gen: 'ghx/0.1.0',
    kind: 'resolve',
    targets: [{ id: 'f_aaaaaa', status: 'wontfix', note: 'n' }],
  });
  const human = foldFeedback(
    input({ config, reviews: [rv], issueComments: [issue(resolve, { login: 'my-app', assoc: 'NONE' })] }),
  );
  assert.deepEqual(human.openFindings, ['f_aaaaaa']);
  assert.ok(human.warnings.some((w) => w.code === 'UNTRUSTED_BLOCK'));
  const app = foldFeedback(
    input({ config, reviews: [rv], issueComments: [issue(resolve, { login: 'my-app', assoc: 'NONE', bot: true })] }),
  );
  assert.deepEqual(app.openFindings, []);
});

const reviewBlock = (findings: string[]) =>
  encode({ t: 'review', id: 'r_aaaaaa', gen: 'ghx/0.1.0', verdict: 'comment', summary: 'S', commit: OLD, findings });
const inlineThread = (body: string) => {
  const id = seq++;
  return {
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 1,
    comments: {
      nodes: [
        {
          databaseId: id,
          author: user('viewer-user'),
          authorAssociation: 'OWNER',
          body,
          createdAt: '2026-10-20T10:00:00Z',
          url: `https://github.com/o/r/pull/1#discussion_r${id}`,
          path: 'src/a.ts',
          line: 1,
        },
      ],
    },
  };
};

test('an invalid finding block in a trusted review warns BLOCK_INVALID and stays open as unknown severity', () => {
  const bad = encode(finding({ id: 'f_bbbbbb', path: undefined }));
  const rv = review(`${reviewBlock(['f_aaaaaa', 'f_bbbbbb'])}\n${encode(finding())}\n${bad}`);
  const r = foldFeedback(input({ reviews: [rv] }));
  assert.ok(r.warnings.some((w) => w.code === 'BLOCK_INVALID' && w.message.includes(`rv:${rv.databaseId}`)));
  assert.deepEqual(r.openFindings, ['f_aaaaaa', 'f_bbbbbb']);
  const ph = r.feedback.findings.find((f) => f.id === 'f_bbbbbb');
  assert.equal(ph?.severity, 'unknown');
  assert.equal(effectiveSeverity(ph?.severity ?? ''), 'high');
  assert.deepEqual([ph?.reviewId, ph?.path, ph?.inline, ph?.status], ['r_aaaaaa', null, false, 'open']);
  assert.equal(r.feedback.counts.findingsOpen, 2);
  Feedback.parse(r.feedback);
  assertConservation(input({ reviews: [rv] }), r);
});

test('an invalid inline finding listed by its review becomes an open placeholder finding', () => {
  const rv = review(reviewBlock(['f_cccccc']));
  const th = inlineThread(encode(finding({ id: 'f_cccccc', review: 'r_aaaaaa', line: 'x' })));
  const r = foldFeedback(input({ reviews: [rv], reviewThreads: [th] }));
  assert.deepEqual(r.openFindings, ['f_cccccc']);
  assert.ok(r.warnings.some((w) => w.code === 'BLOCK_INVALID'));
  assert.match(r.feedback.comments[0]?.blockError ?? '', /^invalid finding block/);
});

test('an unknown block type in a review body warns UNKNOWN_BLOCK_TYPE', () => {
  const rv = review(encode({ t: 'poll', id: 'x_aaaaaa', gen: 'ghx/0.9.0' }));
  const r = foldFeedback(input({ reviews: [rv] }));
  assert.equal(r.feedback.reviews[0]?.structured, false);
  assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_BLOCK_TYPE'));
});

test('a comment reads every block: a trailing invalid block does not discard a valid resolve', () => {
  const rv = review(`${reviewBlock(['f_aaaaaa'])}\n${encode(finding())}`);
  const resolve = encode({
    t: 'comment',
    id: 'c_dddddd',
    gen: 'ghx/0.1.0',
    kind: 'resolve',
    targets: [{ id: 'f_aaaaaa', status: 'wontfix', note: 'n' }],
  });
  const r = foldFeedback(
    input({ reviews: [rv], issueComments: [issue(`${resolve}\n<!-- ghx:v1 {"t":"comment"} -->`)] }),
  );
  assert.deepEqual(r.openFindings, []);
  assert.equal(r.feedback.comments[0]?.structured, true);
  assert.ok(r.warnings.some((w) => w.code === 'BLOCK_INVALID'));
});
