import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitRepo, runCli, write, writeProfile } from './helpers.mjs';

test('init: preview without writing, then write profile, schema and git excludes', () => {
  const dir = gitRepo();
  write(dir, 'package.json', { scripts: { test: 'node -e ""' } });
  const preview = runCli(['init'], { cwd: dir });
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /Стек: node \(npm\)/);
  assert.equal(existsSync(join(dir, '.forge', 'profile.json')), false);

  const written = runCli(['init', '--yes'], { cwd: dir });
  assert.equal(written.code, 0, written.stderr);
  const profile = JSON.parse(readFileSync(join(dir, '.forge', 'profile.json'), 'utf8'));
  assert.equal(profile.commands.test, 'npm test');
  assert.ok(existsSync(join(dir, '.forge', 'profile.schema.json')));
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /\.forge\/state\.json/);

  assert.equal(runCli(['init', '--yes'], { cwd: dir }).code, 1, 'refuses to overwrite');
  write(dir, '.forge/state.json', '{}');
  assert.equal(git(dir, 'status', '--porcelain', '--', '.forge/state.json'), '', 'state is ignored by git');
});

test('mode and route: switching mode changes the routed models', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  assert.match(runCli(['route', 'implementer'], { cwd: dir }).stdout, /agent=forge:implementer model=sonnet effort=high/);
  assert.match(runCli(['route', 'senior'], { cwd: dir }).stdout, /agent=forge:implementer model=opus effort=high/);
  assert.match(runCli(['mode'], { cwd: dir }).stdout, /senior\s+opus\/high/);
  const mode = runCli(['mode', 'eco'], { cwd: dir });
  assert.match(mode.stdout, /Режим: eco/);
  assert.match(runCli(['route', 'implementer'], { cwd: dir }).stdout, /mode=eco .* model=sonnet effort=medium/);
  assert.match(runCli(['route', 'debugger'], { cwd: dir }).stdout, /model=opus/);
  const json = JSON.parse(runCli(['route', 'scout', '--json'], { cwd: dir }).stdout);
  assert.deepEqual(json, { role: 'scout', mode: 'eco', agent: 'forge:scout', model: 'haiku', effort: 'low' });
  assert.equal(runCli(['mode', 'turbo'], { cwd: dir }).code, 2);
  assert.equal(runCli(['route', 'wizard'], { cwd: dir }).code, 2);
});

test('state: set several keys at once, validate known keys, read nested', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  const set = runCli(['state', 'set', 'task.slug', 'oauth', 'tier', '2', 'stage', 'plan', 'artifacts.plan', '.forge/work/oauth/plan.md'], { cwd: dir });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(runCli(['state', 'get', 'task.slug'], { cwd: dir }).stdout.trim(), 'oauth');
  assert.equal(runCli(['state', 'get', 'tier'], { cwd: dir }).stdout.trim(), '2');
  assert.equal(runCli(['state', 'set', 'tier', '7'], { cwd: dir }).code, 2);
  assert.equal(runCli(['state', 'set', 'stage', 'dance'], { cwd: dir }).code, 2);
  runCli(['state', 'reset'], { cwd: dir });
  assert.equal(runCli(['state', 'get', 'task'], { cwd: dir }).stdout.trim(), 'null');
});

test('verify: exit code and summary; doctor reports problems without crashing', () => {
  const dir = gitRepo();
  writeProfile(dir, { commands: { test: 'node -e "process.exit(1)"', lint: 'nonexistent-linter-xyz' }, verify: { steps: ['lint', 'test'] } });
  const v = runCli(['verify'], { cwd: dir });
  assert.equal(v.code, 1);
  assert.match(v.stdout, /FAIL: lint: код 127/);
  const d = runCli(['doctor'], { cwd: dir });
  assert.equal(d.code, 0);
  assert.match(d.stdout, /nonexistent-linter-xyz/);
  assert.match(d.stdout, /не исключены из git/);
});

