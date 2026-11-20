import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  bumpVersion, checkChangelog, compareVersions, parseChangelog, releaseChangelog, suggestBump,
  unreleasedEntryCount,
} from '../lib/changelog.mjs';

const FORGE = new URL('../CHANGELOG.md', import.meta.url);
const service = '/path/to/service/CHANGELOG.md';
const codes = (issues) => issues.map((i) => i.code);
const names = (sections) => sections.map((s) => s.name);

const HEADER = '# Changelog\n\nFree text.\n\n- not an entry (header)\n\n';
const FOOTER = [
  '[Unreleased]: https://example.com/o/r/compare/v0.3.0...HEAD',
  '[0.3.0]: https://example.com/o/r/compare/v0.2.0...v0.3.0',
  '[0.2.0]: https://example.com/o/r/releases/tag/v0.2.0',
  '',
].join('\n');
const BODY = [
  '## [Unreleased]',
  '',
  '### Added',
  '- New thing that wraps',
  '  over two lines.',
  '- Second thing.',
  '',
  '### Выкладка',
  '- Run the migration.',
  '',
  '## [0.3.0] — 2026-11-21',
  '',
  '### Fixed',
  '- Old fix.',
  '',
  '## [0.2.0] - 2026-11-01',
  '',
  '### Added',
  '- Old feature.',
  '',
].join('\n');
const SAMPLE = `${HEADER}${BODY}\n${FOOTER}`;

const unreleased = (sections) => ({ unreleased: { sections } });
const sec = (name, ...entries) => ({ name, entries });
const bump = (sections, current = '1.0.0') => suggestBump(unreleased(sections), current);

// ---- parsing ----

test('parseChangelog: structure of a synthetic file', () => {
  const p = parseChangelog(SAMPLE);
  assert.equal(p.header, HEADER);
  assert.equal(p.eol, '\n');
  assert.equal(p.bom, false);
  assert.deepEqual(names(p.unreleased.sections), ['Added', 'Выкладка']);
  assert.deepEqual(p.unreleased.sections[0].entries, ['New thing that wraps over two lines.', 'Second thing.']);
  assert.deepEqual(p.releases.map((r) => [r.version, r.date]), [['0.3.0', '2026-11-21'], ['0.2.0', '2026-11-01']]);
  assert.deepEqual(p.links.map((l) => l.label), ['Unreleased', '0.3.0', '0.2.0']);
  assert.equal(p.links[1].url, 'https://example.com/o/r/compare/v0.2.0...v0.3.0');
  assert.equal(unreleasedEntryCount(p), 3);
});

test('parseChangelog: dash variants, no unreleased, no footer, pre-release versions', () => {
  const p = parseChangelog('# C\n\n## [1.0.0-rc.1] – 2026-01-02\n\n### Added\n- x\n\n## [0.9.0] — 2026-01-01\n- y\n');
  assert.equal(p.unreleased, null);
  assert.equal(unreleasedEntryCount(p), 0);
  assert.deepEqual(p.releases.map((r) => [r.version, r.date]), [['1.0.0-rc.1', '2026-01-02'], ['0.9.0', '2026-01-01']]);
  assert.deepEqual(p.links, []);
  assert.deepEqual(parseChangelog('').releases, []);
});

test('parseChangelog: eol and BOM', () => {
  const p = parseChangelog('﻿# C\r\n\r\n## [Unreleased]\r\n\r\n### Added\r\n- a\r\n');
  assert.equal(p.eol, '\r\n');
  assert.equal(p.bom, true);
  assert.equal(p.header, '# C\r\n\r\n');
  assert.equal(unreleasedEntryCount(p), 1);
});

test('parseChangelog: ## inside a code fence is not a heading', () => {
  const p = parseChangelog('# C\n\n```\n## [9.9.9] — 2000-01-01\n```\n\n## [Unreleased]\n- a\n');
  assert.deepEqual(p.releases, []);
  assert.equal(p.badHeadings.length, 0);
});

test('real forge CHANGELOG.md parses', () => {
  const p = parseChangelog(readFileSync(FORGE, 'utf8'));
  assert.ok(p.header.startsWith('# Changelog'));
  assert.ok(p.unreleased);
  assert.deepEqual(p.releases.slice(0, 2).map((r) => r.version), ['0.3.0', '0.2.0']);
  assert.ok(names(p.releases[0].sections).includes('Обновление'));
  assert.ok(p.releases[0].sections.every((s) => s.entries.length > 0));
  assert.ok(p.links.some((l) => l.label === 'Unreleased'));
  assert.deepEqual(codes(checkChangelog(readFileSync(FORGE, 'utf8'))).filter((c) => c !== 'bad-heading'), []);
});

