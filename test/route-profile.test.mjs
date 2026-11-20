import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../lib/i18n.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTable, compareStrength, effectiveTable, loadRouting, mergeTable, parseEntry, resolveRoute } from '../lib/route.mjs';
import { DEFAULT_PROTECTED_FILES, DEFAULT_RELEASE_IGNORE, defaultProfile, loadProfile } from '../lib/profile.mjs';
import { matchList } from '../lib/glob.mjs';
import { PLUGIN_ROOT, tempDir, write, writeProfile } from './helpers.mjs';

setLang('ru'); // assertions below check the Russian texts

const routing = loadRouting(PLUGIN_ROOT);

function frontmatter(file) {
  const text = readFileSync(file, 'utf8');
  const block = text.match(/^---\n([\s\S]*?)\n---/)[1];
  return Object.fromEntries(block.split('\n').map((l) => l.split(/:\s*/, 2)).filter((p) => p.length === 2));
}

test('built-in routing table satisfies every invariant', () => {
  assert.deepEqual(checkTable(routing, mergeTable(routing, {})), []);
});

test('route resolution and agent mapping', () => {
  const { table } = effectiveTable(routing, {});
  assert.deepEqual(resolveRoute(routing, table, 'normal', 'implementer'), {
    role: 'implementer', mode: 'normal', agent: 'forge:implementer', model: 'sonnet', effort: 'high',
  });
  assert.equal(resolveRoute(routing, table, 'eco', 'mechanic').agent, 'forge:implementer');
  assert.equal(resolveRoute(routing, table, 'normal', 'architect').agent, 'main');
  assert.throws(() => resolveRoute(routing, table, 'normal', 'wizard'), /неизвестная роль/);
});

test('profile overrides apply only when invariants hold', () => {
  const ok = effectiveTable(routing, { normal: { implementer: 'opus/medium' } });
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.table.normal.implementer, 'opus/medium');

  const weakReviewer = effectiveTable(routing, { normal: { reviewer: 'haiku/low' } });
  assert.match(weakReviewer.warnings.join(), /reviewer/);
  assert.equal(weakReviewer.table.normal.reviewer, 'opus/high');

  const fableEco = effectiveTable(routing, { eco: { debugger: 'fable/high' } });
  assert.match(fableEco.warnings.join(), /eco/);

  const typo = effectiveTable(routing, { normal: { scout: 'haiku' } });
  assert.ok(typo.warnings.length);
});

test('agent files exist, match the normal-mode table and respect tool limits', () => {
  for (const [role, { agent }] of Object.entries(routing.roles)) {
    if (!agent) continue;
    assert.ok(existsSync(join(PLUGIN_ROOT, 'agents', `${agent}.md`)), `${role} → agents/${agent}.md`);
  }
  for (const agent of ['scout', 'implementer', 'reviewer', 'debugger']) {
    const fm = frontmatter(join(PLUGIN_ROOT, 'agents', `${agent}.md`));
    assert.equal(fm.name, agent);
    assert.equal(`${fm.model}/${fm.effort}`, routing.modes.normal[agent], `${agent} frontmatter vs routing.json`);
  }
  const scoutTools = frontmatter(join(PLUGIN_ROOT, 'agents', 'scout.md')).tools;
  assert.doesNotMatch(scoutTools, /Edit|Write|Bash/);
  const reviewerTools = frontmatter(join(PLUGIN_ROOT, 'agents', 'reviewer.md')).tools;
  assert.doesNotMatch(reviewerTools, /Edit|Write/);
});

test('profile: missing file gives defaults, broken JSON gives defaults plus an error', () => {
  const dir = tempDir();
  const missing = loadProfile(dir);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.profile.protected_files, DEFAULT_PROTECTED_FILES);

  write(dir, '.forge/profile.json', '{ not json');
  const broken = loadProfile(dir);
  assert.equal(broken.exists, true);
  assert.match(broken.errors[0], /JSON/);
  assert.deepEqual(broken.profile.git.protected_branches, ['main', 'master']);
});

