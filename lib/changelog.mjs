// CHANGELOG.md in the Keep a Changelog format: parsing, bump suggestion, release edit, checks.
// Pure functions over text. Edits work on the original lines so that everything they do not
// touch (header, older releases, custom sections, line endings, BOM) stays byte-identical.

const UNRELEASED_RE = /^##\s+\[?Unreleased\]?\s*$/i;
const VERSION_RE = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?\s*(?:[—–-]\s*(.*?))?\s*$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const LINK_RE = /^\[([^\]]+)\]:\s*(\S+)\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STANDARD = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'];

// ---- semver ----

export function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative, 0 or positive (build metadata ignored). */
export function compareVersions(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Не версия semver: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // release > pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Next version for a bump level; a pre-release suffix is dropped (1.0.0-rc.1 + patch -> 1.0.1). */
export function bumpVersion(version, level) {
  const v = parseSemver(version);
  if (!v) throw new Error(`Не версия semver: ${version}`);
  if (level === 'major') return `${v.major + 1}.0.0`;
  if (level === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (level === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  throw new Error(`Неизвестный уровень повышения версии: ${level}`);
}

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
    links.push({ label: m[1], url: m[2], line: i });
  }

  // Blocks: every `## ` heading outside code fences up to the next one.
  const starts = [];
  let fence = null;
  for (let i = 0; i < footerStart; i++) {
    const f = /^\s*(```|~~~)/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1];
      else if (fence === f[1]) fence = null;
      continue;
    }
    if (!fence && /^## /.test(lines[i])) starts.push(i);
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
  return { bom, raw, lines, eol, links, footerStart, blocks };
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
  if (!sections.length) return { level: 'patch', reason: 'нет записей в Unreleased' };
  const current = parseSemver(currentVersion) ?? parseSemver('0.0.0');
  const std = (s) => STANDARD.includes(s.name.toLowerCase());
  const has = (name) => sections.some((s) => s.name.toLowerCase() === name);

  let level;
  let reason;
  if (has('removed')) {
    level = 'major';
    reason = 'раздел Removed';
  } else if (sections.some((s) => std(s) && s.entries.some((e) => /BREAKING|несовместим/i.test(e)))) {
    level = 'major';
    reason = 'есть BREAKING или «несовместим»';
  } else if (has('added') || has('changed')) {
    level = 'minor';
    reason = `есть ${['added', 'changed'].filter(has).map((n) => n[0].toUpperCase() + n.slice(1)).join(' и ')}`;
  } else {
    level = 'patch';
    reason = `только ${sections.map((s) => s.name || 'записи без раздела').join(', ')}`;
  }
  if (level === 'major' && current.major === 0) {
    level = 'minor';
    reason += ' (до 1.0 major заменяется на minor)';
  }
  return { level, reason };
}

export function releaseChangelog(text, { version, date, tagPrefix = 'v' } = {}) {
  if (!parseSemver(version)) throw new Error(`Версия «${version}» не похожа на semver (x.y.z).`);
  if (!isValidDate(date)) throw new Error(`Дата «${date}» не в формате ГГГГ-ММ-ДД.`);
  const s = scan(text);
  const unreleased = s.blocks.find((b) => b.kind === 'unreleased');
  if (!unreleased) throw new Error('В CHANGELOG нет раздела «## [Unreleased]».');
  if (countEntries(unreleased.sections) === 0) throw new Error('Раздел [Unreleased] пуст: выпускать нечего.');
  const releases = s.blocks.filter((b) => b.kind === 'release');
  if (releases.some((b) => compareVersions(b.version, version) === 0)) {
    throw new Error(`Версия ${version} уже есть в CHANGELOG.`);
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
    if (existing) raw[existing.line] = `[${version}]: ${url}${term(existing.line) || s.eol}`;
    if (unreleasedLink) {
      const right = /\.\.\.(.+)$/.exec(baseMatch[2])?.[1] ?? 'HEAD';
      const i = unreleasedLink.line;
      const t = term(i);
      raw[i] = `[${unreleasedLink.label}]: ${base}/compare/${newTag}...${right}${t || s.eol}`;
      if (!existing) raw.splice(i + 1, 0, `[${version}]: ${url}${t}`);
    } else if (!existing) {
      const first = s.links.find((l) => parseSemver(l.label));
      raw.splice(first.line, 0, `[${version}]: ${url}${s.eol}`);
    }
  }

  const body = raw.slice(unreleased.start + 1, unreleased.end);
  const nextIsHeading = unreleased.end < s.footerStart;
  const out = [
    ...raw.slice(0, unreleased.start + 1),
    s.eol,
    `## [${version}] — ${date}${s.eol}`,
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
    add('no-unreleased', 'error', 'Нет раздела «## [Unreleased]»: новые записи некуда добавлять.');
  }
  for (const b of s.blocks.filter((x) => x.kind === 'other')) {
    add('bad-heading', 'warn', `Строка ${b.start + 1}: «${b.heading}» — не «## [Unreleased]» и не «## [x.y.z] — ГГГГ-ММ-ДД».`);
  }

  const releases = s.blocks.filter((b) => b.kind === 'release');
  const seen = new Set();
  releases.forEach((r, i) => {
    if (seen.has(r.version)) add('duplicate-version', 'error', `Версия ${r.version} встречается больше одного раза.`);
    seen.add(r.version);
    if (!isValidDate(r.date)) {
      add('bad-date', 'warn', `Версия ${r.version}: дата «${r.date}» не в формате ГГГГ-ММ-ДД.`);
    }
    const older = releases[i + 1];
    if (older && compareVersions(r.version, older.version) < 0) {
      add('version-order', 'error', `Версия ${r.version} стоит выше ${older.version}: версии должны убывать сверху вниз.`);
    }
  });

  if (s.links.length) {
    const url = (label) => s.links.find((l) => l.label === label)?.url;
    const unreleasedUrl = s.links.find((l) => l.label.toLowerCase() === 'unreleased')?.url;
    const latest = releases[0];
    if (unreleasedUrl === undefined) {
      add('link-mismatch', 'warn', 'В ссылках внизу нет [Unreleased].');
    } else if (latest && !compareTo(unreleasedUrl, latest.version, 'HEAD')) {
      add('link-mismatch', 'warn', `Ссылка [Unreleased] должна сравнивать ${latest.version} с HEAD: ${unreleasedUrl}`);
    }
    releases.forEach((r, i) => {
      const u = url(r.version);
      if (u === undefined) {
        add('link-mismatch', 'warn', `В ссылках внизу нет [${r.version}].`);
        return;
      }
      const older = releases[i + 1];
      if (older ? !compareTo(u, older.version, r.version) : !u.endsWith(r.version)) {
        add('link-mismatch', 'warn', older
          ? `Ссылка [${r.version}] должна сравнивать ${older.version} с ${r.version}: ${u}`
          : `Ссылка [${r.version}] должна вести на тег ${r.version}: ${u}`);
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
