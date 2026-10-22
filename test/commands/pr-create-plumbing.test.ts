// The two small shared additions pr create needs: JSON-only input fields (`.meta({jsonOnly: true})`
// keeps prose out of flags, 02 §0) and Git.diffNames (the local 300-file fallback, 02 §2.6 step 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { deriveInterface } from '../../src/cli/args.ts';
import createSpec from '../../src/commands/pr/create.ts';
import { createGit } from '../../src/git/index.ts';
import { FakeProc } from '../helpers/fake-proc.ts';

test('a field marked jsonOnly is never a flag', () => {
  const d = deriveInterface({
    input: z.strictObject({ title: z.string().meta({ jsonOnly: true }), batch: z.boolean().optional() }),
  });
  assert.deepEqual(
    d.flags.map((f) => f.flag),
    ['--batch'],
  );
  assert.deepEqual(d.jsonOnly, ['title']);
});

test('pr create derives no flag from a PR field', () => {
  const d = deriveInterface(createSpec);
  for (const f of ['--title', '--description', '--base', '--head', '--draft', '--risk', '--risk-note']) {
    assert.ok(!d.flags.some((x) => x.flag === f), `${f} must be JSON-only`);
  }
  assert.ok(d.jsonOnly.includes('title') && d.jsonOnly.includes('testing'));
});

test('Git.diffNames parses -z output, and answers undefined when git fails', async () => {
  const fake = new FakeProc()
    .on(
      { cmd: 'git', args: ['diff', '--name-only', '-z', '--no-color', 'a...b'] },
      { stdout: 'src/x.ts\0docs/a b.md\0' },
    )
    .on(
      { cmd: 'git', args: ['diff', '--name-only', '-z', '--no-color', 'a...c'] },
      { exitCode: 128, stderr: 'bad object' },
    );
  const git = createGit({ proc: fake.runner(), cwd: '/w', env: {}, signal: new AbortController().signal });
  assert.deepEqual(await git.diffNames('a', 'b'), ['src/x.ts', 'docs/a b.md']);
  assert.equal(await git.diffNames('a', 'c'), undefined);
});
