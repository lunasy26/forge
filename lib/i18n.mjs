import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Message language for everything the user sees. Catalogs live next to the modules that use them:
 * { en: { key: string | (params) => string }, ru: { ... } }.
 * No imports from other forge modules, so any module can use this one without cycles.
 */

export const LANGS = ['en', 'ru'];

const DEFAULT_LANG = 'en';
const CYRILLIC_SHARE = 0.3;
const MIN_LETTERS = 3;
const TAIL_MAX = 8 * 1024 * 1024;

// An explicit FORGE_LANG wins even before an entry point calls initLang, so library code used
// directly (tests, scripts) speaks the requested language too.
const ENV_LANG = String(process.env.FORGE_LANG || '').trim().toLowerCase();
let current = LANGS.includes(ENV_LANG) ? ENV_LANG : DEFAULT_LANG;
const registry = [];

export function setLang(lang) {
  if (LANGS.includes(lang)) current = lang;
}

export function getLang() {
  return current;
}

/** Record a catalog so a test can check key and placeholder parity across languages. Returns it unchanged. */
export function defineCatalog(catalog) {
  registry.push(catalog);
  return catalog;
}

export function registeredCatalogs() {
  return [...registry];
}

/** Sorted unique {name} placeholders of a string message; function messages build their text themselves. */
export function placeholdersOf(message) {
  if (typeof message !== 'string') return [];
  return [...new Set([...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Look up a message in the current language, falling back to English.
 * A key missing in English is a programming error and throws.
 */
export function t(catalog, key, params = {}) {
  let message;
  if (has(catalog?.[current], key)) message = catalog[current][key];
  else if (has(catalog?.en, key)) message = catalog.en[key];
  else throw new Error(`i18n: key "${key}" is missing in the en catalog`);
  if (typeof message === 'function') return message(params);
  return message.replace(/\{(\w+)\}/g, (whole, name) => (has(params, name) && params[name] !== undefined ? String(params[name]) : whole));
}

const MAX_ANALYSED = 16 * 1024;

// Lines of logs and stack traces: English whatever language the user writes in.
const isLogLine = (line) =>
  /^\s+at /.test(line) || /^\s*Traceback\b/.test(line) || /^\s*File "[^"\n]*", line \d+/.test(line) || /^\s*[\w.$]*(?:Error|Exception)\b:/.test(line);

/**
 * Text without pasted blocks, fenced blocks (an unclosed one runs to the end), log lines, inline code and URLs.
 * Every pattern is linear: a hook runs this on whatever the user typed.
 */
function stripNoise(text) {
  return text
    .replace(/<pasted_content\b[^<>]*>[\s\S]*?(?:<\/pasted_content>|$)/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter((line) => !isLogLine(line))
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

/**
 * 'ru' when Cyrillic is at least 30% of the letters, 'en' otherwise, null when there are too few letters to tell.
 * Only the first 16 KB is analysed.
 */
export function detectLang(text) {
  if (typeof text !== 'string') return null;
  const clean = stripNoise(text.slice(0, MAX_ANALYSED));
  const letters = clean.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return null;
  const cyrillic = clean.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return cyrillic / letters >= CYRILLIC_SHARE ? 'ru' : 'en';
}

// Text parts Claude Code writes on the user's behalf: slash-command and local-command wrappers, reminders,
// background task notifications, ! shell mode, hook output, interruptions, the compaction summary.
const NOT_HUMAN_PREFIXES = [
  '<command-',
  '<local-command-',
  '<system-reminder>',
  '<task-notification',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<user-prompt-submit-hook',
  '[Request interrupted',
  'This session is being continued',
];
const IDE_BLOCK = /<(ide_opened_file|ide_selection)>[\s\S]*?(?:<\/\1>|$)|<terminal\b[^<>]*>[\s\S]*?(?:<\/terminal>|$)/g;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** The human text of one text part, or null: IDE context dropped, a slash command reduced to its arguments. */
function humanPartText(part) {
  const text = part.replace(IDE_BLOCK, '').trim();
  if (!text) return null;
  if (text.startsWith('<command-')) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
    return args || null;
  }
  return NOT_HUMAN_PREFIXES.some((p) => text.startsWith(p)) ? null : text;
}

/** Text of a message the human typed in a transcript entry, or null (tool results, meta, wrappers, other types). */
function userMessageText(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type !== 'user' || entry.message?.role !== 'user') return null;
  if (entry.isMeta || entry.isSidechain || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
  if (entry.origin?.kind !== undefined && entry.origin.kind !== 'human') return null;
  if (entry.promptSource === 'system') return null;
  const content = entry.message.content;
  let parts;
  if (typeof content === 'string') parts = [content];
  else if (Array.isArray(content)) {
    parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  } else return null;
  parts = parts.map(humanPartText).filter((p) => p !== null);
  return parts.length ? parts.join('\n') : null;
}

const CHUNK = 256 * 1024;
const NEWLINE = 0x0a;
const USER_MARK = Buffer.from('"type":"user"');
// Quotes inside JSON strings are escaped, so these only match the structure itself.
const TOOL_RESULT_MARK = Buffer.from('"type":"tool_result"');
const TEXT_MARK = Buffer.from('"type":"text"');

/**
 * Lines of the last `max` bytes of a file that contain `mark`, newest first, as Buffers. A line cut by the
 * window start is dropped. Reads backwards in chunks and only cuts out lines around a mark, so a caller
 * that stops early only pays for what it read and lines without the mark cost one indexOf.
 */
function* markedLinesFromEnd(file, max, mark) {
  const fd = openSync(file, 'r');
  try {
    const total = fstatSync(fd).size;
    const limit = Math.max(0, total - max);
    let pos = total;
    let carry = []; // the line that starts in an earlier chunk and runs into the ones read so far, in file order
    while (pos > limit) {
      const start = Math.max(limit, pos - CHUNK);
      const buf = Buffer.allocUnsafe(pos - start);
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, start + done);
        if (n <= 0) break;
        done += n;
      }
      if (done < buf.length) return; // the file shrank under us
      pos = start;
      const first = buf.indexOf(NEWLINE);
      if (first === -1) {
        carry.unshift(buf);
        continue;
      }
      // The carried line is complete now: it starts after the last newline of this chunk.
      const last = buf.lastIndexOf(NEWLINE);
      const tail = carry.length ? Buffer.concat([buf.subarray(last + 1), ...carry]) : buf.subarray(last + 1);
      if (tail.includes(mark)) yield tail;
      // Whole lines between the first and the last newline: only those around a mark.
      const marks = [];
      for (let at = buf.indexOf(mark, first + 1); at !== -1 && at < last; at = buf.indexOf(mark, at + 1)) marks.push(at);
      let floor = last; // the next line to yield ends at or before this newline
      for (let i = marks.length - 1; i >= 0; i--) {
        if (marks[i] >= floor) continue; // same line as a mark already handled
        const lineStart = buf.lastIndexOf(NEWLINE, marks[i]) + 1;
        const lineEnd = buf.indexOf(NEWLINE, marks[i]);
        yield buf.subarray(lineStart, lineEnd);
        floor = lineStart - 1;
      }
      carry = [buf.subarray(0, first)];
    }
    if (limit === 0 && carry.length) {
      const line = Buffer.concat(carry); // the first line of the file is whole
      if (line.includes(mark)) yield line;
    }
  } finally {
    closeSync(fd);
  }
}

/** Texts of the human's messages in the tail of a Claude Code transcript (JSONL), newest first. */
function* humanMessages(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return;
  // Only lines with "type":"user" are parsed: most of a transcript is assistant turns and tool output.
  for (const line of markedLinesFromEnd(transcriptPath, TAIL_MAX, USER_MARK)) {
    if (line.includes(TOOL_RESULT_MARK) && !line.includes(TEXT_MARK)) continue; // tool output without any text block
    let entry;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      continue;
    }
    const found = userMessageText(entry);
    if (found !== null) yield found;
  }
}

/** The latest message the human typed, from the tail of a Claude Code transcript (JSONL), or null. Never throws. */
export function lastUserText(transcriptPath) {
  try {
    for (const text of humanMessages(transcriptPath)) return text;
  } catch {
    // unreadable transcript: no text
  }
  return null;
}

/**
 * Language of the latest human message it can be told from ("да", "ok" are skipped for earlier ones) within
 * the transcript tail, or null. Never throws.
 */
export function transcriptLang(transcriptPath) {
  try {
    for (const text of humanMessages(transcriptPath)) {
      const lang = detectLang(text);
      if (lang) return lang;
    }
  } catch {
    // unreadable transcript: no language
  }
  return null;
}

const asLang = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LANGS.includes(s) ? s : null;
};

/**
 * Pick the message language: FORGE_LANG, profile.language, the user's latest message in the session transcript
 * (the latest one with enough letters to tell),
 * state.lang, the system locale, then English.
 */
export function resolveLang({ env = process.env, profile, state, input } = {}) {
  const fromEnv = asLang(env?.FORGE_LANG);
  if (fromEnv) return fromEnv;
  const fromProfile = asLang(profile?.language);
  if (fromProfile) return fromProfile;
  const fromText = transcriptLang(input?.transcript_path);
  if (fromText) return fromText;
  const fromState = asLang(state?.lang);
  if (fromState) return fromState;
  const locale = env?.LC_ALL || env?.LC_MESSAGES || env?.LANG || '';
  if (typeof locale === 'string' && locale.toLowerCase().startsWith('ru')) return 'ru';
  return DEFAULT_LANG;
}
