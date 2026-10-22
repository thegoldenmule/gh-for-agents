// Output primitives (01 §3.5): a Sink that resolves only once the bytes are handed to the OS, JSON
// serialization, and text bounding. Node's stdout is asynchronous for pipes on macOS, so nothing may
// call process.exit() after a write; main.ts sets process.exitCode and lets the loop drain.

/** Default bound on one stdout document (01 §3.5, 02 §1.3). */
export const DEFAULT_MAX_BYTES = 16_384;
/** Bound on one non-terminal NDJSON line (01 §3.6). */
export const DEFAULT_MAX_EVENT_BYTES = 4_096;

export interface Sink {
  /** Writes `s` plus a newline. Resolves when the write callback fires. Never rejects on EPIPE. */
  writeLine(s: string): Promise<void>;
  /** True once the reader has gone away (EPIPE). Later writes are dropped. */
  readonly closed: boolean;
}

interface WritableLike {
  write(chunk: string, cb: (err?: Error | null) => void): boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** A Sink over a Node writable (process.stdout). `onClosed` fires once on EPIPE (signals.ts wires shutdown to it). */
export function createWritableSink(stream: WritableLike, onClosed?: () => void): Sink {
  let closed = false;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    onClosed?.();
  };
  stream.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') markClosed();
  });
  return {
    get closed() {
      return closed;
    },
    writeLine(s) {
      if (closed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stream.write(`${s}\n`, (err) => {
          if (err && (err as NodeJS.ErrnoException).code === 'EPIPE') markClosed();
          resolve();
        });
      });
    },
  };
}

/** In-memory sink for tests and the in-process harness. */
export interface MemorySink extends Sink {
  readonly lines: string[];
  text(): string;
}

export function createMemorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    closed: false,
    text: () => lines.map((l) => `${l}\n`).join(''),
    writeLine(s) {
      lines.push(s);
      return Promise.resolve();
    },
  };
}

/** Compact single-line JSON by default; 2-space indent with `pretty`. Key order is the object's own order. */
export function serializeJson(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  const cut = Buffer.from(s, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  return cut.replace(/�+$/, '');
}

export interface BoundTextOptions {
  maxLines: number;
  maxBytes: number;
  /** Which end to keep. Logs usually want the tail; prose wants the head. Default 'head'. */
  keep?: 'head' | 'tail';
}

export interface BoundedText {
  excerpt: string;
  truncated: boolean;
  totalLines: number;
}

/** Bound a text to `maxLines` lines and `maxBytes` bytes (§9.10): commands put the rest in an artifact. */
export function boundText(text: string, o: BoundTextOptions): BoundedText {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = text === '' ? 0 : lines.length;
  const tail = o.keep === 'tail';
  let kept = tail ? lines.slice(Math.max(0, lines.length - o.maxLines)) : lines.slice(0, o.maxLines);
  let truncated = kept.length < lines.length;
  let excerpt = kept.join('\n');
  if (byteLength(excerpt) > o.maxBytes) {
    truncated = true;
    if (tail) {
      while (kept.length > 1 && byteLength(kept.join('\n')) > o.maxBytes) kept = kept.slice(1);
      excerpt = kept.join('\n');
      if (byteLength(excerpt) > o.maxBytes) {
        const buf = Buffer.from(excerpt, 'utf8');
        excerpt = buf
          .subarray(buf.length - o.maxBytes)
          .toString('utf8')
          .replace(/^�+/, '');
      }
    } else {
      excerpt = truncateBytes(excerpt, o.maxBytes);
    }
  }
  return { excerpt, truncated, totalLines };
}
