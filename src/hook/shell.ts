// A small, forgiving shell scanner (03 M12.2, M12.4): finds the simple commands inside a Bash or
// Monitor command string, so the PreToolUse hook and the acceptance scorer agree on what counts as a
// gh call, a pipe, a sleep or a loop. It is not a shell parser: it splits on operators outside quotes,
// strips env assignments and common wrappers (timeout, watch, env, nohup, perl alarm, xargs), and
// rescans `bash -c '…'` and `eval '…'` scripts. Anything it can't follow is simply not matched.

export interface Invocation {
  /** The command words with quotes removed: ['gh', 'pr', 'checks', '3266']. */
  argv: string[];
  /** Wrappers stripped in front of it: ['timeout'], ['watch']. */
  wrappers: string[];
}

export interface ShellScan {
  invocations: Invocation[];
  /** A `|` or `|&` outside quotes. */
  pipe: boolean;
  /** A while/until/for loop, or a `watch` wrapper. */
  loop: boolean;
  /** A `sleep` command. */
  sleep: boolean;
  /** A timeout/gtimeout wrapper or command. */
  timeout: boolean;
  /** `perl -e '… alarm …'`. */
  perlAlarm: boolean;
}

interface Token {
  text: string;
  quoted: boolean;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'in',
  'case',
  'esac',
  'select',
  'function',
  '!',
  '{',
  '}',
  'time',
]);
const LOOP_WORDS = new Set(['while', 'until', 'for', 'select']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^\d*(>>?|<<?<?|>&|<&|&>>?)(.*)$/;
const MAX_DEPTH = 3;

/** Split into simple commands (token lists), noting pipes. */
function segments(src: string): { segs: Token[][]; pipe: boolean } {
  const segs: Token[][] = [];
  let seg: Token[] = [];
  let cur = '';
  let quoted = false;
  let inToken = false;
  let pipe = false;
  const endToken = (): void => {
    if (inToken) seg.push({ text: cur, quoted });
    cur = '';
    quoted = false;
    inToken = false;
  };
  const endSeg = (): void => {
    endToken();
    if (seg.length > 0) segs.push(seg);
    seg = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '\\') {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        inToken = true;
        i++;
      }
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      cur += src.slice(i + 1, stop);
      quoted = true;
      inToken = true;
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1];
          j += 2;
          continue;
        }
        cur += src[j];
        j++;
      }
      quoted = true;
      inToken = true;
      i = j;
      continue;
    }
    if (c === '#' && !inToken) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl - 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endToken();
      continue;
    }
    if (c === '$' && next === '(') {
      endSeg();
      i++;
      continue;
    }
    if (c === '|') {
      if (next === '|') i++;
      else {
        pipe = true;
        if (next === '&') i++;
      }
      endSeg();
      continue;
    }
    if (c === '&' && next !== '>' && src[i - 1] !== '>' && src[i - 1] !== '<') {
      if (next === '&') i++;
      endSeg();
      continue;
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '(' || c === ')' || c === '`') {
      endSeg();
      continue;
    }
    cur += c;
    inToken = true;
  }
  endSeg();
  return { segs, pipe };
}

const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** Skip a wrapper's own flags (and the values of the ones listed), returning the index of the command. */
function skipFlags(words: Token[], i: number, valueFlags: ReadonlySet<string>): number {
  while (i < words.length) {
    const t = (words[i] as Token).text;
    if (t === '--') return i + 1;
    if (!t.startsWith('-') || t === '-') return i;
    i += valueFlags.has(t) ? 2 : 1;
  }
  return i;
}

const TIMEOUT_FLAGS = new Set(['-s', '--signal', '-k', '--kill-after']);
const WATCH_FLAGS = new Set(['-n', '--interval', '-d', '--differences']);
const ENV_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
const XARGS_FLAGS = new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']);