test('real service-app CHANGELOG.md parses', { skip: !existsSync(service) }, () => {
  const text = readFileSync(service, 'utf8');
  const p = parseChangelog(text);
  assert.ok(p.unreleased);
  assert.deepEqual(p.releases.map((r) => r.version).slice(0, 3), ['1.2.0', '1.1.0', '1.0.0']);
  assert.ok(names(p.releases[0].sections).includes('Выкладка'));
  assert.deepEqual(p.links, []);
  assert.deepEqual(checkChangelog(text), []);
});

// ---- bump ----

test('bumpVersion', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('0.0.0', 'minor'), '0.1.0');
  assert.equal(bumpVersion('1.0.0-rc.1', 'minor'), '1.1.0');
  assert.equal(bumpVersion('1.0.0-rc.1+build.5', 'patch'), '1.0.1');
  assert.throws(() => bumpVersion('1.0', 'patch'), /semver/);
  assert.throws(() => bumpVersion('1.0.0', 'huge'), /уровень/);
});

test('compareVersions: semver precedence', () => {
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
});

test('suggestBump: Added/Changed -> minor, with reason', () => {
  assert.deepEqual(bump([sec('Added', 'x')]), { level: 'minor', reason: 'есть Added' });
  assert.deepEqual(bump([sec('Changed', 'x')]), { level: 'minor', reason: 'есть Changed' });
  assert.deepEqual(bump([sec('Added', 'x'), sec('Changed', 'y')]), { level: 'minor', reason: 'есть Added и Changed' });
  assert.equal(bump([sec('added', 'x')]).level, 'minor');
});

test('suggestBump: only Fixed/Security/Deprecated/custom -> patch', () => {
  assert.deepEqual(bump([sec('Fixed', 'x')]), { level: 'patch', reason: 'только Fixed' });
  assert.equal(bump([sec('Security', 'x'), sec('Fixed', 'y')]).reason, 'только Security, Fixed');
  assert.equal(bump([sec('Deprecated', 'x')]).level, 'patch');
  assert.equal(bump([sec('Fixed', 'x'), sec('Added')]).level, 'patch'); // empty Added does not count
  assert.equal(bump([sec('Added', 'x'), sec('Выкладка', 'y')]).level, 'minor');
});

test('suggestBump: Removed and BREAKING/несовместим -> major', () => {
  assert.deepEqual(bump([sec('Removed', 'x')]), { level: 'major', reason: 'раздел Removed' });
  assert.equal(bump([sec('Removed'), sec('Fixed', 'x')]).level, 'patch'); // empty Removed
  assert.equal(bump([sec('Changed', 'BREAKING: new API')]).level, 'major');
  assert.equal(bump([sec('Fixed', 'breaking change in x')]).level, 'major');
  assert.equal(bump([sec('Changed', 'Формат Несовместим со старым')]).level, 'major');
  assert.match(bump([sec('Changed', 'BREAKING')]).reason, /BREAKING/);
});

test('suggestBump: custom sections never raise the level', () => {
  assert.equal(bump([sec('Выкладка', 'Миграция несовместимая'), sec('Fixed', 'x')]).level, 'patch');
  assert.equal(bump([sec('Обновление', 'BREAKING: перенести профиль'), sec('Added', 'x')]).level, 'minor');
  assert.equal(bump([sec('Выкладка', 'x')]).level, 'patch');
  assert.equal(bump([sec('Обновление', 'x')]).reason, 'только Обновление');
});

test('suggestBump: pre-1.0 turns major into minor', () => {
  const r = bump([sec('Removed', 'x')], '0.3.0');
  assert.equal(r.level, 'minor');
  assert.match(r.reason, /Removed/);
  assert.match(r.reason, /до 1\.0/);
  assert.equal(bump([sec('Changed', 'BREAKING')], '0.0.0').level, 'minor');
  assert.equal(bump([sec('Fixed', 'x')], '0.3.0').level, 'patch');
  assert.equal(bump([sec('Added', 'x')], '0.3.0').level, 'minor');
  assert.equal(suggestBump(unreleased([sec('Removed', 'x')])).level, 'minor'); // default 0.0.0
});

