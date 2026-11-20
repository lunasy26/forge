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
const TAIL_START = 256 * 1024;
const TAIL_MAX = 2 * 1024 * 1024;

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

/** Text without fenced blocks (an unclosed fence runs to the end), inline code and URLs. */
function stripNoise(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
}

/** 'ru' when Cyrillic is at least 30% of the letters, 'en' otherwise, null when there are too few letters to tell. */
export function detectLang(text) {
  if (typeof text !== 'string') return null;
  const clean = stripNoise(text);
  const letters = clean.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_LETTERS) return null;
  const cyrillic = clean.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  return cyrillic / letters >= CYRILLIC_SHARE ? 'ru' : 'en';
}

const WRAPPER_PREFIXES = ['<command-', '<local-command-', '<system-reminder>'];
const isWrapper = (text) => WRAPPER_PREFIXES.some((p) => text.trimStart().startsWith(p));

/** Text of a genuine user message in a transcript entry, or null (tool results, meta, wrappers, other types). */
function userMessageText(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type !== 'user' || entry.message?.role !== 'user') return null;
  if (entry.isMeta || entry.isSidechain) return null;
  const content = entry.message.content;
  let parts;
  if (typeof content === 'string') parts = [content];
  else if (Array.isArray(content)) {
    parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  } else return null;
  parts = parts.filter((p) => p.trim() && !isWrapper(p));
  return parts.length ? parts.join('\n') : null;
}

function readTail(file, size) {
  const fd = openSync(file, 'r');
  try {
    const total = fstatSync(fd).size;
    const length = Math.min(size, total);
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(fd, buf, done, length - done, total - length + done);
      if (n <= 0) break;
      done += n;
    }
    let text = buf.toString('utf8', 0, done);
    // A window that starts mid-file begins with a partial line: drop it.
    if (length < total) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { text, whole: length >= total };
  } finally {
    closeSync(fd);
  }
}

/** The latest genuine user message from the tail of a Claude Code transcript (JSONL), or null. Never throws. */
export function lastUserText(transcriptPath) {
  try {
    if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
    for (let size = TAIL_START; ; size *= 2) {
      const { text, whole } = readTail(transcriptPath, Math.min(size, TAIL_MAX));
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const found = userMessageText(entry);
        if (found !== null) return found;
      }
      if (whole || size >= TAIL_MAX) return null;
    }
  } catch {
    return null;
  }
}

const asLang = (v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LANGS.includes(s) ? s : null;
};

/**
 * Pick the message language: FORGE_LANG, profile.language, the user's latest message in the session transcript,
 * state.lang, the system locale, then English.
 */
export function resolveLang({ env = process.env, profile, state, input } = {}) {
  const fromEnv = asLang(env?.FORGE_LANG);
  if (fromEnv) return fromEnv;
  const fromProfile = asLang(profile?.language);
  if (fromProfile) return fromProfile;
  const fromText = detectLang(lastUserText(input?.transcript_path));
  if (fromText) return fromText;
  const fromState = asLang(state?.lang);
  if (fromState) return fromState;
  const locale = env?.LC_ALL || env?.LC_MESSAGES || env?.LANG || '';
  if (typeof locale === 'string' && locale.toLowerCase().startsWith('ru')) return 'ru';
  return DEFAULT_LANG;
}