/** A passing project whose edit log is past the rotation limit, with the given state cursors. */
function bigLogProject(cursors) {
  const dir = gitRepo();
  writeProfile(dir, { commands: { test: 'node -e ""' }, verify: { steps: ['test'] } });
  const log = write(dir, '.forge/edits.jsonl', `${JSON.stringify({ t: 0, f: 'gone.txt' })}\n`.repeat(12000));
  const size = readFileSync(log).length;
  write(dir, '.forge/state.json', { version: 1, lint_offset: size, ...cursors(size) });
  return { dir, log, size };
}
const readState = (dir) => JSON.parse(readFileSync(join(dir, '.forge', 'state.json'), 'utf8'));

test('verify: does not rotate the edit log while the docs cursor lags behind', () => {
  const { dir, log, size } = bigLogProject((size) => ({ docs: { offset: size - 10 } }));
  assert.equal(runCli(['verify'], { cwd: dir }).code, 0);
  assert.equal(readFileSync(log).length, size, 'log kept');
  const s = readState(dir);
  assert.deepEqual([s.verify.edits_offset, s.lint_offset, s.docs.offset], [size, size, size - 10]);
});

test('verify: an absent docs cursor counts as caught up and the log rotates', () => {
  const { dir, log } = bigLogProject(() => ({}));
  assert.equal(runCli(['verify'], { cwd: dir }).code, 0);
  assert.equal(readFileSync(log).length, 0, 'log truncated');
  const s = readState(dir);
  assert.deepEqual([s.verify.edits_offset, s.lint_offset], [0, 0]);
  assert.equal(s.docs, undefined, 'absent cursor stays absent');
});

test('docs: missing AGENTS.md is an error with exit 1, json is parseable, unknown flag is a usage error', () => {
  const dir = gitRepo();
  const r = runCli(['docs'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ .*missing-root/);
  const json = runCli(['docs', '--json'], { cwd: dir });
  assert.equal(json.code, 1);
  const issues = JSON.parse(json.stdout);
  assert.ok(issues.some((i) => i.code === 'missing-root'));
  assert.equal(runCli(['docs', '--bogus'], { cwd: dir }).code, 2);
});

test('docs: --fix creates the missing CLAUDE.md shim and the re-check passes', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', '# Проект\n');
  assert.equal(runCli(['docs'], { cwd: dir }).code, 1);
  const fixed = runCli(['docs', '--fix'], { cwd: dir });
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /создан CLAUDE\.md/);
  assert.match(fixed.stdout, /✓/);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(runCli(['docs'], { cwd: dir }).code, 0);
});

test('docs: clean project prints a single ok line; warnings do not fail', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', '# Проект\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  const ok = runCli(['docs'], { cwd: dir });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), '✓ Агентские файлы в порядке');
  assert.equal(runCli(['docs', '--json'], { cwd: dir }).stdout.trim(), '[]');
  write(dir, 'AGENTS.md', '# Проект\n[x](nope.md)\n');
  const warn = runCli(['docs'], { cwd: dir });
  assert.equal(warn.code, 0);
  assert.match(warn.stdout, /! .*broken-link/);
});