test('suggestBump: pre-release current version and empty Unreleased', () => {
  assert.equal(bump([sec('Removed', 'x')], '1.0.0-rc.1').level, 'major');
  assert.equal(bump([sec('Removed', 'x')], '0.9.0-beta.2').level, 'minor');
  assert.equal(suggestBump({ unreleased: null }, '1.0.0').level, 'patch');
  assert.equal(suggestBump(parseChangelog('# C\n\n## [Unreleased]\n'), '1.0.0').reason, 'нет записей в Unreleased');
});

// ---- release ----

const release = (text, opts = {}) => releaseChangelog(text, { version: '0.4.0', date: '2026-12-01', ...opts });

test('releaseChangelog: moves Unreleased under a new heading, untouched parts byte-identical', () => {
  const out = release(SAMPLE);
  const moved = BODY.split('## [0.3.0]')[0].replace('## [Unreleased]\n\n', '');
  const expectedBody = BODY.replace(BODY.split('## [0.3.0]')[0], `## [Unreleased]\n\n## [0.4.0] — 2026-12-01\n\n${moved}`);
  const expectedFooter = [
    '[Unreleased]: https://example.com/o/r/compare/v0.4.0...HEAD',
    '[0.4.0]: https://example.com/o/r/compare/v0.3.0...v0.4.0',
    ...FOOTER.split('\n').slice(1),
  ].join('\n');
  assert.equal(out, `${HEADER}${expectedBody}\n${expectedFooter}`);

  const p = parseChangelog(out);
  assert.deepEqual(p.unreleased.sections, []);
  assert.equal(p.header, HEADER);
  assert.deepEqual(p.releases.map((r) => r.version), ['0.4.0', '0.3.0', '0.2.0']);
  assert.deepEqual(p.releases[0].sections, parseChangelog(SAMPLE).unreleased.sections);
  assert.deepEqual(p.releases.slice(1), parseChangelog(SAMPLE).releases);
  assert.deepEqual(checkChangelog(out), []);
});

test('releaseChangelog: footer without previous release links to the tag', () => {
  const text = '# C\n\n## [Unreleased]\n\n### Added\n- a\n\n[Unreleased]: https://example.com/o/r/compare/v0.0.0...HEAD\n';
  const out = releaseChangelog(text, { version: '0.1.0', date: '2026-01-01' });
  assert.equal(out, [
    '# C', '', '## [Unreleased]', '', '## [0.1.0] — 2026-01-01', '', '### Added', '- a', '',
    '[Unreleased]: https://example.com/o/r/compare/v0.1.0...HEAD',
    '[0.1.0]: https://example.com/o/r/releases/tag/v0.1.0', '',
  ].join('\n'));
  assert.deepEqual(checkChangelog(out), []);
});

test('releaseChangelog: no footer stays without a footer', () => {
  const text = '# C\n\n## [Unreleased]\n\n### Fixed\n- a\n\n## [0.1.0] — 2026-01-01\n\n### Added\n- b\n';
  assert.equal(release(text), '# C\n\n## [Unreleased]\n\n## [0.4.0] — 2026-12-01\n\n### Fixed\n- a\n\n## [0.1.0] — 2026-01-01\n\n### Added\n- b\n');
});

test('releaseChangelog: tagPrefix, other ref in Unreleased link, compact input', () => {
  const text = '## [Unreleased]\n### Added\n- a\n## [1.0.0] — 2026-01-01\n- b\n\n[Unreleased]: https://h/o/r/compare/rel-1.0.0...main\n[1.0.0]: https://h/o/r/releases/tag/rel-1.0.0\n';
  const out = releaseChangelog(text, { version: '1.1.0', date: '2026-02-02', tagPrefix: 'rel-' });
  assert.equal(out, [
    '## [Unreleased]', '', '## [1.1.0] — 2026-02-02', '', '### Added', '- a', '', '## [1.0.0] — 2026-01-01', '- b', '',
    '[Unreleased]: https://h/o/r/compare/rel-1.1.0...main',
    '[1.1.0]: https://h/o/r/compare/rel-1.0.0...rel-1.1.0',
    '[1.0.0]: https://h/o/r/releases/tag/rel-1.0.0', '',
  ].join('\n'));
});

