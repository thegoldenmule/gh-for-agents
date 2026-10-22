// The single copy of 02 §6.1 that tests import. Tests never retype exit numbers; a renumbering of the
// public table is an edit here (and in src/core/exit.ts, which test/unit/core/exit.test.ts compares).
export interface ExitRow {
  readonly exit: number;
  readonly class: string;
  readonly meaning: string;
}

export const EXIT_TABLE = [
  { exit: 0, class: 'OK', meaning: 'Success. A read that reports red still succeeds' },
  { exit: 1, class: 'INTERNAL', meaning: 'Bug, output contract violation, or read-mode mutation' },
  {
    exit: 2,
    class: 'USAGE',
    meaning: 'Unknown command or flag, bad selector, input missing or not JSON, or VALIDATION',
  },
  { exit: 3, class: 'CONFIG', meaning: '.github/ghx.json missing or invalid' },
  { exit: 4, class: 'ENV', meaning: 'gh missing, too old, or unauthenticated' },
  { exit: 5, class: 'NOT_FOUND', meaning: 'PR, repo, run, id or ref missing, including a cwd mismatch' },
  { exit: 6, class: 'POLICY', meaning: 'A ghx rule refused a write' },
  {
    exit: 7,
    class: 'GH_FAILED',
    meaning: 'gh or API failure after retries, permission, rate limit, or a partial batch',
  },
  { exit: 8, class: 'TIMEOUT', meaning: 'Deadline exceeded (not used by ci wait)' },
  { exit: 9, class: 'STATE', meaning: 'GitHub state forbids it now' },
  { exit: 10, class: 'CI_RED', meaning: 'ci wait: a considered check failed and is not shared with main' },
  { exit: 11, class: 'CI_RED_SHARED', meaning: 'ci wait: red, but every failure is shared with main' },
  { exit: 12, class: 'SUPERSEDED', meaning: 'ci wait: head moved, or the PR closed or merged' },
  { exit: 13, class: 'NO_CHECKS', meaning: 'ci wait: nothing registered within the grace period' },
  { exit: 14, class: 'CI_STALLED', meaning: 'ci wait: a check is running far past its baseline or stuck in the queue' },
  { exit: 15, class: 'CI_PENDING_RESUME', meaning: 'ci wait: self-returned in an unattended session' },
  { exit: 130, class: 'INTERRUPTED', meaning: 'SIGINT' },
  { exit: 143, class: 'INTERRUPTED', meaning: 'SIGTERM' },
] as const satisfies readonly ExitRow[];

/** Exit number by class name; INTERRUPTED splits into SIGINT and SIGTERM. */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  ENV: 4,
  NOT_FOUND: 5,
  POLICY: 6,
  GH_FAILED: 7,
  TIMEOUT: 8,
  STATE: 9,
  CI_RED: 10,
  CI_RED_SHARED: 11,
  SUPERSEDED: 12,
  NO_CHECKS: 13,
  CI_STALLED: 14,
  CI_PENDING_RESUME: 15,
  SIGINT: 130,
  SIGTERM: 143,
} as const;