test('profile: merge, validation and protected_files extending the defaults', () => {
  const dir = tempDir();
  writeProfile(dir, {
    commands: { test: 'npm test', lint: { run: 'eslint {files}', ext: ['.ts'] } },
    verify: { steps: ['lint', 'test', 'typecheck'], on_stop: 'full' },
    protected_files: ['config/secrets.json'],
    mode: 'eco',
  });
  const { profile, errors } = loadProfile(dir);
  assert.match(errors.join(), /typecheck/);
  assert.deepEqual(profile.verify.steps, ['lint', 'test']);
  assert.equal(profile.verify.on_stop, 'full');
  assert.equal(profile.mode, 'eco');
  assert.ok(profile.protected_files.includes('.env'));
  assert.ok(profile.protected_files.includes('config/secrets.json'));
});

const RELEASE_DEFAULTS = {
  changelog: 'CHANGELOG.md',
  tag_prefix: 'v',
  version_files: [],
  remind: true,
  ignore: DEFAULT_RELEASE_IGNORE,
};

function releaseOf(release) {
  const dir = tempDir();
  writeProfile(dir, { release });
  return loadProfile(dir);
}

test('profile.release: absent section means the feature is off', () => {
  assert.equal('release' in defaultProfile(), false);
  const missing = loadProfile(tempDir());
  assert.ok(!missing.profile.release);
  const dir = tempDir();
  writeProfile(dir, { mode: 'eco' });
  const { profile, errors } = loadProfile(dir);
  assert.ok(!profile.release);
  assert.deepEqual(errors, []);
});

test('profile.release: an empty object turns it on with every default', () => {
  const { profile, errors } = releaseOf({});
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.release, RELEASE_DEFAULTS);
  assert.notEqual(profile.release.ignore, DEFAULT_RELEASE_IGNORE, 'defaults are copied, not shared');
});

test('profile.release: a wrong type is an error and the field falls back to its default', () => {
  const cases = [
    ['changelog', 5, /release\.changelog/],
    ['changelog', '', /release\.changelog/],
    ['tag_prefix', 1, /release\.tag_prefix/],
    ['version_files', 'package.json', /release\.version_files/],
    ['remind', 'yes', /release\.remind/],
    ['ignore', 'docs/**', /release\.ignore/],
    ['ignore', [1], /release\.ignore/],
  ];
  for (const [field, value, re] of cases) {
    const { profile, errors } = releaseOf({ [field]: value });
    assert.equal(errors.length, 1, `${field}=${JSON.stringify(value)}: ${errors}`);
    assert.match(errors[0], re);
    assert.deepEqual(profile.release, RELEASE_DEFAULTS, field);
  }
  const notObject = releaseOf(true);
  assert.match(notObject.errors.join(), /release: /);
  assert.ok(!notObject.profile.release);
  assert.match(releaseOf([]).errors.join(), /release: /);
});

test('profile.release: valid scalar fields are taken over', () => {
  const { profile, errors } = releaseOf({ changelog: 'docs/CHANGES.md', tag_prefix: '', remind: false });
  assert.deepEqual(errors, []);
  assert.equal(profile.release.changelog, 'docs/CHANGES.md');
  assert.equal(profile.release.tag_prefix, '');
  assert.equal(profile.release.remind, false);
});

test('profile.release: version_files mixes plain paths and { path, pattern }', () => {
  const item = { path: 'src/version.txt', pattern: 'VERSION = "([^"]+)"' };
  const { profile, errors } = releaseOf({ version_files: ['package.json', item] });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.release.version_files, ['package.json', item]);
});

test('profile.release: a bad version_files item is reported and dropped, the rest stay', () => {
  const good = { path: 'a.txt', pattern: 'v(\\d+)' };
  const bad = [
    ['not a regex', { path: 'a.txt', pattern: '(unclosed' }, /release\.version_files\[1\]/],
    ['no capture group', { path: 'a.txt', pattern: 'v\\d+' }, /release\.version_files\[1\]/],
    ['two capture groups', { path: 'a.txt', pattern: '(\\d+)\\.(\\d+)' }, /release\.version_files\[1\]/],
    ['missing pattern', { path: 'a.txt' }, /release\.version_files\[1\]/],
    ['missing path', { pattern: '(\\d+)' }, /release\.version_files\[1\]/],
    ['empty path string', '', /release\.version_files\[1\]/],
    ['number', 7, /release\.version_files\[1\]/],
  ];
  for (const [name, item, re] of bad) {
    const { profile, errors } = releaseOf({ version_files: ['package.json', item, good] });
    assert.equal(errors.length, 1, `${name}: ${errors}`);
    assert.match(errors[0], re, name);
    assert.deepEqual(profile.release.version_files, ['package.json', good], name);
  }
});