test('doctor: reports the agent files line both when clean and when broken', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  const bad = runCli(['doctor'], { cwd: dir });
  assert.equal(bad.code, 0);
  assert.match(bad.stdout, /✗ Агентские файлы: 1 замечание — forge docs/);
  write(dir, 'AGENTS.md', '# Проект\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /✓ Агентские файлы в порядке/);
  write(dir, 'AGENTS.md', '# Проект\n[x](nope.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Агентские файлы: 1 замечание — forge docs/);
  write(dir, 'AGENTS.md', '# Проект\n[x](nope.md) [y](nope2.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Агентские файлы: 2 замечания — forge docs/);
  write(dir, 'AGENTS.md', '# Проект\n[a](n1.md) [b](n2.md) [c](n3.md) [d](n4.md) [e](n5.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Агентские файлы: 5 замечаний — forge docs/);
  write(dir, 'AGENTS.md', `# Проект\n${Array.from({ length: 21 }, (_, i) => `[l${i}](n${i}.md)`).join(' ')}\n`);
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Агентские файлы: 21 замечание — forge docs/);
});

test('docs: --fix says why it skipped a fixable issue', { skip: process.platform === 'win32' }, () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', '# Проект\n');
  symlinkSync('nowhere.md', join(dir, 'CLAUDE.md'));
  const r = runCli(['docs', '--fix'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /пропущен CLAUDE\.md: .*уже существует/);
  const json = runCli(['docs', '--fix', '--json'], { cwd: dir });
  assert.ok(Array.isArray(JSON.parse(json.stdout)), 'json output stays parseable');
  assert.match(json.stderr, /пропущен CLAUDE\.md/);
});

// ---- release ----

const RELEASE_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Новая команда

## [0.1.0] — 2026-01-01

### Added
- Первая версия
`;

const RELEASE_PROFILE = {
  release: { version_files: ['package.json', { path: 'README.md', pattern: 'version-(\\d+\\.\\d+\\.\\d+)-blue' }] },
};

/** A temp repo with a released 0.1.0 (tagged v0.1.0), an Added entry in [Unreleased] and a clean tree. */
function releaseRepo({ changelog = RELEASE_CHANGELOG, tag = true } = {}) {
  const dir = gitRepo();
  writeProfile(dir, RELEASE_PROFILE);
  write(dir, 'CHANGELOG.md', changelog);
  write(dir, 'package.json', '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  write(dir, 'README.md', '# X\n![v](https://img.shields.io/badge/version-0.1.0-blue)\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: x');
  if (tag) git(dir, 'tag', '-a', 'v0.1.0', '-m', 'release 0.1.0');
  return dir;
}

test('release: every form says so when the release section is not configured', () => {
  const dir = gitRepo();
  writeProfile(dir, {});
  for (const args of [['release'], ['release', '--check'], ['release', 'minor', '--yes']]) {
    const r = runCli(args, { cwd: dir });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stdout, /✗ раздел release в профиле не настроен — forge init предложит его, если проект выпускается/);
  }
});

test('release --check: clean project passes, each problem kind is reported', () => {
  const dir = releaseRepo();
  const ok = runCli(['release', '--check'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.stdout.trim(), '✓ Журнал изменений в порядке');
  assert.equal(runCli(['release', '--check', '--json'], { cwd: dir }).stdout.trim(), '[]');

  // version file out of step with the changelog
  write(dir, 'package.json', '{\n  "version": "0.0.9"\n}\n');
  const mismatch = runCli(['release', '--check', '--json'], { cwd: dir });
  assert.equal(mismatch.code, 1);
  const [issue] = JSON.parse(mismatch.stdout);
  assert.equal(issue.code, 'version-mismatch');
  assert.equal(issue.level, 'error');
  assert.equal(issue.path, 'package.json');
  assert.match(runCli(['release', '--check'], { cwd: dir }).stdout, /✗ package\.json: .*0\.0\.9.*0\.1\.0/);

  // unreadable version file
  write(dir, 'package.json', '{ "name": "x" }\n');
  assert.equal(JSON.parse(runCli(['release', '--check', '--json'], { cwd: dir }).stdout)[0].code, 'version-file-unreadable');

  // changelog error from checkChangelog
  write(dir, 'package.json', '{ "version": "0.1.0" }\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n\n## [0.1.0] — 2026-01-01\n\n### Added\n- Первая версия\n');
  const noUnreleased = runCli(['release', '--check'], { cwd: dir });
  assert.equal(noUnreleased.code, 1);
  assert.match(noUnreleased.stdout, /✗ CHANGELOG\.md: .*\[no-unreleased\]/);

  // changelog file missing
  git(dir, 'rm', '-q', '-f', 'CHANGELOG.md');
  const missing = JSON.parse(runCli(['release', '--check', '--json'], { cwd: dir }).stdout);
  assert.ok(missing.some((i) => i.code === 'changelog-missing' && i.level === 'error' && i.path === 'CHANGELOG.md'));
});

test('release --check: a changelog warning and a missing tag are warnings, not failures', () => {
  const dir = releaseRepo({ tag: false });
  const noTag = runCli(['release', '--check'], { cwd: dir });
  assert.equal(noTag.code, 0);
  assert.match(noTag.stdout, /! .*тега v0\.1\.0 нет \[tag-missing\]/);

  git(dir, 'tag', '-a', 'v0.1.0', '-m', 'release 0.1.0');
  write(dir, 'CHANGELOG.md', `${RELEASE_CHANGELOG}\n## Прочее\n`);
  const warn = runCli(['release', '--check'], { cwd: dir });
  assert.equal(warn.code, 0);
  assert.match(warn.stdout, /! CHANGELOG\.md: .*\[bad-heading\]/);
});

