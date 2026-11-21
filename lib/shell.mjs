import { win32 } from 'node:path';

/**
 * A small, conservative shell splitter for guard checks. It is not a shell parser:
 * it splits a command line into simple commands and words, strips quotes (including
 * ANSI-C $'...'), drops redirection targets and heredoc bodies, and marks words whose
 * value depends on runtime expansion ($VAR, $(...), backticks, undecoded $'\x..') as dynamic.
 * Backslash-newline is removed where bash removes it (not in single quotes, $'...',
 * comments or bodies of heredocs with a quoted delimiter).
 *
 * Commands hidden in substitutions — $(...), backticks, <(...), >(...), including those
 * nested in ${...}, $((...)), ((...)), double quotes, redirection targets and bodies of heredocs
 * with an unquoted delimiter — are collected for inspection: every command (an array of
 * words) carries `subs`, the source texts of the outermost substitutions it runs, and
 * `unterminated` when one of them never closes. Substitutions nested inside those texts
 * are found by splitting the texts again. Heredoc substitutions come as an extra
 * command without words.
 *
 * Input the splitter cannot follow — nesting deeper than MAX_NEST or more work than the step
 * budget — is reported as `unterminated` too, so the guard asks instead of overflowing the
 * stack or running into the hook timeout.
 */

/** Deepest nesting of $( " ${ $(( the scanner follows; deeper input counts as unterminated. */
const MAX_NEST = 64;

const BS = 92; // '\\'
const NL = 10; // '\n'

/** Scanner state for one string. Heredoc bodies get their own state sharing the root's budget. */
function scanner(src, root) {
  const S = { src, n: src.length, memo: new Map() };
  S.root = root || S;
  if (!root) {
    S.left = 40 * src.length + 100000;
    S.bail = false;
  }
  return S;
}

/** One unit of work; false once the budget is spent or the scan was abandoned. */
function tick(S) {
  const r = S.root;
  if (r.bail) return false;
  if (--r.left < 0) r.bail = true;
  return !r.bail;
}

/** Give up on the whole input: it is reported as unterminated. */
function bail(S) {
  S.root.bail = true;
  return S.n;
}

/** Skip backslash-newline pairs (line continuations) at j. */
function skipNl(src, j) {
  while (src.charCodeAt(j) === BS && src.charCodeAt(j + 1) === NL) j += 2;
  return j;
}

const newFound = () => ({ subs: [], unterminated: false });

