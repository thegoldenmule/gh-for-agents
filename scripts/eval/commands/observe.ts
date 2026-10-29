// ghx-eval observe (plan 07 tier 1): a frozen manifest → report.json + report.md. Prints a JSON summary.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { evalHome } from '../corpus/paths.ts';
import { observe, readEraConfig } from '../pipeline.ts';
import { diffDefinitions, formatDiff } from '../report/compare.ts';
import { parseReport, serializeReport } from '../report/json.ts';
import { render } from '../report/markdown.ts';

export const summary = 'Measure a frozen corpus: manifest → tables → units → report.json and report.md';

const HELP = `Usage: pnpm eval observe --manifest FILE [--out DIR] [--era FILE] [--baseline REPORT] [--no-cache]

  --manifest FILE     the manifest to read (from snapshot or ingest)
  --out DIR           where report.json and report.md go (default $GHX_EVAL_HOME/reports/<manifest hash[:12]>)
  --era FILE          era config JSON: {"adoptions": {"<project slug>": "<ISO>"}, "devProjectMarkers": [...]}
                      (default: the 2026-10-29 corpus's)
  --baseline REPORT   a previous report.json: report what changed in the metric definitions since it
  --no-cache          neither read nor write the tables cache next to the manifest
`;

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      manifest: { type: 'string' },
      out: { type: 'string' },
      era: { type: 'string' },
      baseline: { type: 'string' },
      'no-cache': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.manifest === undefined) {
    process.stderr.write(`--manifest is required\n${HELP}`);
    return 2;
  }
  const base = values.baseline !== undefined ? parseReport(readFileSync(values.baseline, 'utf8')) : undefined;
  const { report, corpus } = observe(values.manifest, {
    ...(values.era !== undefined ? { era: readEraConfig(values.era) } : {}),
    cache: values['no-cache'] !== true,
    ...(base ? { baseline: (r: typeof base) => diffDefinitions(base, r) } : {}),
  });
  const out = values.out ?? join(evalHome(), 'reports', report.manifest.hash.slice(0, 12));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), serializeReport(report));
  writeFileSync(join(out, 'report.md'), render(report));
  if (report.baseline) process.stderr.write(formatDiff(report.baseline));
  const result = {
    out,
    manifest: report.manifest.hash,
    metric_version: report.versions.metric,
    units: report.corpus.units_by_kind,
    cells: report.cells.length,
    comparisons: report.comparisons.length,
    eligible: report.comparisons.filter((c) => c.eligible).length,
    cache: corpus.cache,
    definition_changes: report.baseline ? report.baseline.changes.length : null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
