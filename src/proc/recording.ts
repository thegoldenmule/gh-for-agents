// Recording mode (03 §6.1): decorates a ProcessRunner so every gh call is written as a fixture in the
// GhFixture shape that test/helpers/fake-gh.ts and test/fixtures/bin/gh replay. Enabled by main.ts
// when GHX_RECORD_DIR is set; GHX_RECORD_SOURCE sets meta.source.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import type { ProcessRunner, ProcRequest, ProcResult } from './runner.ts';

export type FixtureSource = 'live:sandbox' | 'live:public' | 'synthetic' | 'corpus-shape';

export interface RecordedFixture {
  argv: string[];
  stdin?: { json: unknown } | { text: string };
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutFile?: string;
  meta: { source: FixtureSource; recordedAt: string; ghVersion?: string; note?: string };
}

export interface RecordingOptions {
  dir: string;
  source: FixtureSource;
  clock: Clock;
  /** Command basename to record; default 'gh'. */
  cmd?: string;
}

export function slugFor(argv: readonly string[]): string {
  const slug = argv
    .filter((a) => !a.startsWith('-'))
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'call';
}

function stdinOf(s: string): { json: unknown } | { text: string } {
  try {
    return { json: JSON.parse(s) };
  } catch {
    return { text: s };
  }
}

export function withRecording(inner: ProcessRunner, o: RecordingOptions): ProcessRunner {
  const target = o.cmd ?? 'gh';
  mkdirSync(o.dir, { recursive: true });
  let seq = existsSync(o.dir) ? readdirSync(o.dir).filter((f) => f.endsWith('.json')).length : 0;
  let ghVersion: Promise<string | undefined> | undefined;
  const version = (req: ProcRequest): Promise<string | undefined> => {
    ghVersion ??= inner({ cmd: req.cmd, args: ['--version'], env: req.env, signal: req.signal, timeoutMs: 10_000 })
      .then((r) => /gh version (\S+)/.exec(r.stdout)?.[1])
      .catch(() => undefined);
    return ghVersion;
  };

  return async (req) => {
    const res: ProcResult = await inner(req);
    if (basename(req.cmd) !== target || res.spawnError) return res;
    seq++;
    const name = `${String(seq).padStart(3, '0')}-${slugFor(req.args)}`;
    const fixture: RecordedFixture = {
      argv: [...req.args],
      exitCode: res.exitCode ?? -1,
      stdout: res.stdout,
      stderr: res.stderr,
      meta: { source: o.source, recordedAt: new Date(o.clock.now()).toISOString() },
    };
    const v = await version(req);
    if (v) fixture.meta.ghVersion = v;
    if (req.stdin !== undefined) fixture.stdin = stdinOf(req.stdin);
    if (req.stdoutFile && existsSync(req.stdoutFile)) {
      copyFileSync(req.stdoutFile, join(o.dir, `${name}.log`));
      fixture.stdoutFile = `${name}.log`;
    }
    writeFileSync(join(o.dir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return res;
  };
}
