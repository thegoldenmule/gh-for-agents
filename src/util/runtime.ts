// Which runtime ghx runs on: Node.js (bin/ghx.js, from a checkout or the npm package), or the
// standalone executable `bun build --compile` makes (scripts/build-bin.ts; GitHub Releases).
// ghx install and doctor branch on it: the binary's hook command and --bin-dir link name the
// executable itself, not node plus bin/ghx.js. Functions that branch take a Runtime parameter
// defaulting to RUNTIME, so tests drive the compiled branches under Node.

export interface Runtime {
  /** True only inside a `bun build --compile` executable (its modules live under /$bunfs/). */
  compiled: boolean;
  /** 'bun' under Bun (compiled or not), else 'node'. */
  name: 'node' | 'bun';
  /** The runtime's own version (Bun's, not the Node.js version Bun reports for compatibility). */
  version: string;
  /** The program this process runs: node, or the ghx executable itself when compiled. */
  execPath: string;
}

export function detectRuntime(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  moduleUrl: string = import.meta.url,
  execPath: string = process.execPath,
): Runtime {
  const bun = versions.bun;
  return {
    compiled: bun !== undefined && (moduleUrl.startsWith('file:///$bunfs/') || moduleUrl.includes('/~BUN/')),
    name: bun !== undefined ? 'bun' : 'node',
    version: bun ?? versions.node ?? 'unknown',
    execPath,
  };
}

export const RUNTIME: Runtime = detectRuntime();

/** Installs (or upgrades to) the latest standalone binary, for hints. */
export const BINARY_INSTALL_COMMAND =
  'curl -fsSL https://github.com/thegoldenmule/gh-for-agents/releases/latest/download/install.sh | sh';
