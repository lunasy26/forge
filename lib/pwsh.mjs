/**
 * A small, conservative PowerShell splitter for guard checks — the PowerShell counterpart of
 * splitCommands in lib/shell.mjs. It is not a PowerShell parser: it splits a script into
 * statements and words the way argument mode reads them, strips quotes, drops redirections and
 * comments, and marks words whose value is only known at run time as dynamic.
 *
 *   splitPowerShell(src) → { commands: [{ words: [{ text, dynamic }], subs: [string], unterminated, call }] }
 *
 * - words: the statement's words in order, quotes removed. `text` is the value as written after
 *   quote and escape processing; variables ($x, ${x}, $env:X, @splat) and groups keep their source
 *   text. `dynamic` is true when the value depends on run time: a variable, splatting, $( ), @( ),
 *   @{ }, ( ), { }, or %VAR% after --%.
 * - subs: inner source texts of the outermost groups the statement holds — $( ), @( ), @{ }, ( ) and
 *   script blocks { }, also inside "…" strings and @"…"@ here-strings — so the guard can split and
 *   check them again (that is how nested groups are found). Blank groups are left out.
 * - unterminated: a quote, here-string, group or block comment never closes, a closer has no
 *   opener, a call operator or redirection has nothing after it, or the input is deeper or longer
 *   than the scanner follows. PowerShell parses a whole script before running it, so such input
 *   either does not run or cannot be read statically: the guard should ask.
 * - call: the statement starts with the call operator `&` or dot-sourcing `. `; the operator is not
 *   a word, the first word is the command (dynamic when it is a variable or a group).
 *
 * Statements end at `;`, a newline, `|`, `&&`, `||` and a background `&`; statements inside groups
 * stay inside them. Backslashes are not escapes (Windows paths stay intact); a backtick escapes
 * the next character and a backtick before a newline continues the line. Smart quotes count as
 * quotes. Commas separate array elements, so they end a word. A token that starts with a quote
 * ends at its closing quote (`"a"b` is two words), as PowerShell reads it; a quote inside an
 * unquoted token joins it (`-m:"a b"` is one word). `$x = cmd` comes out as `$x`, `=`, `cmd`.
 * `--%` is dropped and the rest of the line up to a newline or `|` is split on whitespace.
 *
 * Pure: no I/O, never throws, linear time with a step budget.
 */

/** Deepest nesting of groups and strings the scanner follows; deeper input counts as unterminated. */
const MAX_NEST = 64;

