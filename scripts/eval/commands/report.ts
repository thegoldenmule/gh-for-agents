// ghx-eval report: re-render report.md from a report.json, and with --baseline say which metric definitions
// changed since an earlier report. The diff goes to stdout; exit 0 either way.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { diffDefinitions, formatDiff } from '../report/compare.ts';
import { parseReport } from '../report/json.ts';
import { render } from '../report/markdown.ts';

export const summary = 'Re-render report.md from report.json; --baseline diffs metric definitions';

const HELP = `Usage: pnpm eval report --in REPORT [--out FILE] [--baseline REPORT]

  --in REPORT         a report.json written by observe
  --out FILE          where report.md goes (default: report.md beside --in; "-" for stdout)
  --baseline REPORT   an earlier report.json: print what changed in METRIC_VERSION, constants, prices, era
                      config, statistics and metric definitions, and include it in report.md
`;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      baseline: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.in === undefined) {
    process.stderr.write(`--in is required\n${HELP}`);
    return 2;
  }
  let report = parseReport(readFileSync(values.in, 'utf8'));
  if (values.baseline !== undefined) {
    const diff = diffDefinitions(parseReport(readFileSync(values.baseline, 'utf8')), report);
    process.stdout.write(formatDiff(diff));
    report = { ...report, baseline: diff };
  }
  const md = render(report);
  const out = values.out ?? join(dirname(values.in), 'report.md');
  if (out === '-') process.stdout.write(md);
  else writeFileSync(out, md);
  return 0;
}