export function scanShell(command: string, depth = 0): ShellScan {
  const out: ShellScan = {
    invocations: [],
    pipe: false,
    loop: false,
    sleep: false,
    timeout: false,
    perlAlarm: false,
  };
  if (depth > MAX_DEPTH) return out;
  const { segs, pipe } = segments(command);
  out.pipe = pipe;
  const merge = (inner: ShellScan): void => {
    out.invocations.push(...inner.invocations);
    out.pipe ||= inner.pipe;
    out.loop ||= inner.loop;
    out.sleep ||= inner.sleep;
    out.timeout ||= inner.timeout;
    out.perlAlarm ||= inner.perlAlarm;
  };
  for (const seg of segs) {
    const words: Token[] = [];
    for (let k = 0; k < seg.length; k++) {
      const t = seg[k] as Token;
      const m = t.quoted ? null : REDIRECT.exec(t.text);
      if (!m) {
        words.push(t);
        continue;
      }
      if (m[2] === '') k++; // `> file`: the bare operator also takes the next word.
    }
    const wrappers: string[] = [];
    let i = 0;
    for (;;) {
      const w = words[i];
      if (!w) break;
      const t = w.text;
      if (!w.quoted && KEYWORDS.has(t)) {
        if (LOOP_WORDS.has(t)) {
          out.loop = true;
          // `for x in a b c`: no command in this segment.
          if (t === 'for' || t === 'select') {
            i = words.length;
            break;
          }
        }
        i++;
        continue;
      }
      if (!w.quoted && ASSIGNMENT.test(t)) {
        i++;
        continue;
      }
      const b = base(t);
      if (b === 'command' || b === 'exec' || b === 'nohup' || b === 'builtin' || b === 'sudo' || b === 'nice') {
        wrappers.push(b);
        i = skipFlags(words, i + 1, new Set());
        continue;
      }
      if (b === 'env') {
        wrappers.push(b);
        i = skipFlags(words, i + 1, ENV_FLAGS);
        continue;
      }
      if (b === 'timeout' || b === 'gtimeout') {
        out.timeout = true;
        wrappers.push(b);
        i = skipFlags(words, i + 1, TIMEOUT_FLAGS) + 1; // + the duration
        continue;
      }
      if (b === 'watch') {
        out.loop = true;
        wrappers.push(b);
        i = skipFlags(words, i + 1, WATCH_FLAGS);
        continue;
      }
      if (b === 'xargs') {
        wrappers.push(b);
        i = skipFlags(words, i + 1, XARGS_FLAGS);
        continue;
      }
      if (b === 'perl') {
        const e = words.findIndex((x, k) => k > i && (x.text === '-e' || x.text === '-E'));
        const script = e === -1 ? undefined : words[e + 1];
        if (script && /\balarm\b/.test(script.text)) {
          out.perlAlarm = true;
          wrappers.push('perl');
          i = e + 2;
          while (/^\d+$/.test(words[i]?.text ?? '')) i++; // perl -e 'alarm shift; exec @ARGV' 600 cmd
          continue;
        }
      }
      break;
    }
    const rest = words.slice(i);
    // One quoted argument left (watch 'gh pr checks 1', xargs sh -c '…'): rescan it as a script.
    if (rest.length === 1 && (rest[0] as Token).quoted && wrappers.length > 0) {
      merge(scanShell((rest[0] as Token).text, depth + 1));
      continue;
    }
    const argv = rest.map((t) => t.text);
    const head = argv[0];
    if (head === undefined) continue;
    const b = base(head);
    if (b === 'sleep') out.sleep = true;
    if (b === 'timeout' || b === 'gtimeout') out.timeout = true;
    if ((b === 'bash' || b === 'sh' || b === 'zsh') && argv.includes('-c')) {
      const script = argv[argv.indexOf('-c') + 1];
      if (script !== undefined) merge(scanShell(script, depth + 1));
      continue;
    }
    if (b === 'eval') {
      merge(scanShell(argv.slice(1).join(' '), depth + 1));
      continue;
    }
    out.invocations.push({ argv, wrappers });
  }
  return out;
}

/** `gh …` (or a path ending in /gh). */
export function isGh(inv: Invocation): boolean {
  return inv.argv[0] !== undefined && base(inv.argv[0]) === 'gh';
}

/** `ghx …` (or a path ending in /ghx). */
export function isGhx(inv: Invocation): boolean {
  return inv.argv[0] !== undefined && base(inv.argv[0]) === 'ghx';
}

/** `ghx ci wait …` */
export function isCiWait(inv: Invocation): boolean {
  return isGhx(inv) && inv.argv[1] === 'ci' && inv.argv[2] === 'wait';
}

/**
 * The command starts with `ghx ci wait` (after whitespace and VAR=value prefixes only), so
 * `cd x && ghx ci wait 1` and `timeout 60 ghx ci wait 1` don't count.
 */
export function startsWithCiWait(command: string): boolean {
  return /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+)*ghx\s+ci\s+wait(?:\s|$)/.test(command);
}
