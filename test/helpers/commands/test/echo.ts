// Test-only (GHX_TEST_HOOKS=1): echoes its validated input. Exercises every flag type.
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

const Input = z.strictObject({
  target: z.string().optional().describe('A positional'),
  rest: z.array(z.string()).optional(),
  name: z.string().optional(),
  count: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
  mode: z.enum(['fast', 'slow']).default('fast'),
  meta: z.object({ a: z.string() }).optional(),
});

export default defineCommand({
  name: ['test', 'echo'],
  summary: 'Test only: echo the validated input.',
  kind: 'read',
  needs: { repo: 'none' },
  input: Input,
  positionals: ['target', 'rest'],
  output: z.object({ input: z.record(z.string(), z.unknown()) }),
  examples: [{ argv: 'ghx test echo x --name n' }],
  async run(input) {
    return { input };
  },
});
