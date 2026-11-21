// CHANGELOG.md in the Keep a Changelog format: parsing, bump suggestion, release edit, checks.
// Pure functions over text. Edits work on the original lines so that everything they do not
// touch (header, older releases, custom sections, line endings, BOM) stays byte-identical.

import { defineCatalog, t } from './i18n.mjs';
import { bumpVersion, compareVersions, parseSemver } from './semver.mjs';

// One semver implementation lives in semver.mjs; these names stay importable from here.
export { bumpVersion, compareVersions, parseSemver };

const MSG = defineCatalog({
  en: {
    noEntries: 'no entries in Unreleased',
    removedSection: 'Removed section',
    breaking: 'has BREAKING, "breaking change" or "несовместим"',
    hasSections: 'has {names}',
    and: ' and ',
    onlySections: 'only {names}',
    noSection: 'entries without a section',
    pre1: ' (before 1.0 a major bump becomes minor)',
    badVersion: 'Version "{version}" does not look like semver (x.y.z).',
    badDate: 'Date "{date}" is not in YYYY-MM-DD format.',
    noUnreleased: 'CHANGELOG has no "## [Unreleased]" section.',
    emptyUnreleased: 'The [Unreleased] section is empty: nothing to release.',
    versionExists: 'Version {version} is already in CHANGELOG.',
    issueNoUnreleased: 'No "## [Unreleased]" section: nowhere to add new entries.',
    issueBadHeading: 'Line {line}: "{heading}" is neither "## [Unreleased]" nor "## [x.y.z] — YYYY-MM-DD".',
    issueStrayLink: "Line {line}: link definition [{label}] is outside the link block at the bottom of the file: comparison links and the release won't see it.",
    issueDuplicate: 'Version {version} appears more than once.',
    issueBadDate: 'Version {version}: date "{date}" is not in YYYY-MM-DD format.',
    issueOrder: 'Version {version} is above {older}: versions must descend from top to bottom.',
    issueNoUnreleasedLink: 'No [Unreleased] in the links at the bottom.',
    issueUnreleasedLink: 'The [Unreleased] link must compare {version} with HEAD: {url}',
    issueNoLink: 'No [{version}] in the links at the bottom.',
    issueCompareLink: 'The [{version}] link must compare {older} with {version}: {url}',
    issueTagLink: 'The [{version}] link must point to tag {version}: {url}',
  },
  ru: {
    noEntries: 'нет записей в Unreleased',
    removedSection: 'раздел Removed',
    breaking: 'есть BREAKING, «breaking change» или «несовместим»',
    hasSections: 'есть {names}',
    and: ' и ',
    onlySections: 'только {names}',
    noSection: 'записи без раздела',
    pre1: ' (до 1.0 major заменяется на minor)',
    badVersion: 'Версия «{version}» не похожа на semver (x.y.z).',
    badDate: 'Дата «{date}» не в формате ГГГГ-ММ-ДД.',
    noUnreleased: 'В CHANGELOG нет раздела «## [Unreleased]».',
    emptyUnreleased: 'Раздел [Unreleased] пуст: выпускать нечего.',
    versionExists: 'Версия {version} уже есть в CHANGELOG.',
    issueNoUnreleased: 'Нет раздела «## [Unreleased]»: новые записи некуда добавлять.',
    issueBadHeading: 'Строка {line}: «{heading}» — не «## [Unreleased]» и не «## [x.y.z] — ГГГГ-ММ-ДД».',
    issueStrayLink: 'Строка {line}: определение ссылки [{label}] вне блока ссылок внизу файла — ссылки сравнения и выпуск их не увидят.',
    issueDuplicate: 'Версия {version} встречается больше одного раза.',
    issueBadDate: 'Версия {version}: дата «{date}» не в формате ГГГГ-ММ-ДД.',
    issueOrder: 'Версия {version} стоит выше {older}: версии должны убывать сверху вниз.',
    issueNoUnreleasedLink: 'В ссылках внизу нет [Unreleased].',
    issueUnreleasedLink: 'Ссылка [Unreleased] должна сравнивать {version} с HEAD: {url}',
    issueNoLink: 'В ссылках внизу нет [{version}].',
    issueCompareLink: 'Ссылка [{version}] должна сравнивать {older} с {version}: {url}',
    issueTagLink: 'Ссылка [{version}] должна вести на тег {version}: {url}',
  },
});