export function splitCommands(src) {
  const S = scanner(src);
  const n = src.length;
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let dynamic = false;
  let quoted = false;
  let dropNext = false;
  let heredocNext = null;
  let pendingHeredocs = [];
  let found = newFound();

  const endWord = () => {
    if (inWord) {
      if (heredocNext) {
        pendingHeredocs.push({ delim: word, expand: !quoted, tabs: heredocNext === '<<-' });
        heredocNext = null;
      } else if (dropNext) {
        dropNext = false;
      } else {
        words.push({ text: word, dynamic });
      }
    }
    word = '';
    inWord = false;
    dynamic = false;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length || found.subs.length || found.unterminated) commands.push(Object.assign(words, found));
    words = [];
    found = newFound();
    dropNext = false;
    heredocNext = null;
  };
  const expansion = (end) => {
    word += src.slice(i, end);
    inWord = true;
    dynamic = true;
    i = end;
  };

  let i = 0;
  while (i < n) {
    if (!tick(S)) break;
    i = skipNl(src, i);
    if (i >= n) break;
    const c = src[i];

    if (c === '\n') {
      endCommand();
      i++;
      for (const hd of pendingHeredocs) {
        const start = i;
        const body = readHeredoc(S, i, hd);
        i = body.next;
        // an unquoted delimiter means the body is expanded: its substitutions run
        if (hd.expand) {
          const text = scanText(scanner(src.slice(start, body.end), S.root));
          if (text.subs.length || text.unterminated) commands.push(Object.assign([], text));
        }
      }
      pendingHeredocs = [];
      continue;
    }
    if (c === '\\') {
      quoted = true;
      if (i + 1 < n) {
        word += src[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      word += src.slice(i + 1, end === -1 ? n : end);
      inWord = true;
      quoted = true;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      quoted = true;
      i++;
      while (i < n) {
        if (!tick(S)) break;
        i = skipNl(src, i);
        if (i >= n || src[i] === '"') break;
        if (src[i] === '\\' && i + 1 < n && '"\\$`'.includes(src[i + 1])) {
          word += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '$' || src[i] === '`') {
          expansion(scanExpansion(S, i, true, found, 1));
          continue;
        }
        word += src[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '$') {
      const k = skipNl(src, i + 1);
      if (src[k] === "'") {
        const a = scanAnsi(src, k);
        word += a.text;
        inWord = true;
        quoted = true;
        dynamic ||= a.dynamic;
        i = a.end;
        continue;
      }
      expansion(scanExpansion(S, i, false, found, 1));
      continue;
    }
    if (c === '`') {
      expansion(scanExpansion(S, i, false, found, 1));
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if ((c === '<' || c === '>') && src[skipNl(src, i + 1)] === '(') {
      // process substitution: the word is a /dev/fd path, the commands inside run
      expansion(scanCommandSub(S, skipNl(src, i + 1), found, 1));
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[skipNl(src, i + 1)] === '>')) {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
        dynamic = false;
      } else {
        endWord();
      }
      let op = c;
      i = skipNl(src, i + 1);
      while (i < n && op.length < 3 && '<>&|-'.includes(src[i])) {
        op += src[i];
        i = skipNl(src, i + 1);
      }
      if (op === '<<' || op === '<<-') heredocNext = op;
      else dropNext = true;
      continue;
    }
    if (c === '(' && !inWord) {
      // ((...)) and for ((...)): arithmetic, not commands (no heredocs, comments or quotes inside)
      const end = arithCommand(S, i, found, 1);
      if (end !== -1) {
        endCommand();
        i = end;
        continue;
      }
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCommand();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  // input the scanner gave up on must not pass as checked
  if (S.bail) found.unterminated = true;
  endCommand();
  return commands;
}

/**
 * Body of a heredoc whose first line starts at i: { end: index where the terminator line starts,
 * next: index past it }. Only <<- strips leading tabs; an unquoted delimiter joins lines ending in
 * an unescaped backslash before the terminator is compared, as bash does.
 */
function readHeredoc(S, i, { delim, expand, tabs }) {
  const { src, n } = S;
  while (i < n) {
    if (!tick(S)) return { end: n, next: n };
    const lineStart = i;
    let line = '';
    let first = true;
    for (;;) {
      const nl = src.indexOf('\n', i);
      const e = nl === -1 ? n : nl;
      let part = src.slice(i, e);
      if (first && tabs) part = part.replace(/^\t+/, '');
      first = false;
      i = nl === -1 ? n : nl + 1;
      if (expand && nl !== -1 && oddBackslashes(src, e)) {
        line += part.slice(0, -1);
        continue;
      }
      line += part;
      break;
    }
    if (line === delim) return { end: lineStart, next: i };
  }
  return { end: n, next: n };
}

/** True when the run of backslashes ending right before index e has odd length. */
function oddBackslashes(src, e) {
  let k = e;
  while (k > 0 && src.charCodeAt(k - 1) === BS) k--;
  return (e - k) % 2 === 1;
}

const ANSI = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/**
 * ANSI-C quoted text $'...' whose opening quote is at src[q]: { end: index past the closing quote,
 * text: the decoded value, dynamic: true when it holds escapes that are not decoded (\x, \u, octal, \c) }.
 */
function scanAnsi(src, q) {
  const n = src.length;
  let text = '';
  let dynamic = false;
  let j = q + 1;
  while (j < n && src[j] !== "'") {
    if (src[j] === '\\' && j + 1 < n) {
      const e = src[j + 1];
      if (e in ANSI) text += ANSI[e];
      else {
        if (/[0-7xuUc]/.test(e)) dynamic = true;
        text += '\\' + e;
      }
      j += 2;
    } else text += src[j++];
  }
  return { end: Math.min(j + 1, n), text, dynamic };
}

/**
 * Index just past the expansion at src[i] ('$' or '`'; a lone '$' is just itself). Commands it
 * runs go to found.subs — for ${...} and $((...)) the substitutions nested inside them, since those
 * texts are not commands. inDq: inside double quotes or a heredoc body, where single quotes are
 * literal. d: nesting level.
 */
function scanExpansion(S, i, inDq, found, d) {
  if (d > MAX_NEST) return bail(S);
  const { src, n } = S;
  if (src[i] === '`') {
    let j = i + 1;
    while (j < n && src[j] !== '`') {
      if (!tick(S)) return n;
      j += src[j] === '\\' ? 2 : 1;
    }
    found.subs.push(src.slice(i + 1, Math.min(j, n)).replace(inDq ? /\\([\\`$"])/g : /\\([\\`$])/g, '$1'));
    if (j >= n) {
      found.unterminated = true;
      return n;
    }
    return j + 1;
  }
  const k = skipNl(src, i + 1);
  if (src[k] === '(') {
    // $(...) and $((...)) do not depend on the surrounding quotes: scan each once, so a failed
    // arithmetic attempt re-read as a command substitution does not rescan what is nested inside
    let hit = S.memo.get(i);
    if (!hit) {
      hit = newFound();
      const k2 = skipNl(src, k + 1);
      if (src[k2] === '(') {
        // $((...)) is arithmetic only when the inner "(" closes right before the outer ")"
        const e = scanArith(S, k2 + 1, hit, d + 1);
        const e2 = e < n ? skipNl(src, e + 1) : n;
        if (e2 < n && src[e2] === ')') hit.end = e2 + 1;
        else Object.assign(hit, newFound());
      }
      if (hit.end === undefined) hit.end = scanCommandSub(S, k, hit, d + 1);
      S.memo.set(i, hit);
    }
    found.subs.push(...hit.subs);
    found.unterminated ||= hit.unterminated;
    return hit.end;
  }
  if (src[k] === '{') {
    let j = k + 1;
    while (j < n) {
      if (!tick(S)) return n;
      j = skipNl(src, j);
      if (j >= n) break;
      const c = src[j];
      if (c === '}') return j + 1;
      if (c === '\\') j += 2;
      else if (c === "'" && !inDq) j = skipSingle(src, j);
      else if (c === '"') j = scanDouble(S, j, found, d + 1);
      else if (c === '$' && src[skipNl(src, j + 1)] === "'") j = scanAnsi(src, skipNl(src, j + 1)).end;
      else if (c === '$' || c === '`') j = scanExpansion(S, j, inDq, found, d + 1);
      else j++;
    }
    found.unterminated = true;
    return n;
  }
  return i + 1;
}

/** The command list after the "(" at src[open] goes to found.subs; returns the index past its ")". */
function scanCommandSub(S, open, found, d) {
  const end = scanParens(S, open + 1, d);
  found.subs.push(S.src.slice(open + 1, Math.min(end, S.n)));
  if (end >= S.n) {
    found.unterminated = true;
    return S.n;
  }
  return end + 1;
}

/** Arithmetic text from j: index of the ")" that closes it. Quotes other than "..." are literal. */
function scanArith(S, j, found, d) {
  if (d > MAX_NEST) return bail(S);
  const { src, n } = S;
  let depth = 0;
  while (j < n) {
    if (!tick(S)) return n;
    j = skipNl(src, j);
    if (j >= n) break;
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === '$' || c === '`') j = scanExpansion(S, j, true, found, d + 1);
    else if (c === '"') j = scanDouble(S, j, found, d + 1);
    else if (c === '(') {
      depth++;
      j++;
    } else if (c === ')') {
      if (depth === 0) return j;
      depth--;
      j++;
    } else j++;
  }
  return n;
}

/**
 * At a "(" in command position: when it opens an arithmetic command ((...)), its substitutions go to
 * found and the index past "))" is returned; -1 when it is a subshell.
 */
function arithCommand(S, i, found, d) {
  const { src, n } = S;
  const k = skipNl(src, i + 1);
  if (src[k] !== '(') return -1;
  const inner = newFound();
  const e = scanArith(S, k + 1, inner, d);
  const e2 = e < n ? skipNl(src, e + 1) : n;
  if (e2 >= n || src[e2] !== ')') return -1;
  found.subs.push(...inner.subs);
  found.unterminated ||= inner.unterminated;
  return e2 + 1;
}

/** Reserved words after which the next word is still in command position. */
const KEEP_COMMAND_POSITION = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!']);

/**
 * Index of the ")" closing the command list that starts at j, skipping quotes, nested expansions,
 * comments, heredoc bodies, arithmetic commands and case patterns (n when it never closes or cannot
 * be followed). Substitutions nested in the text are found again when the text itself is split.
 *
 * case is tracked with a stack of { state, depth }: 'word' (the subject), 'in', 'pattern' (after
 * "in", ";;", ";&", ";;&": only a bare esac ends the case here), 'inpattern' (up to its ")") and
 * 'body' (commands). Reserved words count only in command position and only when written plainly.
 * Anything unexpected gives up (n), which the guard turns into ask.
 */
function scanParens(S, j, d) {
  if (d > MAX_NEST) return bail(S);
  const { src, n } = S;
  const nested = newFound();
  let depth = 0;
  const cases = [];
  let heredocs = [];
  let giveUp = false;
  let commandPos = true;
  let afterPipe = false;
  let lead = null; // 'function' | 'time' | 'coproc': the word before changes what the next one is
  let inWord = false;
  let wordAtCommand = false;
  let wordAfterPipe = false;
  let plain = '';
  const top = () => cases[cases.length - 1];
  const inPattern = () => top() && (top().state === 'pattern' || top().state === 'inpattern');
  const startWord = (ch) => {
    if (!inWord) {
      inWord = true;
      wordAtCommand = commandPos;
      wordAfterPipe = afterPipe;
      plain = '';
    }
    plain = ch && plain !== null && plain.length < 8 ? plain + ch : null;
  };
  const endWord = () => {
    if (!inWord) return;
    inWord = false;
    const c = top();
    if (c && c.state === 'word') c.state = 'in';
    else if (c && c.state === 'in') {
      if (plain === 'in') c.state = 'pattern';
      else giveUp = true;
    } else if (c && c.state === 'pattern') {
      if (plain === 'esac') {
        cases.pop();
        commandPos = false;
      } else c.state = 'inpattern';
    } else if (!c || c.state === 'body') commandWord(c);
  };
  const commandWord = (c) => {
    const prev = lead;
    lead = null;
    afterPipe = false;
    if (wordAtCommand) {
      if (plain === 'case') {
        cases.push({ state: 'word', depth });
        commandPos = false;
        return;
      }
      if (plain === 'esac' && c && !wordAfterPipe) {
        cases.pop();
        commandPos = false;
        return;
      }
      if (plain === 'function' || plain === 'time' || plain === 'coproc') {
        lead = plain;
        commandPos = plain !== 'function';
        return;
      }
      if (KEEP_COMMAND_POSITION.has(plain)) return;
      if (prev === 'time' && (plain === '-p' || plain === '--')) return;
      // coproc NAME { ... }: the optional name may be followed by a command
      if (prev === 'coproc') return;
    }
    // function NAME [()] { ... }: the body follows the name
    commandPos = prev === 'function';
  };
  while (j < n) {
    if (giveUp || !tick(S)) return n;
    j = skipNl(src, j);
    if (j >= n) break;
    const c = src[j];
    if (c === '\\') {
      startWord(null);
      j += 2;
    } else if (c === "'") {
      startWord(null);
      j = skipSingle(src, j);
    } else if (c === '"') {
      startWord(null);
      j = scanDouble(S, j, nested, d + 1);
    } else if (c === '$' && src[skipNl(src, j + 1)] === "'") {
      startWord(null);
      j = scanAnsi(src, skipNl(src, j + 1)).end;
    } else if (c === '$' || c === '`') {
      startWord(null);
      j = scanExpansion(S, j, false, nested, d + 1);
    } else if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', j);
      j = nl === -1 ? n : nl;
    } else if (c === '(') {
      if (!inWord && top()?.state === 'pattern') {
        // the optional "(" in front of a case pattern
        top().state = 'inpattern';
        j++;
        continue;
      }
      const arith = inWord || inPattern() ? -1 : arithCommand(S, j, nested, d + 1);
      endWord();
      if (arith !== -1) {
        j = arith;
        commandPos = false;
      } else {
        depth++;
        commandPos = true;
        j++;
      }
    } else if (c === ')') {
      endWord();
      const t = top();
      if (t && inPattern() && depth === t.depth) {
        // end of a case pattern: commands follow
        t.state = 'body';
        commandPos = true;
      } else if (depth > (t ? t.depth : 0)) {
        // end of a subshell, or of the () in "name()"
        depth--;
        commandPos = true;
      } else if (!t) return j;
      else return n;
      j++;
    } else if (c === '<' || c === '>') {
      endWord();
      let op = c;
      j = skipNl(src, j + 1);
      while (j < n && op.length < 3 && '<>&|-'.includes(src[j])) {
        op += src[j];
        j = skipNl(src, j + 1);
      }
      if (op === '<<' || op === '<<-') {
        const hd = readDelimiter(S, j);
        j = hd.end;
        if (hd.word) heredocs.push({ delim: hd.delim, expand: !hd.quoted, tabs: op === '<<-' });
      }
      commandPos = false;
    } else if (c === '\n') {
      endWord();
      j++;
      for (const hd of heredocs) {
        const body = subHeredoc(S, j, hd);
        if (!body) return n;
        j = body.next;
        if (body.glued) break;
      }
      heredocs = [];
      if (!inPattern() && top()?.state !== 'word' && top()?.state !== 'in') commandPos = true;
      lead = null;
    } else if (c === ';' || c === '&' || c === '|') {
      endWord();
      const t = top();
      if (t && inPattern()) {
        // "|" separates alternatives of a pattern; anything else is not a pattern
        if (c !== '|') return n;
        t.state = 'inpattern';
        j++;
        continue;
      }
      if (c === ';' && t && t.state === 'body') {
        // ;; ;& ;;& end a case item: a pattern or esac follows
        let k = skipNl(src, j + 1);
        if (src[k] === ';' || src[k] === '&') {
          if (src[k] === ';' && src[skipNl(src, k + 1)] === '&') k = skipNl(src, k + 1);
          t.state = 'pattern';
          commandPos = false;
          lead = null;
          j = k + 1;
          continue;
        }
      }
      commandPos = true;
      afterPipe = c === '|' && src[j - 1] !== '|';
      lead = null;
      j++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      j++;
    } else {
      startWord(c);
      j++;
    }
  }
  return n;
}

/**
 * A heredoc body read inside $(...), starting at i: { next, glued }, or null when bash versions
 * would end it in different places. bash 3.2 and 5 both end it at the delimiter line and at the
 * delimiter followed by ")" — scanning then resumes at that ")" (glued). bash 5 also ends it at a
 * line that merely starts with the delimiter, and joins backslash-newline before comparing an
 * unquoted delimiter while bash 3.2 does not: those cases return null.
 */
function subHeredoc(S, i, hd) {
  const plain = heredocTerminator(S, i, hd, false);
  if (!hd.expand) return plain;
  const joined = heredocTerminator(S, i, hd, true);
  return plain && joined && plain.next === joined.next ? plain : null;
}

function heredocTerminator(S, i, { delim, tabs }, join) {
  const { src, n } = S;
  while (i < n) {
    if (!tick(S)) return { next: n, glued: false };
    let line = '';
    let parts = 0;
    let textStart = i;
    for (;;) {
      const nl = src.indexOf('\n', i);
      const e = nl === -1 ? n : nl;
      let part = src.slice(i, e);
      if (parts === 0 && tabs) {
        const stripped = part.replace(/^\t+/, '');
        textStart = i + part.length - stripped.length;
        part = stripped;
      }
      parts++;
      i = nl === -1 ? n : nl + 1;
      if (join && nl !== -1 && oddBackslashes(src, e)) {
        line += part.slice(0, -1);
        continue;
      }
      line += part;
      break;
    }
    if (parts > 1 && line.startsWith(delim)) return null; // only the joined reading ends here
    if (line === delim) return { next: i, glued: false };
    if (delim && line.startsWith(delim)) {
      return line[delim.length] === ')' ? { next: textStart + delim.length, glued: true } : null;
    }
  }
  return { next: n, glued: false };
}

/** The heredoc delimiter word after "<<" at j: { delim, quoted, word: whether there was one, end }. */
function readDelimiter(S, j) {
  const { src, n } = S;
  for (j = skipNl(src, j); src[j] === ' ' || src[j] === '\t'; ) j = skipNl(src, j + 1);
  let delim = '';
  let quoted = false;
  let word = false;
  while (j < n) {
    if (!tick(S)) return { delim, quoted, word, end: n };
    j = skipNl(src, j);
    if (j >= n || /[\s;&|()<>]/.test(src[j])) break;
    word = true;
    const c = src[j];
    if (c === "'" || c === '"') {
      const e = src.indexOf(c, j + 1);
      delim += src.slice(j + 1, e === -1 ? n : e);
      quoted = true;
      j = e === -1 ? n : e + 1;
    } else if (c === '$' && src[skipNl(src, j + 1)] === "'") {
      const a = scanAnsi(src, skipNl(src, j + 1));
      delim += a.text;
      quoted = true;
      j = a.end;
    } else if (c === '\\') {
      delim += src[j + 1] ?? '';
      quoted = true;
      j += 2;
    } else delim += src[j++];
  }
  return { delim, quoted, word, end: j };
}

function skipSingle(src, j) {
  const end = src.indexOf("'", j + 1);
  return end === -1 ? src.length : end + 1;
}

/** Index past the double-quoted string opening at src[j] (n when it never closes). */
function scanDouble(S, j, found, d) {
  if (d > MAX_NEST) return bail(S);
  const { src, n } = S;
  j++;
  while (j < n) {
    if (!tick(S)) return n;
    j = skipNl(src, j);
    if (j >= n) break;
    const c = src[j];
    if (c === '"') return j + 1;
    if (c === '\\') j += 2;
    else if (c === '$' || c === '`') j = scanExpansion(S, j, true, found, d + 1);
    else j++;
  }
  return n;
}

/** Substitutions in text that is expanded but not split into words (a heredoc body). */
function scanText(S) {
  const found = newFound();
  const { src, n } = S;
  for (let j = 0; j < n; ) {
    if (!tick(S)) break;
    j = skipNl(src, j);
    if (j >= n) break;
    if (src[j] === '\\') j += 2;
    else if (src[j] === '$' || src[j] === '`') j = scanExpansion(S, j, true, found, 1);
    else j++;
  }
  if (S.root.bail) found.unterminated = true;
  return found;
}

/**
 * Command name as the shell finds it: the last path segment (split on "/" and "\" alike), lowercased,
 * without ".exe" — git.exe, GIT, C:\Git\cmd\git.exe and /usr/bin/git are all git. Lowercasing is
 * right for Windows' case-insensitive file system; on Linux a command named GIT that is not git is
 * not a realistic false positive.
 */
export function commandName(text) {
  return win32.basename(text).toLowerCase().replace(/\.exe$/, '');
}

/**
 * Wrappers: commands that run the rest of the line. Recognised by normalised name (/usr/bin/env, SUDO,
 * env.exe). Per wrapper:
 *   arg      short options that take an argument (-u root, -uroot, -Eu root)
 *   flags    short options that take none
 *   longArg  long options that take an argument (--user root, --user=root)
 *   longFlag long options that take none (or only an attached =value, like env --default-signal=INT)
 *   pos      leading positional words before the command (timeout's duration, chrt's priority, taskset's mask)
 *   script   option whose argument env splits into words of its own (env -S); see splitEnvString
 *   joined   the rest is joined into one string run by `sh -c` (watch)
 * A word starting with "-" that the table does not know makes the wrapper's option list uncertain; see
 * the safety net in stripWrappers. The tables list what real versions accept, they are not exhaustive:
 * an option left out is caught by the safety net, an option listed with the wrong arity hides a command,
 * so list only what you are sure of.
 */
const DIGITS = '0123456789';
const WRAPPER_SPECS = {
  sudo: {
    arg: 'ugChprtUDR',
    flags: 'AbEeHiKklnPSVvBN',
    longArg: ['user', 'group', 'close-from', 'host', 'prompt', 'role', 'type', 'other-user', 'chdir', 'chroot', 'command-timeout'],
    longFlag: ['askpass', 'background', 'bell', 'edit', 'help', 'login', 'list', 'non-interactive', 'preserve-env', 'remove-timestamp', 'reset-timestamp', 'set-home', 'shell', 'stdin', 'validate', 'version'],
  },
  doas: { arg: 'uC', flags: 'nsL' },
  // GNU coreutils and macOS/BSD (-P altpath)
  env: {
    arg: 'uCSaP',
    flags: 'i0v',
    longArg: ['unset', 'chdir', 'split-string', 'argv0'],
    longFlag: ['ignore-environment', 'null', 'debug', 'help', 'version', 'default-signal', 'ignore-signal', 'block-signal', 'list-signal-handling'],
    script: ['S', 'split-string'],
  },
  nice: { arg: 'n', flags: DIGITS, longArg: ['adjustment'], longFlag: ['help', 'version'] },
  time: { arg: 'fo', flags: 'apvVhq', longArg: ['format', 'output'], longFlag: ['append', 'portability', 'verbose', 'quiet', 'help', 'version'] },
  timeout: {
    arg: 'sk',
    flags: 'v',
    longArg: ['signal', 'kill-after'],
    longFlag: ['foreground', 'preserve-status', 'verbose', 'help', 'version'],
    pos: 1,
  },
  xargs: {
    arg: 'ILnPsdEaJRS',
    flags: '0opr' + 'txeil',
    longArg: ['max-args', 'max-lines', 'max-procs', 'max-chars', 'delimiter', 'eof', 'arg-file', 'process-slot-var'],
    longFlag: ['null', 'interactive', 'no-run-if-empty', 'verbose', 'exit', 'open-tty', 'show-limits', 'replace', 'help', 'version'],
  },
  stdbuf: { arg: 'ioe', longArg: ['input', 'output', 'error'], longFlag: ['help', 'version'] },
  ionice: { arg: 'cnpPu', flags: 't', longArg: ['class', 'classdata', 'pid', 'pgid', 'uid'], longFlag: ['ignore', 'help', 'version'] },
  chrt: {
    arg: 'TPDp',
    flags: 'fribodRmahvV',
    longArg: ['sched-runtime', 'sched-deadline', 'sched-period', 'pid'],
    longFlag: ['fifo', 'rr', 'batch', 'other', 'idle', 'deadline', 'reset-on-fork', 'max', 'all-tasks', 'verbose', 'help', 'version'],
    pos: 1,
  },
  taskset: { arg: '', flags: 'capR', longFlag: ['cpu-list', 'pid', 'all-tasks', 'help', 'version'], pos: 1 },
  // procps-ng: -n/--interval and -q/--equexit take a value; -d takes only an attached one (--differences=permanent)
  watch: {
    arg: 'nq',
    flags: 'bcCdeghprtvwx',
    longArg: ['interval', 'equexit'],
    longFlag: ['beep', 'color', 'no-color', 'differences', 'errexit', 'chgexit', 'precise', 'no-rerun', 'no-title', 'no-wrap', 'exec', 'help', 'version'],
    joined: true,
  },
  command: { flags: 'pvV' },
  exec: { arg: 'a', flags: 'cl' },
  nohup: { longFlag: ['help', 'version'] },
  builtin: {},
};
for (const spec of Object.values(WRAPPER_SPECS)) {
  spec.arg ??= '';
  spec.flags ??= '';
  spec.longArg = new Set(spec.longArg);
  spec.longFlag = new Set(spec.longFlag);
}
/** The wrapper spec for a command word, or undefined (own keys only: `constructor` is not a wrapper). */
const wrapperSpec = (text) => {
  const name = commandName(text);
  return Object.hasOwn(WRAPPER_SPECS, name) ? WRAPPER_SPECS[name] : undefined;
};
/** Shell keywords: only the exact word counts (there is no /usr/bin/if). */
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
/** POSIX shells whose `-c` script the guards check again. */
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/**
 * Commands (by commandName) the Bash guard has rules for: git, rm, eval, the shells, and PowerShell and
 * cmd started from Bash. The safety net in stripWrappers looks for them; checkWords in guards.mjs
 * dispatches on the same names — keep the two in step.
 */
export const GUARDED = new Set(['git', 'rm', 'eval', ...SHELLS, 'pwsh', 'powershell', 'cmd']);

/** Where the safety net may land: a guarded command or another wrapper (stripped with its own table). */
const isTarget = (text) => GUARDED.has(commandName(text)) || wrapperSpec(text) !== undefined;

const word = (text) => ({ text, dynamic: false });

/**
 * What stripWrappers returns for a line it cannot take apart (an env -S string env itself would reject):
 * a script with an unterminated substitution, which checkBash already turns into an ask.
 */
const UNCHECKABLE = () => [word('sh'), word('-c'), word('$(')];

/** How deep env -S strings may nest (-S inside an -S string); deeper ones are UNCHECKABLE. */
const MAX_SPLIT_DEPTH = 8;

const ENV_SPACE = ' \t\n\v\f\r';
const ENV_ESCAPES = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/**
 * Split an env -S string into words the way env does (GNU coreutils; BSD env follows the same rules):
 * whitespace and \_ separate words, '…' keeps everything but \\ and \', "…" decodes escapes and turns
 * \_ into a space, \c ends the string, # at the start of a word starts a comment, ${VAR} is expanded by
 * env (the word becomes dynamic). ; | & and the like are ordinary characters. An escape env does not know
 * makes env fail; here it stands for its character, which keeps `g\it` visible as git. Returns the words
 * (dynamic when the source word was), or null when env would reject the string (unterminated quote or
 * ${, trailing backslash, \c inside double quotes).
 */
function splitEnvString(s, dynamicSource) {
  const out = [];
  let cur = '';
  let inWord = false;
  let dynamic = false;
  let quote = null;
  const end = () => {
    if (inWord) out.push({ text: cur, dynamic: dynamic || dynamicSource });
    cur = '';
    inWord = false;
    dynamic = false;
  };
  let i = 0;
  scan: while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else if (c === '\\' && (s[i + 1] === '\\' || s[i + 1] === "'")) cur += s[++i];
      else cur += c;
      i++;
      continue;
    }
    if (c === '\\') {
      const e = s[i + 1];
      if (e === undefined) return null;
      i += 2;
      if (e === 'c') {
        if (quote) return null;
        break scan;
      }
      inWord = true;
      if (e === '_') {
        if (quote) cur += ' ';
        else end();
      } else {
        cur += ENV_ESCAPES[e] ?? e;
      }
      continue;
    }
    if (c === '$') {
      // env expands ${VAR} (and rejects a bare $): the value is known only at run time
      if (s[i + 1] === '{') {
        const close = s.indexOf('}', i + 2);
        if (close === -1) return null;
        cur += s.slice(i, close + 1);
        i = close + 1;
      } else {
        cur += c;
        i++;
      }
      inWord = true;
      dynamic = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (ENV_SPACE.includes(c)) end();
    else if (c === '#' && !inWord) break;
    else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else {
      cur += c;
      inWord = true;
    }
    i++;
  }
  if (quote) return null;
  end();
  return out;
}

/**
 * The words of a command as a stream: env -S pushes the words of its string in front of the rest.
 * `front` is a stack (next word last), so splicing costs only the spliced words.
 */
class WordStream {
  constructor(words) {
    this.words = words;
    this.i = 0;
    this.front = [];
    this.depth = new WeakMap(); // spliced word -> how many -S strings it came out of
    this.next = null; // lazily: next[k] = index of the first target at or after words[k]
  }
  get done() {
    return !this.front.length && this.i >= this.words.length;
  }
  peek() {
    return this.front.length ? this.front[this.front.length - 1] : this.words[this.i];
  }
  shift() {
    return this.front.length ? this.front.pop() : this.words[this.i++];
  }
  unshift(list, depth) {
    for (let k = list.length - 1; k >= 0; k--) {
      this.depth.set(list[k], depth);
      this.front.push(list[k]);
    }
  }
  rest() {
    return this.front.length ? [...this.front].reverse().concat(this.words.slice(this.i)) : this.words.slice(this.i);
  }
  /** Move to the first later word that isTarget; stay put when there is none. Linear over all calls. */
  jumpToTarget() {
    for (let k = this.front.length - 2; k >= 0; k--) {
      if (isTarget(this.front[k].text)) {
        this.front.length = k + 1;
        return;
      }
    }
    if (!this.next) {
      const n = this.words.length;
      this.next = new Int32Array(n + 1);
      this.next[n] = n;
      for (let k = n - 1; k >= 0; k--) this.next[k] = isTarget(this.words[k].text) ? k : this.next[k + 1];
    }
    // with an empty front the current word is words[i], which is not a target itself
    const j = this.next[this.i];
    if (j < this.words.length) {
      this.front.length = 0;
      this.i = j;
    }
  }
}

/**
 * Skip a wrapper's options (and the arguments of those that take one) at the head of the stream.
 * The argument of the spec's `script` option is split with env rules and its words are put back in front
 * of the stream, so options among them are read as the wrapper's options again — as env does.
 * Returns { uncertain: an option the table does not know was seen, broken: a script string env would
 * reject }.
 */
function skipOptions(stream, spec) {
  let uncertain = false;
  let broken = false;
  const take = (name, from, attached) => {
    const value = attached !== undefined ? { text: attached, dynamic: from.dynamic } : stream.done ? null : stream.shift();
    if (!value || !spec.script?.includes(name)) return;
    const depth = (stream.depth.get(attached !== undefined ? from : value) ?? 0) + 1;
    const split = depth <= MAX_SPLIT_DEPTH ? splitEnvString(value.text, value.dynamic) : null;
    if (split) stream.unshift(split, depth);
    else broken = true;
  };
  while (!broken && !stream.done && stream.peek().text.startsWith('-')) {
    const w = stream.shift();
    const t = w.text;
    if (t === '--') break;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = t.slice(2, eq === -1 ? undefined : eq);
      if (spec.longArg.has(name)) take(name, w, eq === -1 ? undefined : t.slice(eq + 1));
      else if (!spec.longFlag.has(name) && eq === -1) uncertain = true;
      continue;
    }
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (spec.arg.includes(c)) {
        take(c, w, k + 1 < t.length ? t.slice(k + 1) : undefined);
        break;
      }
      if (!spec.flags.includes(c)) uncertain = true;
    }
  }
  return { uncertain, broken };
}

