// The scenario contract shared by scripts/fixtures/scenarios/*.ts, record.ts and verify.ts. Kept in
// its own module so scenarios never import record.ts (which is a CLI entry point).

export type Source = 'live:sandbox' | 'live:public' | 'synthetic' | 'corpus-shape';

export interface Captured {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RecordContext {
  /** Run a read-only gh call and write it as <outDir>/<file>.json (GhFixture shape). */
  capture(
    outDir: string,
    file: string,
    argv: string[],
    o?: { note?: string; source?: Source; stdoutFile?: boolean },
  ): Captured;
  /** Run gh without writing a fixture (lookups, e.g. finding a run id). */
  gh(argv: string[]): Captured;
  /** Write a hand-built fixture (synthetic shapes derived from live ones). */
  write(outDir: string, file: string, fixture: Record<string, unknown>): void;
  readonly ghVersion: string;
  readonly recordedAt: string;
}

export interface Scenario {
  name: string;
  description: string;
  /** Directories under test/fixtures/gh/ this scenario owns (replaced on record). */
  outDirs: string[];
  /** live:* scenarios are re-recorded by `fixtures:verify`. */
  source: Source;
  record(ctx: RecordContext): Promise<void> | void;
}

export function defineScenario(s: Scenario): Scenario {
  return s;
}
