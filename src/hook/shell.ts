// A small, forgiving shell scanner (03 M12.2, M12.4): finds the simple commands inside a Bash or
// Monitor command string, so the PreToolUse hook and the acceptance scorer agree on what counts as a
// gh call, a pipe, a sleep or a loop. It is not a shell parser: it splits on operators outside quotes,
// strips env assignments and common wrappers (timeout, watch, env, nohup, perl alarm, xargs), and
// rescans `bash -c '…'` and `eval '…'` scripts and `"$(…)"` inside double quotes. Heredoc bodies are data
// (`cat > x.sh <<'EOF'`) unless a shell reads them as its script (`bash <<'EOF'`). Anything it can't
// follow (`cat <<'EOF' | bash`) is simply not matched.

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
  /** A while/until loop or a `watch` wrapper: repeats until something changes. A `for` over a fixed list
   * (`for n in 3296 3297`) is not polling on its own; with a `sleep` in it, `sleep` catches it. */
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
  /** The text before the first quote: `X=` in `X="$(…)"`, so a quoted assignment is still an assignment. */
  lead: string;
  /** Scripts of the `$(…)` and backquote substitutions inside its double quotes, which the shell runs. */
  subs: string[];
}

/** A simple command: its words, and the bodies of the heredocs that feed it. */
interface Segment {
  tokens: Token[];
  heredocs: string[];
}

