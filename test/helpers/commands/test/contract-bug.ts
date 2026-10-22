// Test-only (GHX_TEST_HOOKS=1): returns off-schema output, so the runner must exit 1
// (INTERNAL_OUTPUT_CONTRACT). This is how exit 1 is produced in the exit-code contract table.
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

export default defineCommand({
  name: ['test', 'contract-bug'],
  summary: 'Test only: violate the output contract on purpose.',
  kind: 'read',
  needs: { repo: 'none' },
  input: z.strictObject({}),
  output: z.object({ count: z.number() }),
  async run() {
    return { count: 'not a number' } as unknown as { count: number };
  },
});
