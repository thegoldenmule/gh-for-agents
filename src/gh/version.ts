// `gh --version` parsing and comparison. MIN_GH_VERSION is the floor for the features ghx probes
// (doctor): it is set from the cli/cli release notes, not guessed.

export interface GhVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
  date?: string;
}

export function parseGhVersion(stdout: string): GhVersion | undefined {
  const m = /gh version (\d+)\.(\d+)\.(\d+)(?:\S*)?(?:\s+\((\d{4}-\d{2}-\d{2})\))?/.exec(stdout);
  if (!m) return undefined;
  const v: GhVersion = {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: `${m[1]}.${m[2]}.${m[3]}`,
  };
  if (m[4]) v.date = m[4];
  return v;
}

export function compareVersions(
  a: Pick<GhVersion, 'major' | 'minor' | 'patch'>,
  b: Pick<GhVersion, 'major' | 'minor' | 'patch'>,
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function versionAtLeast(v: GhVersion, min: string): boolean {
  const [major = 0, minor = 0, patch = 0] = min.split('.').map(Number);
  return compareVersions(v, { major, minor, patch }) >= 0;
}