const UNRELEASED_RE = /^##\s+\[?Unreleased\]?\s*$/i;
const VERSION_RE = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]\s*(.*?))?\s*$/;
// The separator between version and date, spaces included, as the heading spells it.
const SEPARATOR_RE = /^##\s+\[?[^\s\]]+\]?( [—–-] )/;
const DEFAULT_SEPARATOR = ' — ';

function separatorOf(release) {
  return (release && SEPARATOR_RE.exec(release.heading)?.[1]) || DEFAULT_SEPARATOR;
}

/** The version/date separator a release would write: copied from the most recent version heading, em dash by default. */
export function releaseSeparator(text) {
  return separatorOf(scan(text).blocks.find((b) => b.kind === 'release'));
}
const SECTION_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
// `[label]: url`, optionally followed by a title ("t", 't' or (t)) and an HTML comment.
const LINK_RE = /^\[([^\]]+)\]:\s*(\S+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?(?:\s*<!--.*?-->)?\s*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STANDARD = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];
// BREAKING counts in capitals only; «breaking change» in any case. Neither inside a longer word or after
// a hyphen («non-breaking», «line breaking»).
const BREAKING_UPPER_RE = /(?<![\w-])BREAKING\b/;
const BREAKING_PHRASE_RE = /(?<![\w-])breaking change|несовместим/i;

// ---- scanning ----

function scan(input) {
  const text = String(input ?? '');
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const raw = body.split(/(?<=\n)/).filter((s) => s !== '');
  const lines = raw.map((r) => r.replace(/\r?\n$/, ''));
  const eol = /\r?\n/.exec(body)?.[0] === '\r\n' ? '\r\n' : '\n';

  // Footer: the trailing run of blank lines and `[label]: url` lines.
  let tail = lines.length;
  while (tail > 0 && (lines[tail - 1].trim() === '' || LINK_RE.test(lines[tail - 1]))) tail--;
  let footerStart = lines.length;
  const links = [];
  for (let i = tail; i < lines.length; i++) {
    const m = LINK_RE.exec(lines[i]);
    if (!m) continue;
    if (footerStart === lines.length) footerStart = i;
    links.push({ label: m[1], url: m[2], rest: m[3], line: i });
  }

  // Blocks: every `## ` heading outside code fences up to the next one.
  const starts = [];
  const strayLinks = []; // link definitions above the footer: the footer logic does not see them
  let fence = null;
  for (let i = 0; i < footerStart; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^## /.test(lines[i])) starts.push(i);
    else {
      const lm = LINK_RE.exec(lines[i]);
      if (lm) strayLinks.push({ label: lm[1], line: i });
    }
  }
  const blocks = starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : footerStart;
    const heading = lines[start];
    let kind = 'other';
    let version = null;
    let date = '';
    if (UNRELEASED_RE.test(heading)) kind = 'unreleased';
    else {
      const m = VERSION_RE.exec(heading);
      if (m && parseSemver(m[1])) {
        kind = 'release';
        version = m[1];
        date = (m[2] ?? '').trim();
      }
    }
    return { kind, start, end, heading, version, date, sections: parseSections(lines, start + 1, end) };
  });
  return { bom, raw, lines, eol, links, strayLinks, footerStart, blocks };
}

function parseSections(lines, from, to) {
  const sections = [];
  let section = null;
  let entry = null; // index into section.entries of the bullet being continued
  let blank = false;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    const sm = SECTION_RE.exec(line);
    if (sm) {
      section = { name: sm[1], entries: [] };
      sections.push(section);
      entry = null;
      blank = false;
      continue;
    }
    if (line.trim() === '') {
      blank = true;
      continue;
    }
    const bm = BULLET_RE.exec(line);
    if (bm) {
      if (!section) {
        section = { name: '', entries: [] };
        sections.push(section);
      }
      section.entries.push(bm[1].trim());
      entry = section.entries.length - 1;
      blank = false;
      continue;
    }
    // Wrapped line of the current bullet: indented, or directly after it.
    if (entry !== null && (/^\s/.test(line) || !blank)) {
      section.entries[entry] = `${section.entries[entry]} ${line.trim()}`;
      blank = false;
    }
  }
  return sections;
}

const countEntries = (sections) => sections.reduce((n, s) => n + s.entries.length, 0);

// ---- public API ----

