import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../lib/i18n.mjs';
import { buildCommand, runSteps, summarize } from '../lib/verify.mjs';
import { detectProfile, detectRelease } from '../lib/detect.mjs';
import { defaultProfile } from '../lib/profile.mjs';
import { trimOutput } from '../lib/util.mjs';
import { git, gitRepo, tempDir, write } from './helpers.mjs';

setLang('ru'); // assertions below check the Russian texts

test('buildCommand: {files} substitution, quoting and extension filter', () => {
  assert.equal(buildCommand('npm test', []), 'npm test');
  assert.equal(buildCommand('eslint {files}', ['a.ts', 'my file.ts']), "eslint a.ts 'my file.ts'");
  assert.equal(buildCommand({ run: 'ruff check {files}', ext: ['.py'] }, ['a.ts', 'b.py']), 'ruff check b.py');
  assert.equal(buildCommand({ run: 'ruff check {files}', ext: ['.py'] }, ['a.ts']), null);
  assert.equal(buildCommand('eslint {files}', []), null);
});

test('runSteps: stops at the first failure, skips steps without files', () => {
  const dir = tempDir();
  const profile = defaultProfile();
  profile.commands = { lint: 'echo lint {files}', typecheck: 'echo types', test: 'echo boom >&2; exit 3', after: 'echo never' };
  const r = runSteps(dir, profile, ['lint', 'typecheck', 'test', 'after'], { files: [] });
  assert.equal(r.ok, false);
  assert.equal(r.failed.step, 'test');
  assert.equal(r.failed.code, 3);
  assert.match(r.failed.output, /boom/);
  assert.deepEqual(r.results.map((x) => x.step), ['lint', 'typecheck', 'test']);
  assert.match(summarize(r), /lint: пропущен.*typecheck: ok.*test: код 3/);
});

test('runSteps: test_fast replaces test in fast mode when it has files', () => {
  const dir = tempDir();
  const profile = defaultProfile();
  profile.commands = { test: 'echo full', test_fast: 'echo fast {files}' };
  const fast = runSteps(dir, profile, ['test'], { files: ['a.ts'], fast: true });
  assert.match(fast.results[0].command, /fast a\.ts/);
  const noFiles = runSteps(dir, profile, ['test'], { files: [], fast: true });
  assert.equal(noFiles.results[0].command, 'echo full');
});

test('runSteps: timeout is reported as a failure', () => {
  const dir = tempDir();
  const profile = defaultProfile();
  profile.commands = { test: 'sleep 5' };
  const r = runSteps(dir, profile, ['test'], { timeoutSec: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.failed.timedOut, true);
});

test('trimOutput keeps head and tail', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const out = trimOutput(text, 30).split('\n');
  assert.equal(out.length, 30);
  assert.equal(out[0], 'line 0');
  assert.equal(out.at(-1), 'line 199');
  assert.match(out[10], /скрыто строк: 171/);
});

test('detect: node with vitest, eslint, prettier and TypeScript', () => {
  const dir = tempDir();
  write(dir, 'package.json', {
    scripts: { test: 'vitest run', lint: 'eslint .' },
    devDependencies: { vitest: '1', eslint: '9', prettier: '3', typescript: '5' },
  });
  write(dir, 'tsconfig.json', '{}');
  write(dir, 'pnpm-lock.yaml', '');
  const { stack, profile } = detectProfile(dir);
  assert.equal(stack, 'node (pnpm)');
  assert.equal(profile.commands.test, 'pnpm test');
  assert.equal(profile.commands.typecheck, 'pnpm exec tsc --noEmit');
  assert.match(profile.commands.lint.run, /eslint \{files\}/);
  assert.match(profile.commands.test_fast.run, /vitest related --run \{files\}/);
  assert.match(profile.commands.format, /prettier --write --ignore-unknown/);
  assert.deepEqual(profile.verify.steps, ['typecheck', 'lint', 'test']);
});

