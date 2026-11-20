import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// ---- semver ---------------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse "1.2.3", "1.2.3-rc.1" or "1.2.3+build" into { major, minor, patch, pre: string[] }, or null. */
export function parseSemver(text) {
  const m = SEMVER.exec(String(text));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** SemVer precedence: negative if a < b, 0 if equal, positive if a > b. A pre-release sorts below its release. */
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- locating the version inside a file -----------------------------------------------------
// Every locator returns spans [{ start, end }] of the version text, so a write replaces only
// those characters and keeps formatting, key order, line endings and BOM untouched.

/** Top-level "version": "x" of a JSON object. */
function locateJson(text) {
  let depth = 0;
  let i = 0;
  const readString = () => {
    const start = i + 1;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    const end = i;
    i++;
    return { start, end, value: text.slice(start, end) };
  };
  const skipWs = () => {
    while (i < text.length && /[\s﻿]/.test(text[i])) i++;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '{' || c === '[') {
      depth++;
      i++;
    } else if (c === '}' || c === ']') {
      depth--;
      i++;
    } else if (c === '"') {
      const s = readString();
      if (depth !== 1) continue;
      const after = i;
      skipWs();
      if (text[i] !== ':') {
        i = after;
        continue;
      }
      i++;
      if (s.value !== 'version') continue;
      skipWs();
      if (text[i] !== '"') return { error: '"version" не строка' };
      const v = readString();
      return { spans: [{ start: v.start, end: v.end }] };
    } else i++;
  }
  return { error: 'поле "version" не найдено' };
}

/** `version = "x"` inside one of the given TOML tables (first table in the list that has it wins). */
function locateToml(text, tables) {
  const found = {};
  let section = '';
  let offset = 0;
  for (const line of text.split('\n')) {
    const header = /^\s*(\[\[?)\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line.replace(/\r$/, ''));
    if (header) section = header[1] === '[[' ? `[[${header[2]}]]` : header[2].replace(/\s*\.\s*/g, '.');
    else if (tables.includes(section) && !found[section]) {
      const m = /^(\s*version\s*=\s*)(["'])([^"'\r\n]*)\2/.exec(line);
      if (m) {
        const start = offset + m[1].length + 1;
        found[section] = { start, end: start + m[3].length };
      }
    }
    offset += line.length + 1;
  }
  for (const t of tables) if (found[t]) return { spans: [found[t]] };
  return { error: `version не найдена в [${tables.join('] или [')}]` };
}

/** The project's own <version>: a direct child of <project>. */
function locatePom(text) {
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![\w-]+[^>]*>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  let m;
  while ((m = tag.exec(text))) {
    if (!m[2]) continue;
    const name = m[2];
    if (m[1]) {
      stack.pop();
    } else if (!m[3].endsWith('/')) {
      stack.push(name);
      if (name === 'version' && stack.length === 2 && stack[0] === 'project') {
        const from = m.index + m[0].length;
        const to = text.indexOf('<', from);
        if (to < 0) break;
        const raw = text.slice(from, to);
        const lead = raw.length - raw.trimStart().length;
        return { spans: [{ start: from + lead, end: from + lead + raw.trim().length }] };
      }
    }
  }
  return { error: '<version> проекта не найден' };
}

function locateCsproj(text) {
  const m = /<Version>(\s*)([^<]*?)\s*<\/Version>/.exec(text);
  if (!m) return { error: '<Version> не найден' };
  const start = m.index + '<Version>'.length + m[1].length;
  return { spans: [{ start, end: start + m[2].length }] };
}

/** Every occurrence of the pattern's single capture group. */
function locatePattern(text, pattern) {
  let re;
  try {
    re = new RegExp(pattern, 'gd');
  } catch (err) {
    return { error: `невалидный pattern (${err.message})` };
  }
  const spans = [];
  for (const m of text.matchAll(re)) {
    const g = m.indices && m.indices[1];
    if (g) spans.push({ start: g[0], end: g[1] });
  }
  return spans.length ? { spans } : { error: 'pattern ничего не нашёл в файле' };
}

function locatorFor(item) {
  if (typeof item === 'object' && item) return { path: item.path, locate: (text) => locatePattern(text, item.pattern) };
  const path = item;
  const name = basename(path);
  if (name === 'pyproject.toml') return { path, locate: (t) => locateToml(t, ['project', 'tool.poetry']) };
  if (name === 'Cargo.toml') return { path, locate: (t) => locateToml(t, ['package']) };
  if (name === 'pom.xml') return { path, locate: locatePom };
  if (name.endsWith('.csproj')) return { path, locate: locateCsproj };
  if (name.endsWith('.json')) return { path, locate: locateJson };
  return { path, locate: null };
}

const UNKNOWN_TYPE = 'неизвестный тип файла версии, укажи pattern';

function load(root, item) {
  const { path, locate } = locatorFor(item);
  if (!locate) return { path, error: UNKNOWN_TYPE };
  const file = join(root, path);
  if (!existsSync(file)) return { path, error: 'файл не найден' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { path, error: `не удалось прочитать файл (${err.message})` };
  }
  return { path, file, text, ...locate(text) };
}

/** Read the current version of one version file. version is null (with error) when it cannot be found. */
export function readVersion(root, item) {
  const r = load(root, item);
  if (r.error) return { path: r.path, version: null, error: r.error };
  return { path: r.path, version: r.text.slice(r.spans[0].start, r.spans[0].end) };
}

/** Replace the version in one version file, editing only the version text. Throws a Russian Error on failure. */
export function writeVersion(root, item, newVersion) {
  if (typeof newVersion !== 'string' || !/^[^\s"'<>\\]+$/.test(newVersion)) {
    throw new Error(`некорректная версия: ${JSON.stringify(newVersion)}`);
  }
  const r = load(root, item);
  if (r.error) throw new Error(`${r.path}: ${r.error}`);
  let out = r.text;
  for (const { start, end } of [...r.spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + newVersion + out.slice(end);
  }
  if (out !== r.text) {
    try {
      writeFileSync(r.file, out);
    } catch (err) {
      throw new Error(`${r.path}: не удалось записать файл (${err.message})`);
    }
  }
}

/** Read every file of release.version_files. */
export function readVersions(root, release) {
  return ((release && release.version_files) || []).map((item) => readVersion(root, item));
}
