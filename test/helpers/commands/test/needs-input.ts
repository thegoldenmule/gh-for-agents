// Test-only (GHX_TEST_HOOKS=1): a write command whose JSON input is required; mutates through gh.
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

export default defineCommand({
  name: ['test', 'needs-input'],
  summary: 'Test only: requires --input; posts it with gh api (dry-run halts there).',
  kind: 'write',
  needs: { repo: 'none' },
  jsonInput: 'required',
  input: z.strictObject({ title: z.string().min(1), body: z.string().optional() }),
  output: z.object({ posted: z.boolean(), title: z.string() }),
  examples: [{ argv: 'ghx test needs-input --input -', input: { title: 't' } }],
  async run(input, ctx) {
    ctx.preview({ title: input.title });
    await ctx.gh.exec({
      args: ['api', '-X', 'POST', 'repos/o/r/issues', '--input', '-'],
      stdin: JSON.stringify(input),
    });
    return { posted: true, title: input.title };
  },
});