const SQ = new Set(["'", '‘', '’', '‚', '‛']);
const DQ = new Set(['"', '“', '”', '„']);
const ESC = { 0: '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

const isNl = (c) => c === '\n' || c === '\r';
const isSpace = (c) =>
  c === ' ' || c === '\t' || c === '\f' || c === '\v' || (c !== undefined && c > '\x7f' && /\s/.test(c));
const isNameChar = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Length of the newline at src[i] (1 or 2 for \r\n), 0 when there is none. */
function newlineAt(src, i) {
  if (src[i] === '\r') return src[i + 1] === '\n' ? 2 : 1;
  return src[i] === '\n' ? 1 : 0;
}

/** Scanner state with a step budget shared by all nested scans. */
function scanner(src) {
  return { src, n: src.length, left: 40 * src.length + 100000, bail: false };
}

/** One unit of work; false once the budget is spent or the scan was abandoned. */
function tick(S) {
  if (S.bail) return false;
  if (--S.left < 0) S.bail = true;
  return !S.bail;
}

const newCommand = () => ({ words: [], subs: [], unterminated: false, call: false });

/**
 * Split a PowerShell script into statements and words; see the module comment for the shape.
 * @param {string} src
 * @returns {{ commands: { words: { text: string, dynamic: boolean }[], subs: string[], unterminated: boolean, call: boolean }[] }}
 */
export function splitPowerShell(src) {
  if (typeof src !== 'string') return { commands: [] };
  const S = scanner(src);
  const r = scan(S, 0, null, 0);
  return { commands: r.commands };
}

/**
 * Statements from src[start] to the closer `close` (null at top level): { commands, end: index
 * past the closer (n when it never closes), closed, bad: some statement is unterminated }.
 */
function scan(S, start, close, d) {
  const { src, n } = S;
  if (d > MAX_NEST) {
    S.bail = true;
    return { commands: [], end: n, closed: false, bad: true };
  }
  const commands = [];
  let bad = false;
  let cmd = newCommand();
  let word = '';
  let inWord = false;
  let dynamic = false;
  let quoted = false;
  let variable = false; // the token started with a variable: `=` after it is an assignment
  let dropNext = false; // the next word is a redirection target
  let stopParsing = false; // --% was just read

  const resetWord = () => {
    word = '';
    inWord = false;
    dynamic = false;
    quoted = false;
    variable = false;
  };
  const endWord = () => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else if (!quoted && !dynamic && word === '--%') stopParsing = true;
      else cmd.words.push({ text: word, dynamic });
    }
    resetWord();
  };
  const endCommand = () => {
    endWord();
    // `&`, `.` or a redirection with nothing after it does not parse
    if (dropNext || (cmd.call && !cmd.words.length)) cmd.unterminated = true;
    if (cmd.words.length || cmd.subs.length || cmd.unterminated) {
      commands.push(cmd);
      bad ||= cmd.unterminated;
    }
    cmd = newCommand();
    dropNext = false;
    stopParsing = false;
  };
  const atStatementStart = () => !inWord && !cmd.words.length && !cmd.call && !dropNext;
  /** The group whose opener is at src[open]: its inner text goes to subs; returns the index past it. */
  const group = (open, closer) => {
    const r = scan(S, open + 1, closer, d + 1);
    const inner = src.slice(open + 1, r.closed ? r.end - 1 : n);
    if (/\S/.test(inner)) cmd.subs.push(inner);
    if (!r.closed || r.bad) cmd.unterminated = true;
    return r.end;
  };
  const startToken = () => {
    if (!inWord) {
      inWord = true;
      return true;
    }
    return false;
  };

  let i = start;
  while (i < n) {
    if (!tick(S)) break;
    if (stopParsing) {
      stopParsing = false;
      i = readVerbatim(S, i, cmd);
      continue;
    }
    const c = src[i];

    if (c === '`') {
      const nl = newlineAt(src, i + 1);
      if (nl) {
        endWord();
        i += 1 + nl;
        continue;
      }
      if (i + 1 >= n) {
        cmd.unterminated = true;
        i = n;
        break;
      }
      startToken();
      word += src[i + 1];
      quoted = true;
      i += 2;
      continue;
    }
    if (close && c === close) {
      endCommand();
      return { commands, end: i + 1, closed: true, bad };
    }
    if (c === ')' || c === '}') {
      // a closer without its opener: PowerShell does not parse the script
      endWord();
      cmd.unterminated = true;
      i++;
      continue;
    }
    if (isNl(c) || c === ';') {
      endCommand();
      i++;
      continue;
    }
    if (c === '|') {
      endCommand();
      i += src[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') {
        endCommand();
        i += 2;
        continue;
      }
      endWord();
      if (atStatementStart()) cmd.call = true;
      else endCommand(); // background job
      i++;
      continue;
    }
    if (c === '>') {
      // redirection: an n> or *> stream prefix is not a word, nor is the target unless it is &n
      if (inWord && !quoted && !dynamic && /^[1-6*]$/.test(word)) resetWord();
      else endWord();
      i++;
      if (src[i] === '>') i++;
      if (src[i] === '&' && /[1-6]/.test(src[i + 1] || '')) i += 2;
      else dropNext = true;
      continue;
    }
    if (c === '<') {
      endWord();
      if (src[i + 1] === '#') {
        const e = src.indexOf('#>', i + 2);
        if (e === -1) {
          cmd.unterminated = true;
          i = n;
        } else i = e + 2;
        continue;
      }
      cmd.unterminated = true; // `<` is reserved: the script does not parse
      i++;
      continue;
    }
    if (isSpace(c) || c === ',') {
      endWord();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && !isNl(src[i])) i++;
      continue;
    }
    if (SQ.has(c)) {
      const fresh = startToken();
      const r = readSingle(S, i + 1);
      word += r.text;
      quoted = true;
      i = r.end;
      if (!r.closed) cmd.unterminated = true;
      if (fresh) endWord();
      continue;
    }
    if (DQ.has(c)) {
      const fresh = startToken();
      const r = readExpandable(S, i + 1, cmd, d, false);
      word += r.text;
      quoted = true;
      dynamic ||= r.dynamic;
      i = r.end;
      if (!r.closed) cmd.unterminated = true;
      if (fresh) endWord();
      continue;
    }
    if (c === '@' && !inWord) {
      const q = src[i + 1];
      if (SQ.has(q) || DQ.has(q)) {
        let k = i + 2;
        while (k < n && isSpace(src[k])) k++;
        const nl = newlineAt(src, k);
        if (nl || k >= n) {
          startToken();
          const r = SQ.has(q) ? readHereLiteral(S, k + nl) : readExpandable(S, k + nl, cmd, d, true);
          word += r.text;
          quoted = true;
          dynamic ||= !!r.dynamic;
          i = r.end;
          if (!r.closed || !nl) cmd.unterminated = true;
          endWord();
          continue;
        }
        // text after a here-string header does not parse
        cmd.unterminated = true;
      } else if (q === '(' || q === '{') {
        startToken();
        const e = group(i + 1, q === '(' ? ')' : '}');
        word += src.slice(i, e);
        dynamic = true;
        i = e;
        endWord();
        continue;
      } else if (isNameChar(q)) {
        // splatting
        let k = i + 1;
        while (k < n && isNameChar(src[k])) k++;
        startToken();
        variable = true;
        word += src.slice(i, k);
        dynamic = true;
        i = k;
        continue;
      }
    }
    if (c === '$') {
      const fresh = !inWord;
      if (src[i + 1] === '(') {
        startToken();
        const e = group(i + 1, ')');
        word += src.slice(i, e);
        dynamic = true;
        i = e;
        // $( ) at the start of a token: what follows is a new argument
        if (fresh) endWord();
        continue;
      }
      const e = src[i + 1] === '{' ? bracedVariable(S, i + 1) : variableEnd(src, i);
      if (e !== -1) {
        startToken();
        if (fresh) variable = true;
        word += src.slice(i, e);
        dynamic = true;
        i = e;
        continue;
      }
      if (src[i + 1] === '{') {
        cmd.unterminated = true;
        startToken();
        word += src.slice(i);
        dynamic = true;
        i = n;
        continue;
      }
    }
    if (c === '(' || c === '{') {
      // a parameter value glued with a colon or a member call joins the word; after a literal
      // the group is a new argument
      if (inWord && !(dynamic || word.endsWith(':'))) endWord();
      const fresh = startToken();
      const e = group(i, c === '(' ? ')' : '}');
      word += src.slice(i, e);
      dynamic = true;
      i = e;
      if (fresh) endWord();
      continue;
    }
    if (c === '=' && inWord && variable) {
      endWord();
      cmd.words.push({ text: '=', dynamic: false });
      i++;
      continue;
    }
    if (c === '.' && atStatementStart()) {
      const next = src[i + 1];
      if (isSpace(next) || next === '{' || next === '(' || next === '$' || SQ.has(next) || DQ.has(next)) {
        cmd.call = true;
        i++;
        continue;
      }
    }
    startToken();
    word += c;
    i++;
  }
  // input the scanner gave up on must not pass as checked
  if (S.bail) cmd.unterminated = true;
  endCommand();
  return { commands, end: n, closed: false, bad: bad || S.bail };
}