test('release: preview suggests the level and lists every file, changing nothing', () => {
  const dir = releaseRepo();
  const r = runCli(['release', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Уровень: minor \(есть Added\)/);
  assert.match(r.stdout, /0\.1\.0 → 0\.2\.0/);
  assert.match(r.stdout, /CHANGELOG\.md: \[Unreleased\] → \[0\.2\.0\] — 2026-03-04/);
  assert.match(r.stdout, /package\.json: 0\.1\.0 → 0\.2\.0/);
  assert.match(r.stdout, /README\.md: 0\.1\.0 → 0\.2\.0/);
  assert.match(r.stdout, /Тег: v0\.2\.0/);
  assert.match(r.stdout, /Коммит: chore\(release\): 0\.2\.0/);
  assert.match(r.stdout, /Выпустить: forge release minor --date 2026-03-04 --yes/);
  assert.equal(git(dir, 'status', '--porcelain'), '');

  const json = JSON.parse(runCli(['release', 'patch', '--json'], { cwd: dir }).stdout);
  assert.equal(json.level, 'patch');
  assert.equal(json.current, '0.1.0');
  assert.equal(json.next, '0.1.1');
  assert.equal(json.tag, 'v0.1.1');
  assert.equal(json.commit, 'chore(release): 0.1.1');
  assert.deepEqual(json.files.map((f) => f.path), ['CHANGELOG.md', 'package.json', 'README.md']);
  assert.deepEqual(json.files[1], { path: 'package.json', from: '0.1.0', to: '0.1.1' });
});

test('release: nothing to release when [Unreleased] is empty; bad arguments are usage errors', () => {
  const dir = releaseRepo({ changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] — 2026-01-01\n\n### Added\n- Первая версия\n' });
  const r = runCli(['release'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ в \[Unreleased\] пусто — выпускать нечего/);
  assert.equal(runCli(['release', 'minor', '--yes'], { cwd: dir }).code, 1);
  assert.equal(runCli(['release', 'huge'], { cwd: dir }).code, 2);
  assert.equal(runCli(['release', '--date', '2026-02-31'], { cwd: dir }).code, 2);
  assert.equal(runCli(['release', '--date'], { cwd: dir }).code, 2);
  assert.equal(runCli(['release', '--bogus'], { cwd: dir }).code, 2);
});

test('release --yes: moves the changelog, bumps files, commits and tags without pushing', () => {
  const dir = releaseRepo();
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = runCli(['release', 'minor', '--yes', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Тег: v0\.2\.0/);
  assert.match(r.stdout, /Отправить: git push origin main && git push origin v0\.2\.0/);

  const changelog = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.2\.0\] — 2026-03-04\n\n### Added\n- Новая команда/);
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /^\{\n {2}"name": "x",\n {2}"version": "0\.2\.0"\n\}\n$/);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /badge\/version-0\.2\.0-blue/);

  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore(release): 0.2.0');
  assert.equal(git(dir, 'rev-parse', 'HEAD~1'), before);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'cat-file', '-t', 'v0.2.0'), 'tag', 'annotated tag');
  assert.equal(git(dir, 'rev-parse', 'v0.2.0^{commit}'), git(dir, 'rev-parse', 'HEAD'));
  assert.match(r.stdout, new RegExp(git(dir, 'rev-parse', '--short=7', 'HEAD')));
  assert.equal(git(dir, 'remote'), '', 'nothing was pushed (no remote exists)');
  assert.equal(runCli(['release', '--check'], { cwd: dir }).code, 0);
});

