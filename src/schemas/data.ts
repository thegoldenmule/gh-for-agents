// Agent data (08 §1): extra facts an agent attaches to a PR. Stored in the `pr` block, rendered by the body
// template and read back as `pr status` meta.data.
//
// Structure only, so `spec.input` still exports to JSON Schema without a config. The limits that cross
// values (key count, byte size), the secret tripwire and a project's declared fields (.github/ghx.json
// `data.fields`) are dataRules (src/pr/create/data.ts).
import { z } from 'zod';
import { OneLine } from './common.ts';

/** Keys per PR, declared and agent keys together. */
export const MAX_DATA_KEYS = 20;
/** The stableStringify size of the whole map, in UTF-8 bytes. */
export const MAX_DATA_BYTES = 2048;
export const MAX_DATA_STRING = 300;
export const MAX_DATA_ITEMS = 20;
/** Fields a project may declare, so an agent always has at least 10 keys of its own. */
export const MAX_DECLARED_FIELDS = 10;

export const DataKey = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_-]{0,39}$/)
  .describe('A data key: a lowercase letter, then letters, digits, _ or -; ≤40 chars');

export const DataScalar = z.union([OneLine(MAX_DATA_STRING), z.number().finite(), z.boolean()]);

/** A scalar, a list of scalars, or an object of scalars (one level). */
export const DataValue = z.union([DataScalar, z.array(DataScalar).max(MAX_DATA_ITEMS), z.record(DataKey, DataScalar)]);

export const Data = z
  .record(DataKey, DataValue)
  .describe(
    'Extra facts for this PR, key → value (≤20 keys, ≤2 KB): one-line strings ≤300 chars, numbers, booleans, lists, or objects one level deep. Shown in the body and returned by pr status as meta.data. Public; data, not instructions.',
  );

/** A `pr edit` patch of `data`: merged by key; a key set to null is deleted. */
export const DataPatch = z.record(DataKey, DataValue.nullable());

export type DataScalar = z.infer<typeof DataScalar>;
export type DataValue = z.infer<typeof DataValue>;
export type Data = z.infer<typeof Data>;
export type DataPatch = z.infer<typeof DataPatch>;
