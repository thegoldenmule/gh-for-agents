// gh-shaped input on ghx commands: a gh flag that is a field of the JSON input names the field and the
// JSON fragment to write, instead of an edit-distance guess (`--head` read as `--help`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT } from '../contract/exit-table.ts';
import { runInProcess } from '../helpers/harness.ts';

test('a gh flag that is a JSON input field names the field and the fragment to write', async () => {
  const rows: [argv: string[], field: string, json: unknown, hint: RegExp][] = [
    [
      ['pr', 'create', '--head', 'feat/x'],
      'head',
      { head: 'feat/x' },
      /^'head' is a field of the JSON input, not a flag: put \{"head": "feat\/x"\} in the file, then run ghx pr create --input pr\.json/,
    ],
    [
      ['pr', 'create', '--title=Fix it'],
      'title',
      { title: 'Fix it' },
      /^'title' is a field of the JSON input, not a flag: put \{"title": "Fix it"\}/,
    ],
    [
      ['pr', 'create', '--body', 'why'],
      'description',
      { description: 'why' },
      /^gh's --body is the 'description' field of the JSON input in ghx: put \{"description": "why"\}/,
    ],
    [['pr', 'create', '-B', 'main'], 'base', { base: 'main' }, /gh's -B is the 'base' field/],
    [['pr', 'create', '--draft'], 'draft', { draft: true }, /put \{"draft": true\}/],
    [
      ['pr', 'create', '--body-file', 'b.md'],
      'description',
      { description: '<the text of the file>' },
      /\{"description": "<the text of the file>"\}/,
    ],
    [
      ['pr', 'edit', '12', '-t', 'New title'],
      'title',
      { title: 'New title' },
      /then run ghx pr edit <pr> --input patch\.json/,
    ],
    [['pr', 'comment', '12', '--body', 'hi'], 'body', { body: 'hi' }, /ghx pr comment <pr> --input comment\.json/],
    [['pr', 'review', '12', '--approve'], 'verdict', { verdict: 'approve' }, /\{"verdict": "approve"\}/],
  ];
  for (const [argv, field, json, hint] of rows) {
    const r = await runInProcess(argv);
    assert.equal(r.exitCode, EXIT.USAGE, r.stdout);
    assert.equal(r.json.error.code, 'USAGE_UNKNOWN_FLAG');
    assert.deepEqual(r.json.error.details, {
      flag: argv.find((a) => a.startsWith('-'))?.split('=')[0],
      suggestions: [],
      field,
      json,
    });
    assert.match(r.json.error.hint, hint);
    assert.equal(r.calls.length, 0);
  }
});

test('gh pr flags ghx has no home for say so; other commands keep the edit-distance hint', async () => {
  const label = await runInProcess(['pr', 'create', '--label', 'bug']);
  assert.match(label.json.error.hint, /^gh's --label has no ghx flag; ghx sets no labels, reviewers/);
  const fill = await runInProcess(['pr', 'create', '--fill']);
  assert.match(fill.json.error.hint, /ghx does not fill from commits/);
  const addLabel = await runInProcess(['pr', 'edit', '1', '--add-label', 'x']);
  assert.match(addLabel.json.error.hint, /ghx sets no labels/);
  const status = await runInProcess(['pr', 'status', '1', '--title', 'x']);
  assert.match(status.json.error.hint, /^Run 'ghx pr status --help'/, 'pr status has no JSON fields');
});
