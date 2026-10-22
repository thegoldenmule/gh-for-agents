// Test-only (GHX_TEST_HOOKS=1): emits a document of about `bytes` bytes (spill and pipe-flush tests).
import { z } from 'zod';
import { defineCommand } from '../../../../src/core/command.ts';

export default defineCommand({
  name: ['test', 'big'],
  summary: 'Test only: emit a large document.',
  kind: 'read',
  needs: { repo: 'none' },
  input: z.strictObject({ bytes: z.number().int().min(0).max(8_000_000).default(20_000) }),
  output: z.object({ items: z.array(z.string()), last: z.string() }),
  examples: [{ argv: 'ghx test big --bytes 100' }],
  async run(input) {
    const line = 'x'.repeat(98);
    const items = Array.from({ length: Math.max(1, Math.ceil(input.bytes / 101)) }, () => line);
    return { items, last: 'END' };
  },
});