test('releaseChangelog: CRLF and BOM are preserved', () => {
  const crlf = `﻿${SAMPLE.replace(/\n/g, '\r\n')}`;
  const out = release(crlf);
  assert.ok(out.startsWith('﻿# Changelog'));
  assert.equal(out.replace(/\r\n/g, ''), out.replace(/\r\n/g, '').replace(/\n/g, '')); // no bare LF
  assert.equal(out.replace(/\r\n/g, '\n'), `﻿${release(SAMPLE)}`);
  const p = parseChangelog(out);
  assert.equal(p.eol, '\r\n');
  assert.equal(p.bom, true);
  assert.deepEqual(codes(checkChangelog(out)), []);
});

test('releaseChangelog: missing final newline and mixed endings stay as they were', () => {
  const noNl = SAMPLE.replace(/\n$/, '');
  assert.equal(release(noNl), release(SAMPLE).replace(/\n$/, ''));
  const mixed = '# C\r\n\r\n## [Unreleased]\r\n- a\r\n\r\n## [0.1.0] — 2026-01-01\n- b\n';
  assert.equal(release(mixed), '# C\r\n\r\n## [Unreleased]\r\n\r\n## [0.4.0] — 2026-12-01\r\n\r\n- a\r\n\r\n## [0.1.0] — 2026-01-01\n- b\n');
});

test('releaseChangelog: errors', () => {
  assert.throws(() => release('# C\n\n## [0.1.0] — 2026-01-01\n- a\n'), /Unreleased/);
  assert.throws(() => release('# C\n\n## [Unreleased]\n\n## [0.1.0] — 2026-01-01\n- a\n'), /пуст/);
  assert.throws(() => release('# C\n\n## [Unreleased]\n\n### Added\n\n'), /пуст/);
  assert.throws(() => release(SAMPLE, { version: '0.3.0' }), /0\.3\.0.*уже есть/);
  assert.throws(() => release(SAMPLE, { version: 'x' }), /semver/);
  assert.throws(() => release(SAMPLE, { date: '2026-13-40' }), /Дата/);
  assert.throws(() => release(SAMPLE, { date: undefined }), /Дата/);
});