export function parseChangelog(text) {
  const s = scan(text);
  const firstHeading = s.blocks.length ? s.blocks[0].start : s.footerStart;
  const unreleasedBlock = s.blocks.find((b) => b.kind === 'unreleased');
  return {
    header: s.raw.slice(0, firstHeading).join(''),
    unreleased: unreleasedBlock ? { sections: unreleasedBlock.sections } : null,
    releases: s.blocks
      .filter((b) => b.kind === 'release')
      .map((b) => ({ version: b.version, date: b.date, sections: b.sections })),
    links: s.links.map(({ label, url }) => ({ label, url })),
    eol: s.eol,
    bom: s.bom,
    // `## ` lines that are neither Unreleased nor a version heading (for checkChangelog).
    badHeadings: s.blocks.filter((b) => b.kind === 'other').map((b) => ({ line: b.start + 1, text: b.heading })),
  };
}

export function unreleasedEntryCount(parsed) {
  return parsed?.unreleased ? countEntries(parsed.unreleased.sections) : 0;
}

export function suggestBump(parsed, currentVersion = '0.0.0') {
  const sections = (parsed?.unreleased?.sections ?? []).filter((s) => s.entries.length);
  if (!sections.length) return { level: 'patch', reason: t(MSG, 'noEntries') };
  const current = parseSemver(currentVersion) ?? parseSemver('0.0.0');
  const std = (s) => STANDARD.includes(s.name.toLowerCase());
  const has = (name) => sections.some((s) => s.name.toLowerCase() === name);

  let level;
  let reason;
  if (has('removed')) {
    level = 'major';
    reason = t(MSG, 'removedSection');
  } else if (sections.some((s) => std(s) && s.entries.some((e) => (BREAKING_UPPER_RE.test(e) || BREAKING_PHRASE_RE.test(e))))) {
    level = 'major';
    reason = t(MSG, 'breaking');
  } else if (has('added') || has('changed')) {
    level = 'minor';
    reason = t(MSG, 'hasSections', {
      names: ['added', 'changed'].filter(has).map((n) => n[0].toUpperCase() + n.slice(1)).join(t(MSG, 'and')),
    });
  } else {
    level = 'patch';
    reason = t(MSG, 'onlySections', { names: sections.map((s) => s.name || t(MSG, 'noSection')).join(', ') });
  }
  if (level === 'major' && current.major === 0) {
    level = 'minor';
    reason += t(MSG, 'pre1');
  }
  return { level, reason };
}

export function releaseChangelog(text, { version, date, tagPrefix = 'v' } = {}) {
  if (!parseSemver(version)) throw new Error(t(MSG, 'badVersion', { version }));
  if (!isValidDate(date)) throw new Error(t(MSG, 'badDate', { date }));
  const s = scan(text);
  const unreleased = s.blocks.find((b) => b.kind === 'unreleased');
  if (!unreleased) throw new Error(t(MSG, 'noUnreleased'));
  if (countEntries(unreleased.sections) === 0) throw new Error(t(MSG, 'emptyUnreleased'));
  const releases = s.blocks.filter((b) => b.kind === 'release');
  if (releases.some((b) => compareVersions(b.version, version) === 0)) {
    throw new Error(t(MSG, 'versionExists', { version }));
  }

  // Footer links. New lines take the file's line ending; an unterminated last line stays so.
  const raw = s.raw.slice();
  const term = (i) => raw[i].slice(s.lines[i].length);
  const unreleasedLink = s.links.find((l) => l.label.toLowerCase() === 'unreleased');
  const baseSource = unreleasedLink ?? s.links.find((l) => parseSemver(l.label));
  const baseMatch = baseSource && /^(.+?)\/(?:compare|releases)\/(.*)$/.exec(baseSource.url);
  if (baseMatch) {
    const base = baseMatch[1];
    const newTag = `${tagPrefix}${version}`;
    const prev = releases[0];
    const url = prev
      ? `${base}/compare/${tagPrefix}${prev.version}...${newTag}`
      : `${base}/releases/tag/${newTag}`;
    const existing = s.links.find((l) => l.label === version);
    if (existing) raw[existing.line] = `[${version}]: ${url}${existing.rest}${term(existing.line) || s.eol}`;
    if (unreleasedLink) {
      const right = /\.\.\.(.+)$/.exec(baseMatch[2])?.[1] ?? 'HEAD';
      const i = unreleasedLink.line;
      const tail = term(i);
      raw[i] = `[${unreleasedLink.label}]: ${base}/compare/${newTag}...${right}${unreleasedLink.rest}${tail || s.eol}`;
      if (!existing) raw.splice(i + 1, 0, `[${version}]: ${url}${tail}`);
    } else if (!existing) {
      const first = s.links.find((l) => parseSemver(l.label));
      raw.splice(first.line, 0, `[${version}]: ${url}${s.eol}`);
    }
  }

  const separator = separatorOf(releases[0]);
  const body = raw.slice(unreleased.start + 1, unreleased.end);
  const nextIsHeading = unreleased.end < s.footerStart;
  const out = [
    ...raw.slice(0, unreleased.start + 1),
    s.eol,
    `## [${version}]${separator}${date}${s.eol}`,
  ];
  if (body.length && body[0].trim() !== '') out.push(s.eol);
  out.push(...body);
  if (nextIsHeading && body.length && body[body.length - 1].trim() !== '') out.push(s.eol);
  out.push(...raw.slice(unreleased.end));
  return (s.bom ? '﻿' : '') + out.join('');
}

