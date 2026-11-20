/**
 * A small, conservative shell splitter for guard checks. It is not a shell parser:
 * it splits a command line into simple commands and words, strips quotes, drops
 * redirection targets and heredoc bodies, and marks words whose value depends on
 * runtime expansion ($VAR, $(...), backticks) as dynamic.
 */
export function splitCommands(src) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  let dynamic = false;
  let dropNext = false;
  let heredocNext = false;
  let pendingHeredocs = [];

  const endWord = () => {
    if (inWord) {
      if (heredocNext) {
        pendingHeredocs.push(word);
        heredocNext = false;
      } else if (dropNext) {
        dropNext = false;
      } else {
        words.push({ text: word, dynamic });
      }
    }
    word = '';
    inWord = false;
    dynamic = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      endCommand();
      i++;
      for (const delim of pendingHeredocs) {
        while (i < n) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl === -1 ? n : nl);
          i = nl === -1 ? n : nl + 1;
          if (line.replace(/^\t+/, '') === delim) break;
        }
      }
      pendingHeredocs = [];
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
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
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1])) {
          word += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '$' || src[i] === '`') dynamic = true;
        word += src[i];
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      word += src.slice(i, end === -1 ? n : end + 1);
      inWord = true;
      dynamic = true;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '$') {
      inWord = true;
      dynamic = true;
      const open = src[i + 1];
      if (open === '(' || open === '{') {
        const close = open === '(' ? ')' : '}';
        let depth = 0;
        let j = i + 1;
        for (; j < n; j++) {
          if (src[j] === open) depth++;
          else if (src[j] === close && --depth === 0) break;
        }
        word += src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      word += c;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
        dynamic = false;
      } else {
        endWord();
      }
      let op = c;
      i++;
      while (i < n && op.length < 3 && '<>&|-'.includes(src[i])) op += src[i++];
      if (op === '<<' || op === '<<-') heredocNext = true;
      else dropNext = true;
      continue;
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
  endCommand();
  return commands;
}

const WRAPPERS = new Set([
  'sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin',
  '{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until',
]);

/** Drop env assignments and wrappers like sudo/env/nohup in front of the real command. */
export function stripWrappers(words) {
  let i = 0;
  while (i < words.length) {
    const t = words[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(t)) {
      i++;
      while (i < words.length && words[i].text.startsWith('-')) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}
