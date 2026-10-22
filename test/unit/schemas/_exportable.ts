// Asserts every zod schema a module exports converts to JSON Schema both ways, with no
// `unrepresentable: 'any'` escape hatch (as strict as test/registry.test.ts). Factories are passed samples.
import assert from 'node:assert/strict';
import { z } from 'zod';

export function assertExportable(
  mod: Record<string, unknown>,
  factories: Record<string, () => z.ZodType> = {},
): number {
  let n = 0;
  for (const [name, value] of Object.entries(mod)) {
    const schema = value instanceof z.ZodType ? value : factories[name]?.();
    if (!schema) continue;
    for (const io of ['input', 'output'] as const) {
      assert.doesNotThrow(() => z.toJSONSchema(schema, { io }), `${name} (${io}) must export to JSON Schema`);
    }
    n++;
  }
  return n;
}