function isValidDate(date) {
  if (!DATE_RE.test(String(date ?? ''))) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function checkChangelog(text) {
  const s = scan(text);
  const issues = [];
  const add = (code, level, message) => issues.push({ code, level, message });

  if (!s.blocks.some((b) => b.kind === 'unreleased')) {
    add('no-unreleased', 'error', t(MSG, 'issueNoUnreleased'));
  }
  for (const b of s.blocks.filter((x) => x.kind === 'other')) {
    add('bad-heading', 'warn', t(MSG, 'issueBadHeading', { line: b.start + 1, heading: b.heading }));
  }

  for (const l of s.strayLinks) {
    if (!/^unreleased$/i.test(l.label) && !parseSemver(l.label)) continue; // [kac]: ... and the like are not release links
    add('stray-link', 'warn', t(MSG, 'issueStrayLink', { line: l.line + 1, label: l.label }));
  }

  const releases = s.blocks.filter((b) => b.kind === 'release');
  const seen = new Set();
  releases.forEach((r, i) => {
    if (seen.has(r.version)) add('duplicate-version', 'error', t(MSG, 'issueDuplicate', { version: r.version }));
    seen.add(r.version);
    if (!isValidDate(r.date)) {
      add('bad-date', 'warn', t(MSG, 'issueBadDate', { version: r.version, date: r.date }));
    }
    const older = releases[i + 1];
    if (older && compareVersions(r.version, older.version) < 0) {
      add('version-order', 'error', t(MSG, 'issueOrder', { version: r.version, older: older.version }));
    }
  });

  if (s.links.length) {
    const url = (label) => s.links.find((l) => l.label === label)?.url;
    const unreleasedUrl = s.links.find((l) => l.label.toLowerCase() === 'unreleased')?.url;
    const latest = releases[0];
    if (unreleasedUrl === undefined) {
      add('link-mismatch', 'warn', t(MSG, 'issueNoUnreleasedLink'));
    } else if (latest && !compareTo(unreleasedUrl, latest.version, 'HEAD')) {
      add('link-mismatch', 'warn', t(MSG, 'issueUnreleasedLink', { version: latest.version, url: unreleasedUrl }));
    }
    releases.forEach((r, i) => {
      const u = url(r.version);
      if (u === undefined) {
        add('link-mismatch', 'warn', t(MSG, 'issueNoLink', { version: r.version }));
        return;
      }
      const older = releases[i + 1];
      if (older ? !compareTo(u, older.version, r.version) : !u.endsWith(r.version)) {
        add('link-mismatch', 'warn', older
          ? t(MSG, 'issueCompareLink', { version: r.version, older: older.version, url: u })
          : t(MSG, 'issueTagLink', { version: r.version, url: u }));
      }
    });
  }
  return issues;
}

// `…/compare/<prefix><from>...<prefix><to>` where `to` may be a ref such as HEAD.
function compareTo(url, from, to) {
  const m = /\/compare\/(.+)\.\.\.(.+)$/.exec(url);
  if (!m) return false;
  if (to === 'HEAD') return m[2] === 'HEAD' && m[1].endsWith(from);
  if (!m[2].endsWith(to)) return false;
  const prefix = m[2].slice(0, m[2].length - to.length);
  return m[1] === `${prefix}${from}`;
}
