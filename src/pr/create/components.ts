// Component names as agents write them: the canonical key, an alias of it (`aliases` in .github/ghx.json),
// or a near miss. resolveComponent maps the first two; suggestComponent ranks a did-you-mean for the rest.
import { aliasMap } from '../../config/sections/components.ts';
import { suggest } from '../../core/suggest.ts';
import type { CreateRulesConfig } from './rules.ts';

type Components = CreateRulesConfig['components'];

/** The canonical name for `name` (itself, or the component it is an alias of), or null when unknown. */
export function resolveComponent(name: string, components: Components): string | null {
  if (Object.hasOwn(components, name)) return name;
  return aliasMap(components).get(name) ?? null;
}

/** The directory a glob names before its first wildcard: `apps/switchboard/**` → `apps/switchboard`. */
function globDir(glob: string): string {
  const star = glob.search(/[*?[{]/);
  const fixed = star === -1 ? glob : glob.slice(0, star);
  return fixed.replace(/\/+$/, '');
}

/**
 * The paths a hyphenated name may stand for: `apps-reactor-monitor` → `apps/reactor-monitor`,
 * `apps/reactor/monitor`, …, and the name itself (a basename).
 */
function pathReadings(name: string): string[] {
  const parts = name.split('-');
  const out = new Set<string>([name]);
  const n = parts.length - 1;
  // Each hyphen is either kept or read as '/': 2^n readings, bounded for long names.
  if (n <= 6) {
    for (let mask = 1; mask < 1 << n; mask++) {
      let s = parts[0] ?? '';
      for (let i = 1; i <= n; i++) s += (mask & (1 << (i - 1)) ? '/' : '-') + (parts[i] ?? '');
      out.add(s);
    }
  }
  return [...out];
}

/**
 * Did-you-mean for an unknown component name, best first: the component it is an alias of; a component
 * whose path globs name the directory the name spells (`packages-codegen` → the component with
 * `packages/codegen/**`, `switchboard` → the one with `apps/switchboard/**`); then edit distance.
 */
export function suggestComponent(name: string, components: Components): string[] {
  const alias = resolveComponent(name, components);
  if (alias !== null && alias !== name) return [alias];
  const readings = pathReadings(name);
  const byPath: string[] = [];
  for (const [key, c] of Object.entries(components)) {
    const dirs = (c.paths ?? []).map(globDir).filter((d) => d !== '');
    const hit = dirs.some(
      (d) => readings.some((r) => d === r || d.endsWith(`/${r}`)) || readings.includes(d.split('/').pop() ?? ''),
    );
    if (hit) byPath.push(key);
  }
  if (byPath.length > 0) return byPath.slice(0, 3);
  return suggest(name, Object.keys(components));
}

/** The names for a message: every component when few, else the first ones and a count. */
export function componentList(components: Components, max = 20): string {
  const names = Object.keys(components);
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')}, +${names.length - max} more`;
}
