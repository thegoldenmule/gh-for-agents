// Every canonical question, one per file. Order here does not matter: the runner sorts by id.
import type { Question } from '../types.ts';
import { question as ciRerun } from './ci-rerun.ts';
import { question as ciWhyGreen } from './ci-why-green.ts';
import { question as ciWhyPending } from './ci-why-pending.ts';
import { question as ciWhyRed } from './ci-why-red.ts';
import { question as mainHealth } from './main-health.ts';
import { question as prFeedback } from './pr-feedback.ts';
import { question as prMerge } from './pr-merge.ts';
import { question as prStatus } from './pr-status.ts';

export const QUESTIONS: readonly Question[] = [
  prStatus,
  ciWhyGreen,
  ciWhyRed,
  ciWhyPending,
  mainHealth,
  prFeedback,
  prMerge,
];