test('release --yes: an explicit version works, and a lower one is refused', () => {
  const dir = releaseRepo();
  const low = runCli(['release', '0.0.5', '--yes'], { cwd: dir });
  assert.equal(low.code, 1);
  assert.match(low.stdout, /✗ версия 0\.0\.5 не больше текущей 0\.1\.0/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  const ok = runCli(['release', '1.0.0', '--yes', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(git(dir, 'tag', '--list', 'v1.0.0'), 'v1.0.0');
});

test('release --yes: refused on a dirty tree, an existing tag or without a level; nothing changes', () => {
  const dir = releaseRepo();
  const head = git(dir, 'rev-parse', 'HEAD');

  assert.equal(runCli(['release', '--yes'], { cwd: dir }).code, 2, 'missing level is a usage error');

  write(dir, 'README.md', '# X changed\n');
  const dirty = runCli(['release', 'minor', '--yes'], { cwd: dir });
  assert.equal(dirty.code, 1);
  assert.match(dirty.stdout, /✗ .*незакоммиченные изменения/);
  git(dir, 'checkout', '--', 'README.md');

  git(dir, 'tag', 'v0.2.0');
  const tagged = runCli(['release', 'minor', '--yes'], { cwd: dir });
  assert.equal(tagged.code, 1);
  assert.match(tagged.stdout, /✗ тег v0\.2\.0 уже существует/);

  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), RELEASE_CHANGELOG);

  const bare = gitRepo();
  writeProfile(bare, RELEASE_PROFILE);
  const outside = runCli(['release', 'patch', '--yes'], { cwd: bare });
  assert.equal(outside.code, 1);
});

test('release --yes: a failing commit restores every changed file and leaves no tag', () => {
  const dir = releaseRepo();
  const hooks = join(dir, 'test-hooks');
  write(dir, 'test-hooks/pre-commit', '#!/bin/sh\necho "no commits today" >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(dir, 'config', 'core.hooksPath', hooks);
  git(dir, 'add', 'test-hooks');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  git(dir, 'commit', '-q', '-m', 'chore: hook');
  git(dir, 'config', 'core.hooksPath', hooks);
  const head = git(dir, 'rev-parse', 'HEAD');

  const r = runCli(['release', 'minor', '--yes', '--date', '2026-03-04'], { cwd: dir });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ git commit не удался/);
  assert.match(r.stdout, /Файлы возвращены в исходное состояние/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'working tree and index are back to HEAD');
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), RELEASE_CHANGELOG);
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"version": "0\.1\.0"/);
  assert.equal(git(dir, 'tag', '--list', 'v0.2.0'), '');
});

test('doctor: shows the changelog line only when release is configured', () => {
  const plain = gitRepo();
  writeProfile(plain, {});
  assert.doesNotMatch(runCli(['doctor'], { cwd: plain }).stdout, /Журнал изменений/);

  const dir = releaseRepo();
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /✓ Журнал изменений в порядке/);
  write(dir, 'package.json', '{ "version": "0.0.9" }\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /✗ Журнал изменений: 1 замечание — forge release --check/);
  write(dir, 'package.json', '{ "version": "0.1.0" }\n');
  git(dir, 'tag', '-d', 'v0.1.0');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Журнал изменений: 1 замечание — forge release --check/);
});