interface Heredoc {
  delim: string;
  /** `<<-`: leading tabs are stripped from body lines and the delimiter line. */
  strip: boolean;
  owner: Segment;
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
const POLL_WORDS = new Set(['while', 'until']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^\d*(>>?|<<?<?|>&|<&|&>>?)(.*)$/;
const MAX_DEPTH = 3;

/** The delimiter after a `<<` at `k`, or undefined when it doesn't look like one (`$((1<<2))`). */
function heredocOperator(src: string, k: number): { delim: string; strip: boolean; end: number } | undefined {
  let strip = false;
  if (src[k] === '-') {
    strip = true;
    k++;
  }
  while (src[k] === ' ' || src[k] === '\t') k++;
  let delim = '';
  while (k < src.length && !/[\s;&|()<>]/.test(src[k] as string)) {
    const c = src[k] as string;
    if (c === "'" || c === '"') {
      const e = src.indexOf(c, k + 1);
      if (e === -1) return undefined;
      delim += src.slice(k + 1, e);
      k = e + 1;
      continue;
    }
    if (c === '\\') {
      delim += src[k + 1] ?? '';
      k += 2;
      continue;
    }
    delim += c;
    k++;
  }
  return /^[A-Za-z_][\w.-]*$/.test(delim) ? { delim, strip, end: k } : undefined;
}

/**
 * Read the bodies of the pending heredocs from `p`, the start of the line after their operators, onto their
 * segments. Returns where lexing resumes: after each delimiter line, or at a `)` right after the last
 * delimiter (`EOF)` closing a `$(cat <<EOF …`).
 */
function heredocBodies(src: string, p: number, pending: readonly Heredoc[]): number {
  for (const h of pending) {
    const start = p;
    let body: string | undefined;
    while (p < src.length) {
      const nl = src.indexOf('\n', p);
      const lineEnd = nl === -1 ? src.length : nl;
      const line = src.slice(p, lineEnd);
      const test = h.strip ? line.replace(/^\t+/, '') : line;
      if (test.trimEnd() === h.delim) {
        body = src.slice(start, p);
        p = lineEnd + 1;
        break;
      }
      if (test.startsWith(h.delim) && test.slice(h.delim.length).startsWith(')')) {
        body = src.slice(start, p);
        p += line.length - test.length + h.delim.length;
        break;
      }
      p = lineEnd + 1;
    }
    h.owner.heredocs.push(body ?? src.slice(start));
  }
  return Math.min(p, src.length);
}

/** Lexed source: its simple commands, whether any was piped, and (nested) the index of the closing `)`. */
interface Lexed {
  segs: Segment[];
  pipe: boolean;
  end: number;
}

/** The index of the backquote closing the one at `j`, or src.length. */
function backquoteEnd(src: string, j: number): number {
  let k = j + 1;
  while (k < src.length && src[k] !== '`') k += src[k] === '\\' ? 2 : 1;
  return Math.min(k, src.length);
}

/**
 * Split into simple commands, noting pipes. Heredoc bodies are data on the command they feed, not commands.
 * `nested` lexes the inside of a `$(` from `start` and stops at its unmatched `)`.
 */
function segments(src: string, start = 0, nested = false): Lexed {
  const segs: Segment[] = [];
  let seg: Segment = { tokens: [], heredocs: [] };
  let cur = '';
  let lead = '';
  let subs: string[] = [];
  let quoted = false;
  let inToken = false;
  let pipe = false;
  let depth = 0;
  let pending: Heredoc[] = [];
  const quote = (): void => {
    if (!quoted) lead = cur;
    quoted = true;
    inToken = true;
  };
  const endToken = (): void => {
    if (inToken) seg.tokens.push({ text: cur, quoted, lead: quoted ? lead : cur, subs });
    cur = '';
    lead = '';
    subs = [];
    quoted = false;
    inToken = false;
  };
  const endSeg = (): void => {
    endToken();
    if (seg.tokens.length > 0) segs.push(seg);
    seg = { tokens: [], heredocs: [] };
  };
  for (let i = start; i < src.length; i++) {
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
      quote();
      cur += src.slice(i + 1, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      quote();
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1];
          j += 2;
          continue;
        }
        // "$(…)" and "`…`" run their script; its quotes and heredocs are its own.
        if (src[j] === '$' && src[j + 1] === '(' && src[j + 2] !== '(') {
          const close = segments(src, j + 2, true).end;
          subs.push(src.slice(j + 2, close));
          cur += src.slice(j, close + 1);
          j = close + 1;
          continue;
        }
        if (src[j] === '`') {
          const close = backquoteEnd(src, j);
          subs.push(src.slice(j + 1, close));
          cur += src.slice(j, close + 1);
          j = close + 1;
          continue;
        }
        cur += src[j];
        j++;
      }
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
    if (c === '<' && next === '<' && src[i + 2] !== '<') {
      const h = heredocOperator(src, i + 2);
      if (h) {
        if (inToken && !quoted && /^\d+$/.test(cur)) inToken = false; // `0<<EOF`: the fd isn't a word
        endToken();
        pending.push({ delim: h.delim, strip: h.strip, owner: seg });
        i = h.end - 1;
        continue;
      }
    }
    if (c === '$' && next === '(') {
      endSeg();
      if (nested) depth++;
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
    if (nested && c === '(') depth++;
    if (nested && c === ')') {
      if (depth === 0) {
        endSeg();
        return { segs, pipe, end: i };
      }
      depth--;
    }
    if (c === '\n' && pending.length > 0) {
      endSeg();
      i = heredocBodies(src, i + 1, pending) - 1;
      pending = [];
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
  return { segs, pipe, end: src.length };
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
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** `bash`, `sh -s x`, `bash -e -o pipefail`: no script operand, so the shell runs its stdin. */
function runsStdin(argv: readonly string[]): boolean {
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k] as string;
    if (w === '-s') return true;
    if (w === '-o' || w === '+o') k++;
    else if (!w.startsWith('-') && !w.startsWith('+')) return false;
  }
  return true;
}

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
  /** Scan one simple command. Returns the words it rescanned as scripts, whose substitutions that covered. */
  const scanSegment = (seg: Segment): ReadonlySet<Token> => {
    const words: Token[] = [];
    for (let k = 0; k < seg.tokens.length; k++) {
      const t = seg.tokens[k] as Token;
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
          if (POLL_WORDS.has(t)) out.loop = true;
          // `for x in a b c`: no command in this segment.
          if (t === 'for' || t === 'select') {
            i = words.length;
            break;
          }
        }
        i++;
        continue;
      }
      if (ASSIGNMENT.test(w.lead)) {
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
      return new Set(rest);
    }
    const argv = rest.map((t) => t.text);
    const head = argv[0];
    if (head === undefined) return new Set();
    const b = base(head);
    if (b === 'sleep') out.sleep = true;
    if (b === 'timeout' || b === 'gtimeout') out.timeout = true;
    if (SHELLS.has(b) && argv.includes('-c')) {
      const script = rest[argv.indexOf('-c') + 1];
      if (script !== undefined) merge(scanShell(script.text, depth + 1));
      return new Set(script ? [script] : []);
    }
    // `bash <<'EOF'` runs its heredoc; any other command (cat > x.sh <<'EOF') only reads it as data.
    if (SHELLS.has(b) && seg.heredocs.length > 0 && runsStdin(argv)) {
      for (const body of seg.heredocs) merge(scanShell(body, depth + 1));
      return new Set();
    }
    if (b === 'eval') {
      merge(scanShell(argv.slice(1).join(' '), depth + 1));
      return new Set(rest);
    }
    out.invocations.push({ argv, wrappers });
    return new Set();
  };
  for (const seg of segs) {
    const scripted = scanSegment(seg);
    // "$(…)" inside double quotes: listed after the command whose word holds it, in source order.
    for (const t of seg.tokens) if (!scripted.has(t)) for (const sub of t.subs) merge(scanShell(sub, depth + 1));
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
