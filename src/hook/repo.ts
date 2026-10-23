// Does the PreToolUse event's cwd sit in a repo that opted into ghx (`.github/ghx.json`)? The hook
// enforces only there (04 "enforcement scope"). Filesystem only, no gh and no git spawn, so it stays
// far inside the hook's 100 ms budget. Any doubt (no cwd, an unreadable path) answers false: fail open.
import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const exists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The checkout root above `cwd`: the nearest directory holding a `.git` entry. A worktree or submodule
 * has a `.git` file rather than a directory, and its root is still where that file sits.
 */
export function repoRoot(cwd: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return null;
  }
  for (;;) {
    if (exists(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** True when `cwd` is inside a checkout whose root has `.github/ghx.json`. */
export function ghxConfigured(cwd: unknown): boolean {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const root = repoRoot(cwd);
  return root !== null && isFile(join(root, '.github', 'ghx.json'));
}
