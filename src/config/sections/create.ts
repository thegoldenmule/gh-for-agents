// `create` (02 §15). Owned by M9 (pr create): create.requirePassingTest.
import { z } from 'zod';

export const CreateSection = z
  .strictObject({
    /** At least one testing item must have result `pass` (testing.min_pass). */
    requirePassingTest: z.boolean().prefault(true),
  })
  .prefault({});
