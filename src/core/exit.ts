// Exit codes: 02 §6.1. This is a public contract; test/contract/exit-table.ts holds the independent
// copy that tests read, and test/unit/core/exit.test.ts asserts the two agree.
export const ExitCode = {
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

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCode = (typeof ExitCode)[ExitCodeName];

/** Exit code for a shutdown signal. SIGINT is 130; every other shutdown cause (SIGTERM, SIGHUP, EPIPE) is 143. */
export function exitForSignal(signal: string | undefined): ExitCode {
  return signal === 'SIGINT' ? ExitCode.SIGINT : ExitCode.SIGTERM;
}

/** When `ci wait` watches several targets, the aggregate exit is the first that applies (02 §6.1). */
export const CI_WAIT_EXIT_PRECEDENCE: readonly ExitCode[] = [
  ExitCode.CI_RED,
  ExitCode.CI_STALLED,
  ExitCode.NO_CHECKS,
  ExitCode.SUPERSEDED,
  ExitCode.CI_PENDING_RESUME,
  ExitCode.CI_RED_SHARED,
  ExitCode.OK,
];