const withEntry = (text) => text.replace(/## \[Unreleased\]\r?\n/, (m) => `${m}${m.endsWith('\r\n') ? '\r\n' : '\n'}### Added\n- Новая запись\n`);

test('releaseChangelog on a copy of the real forge CHANGELOG.md', () => {
  const text = withEntry(readFileSync(FORGE, 'utf8'));
  const out = releaseChangelog(text, { version: '0.4.0', date: '2026-12-01' });
  const p = parseChangelog(out);
  assert.deepEqual(p.unreleased.sections, []);
  assert.deepEqual(p.releases[0], { version: '0.4.0', date: '2026-12-01', sections: [{ name: 'Added', entries: ['Новая запись'] }] });
  assert.ok(out.includes('[Unreleased]: https://github.com/lunasy26/forge/compare/v0.4.0...HEAD\n[0.4.0]: https://github.com/lunasy26/forge/compare/v0.3.0...v0.4.0\n[0.3.0]:'));
  assert.deepEqual(checkChangelog(out).filter((i) => i.level === 'error'), []);
  // Everything after the new release is the old file byte for byte except the two footer lines.
  const oldTail = text.slice(text.indexOf('## [0.3.0]'));
  assert.ok(out.includes(oldTail.slice(0, oldTail.indexOf('[Unreleased]: '))));
});

test('releaseChangelog on a copy of the real service-app CHANGELOG.md', { skip: !existsSync(service) }, () => {
  const original = readFileSync(service, 'utf8');
  const out = releaseChangelog(withEntry(original), { version: '1.3.0', date: '2026-12-01' });
  const p = parseChangelog(out);
  assert.deepEqual(p.releases.slice(0, 2).map((r) => r.version), ['1.3.0', '1.2.0']);
  assert.deepEqual(p.releases.slice(1), parseChangelog(original).releases);
  assert.equal(p.header, parseChangelog(original).header);
  assert.deepEqual(checkChangelog(out), []);
  assert.equal(out.replace('## [Unreleased]\n\n## [1.3.0] — 2026-12-01\n\n### Added\n- Новая запись\n\n', '## [Unreleased]\n\n'), original);
});

// ---- check ----

const has = (text, code) => codes(checkChangelog(text)).includes(code);

test('checkChangelog: a clean file has no issues', () => {
  assert.deepEqual(checkChangelog(SAMPLE), []);
});

test('checkChangelog: no-unreleased', () => {
  assert.equal(has('# C\n\n## [0.1.0] — 2026-01-01\n- a\n', 'no-unreleased'), true);
  assert.equal(checkChangelog('').find((i) => i.code === 'no-unreleased').level, 'error');
  assert.equal(has(SAMPLE, 'no-unreleased'), false);
});

test('checkChangelog: bad-heading', () => {
  const issues = checkChangelog('# C\n\n## [Unreleased]\n\n## Что-то ещё\n\n## [1.0] — 2026-01-01\n');
  assert.deepEqual(issues.filter((i) => i.code === 'bad-heading').map((i) => i.level), ['warn', 'warn']);
  assert.match(issues[0].message, /Что-то ещё/);
  assert.equal(has(SAMPLE, 'bad-heading'), false);
  assert.equal(has('# C\n\n## [Unreleased]\n\n### Added\n', 'bad-heading'), false);
});

test('checkChangelog: version-order', () => {
  const text = (a, b) => `## [Unreleased]\n\n## [${a}] — 2026-01-02\n\n## [${b}] — 2026-01-01\n`;
  const bad = checkChangelog(text('0.1.0', '0.2.0')).find((i) => i.code === 'version-order');
  assert.equal(bad.level, 'error');
  assert.equal(has(text('0.9.0', '0.10.0'), 'version-order'), true);
  assert.equal(has(text('0.10.0', '0.9.0'), 'version-order'), false);
  assert.equal(has(text('1.0.0', '1.0.0-rc.1'), 'version-order'), false);
  assert.equal(has(text('1.0.0-rc.1', '1.0.0'), 'version-order'), true);
});

test('checkChangelog: duplicate-version', () => {
  const dup = '## [Unreleased]\n\n## [0.2.0] — 2026-01-02\n\n## [0.2.0] — 2026-01-01\n';
  const issues = checkChangelog(dup);
  assert.equal(issues.find((i) => i.code === 'duplicate-version').level, 'error');
  assert.equal(has(dup, 'version-order'), false); // reported once, as a duplicate
  assert.equal(has(SAMPLE, 'duplicate-version'), false);
});

test('checkChangelog: bad-date', () => {
  const text = (d) => `## [Unreleased]\n\n## [0.2.0] — ${d}\n`;
  assert.equal(checkChangelog(text('2026-02-30')).find((i) => i.code === 'bad-date').level, 'warn');
  assert.equal(has(text('yesterday'), 'bad-date'), true);
  assert.equal(has('## [Unreleased]\n\n## [0.2.0]\n', 'bad-date'), true);
  assert.equal(has(text('2026-02-28'), 'bad-date'), false);
});

test('checkChangelog: link-mismatch', () => {
  const swap = (from, to) => SAMPLE.replace(from, to);
  const level = checkChangelog(swap('compare/v0.2.0...v0.3.0', 'compare/v0.1.0...v0.3.0')).find((i) => i.code === 'link-mismatch').level;
  assert.equal(level, 'warn');
  assert.equal(has(swap('compare/v0.2.0...v0.3.0', 'compare/v0.1.0...v0.3.0'), 'link-mismatch'), true); // wrong neighbour
  assert.equal(has(swap('compare/v0.3.0...HEAD', 'compare/v0.2.0...HEAD'), 'link-mismatch'), true); // stale Unreleased
  assert.equal(has(swap('[0.3.0]: https://example.com/o/r/compare/v0.2.0...v0.3.0\n', ''), 'link-mismatch'), true); // missing
  assert.equal(has(swap('[Unreleased]: https://example.com/o/r/compare/v0.3.0...HEAD\n', ''), 'link-mismatch'), true);
  assert.equal(has(swap('releases/tag/v0.2.0', 'releases/tag/v0.1.0'), 'link-mismatch'), true); // oldest
  assert.equal(has(SAMPLE, 'link-mismatch'), false);
  assert.equal(has(SAMPLE.slice(0, SAMPLE.indexOf('[Unreleased]:')), 'link-mismatch'), false); // no footer at all
  assert.equal(has(swap(/v(\d)/g, 'rel-$1').replace(/v(\d)/g, 'rel-$1'), 'link-mismatch'), false); // any tag prefix
});