/**
 * Drop env assignments and wrappers like sudo/env/nohup/timeout/xargs in front of the real command,
 * together with their options and the arguments of those options (nice -n 5, sudo -u root, timeout -s KILL 10).
 *
 * Safety net: the tables cannot know every option of every version. When a wrapper had an option the table
 * does not know, its argument may be left standing as the "command" (`sudo --made-up value git push`); then,
 * if that word is neither a guarded command (git, rm, a shell, eval…) nor a wrapper, we continue from the
 * first later word that is one of them — a nested wrapper is then stripped with its own table, so the value
 * of its options is not taken for the command. A false ask/deny on `sudo --made-up echo git push` is better
 * than a silent allow. Without an unknown option nothing jumps, so `sudo echo git push` and `sudo -u git ls`
 * keep their real command.
 *
 * env -S splices the words of its string in place (see splitEnvString); watch hands the rest of the line
 * to `sh -c`, so it becomes `sh -c <line>` and the guard re-checks it.
 */
export function stripWrappers(words) {
  const stream = new WordStream(words);
  while (!stream.done) {
    const t = stream.peek().text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      stream.shift();
      continue;
    }
    if (KEYWORDS.has(t)) {
      stream.shift();
      while (!stream.done && stream.peek().text.startsWith('-')) stream.shift();
      continue;
    }
    const spec = wrapperSpec(t);
    if (!spec) break;
    stream.shift();
    const opts = skipOptions(stream, spec);
    if (opts.broken) return UNCHECKABLE();
    for (let k = 0; k < (spec.pos ?? 0) && !stream.done; k++) stream.shift();
    if (opts.uncertain && !stream.done && !isTarget(stream.peek().text)) stream.jumpToTarget();
    if (spec.joined) {
      const rest = stream.rest();
      return rest.length ? [word('sh'), word('-c'), word(rest.map((w) => w.text).join(' '))] : [];
    }
  }
  return stream.rest();
}
