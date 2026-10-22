// --verbose diagnostics: NDJSON on stderr. stderr is never part of the output contract (01 §3.5).

export interface Logger {
  readonly enabled: boolean;
  debug(event: string, data?: Record<string, unknown>): void;
}

export const nullLogger: Logger = { enabled: false, debug() {} };

export function createLineLogger(writeLine: (line: string) => void, now: () => number): Logger {
  return {
    enabled: true,
    debug(event, data = {}) {
      writeLine(JSON.stringify({ at: new Date(now()).toISOString(), event, ...data }));
    },
  };
}
