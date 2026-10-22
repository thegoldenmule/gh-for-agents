// The only module that touches `process` (01 §1): builds the real dependencies, runs the CLI, sets
// process.exitCode and lets the event loop drain so the last byte reaches a pipe (01 §3.5).
import { readFile } from 'node:fs/promises';
import { commandRoots, fsRegistry } from './cli/registry.ts';
import { runCli } from './cli/run.ts';
import { realClock } from './core/clock.ts';
import { createWritableSink } from './core/output.ts';
import { realRandom } from './core/random.ts';
import { createShutdown, forceExit, installSignalHandlers } from './core/signals.ts';
import { type FixtureSource, withRecording } from './proc/recording.ts';
import { createSpawnRunner, type ProcessRunner } from './proc/runner.ts';
import { VERSION } from './version.ts';

function readStdin(maxBytes: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stdin = process.stdin;
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      stdin.pause();
    };
    const onData = (c: Buffer): void => {
      total += c.length;
      chunks.push(c);
      if (total > maxBytes) {
        cleanup();
        stdin.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const onAbort = (): void => {
      cleanup();
      stdin.destroy();
      reject(signal.reason);
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const env = process.env;
  const shutdown = createShutdown();
  const uninstall = installSignalHandlers(shutdown, process);
  const stdout = createWritableSink(process.stdout, () => shutdown.trigger('EPIPE'));
  let proc: ProcessRunner = createSpawnRunner({ clock: realClock });
  if (env.GHX_RECORD_DIR) {
    proc = withRecording(proc, {
      dir: env.GHX_RECORD_DIR,
      source: (env.GHX_RECORD_SOURCE as FixtureSource | undefined) ?? 'live:public',
      clock: realClock,
    });
  }
  const outcome = await runCli(process.argv.slice(2), {
    registry: fsRegistry(commandRoots(env, import.meta.dirname)),
    version: VERSION,
    cwd: process.cwd(),
    env,
    clock: realClock,
    random: realRandom,
    proc,
    stdout,
    stderrLine: (line) => process.stderr.write(`${line}\n`),
    shutdown,
    stdoutIsTTY: process.stdout.isTTY === true,
    readFile: (p) => readFile(p, 'utf8'),
    readStdin,
  });
  process.exitCode = outcome.exitCode;
  if (outcome.forced) forceExit(outcome.exitCode);
  uninstall();
}

await main();