/** Index past the name of the variable whose `$` is at src[j], or -1 when `$` is a plain character. */
function variableEnd(src, j) {
  let k = j + 1;
  const c = src[k];
  if (c === '?' || c === '^' || c === '$') return k + 1;
  if (!isNameChar(c)) return -1;
  while (isNameChar(src[k])) k++;
  // scope or drive qualifier: $env:X, $script:x
  if (src[k] === ':' && isNameChar(src[k + 1])) {
    k++;
    while (isNameChar(src[k])) k++;
  }
  return k;
}

/** Index past the `}` of ${...} whose `{` is at src[j]; -1 when it never closes. */
function bracedVariable(S, j) {
  const { src, n } = S;
  for (let k = j + 1; k < n; k++) {
    if (!tick(S)) return -1;
    if (src[k] === '`') k++;
    else if (src[k] === '}') return k + 1;
  }
  return -1;
}

/** Single-quoted text from j (past the opening quote): { text, end, closed }. */
function readSingle(S, j) {
  const { src, n } = S;
  let text = '';
  while (j < n) {
    if (!tick(S)) break;
    const c = src[j];
    if (SQ.has(c)) {
      if (SQ.has(src[j + 1])) {
        text += src[j + 1];
        j += 2;
        continue;
      }
      return { text, end: j + 1, closed: true };
    }
    text += c;
    j++;
  }
  return { text, end: n, closed: false };
}

