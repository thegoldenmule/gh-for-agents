// ghx-eval snapshot: manifest a corpus directory (plan 07, M0). Prints a JSON summary; with --out the
// manifest goes to that file, otherwise the manifest itself goes to stdout.
import { parseArgs } from 'node:util';
import { serializeManifest, writeManifest } from '../corpus/manifest.ts';
import { claudeProjectsDir, nowFrom, storeLayout, windowFrom } from '../corpus/paths.ts';
import { DEFAULT_WINDOW_HOURS, snapshot } from '../corpus/snapshot.ts';

export const summary = 'Manifest a corpus: path, size, mtime, sha256 per file, plus a hash of the list';

const HELP = `Usage: pnpm eval snapshot [--root DIR | --store DIR] [--out FILE] [--now ISO] [--window-hours N]

  --root DIR          corpus root (default: ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects)
  --store DIR         manifest an ingest store: root is DIR/files
  --out FILE          write the manifest here (root is recorded relative to FILE) and print a summary
  --now ISO           the snapshot instant (default: now); files modified after now - window are excluded
  --window-hours N    exclusion window (default ${DEFAULT_WINDOW_HOURS})
`;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      store: { type: 'string' },
      out: { type: 'string' },
      now: { type: 'string' },
      'window-hours': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.root !== undefined && values.store !== undefined) {
    process.stderr.write(`--root and --store are exclusive\n${HELP}`);
    return 2;
  }
  const root = values.store !== undefined ? storeLayout(values.store).files : (values.root ?? claudeProjectsDir());
  const manifest = snapshot({
    root,
    now: nowFrom(values.now),
    windowHours: windowFrom(values['window-hours'], DEFAULT_WINDOW_HOURS),
  });
  if (values.out === undefined) {
    process.stdout.write(serializeManifest(manifest));
    return 0;
  }
  writeManifest(values.out, manifest);
  const { hash, counts, excluded, cutoff } = manifest;
  process.stdout.write(`${JSON.stringify({ out: values.out, hash, counts, excluded, cutoff }, null, 2)}\n`);
  return 0;
}
