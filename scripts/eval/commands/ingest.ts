// ghx-eval ingest: copy new and grown transcripts into the store, then manifest the store (plan 07, M0).
// Prints one JSON summary: the run's counts and the manifest's path and hash.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ingest } from '../corpus/ingest.ts';
import { writeManifest } from '../corpus/manifest.ts';
import { claudeProjectsDir, defaultStore, nowFrom, storeLayout, windowFrom } from '../corpus/paths.ts';
import { DEFAULT_WINDOW_HOURS, snapshot } from '../corpus/snapshot.ts';

export const summary = 'Copy new and grown transcripts into the store (~/.ghx-eval/corpus), then manifest it';

const HELP = `Usage: pnpm eval ingest [--from DIR|ARCHIVE] [--store DIR] [--label TEXT] [--now ISO]
                        [--window-hours N] [--no-manifest]

  --from DIR|ARCHIVE  a directory laid out like ~/.claude/projects, or a .tar/.tar.gz/.tgz of one
                      (default: ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects)
  --store DIR         the store (default: $GHX_EVAL_HOME/corpus, GHX_EVAL_HOME defaulting to ~/.ghx-eval)
  --label TEXT        recorded with the run in the store's state.json
  --now ISO           the run's instant (default: now)
  --window-hours N    the store manifest excludes files modified after now - N hours (default ${DEFAULT_WINDOW_HOURS})
  --no-manifest       skip writing the store manifest
`;

/** manifests/<YYYYMMDDTHHMMSSZ>.json */
export function manifestName(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}.json`;
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      store: { type: 'string' },
      label: { type: 'string' },
      now: { type: 'string' },
      'window-hours': { type: 'string' },
      'no-manifest': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const now = nowFrom(values.now);
  const store = values.store ?? defaultStore();
  const runResult = ingest({
    source: values.from ?? claudeProjectsDir(),
    store,
    now,
    ...(values.label !== undefined ? { label: values.label } : {}),
  });
  const out: Record<string, unknown> = { store, run: runResult };
  if (!values['no-manifest']) {
    const layout = storeLayout(store);
    const manifest = snapshot({
      root: layout.files,
      now,
      windowHours: windowFrom(values['window-hours'], DEFAULT_WINDOW_HOURS),
    });
    const path = join(layout.manifests, manifestName(now));
    writeManifest(path, manifest);
    out.manifest = { path, hash: manifest.hash, counts: manifest.counts, excluded: manifest.excluded };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}
