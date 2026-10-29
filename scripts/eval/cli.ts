#!/usr/bin/env node
// ghx-eval (plan 07): `pnpm eval [--projects DIR] [--out DIR] [--json] [--era FILE]`. Reads the Claude Code
// sessions on disk and prints report.md, or report.json with --json, or writes both to --out.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { EraConfig } from './model/session.ts';
import { defaultProjectsDir, evaluate, readEraConfig } from './pipeline.ts';
import { serializeReport } from './report/json.ts';
import { render } from './report/markdown.ts';

export const HELP = `Usage: pnpm eval [--projects DIR] [--out DIR] [--json] [--era FILE]

Reads every Claude Code session under the projects directory, as it is on disk now, and reports how
GitHub work went with ghx and with raw gh. Prints report.md to stdout.

  --projects DIR   the projects directory (default $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects)
  --out DIR        write report.json and report.md to DIR instead of printing
  --json           print report.json instead of report.md
  --era FILE       era config JSON: {"adoptions": {"<project slug>": "<ISO time>"}, "devProjectMarkers": [...]}
                   (default: the one in scripts/eval/model/session.ts)
`;

export function main(argv: string[]): number {
  let values: { projects?: string; out?: string; json?: boolean; era?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        projects: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        era: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (e) {
    process.stderr.write(`ghx-eval: ${(e as Error).message}\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const projects = resolve(values.projects ?? defaultProjectsDir());
  if (!statSync(projects, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`ghx-eval: ${projects} is not a directory\n`);
    return 2;
  }
  let era: EraConfig | undefined;
  try {
    if (values.era !== undefined) era = readEraConfig(values.era);
  } catch (e) {
    process.stderr.write(`ghx-eval: --era ${values.era}: ${(e as Error).message}\n`);
    return 2;
  }
  const report = evaluate(projects, era ? { era } : {});
  if (values.out !== undefined) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, 'report.json'), serializeReport(report));
    writeFileSync(join(values.out, 'report.md'), render(report));
    process.stderr.write(
      `ghx-eval: ${report.input.files} files, ${report.corpus.sessions} sessions from ${projects} → ${values.out}\n`,
    );
  } else {
    process.stdout.write(values.json ? serializeReport(report) : render(report));
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
