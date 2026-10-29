// "Change a metric definition and the report says so" (plan 07 Goal): what differs in the definitions a
// report was computed with, against a baseline report. Only definitions are compared (METRIC_VERSION,
// constants, prices, era config, statistics, the metric catalog), never the numbers.
import type { BaselineDiff, DefinitionChange, Report } from './json.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaf-level differences between two JSON values, as dotted paths in sorted key order. */
export function diffValues(path: string, from: unknown, to: unknown, out: DefinitionChange[] = []): DefinitionChange[] {
  if (isObject(from) && isObject(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
    for (const k of keys) diffValues(path ? `${path}.${k}` : k, from[k], to[k], out);
    return out;
  }
  if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ what: path, from: from ?? null, to: to ?? null });
  return out;
}

type Defs = Pick<Report, 'versions' | 'constants' | 'price_table' | 'era_config' | 'stats' | 'metrics' | 'manifest'>;

/** Definition changes from `baseline` to `current`. */
export function diffDefinitions(baseline: Defs, current: Defs): BaselineDiff {
  const changes: DefinitionChange[] = [];
  diffValues('versions', baseline.versions, current.versions, changes);
  diffValues('constants', baseline.constants, current.constants, changes);
  diffValues('price_table', baseline.price_table, current.price_table, changes);
  diffValues('era_config', baseline.era_config, current.era_config, changes);
  diffValues('stats', baseline.stats, current.stats, changes);
  const before = new Map(baseline.metrics.map((m) => [m.id, m]));
  const after = new Map(current.metrics.map((m) => [m.id, m]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    diffValues(`metrics.${id}`, before.get(id), after.get(id), changes);
  }
  const definitionChanged = changes.some((c) => !c.what.startsWith('versions.'));
  return {
    manifest: baseline.manifest.hash,
    metric_version: { from: baseline.versions.metric, to: current.versions.metric },
    changes,
    unversioned: definitionChanged && baseline.versions.metric === current.versions.metric,
  };
}

/** Plain-text lines for a terminal. */
export function formatDiff(d: BaselineDiff): string {
  const lines = [
    `baseline manifest ${d.manifest.slice(0, 12)}; METRIC_VERSION ${d.metric_version.from} → ${d.metric_version.to}`,
  ];
  if (d.changes.length === 0) lines.push('no definition changes');
  for (const c of d.changes) lines.push(`  ${c.what}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  if (d.unversioned) lines.push('WARNING: definitions changed but METRIC_VERSION did not');
  return `${lines.join('\n')}\n`;
}
