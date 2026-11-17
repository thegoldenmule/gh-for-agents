import type { GhxConfig } from '../../config/schema.ts';
import { RISK_ORDER, riskRank } from '../../schemas/pr.ts';
import { matchesGlob } from '../../util/glob.ts';

type Components = GhxConfig['components'];

/** Matching paths are deduplicated: a rename may name both its old and new component. */
export function touchedComponents(files: readonly string[], components: Components): Map<string, string[]> {
  const paths = [...new Set(files)];
  const out = new Map<string, string[]>();
  for (const [name, component] of Object.entries(components)) {
    const hits = paths.filter((path) => component.paths?.some((glob) => matchesGlob(path, glob)));
    if (hits.length) out.set(name, hits);
  }
  return out;
}

export function riskFloor(names: readonly string[], components: Components): { floor: number; setters: string[] } {
  let floor = -1;
  const setters: string[] = [];
  for (const name of names) {
    const risk = components[name]?.minRisk;
    if (risk === undefined) continue;
    const rank = riskRank(risk);
    if (rank > floor) {
      floor = rank;
      setters.length = 0;
    }
    if (rank === floor) setters.push(`${name} (${risk})`);
  }
  return { floor, setters };
}

export function deriveImpact(files: readonly string[], components: Components) {
  const touched = touchedComponents(files, components);
  const order = [...touched.keys()];
  const ranked = [...order].sort(
    (a, b) => (touched.get(b)?.length ?? 0) - (touched.get(a)?.length ?? 0) || order.indexOf(a) - order.indexOf(b),
  );
  const { floor } = riskFloor(ranked, components);
  return { components: ranked.slice(0, 5), alsoTouched: ranked.slice(5), riskFloor: RISK_ORDER[floor] ?? null };
}