/** True when src[j] starts a line of a here-string body that starts at `start`. */
function lineStart(src, j, start) {
  return j === start || src[j - 1] === '\n' || (src[j - 1] === '\r' && src[j] !== '\n');
}

/** Text without the newline that precedes a here-string terminator. */
function stripNewline(text) {
  return text.replace(/\r?\n$|\r$/, '');
}

/** Body of @'...'@ starting at j: { text, end, closed }; the terminator '@ must start a line. */
function readHereLiteral(S, j) {
  const { src, n } = S;
  const start = j;
  while (j < n) {
    if (!tick(S)) break;
    if (SQ.has(src[j]) && src[j + 1] === '@' && lineStart(src, j, start)) {
      return { text: stripNewline(src.slice(start, j)), end: j + 2, closed: true };
    }
    j++;
  }
  return { text: src.slice(start), end: n, closed: false };
}

/**
 * Expandable text from j: the body of "..." (j past the opening quote) or of @"..."@ (here: j at the
 * first body line). Backtick escapes are decoded; variables keep their source and make the text
 * dynamic; $( ) goes to found.subs. Returns { text, dynamic, end, closed }.
 */
function readExpandable(S, j, found, d, here) {
  const { src, n } = S;
  const start = j;
  let text = '';
  let dynamic = false;
  if (d + 1 > MAX_NEST) {
    S.bail = true;
    return { text, dynamic, end: n, closed: false };
  }
  while (j < n) {
    if (!tick(S)) break;
    const c = src[j];
    if (here) {
      if (DQ.has(c) && src[j + 1] === '@' && lineStart(src, j, start)) {
        return { text: stripNewline(text), dynamic, end: j + 2, closed: true };
      }
    } else if (DQ.has(c)) {
      if (DQ.has(src[j + 1])) {
        text += src[j + 1];
        j += 2;
        continue;
      }
      return { text, dynamic, end: j + 1, closed: true };
    }
    if (c === '`') {
      if (j + 1 >= n) break;
      const e = src[j + 1];
      if (e === 'u' && src[j + 2] === '{') {
        const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(j + 2, j + 10));
        const cp = m ? parseInt(m[1], 16) : -1;
        if (cp >= 0 && cp <= 0x10ffff) {
          text += String.fromCodePoint(cp);
          j += 2 + m[0].length;
          continue;
        }
      }
      text += ESC[e] ?? e;
      j += 2;
      continue;
    }
    if (c === '$') {
      if (src[j + 1] === '(') {
        const r = scan(S, j + 2, ')', d + 1);
        const inner = src.slice(j + 2, r.closed ? r.end - 1 : n);
        if (/\S/.test(inner)) found.subs.push(inner);
        if (!r.closed || r.bad) found.unterminated = true;
        text += src.slice(j, r.end);
        dynamic = true;
        j = r.end;
        continue;
      }
      const e = src[j + 1] === '{' ? bracedVariable(S, j + 1) : variableEnd(src, j);
      if (e !== -1) {
        text += src.slice(j, e);
        dynamic = true;
        j = e;
        continue;
      }
      if (src[j + 1] === '{') {
        found.unterminated = true;
        return { text: text + src.slice(j), dynamic: true, end: n, closed: false };
      }
    }
    text += c;
    j++;
  }
  return { text, dynamic, end: n, closed: false };
}

/**
 * The rest of the line after --%, up to a newline or `|`: words split on whitespace, double quotes
 * group and are removed, %NAME% makes a word dynamic. Returns the index of the newline or `|`.
 */
function readVerbatim(S, i, cmd) {
  const { src, n } = S;
  let word = '';
  let inWord = false;
  let inQuote = false;
  const end = () => {
    if (inWord) cmd.words.push({ text: word, dynamic: /%[^%\s]+%/.test(word) });
    word = '';
    inWord = false;
  };
  while (i < n) {
    if (!tick(S)) break;
    const c = src[i];
    if (isNl(c) || c === '|') break;
    if (c === '"') {
      inQuote = !inQuote;
      inWord = true;
    } else if ((c === ' ' || c === '\t') && !inQuote) end();
    else {
      word += c;
      inWord = true;
    }
    i++;
  }
  end();
  return i;
}
