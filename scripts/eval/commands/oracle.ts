// ghx-eval oracle (plan 07, tier 2, M4): answer the canonical questions with ghx, expert gh and typical gh
// against the fake gh, and report tool calls, API calls, bytes, tokens and correctness. Exit 0 when every
// ghx and gh-expert answer is correct (M4's done-when), 1 otherwise; the report is written either way.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { QUESTIONS, renderMarkdown, runOracle, serializeReport } from '../oracle/index.ts';

export const summary = 'Tier 2 replay oracle: canonical questions answered by ghx, expert gh and typical gh';

const HELP = `Usage: pnpm eval oracle [--out FILE] [--md FILE] [--format json|md] [--only ID,...] [--keep]

  --out FILE        write report.json here (stdout then gets the markdown table)
  --md FILE         write the markdown table here
  --format F        what stdout gets when --out is not given: json (default) or md
  --only IDS        comma-separated question ids (${QUESTIONS.map((q) => q.id)
    .sort()
    .join(', ')})
  --keep            keep the per-answer directories (OS temp dir, ghx-oracle-*)
`;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      md: { type: 'string' },
      format: { type: 'string' },
      only: { type: 'string' },
      keep: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'md') {
    process.stderr.write(`--format must be json or md\n${HELP}`);
    return 2;
  }
  const only = values.only
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const report = await runOracle({ ...(only ? { only } : {}), ...(values.keep ? { keep: true } : {}) });
  const json = serializeReport(report);
  const md = renderMarkdown(report);
  if (values.out !== undefined) writeFileSync(values.out, json);
  if (values.md !== undefined) writeFileSync(values.md, md);
  process.stdout.write(values.out !== undefined || format === 'md' ? md : json);
  return report.done ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
