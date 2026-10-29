// Every canonical question, one per file. Order here does not matter: the runner sorts by id.
import type { Question } from '../types.ts';
import { question as prStatus } from './pr-status.ts';

export const QUESTIONS: readonly Question[] = [prStatus];