test('detect: python with uv, ruff and pytest', () => {
  const dir = tempDir();
  write(dir, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n');
  write(dir, 'uv.lock', '');
  const { stack, profile } = detectProfile(dir);
  assert.equal(stack, 'python (uv)');
  assert.equal(profile.commands.test, 'uv run pytest -q');
  assert.deepEqual(profile.commands.lint, { run: 'uv run ruff check {files}', ext: ['.py', '.pyi'] });
});

test('detect: SwiftPM turns verification on stop off; unknown stack is reported', () => {
  const swift = tempDir();
  write(swift, 'Package.swift', '// swift-tools-version:5.9');
  const s = detectProfile(swift);
  assert.equal(s.profile.verify.on_stop, 'off');
  assert.equal(s.profile.commands.test, 'swift test');

  const empty = detectProfile(tempDir());
  assert.equal(empty.stack, 'unknown');
  assert.deepEqual(empty.profile.verify.steps, []);
});

const BADGE = { path: 'README.md', pattern: 'badge/version-(\\d+\\.\\d+\\.\\d+)-' };

test('detect release: forge-like project (CHANGELOG, v* tags, three version files)', () => {
  const dir = gitRepo();
  write(dir, 'CHANGELOG.md', '# Changelog\n');
  write(dir, 'package.json', { name: 'forge', version: '0.3.0' });
  write(dir, '.claude-plugin/plugin.json', { name: 'forge', version: '0.3.0' });
  write(dir, 'README.md', '[![version](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md)\n');
  git(dir, 'tag', 'v0.2.0');
  git(dir, 'tag', 'v0.3.0');
  const { release, notes } = detectRelease(dir);
  assert.deepEqual(release, { changelog: 'CHANGELOG.md', tag_prefix: 'v', version_files: ['package.json', '.claude-plugin/plugin.json', BADGE] });
  assert.ok(notes.some((n) => /найден CHANGELOG\.md/.test(n)));
  assert.ok(notes.some((n) => /теги версий \(v0\.3\.0\)/.test(n)));
  assert.deepEqual(detectProfile(dir).profile.release, release);
  assert.ok(detectProfile(dir).notes.some((n) => /CHANGELOG\.md/.test(n)));
});

test('detect release: service-like project (0.0.0 only in a subdir, CI publishes images on dispatch)', () => {
  const dir = gitRepo();
  write(dir, 'CHANGELOG.md', '# Changelog\n');
  write(dir, 'web/package.json', { name: 'web', version: '0.0.0' });
  write(dir, 'package.json', { name: 'root', version: '0.0.0', private: true });
  write(dir, '.github/workflows/images.yml', `name: images
on:
  # push:
  #   tags: ['v*']
  workflow_dispatch:
    inputs:
      ref:
        description: ref
      publish:
        description: push images
        type: boolean
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t app .
      - run: docker push app
`);
  git(dir, 'tag', 'v1.0.0');
  const { release, notes } = detectRelease(dir);
  assert.deepEqual(release, { changelog: 'CHANGELOG.md', tag_prefix: 'v', version_files: [] });
  assert.ok(notes.some((n) => /CI публикует образы \(docker push\)/.test(n)));
  assert.ok(notes.some((n) => /параметром publish/.test(n)));
  assert.ok(!notes.some((n) => /по тегам/.test(n)), 'commented-out trigger is ignored');
});

test('detect release: a plain project has no release signals', () => {
  const dir = gitRepo();
  write(dir, 'package.json', { name: 'plain', version: '1.2.3', scripts: { test: 'node --test' } });
  write(dir, 'README.md', 'version-1.2.3-blue\n');
  write(dir, '.github/workflows/ci.yml', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      verbose:\n        type: boolean\njobs:\n  t:\n    steps:\n      - run: npm test\n');
  git(dir, 'tag', 'nightly');
  assert.deepEqual(detectRelease(dir), { release: null, notes: [] });
  assert.equal('release' in detectProfile(dir).profile, false);
  assert.deepEqual(detectRelease(tempDir()), { release: null, notes: [] });
});

test('detect release: CI npm publish alone turns it on; unprefixed tags give an empty prefix', () => {
  const dir = tempDir();
  write(dir, '.github/workflows/publish.yml', 'on: push\njobs:\n  p:\n    steps:\n      - run: npm publish\n');
  const a = detectRelease(dir);
  assert.deepEqual(a.release, { changelog: 'CHANGELOG.md', tag_prefix: 'v', version_files: [] });
  assert.deepEqual(a.notes, ['Релизы включены: CI публикует пакеты (npm publish).']);

  const repo = gitRepo();
  write(repo, 'pom.xml', '<project><parent><version>9.0.0</version></parent><version>3.1.0</version></project>');
  write(repo, 'ci/x.csproj', '<Project><Version>1.0.0</Version></Project>');
  write(repo, 'app.csproj', '<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>');
  write(repo, '.github/workflows/rel.yml', 'on:\n  push:\n    tags:\n      - "*"\njobs: {}\n');
  git(repo, 'tag', '1.0.0');
  git(repo, 'tag', '1.1.0');
  const b = detectRelease(repo);
  assert.equal(b.release.tag_prefix, '');
  assert.deepEqual(b.release.version_files, ['pom.xml', 'app.csproj']);
  assert.ok(b.notes.some((n) => /по тегам \(push: tags\)/.test(n)));
});

test('detect release: only a SemVer version counts, a shields badge is the only README pattern', () => {
  const dir = gitRepo();
  write(dir, 'CHANGELOG.md', '# Changelog\n');
  write(dir, 'pom.xml', '<project><version>${revision}</version></project>');
  write(dir, 'app.csproj', '<Project><PropertyGroup><Version>1.0</Version></PropertyGroup></Project>');
  write(dir, 'package.json', { name: 'x', version: '2024.01.15' });
  write(dir, 'README.md', 'see https://x/version-1.2.3-green\n');
  assert.deepEqual(detectRelease(dir).release.version_files, []);

  write(dir, 'package.json', { name: 'x', version: '1.2.3' });
  write(dir, 'app.csproj', '<Project><ItemGroup><PackageReference Include="L"><Version>9.9.9</Version></PackageReference></ItemGroup></Project>');
  write(dir, 'README.md', '![v](https://img.shields.io/badge/version-1.2.3-blue)\n');
  assert.deepEqual(detectRelease(dir).release.version_files, ['package.json', BADGE]);
});

test('detect release: CalVer tags are not version tags', () => {
  const dir = gitRepo();
  write(dir, 'CHANGELOG.md', '# Changelog\n');
  git(dir, 'tag', 'v2024.01.15');
  const { release, notes } = detectRelease(dir);
  assert.equal(release.tag_prefix, 'v');
  assert.ok(!notes.some((n) => /теги версий/.test(n)));
});
