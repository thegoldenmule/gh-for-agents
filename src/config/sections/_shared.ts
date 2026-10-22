// Building blocks shared by config sections.
import { z } from 'zod';
import { isValidGlob } from '../../util/glob.ts';

export const Glob = z.string().min(1).refine(isValidGlob, 'invalid glob');
export const MergeMethod = z.enum(['merge', 'squash', 'rebase']);