test('profile.release: named groups and non-capturing groups count correctly', () => {
  const ok = { path: 'a.txt', pattern: '(?:v)(?<ver>\\d+)' };
  const { profile, errors } = releaseOf({ version_files: [ok] });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.release.version_files, [ok]);
  const escaped = { path: 'a.txt', pattern: '\\(\\d+\\)' };
  assert.match(releaseOf({ version_files: [escaped] }).errors.join(), /version_files\[0\]/);
});

test('profile.release: ignore is appended to the defaults and "!" removes', () => {
  const { profile, errors } = releaseOf({ ignore: ['scripts/**', '!docs/**', '!README.md'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile.release.ignore, [...DEFAULT_RELEASE_IGNORE, 'scripts/**', '!docs/**', '!README.md']);
  const ignored = (p) => matchList(p, profile.release.ignore) !== null;
  assert.ok(ignored('scripts/build.sh'));
  assert.ok(ignored('test/a.test.mjs'));
  assert.ok(ignored('CHANGELOG.md'));
  assert.ok(ignored('.forge/profile.json'));
  assert.ok(!ignored('docs/guide.txt'), '"!docs/**" un-ignores docs');
  assert.ok(!ignored('README.md'), '"!README.md" un-ignores the readme');
  assert.ok(ignored('sub/NOTES.md'));
  assert.ok(!ignored('lib/profile.mjs'));
});

test('DEFAULT_RELEASE_IGNORE covers tests, docs, markdown and .forge', () => {
  const ignored = (p) => matchList(p, DEFAULT_RELEASE_IGNORE) !== null;
  for (const p of [
    'test/a.mjs', 'tests/a.py', 'pkg/__tests__/a.js', 'src/a.test.ts', 'src/a.spec.js',
    'docs/a.txt', 'README.md', 'sub/dir/NOTES.md', '.forge/state.json', 'CHANGELOG.md',
  ]) assert.ok(ignored(p), p);
  for (const p of ['lib/a.mjs', 'src/index.ts', 'package.json']) assert.ok(!ignored(p), p);
});

test('senior routes to the implementer agent, strictly above implementer in every mode', () => {
  const { table } = effectiveTable(routing, {});
  assert.deepEqual(resolveRoute(routing, table, 'normal', 'senior'), {
    role: 'senior', mode: 'normal', agent: 'forge:implementer', model: 'opus', effort: 'high',
  });
  assert.equal(table.eco.senior, 'sonnet/high');
  assert.equal(table.max.senior, 'opus/xhigh');
  for (const mode of ['eco', 'normal', 'max']) {
    assert.ok(compareStrength(routing, parseEntry(table[mode].senior), parseEntry(table[mode].implementer)) > 0, mode);
  }
  assert.equal(effectiveTable(routing, { normal: { scout: 'haiku/medium' } }).table.normal.senior, 'opus/high');
});

test('overrides that break the senior ladder are rejected', () => {
  const flat = effectiveTable(routing, { normal: { senior: 'sonnet/medium' } });
  assert.match(flat.warnings.join(), /senior .* слабее implementer/);
  assert.equal(flat.table.normal.senior, 'opus/high');

  assert.match(effectiveTable(routing, { normal: { implementer: 'opus/xhigh' } }).warnings.join(), /routing\.normal\.senior/);
  assert.match(effectiveTable(routing, { normal: { senior: 'opus/xhigh' } }).warnings.join(), /reviewer .* слабее senior/);
  assert.match(
    effectiveTable(routing, { eco: { senior: 'opus/xhigh', reviewer: 'opus/xhigh' } }).warnings.join(),
    /debugger .* слабее senior/,
  );
});

test('overrides that make implementer equal to senior are kept', () => {
  for (const [mode, implementer] of [['normal', 'opus/high'], ['max', 'opus/xhigh'], ['eco', 'sonnet/high']]) {
    const res = effectiveTable(routing, { [mode]: { implementer } });
    assert.deepEqual(res.warnings, [], mode);
    assert.equal(res.table[mode].implementer, implementer, mode);
  }
});

test('equality boundaries of the senior ladder are valid', () => {
  assert.deepEqual(effectiveTable(routing, { normal: { senior: 'opus/high', reviewer: 'opus/high' } }).warnings, []);
  assert.deepEqual(effectiveTable(routing, { eco: { senior: 'opus/high', reviewer: 'opus/high' } }).warnings, []);
});
