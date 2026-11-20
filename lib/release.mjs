import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseChangelog, unreleasedEntryCount } from './changelog.mjs';
import { fitList } from './docs.mjs';
import { currentBranch, defaultBranch, latestVersionTag } from './git.mjs';
import { matchList } from './glob.mjs';
import { compareSemver, parseSemver } from './semver.mjs';

// The one semver implementation is in semver.mjs; these names stay importable from here.
export { compareSemver, parseSemver };

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

/**
 * Text of the first element for which `match(stack)` holds, where stack is the chain of open elements
 * [{ name, attrs }] ending with the element itself. Comments, CDATA, processing instructions and
 * self-closing tags are skipped, so they never count as the element.
 */
function locateXmlText(text, match, error) {
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![\w-]+[^>]*>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack = [];
  let m;
  while ((m = tag.exec(text))) {
    if (!m[2]) continue;
    if (m[1]) {
      stack.pop();
    } else if (!m[3].endsWith('/')) {
      stack.push({ name: m[2], attrs: m[3] });
      if (match(stack)) {
        const from = m.index + m[0].length;
        const to = text.indexOf('<', from);
        if (to < 0) break;
        const raw = text.slice(from, to);
        const lead = raw.length - raw.trimStart().length;
        return { spans: [{ start: from + lead, end: from + lead + raw.trim().length }] };
      }
    }
  }
  return { error };
}

/** The project's own <version>: a direct child of <project>. */
function locatePom(text) {
  return locateXmlText(text, (st) => st.length === 2 && st[0].name === 'project' && st[1].name === 'version', '<version> проекта не найден');
}

/** <Version> in a Project > PropertyGroup without a Condition: never a PackageReference or a conditional group. */
function locateCsproj(text) {
  return locateXmlText(
    text,
    (st) => st.length === 3 && st[0].name === 'Project' && st[1].name === 'PropertyGroup' && !/\bCondition\s*=/.test(st[1].attrs) && st[2].name === 'Version',
    '<Version> проекта не найден (нужен Project > PropertyGroup без Condition)',
  );
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

/**
 * Read the current version of one version file. version is null (with error) when it cannot be found,
 * is not SemVer, or — for a pattern — the matches disagree with each other.
 */
export function readVersion(root, item) {
  const r = load(root, item);
  if (r.error) return { path: r.path, version: null, error: r.error };
  const found = [...new Set(r.spans.map(({ start, end }) => r.text.slice(start, end)))];
  if (found.length > 1) return { path: r.path, version: null, error: `значения по pattern расходятся: ${found.join(', ')}` };
  if (!parseSemver(found[0])) return { path: r.path, version: null, error: `версия не в формате SemVer: ${found[0]}` };
  return { path: r.path, version: found[0] };
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

// ---- Stop reminder: an empty [Unreleased] ---------------------------------------------------

/** How many reminder keys state.release.reminded keeps (the most recent ones). */
export const RELEASE_REMINDED_MAX = 20;

/**
 * Memory key of the release reminder: once per branch; on the default branch (origin/HEAD, or main/master
 * when origin is unknown) or a detached/unknown HEAD — once per latest version tag.
 */
export function releaseReminderKey(root, release) {
  const branch = currentBranch(root);
  const main = defaultBranch(root);
  const isDefault = !branch || (main ? branch === main : ['main', 'master'].includes(branch));
  if (!isDefault) return branch;
  const tag = latestVersionTag(root, release?.tag_prefix ?? '');
  return `${branch || 'HEAD'}@${tag ? tag.tag : 'none'}`;
}

/** state.release.reminded cleaned: a list of strings. */
export function releaseMemory(state) {
  const list = state?.release?.reminded;
  return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
}

/** The memory after reminding under `key`: the key moves to the end, the list keeps the newest RELEASE_REMINDED_MAX. */
export function rememberRelease(list, key) {
  return [...list.filter((k) => k !== key), key].slice(-RELEASE_REMINDED_MAX);
}

/**
 * End-of-turn reminder over the files edited in this window (relative to root): code changed (files outside
 * release.ignore, the changelog itself never counts) while [Unreleased] of the changelog has no entries.
 * Returns { reason, remember } (remember — the memory key to add to state.release.reminded) or null: no
 * release section or remind false, nothing relevant, the changelog missing (forge release --check reports it),
 * Unreleased not empty, or this branch (tag on the default branch) already reminded.
 */
export function releaseReminder(root, profile, files, state) {
  const release = profile?.release;
  if (!release || release.remind === false || !files?.length) return null;
  const changelog = (release.changelog || 'CHANGELOG.md').replace(/^(\.\/)+/, '');
  const relevant = files.filter((f) => f !== changelog && !matchList(f, release.ignore || []));
  if (!relevant.length) return null;
  const file = join(root, changelog);
  if (!existsSync(file)) return null;
  if (unreleasedEntryCount(parseChangelog(readFileSync(file, 'utf8'))) > 0) return null;
  const key = releaseReminderKey(root, release);
  if (releaseMemory(state).includes(key)) return null;
  const reason = `forge: в этой задаче менялся код (${fitList(relevant, 100)}), а в ${changelog} в [Unreleased] пусто. ` +
    'Если изменение заметно тому, кто пользуется проектом, добавь запись в нужный раздел; если нет — так и скажи и заверши работу.';
  return { reason, remember: key };
}
