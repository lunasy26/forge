import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareSemver, parseSemver, readVersion, readVersions, writeVersion } from '../lib/release.mjs';
import * as semver from '../lib/semver.mjs';
import { headSha, isClean, latestVersionTag, listTags, mergeBase, tagExists } from '../lib/git.mjs';
import { git, gitRepo, tempDir, write } from './helpers.mjs';

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

test('semver: precedence puts pre-releases below their release', () => {
  assert.equal(parseSemver('1.2'), null);
  assert.deepEqual(parseSemver('1.2.3-rc.1+b5').pre, ['rc', '1']);
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 1; i < order.length; i++) assert.ok(compareSemver(order[i - 1], order[i]) < 0, `${order[i - 1]} < ${order[i]}`);
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
});

test('semver: release.mjs re-exports the one implementation; no leading zeros', () => {
  assert.equal(parseSemver, semver.parseSemver);
  assert.equal(compareSemver, semver.compareSemver);
  assert.equal(parseSemver('2024.01.15'), null);
  assert.equal(parseSemver('1.2.03'), null);
  assert.equal(parseSemver('0.0.0').major, 0);
  assert.equal(latestVersionTag(gitRepoWithTags('v2024.01.15', 'v0.2.0'), 'v').tag, 'v0.2.0');
  assert.equal(latestVersionTag(gitRepoWithTags('2024.01.15'), ''), null);
});

function gitRepoWithTags(...tags) {
  const dir = gitRepo();
  for (const t of tags) git(dir, 'tag', t);
  return dir;
}

test('json: edits only the top-level version and keeps formatting, key order and BOM', () => {
  const dir = tempDir();
  const src = '﻿{\r\n    "name": "x",\r\n    "dependencies": { "version": "9.9.9" },\r\n    "version": "0.3.0",\r\n    "files": ["version"]\r\n}\r\n';
  write(dir, 'package.json', src);
  assert.deepEqual(readVersion(dir, 'package.json'), { path: 'package.json', version: '0.3.0' });
  writeVersion(dir, 'package.json', '0.4.0');
  assert.equal(read(dir, 'package.json'), src.replace('"0.3.0"', '"0.4.0"'));
});

test('json: any *.json works, e.g. .claude-plugin/plugin.json; missing field is an error', () => {
  const dir = tempDir();
  write(dir, '.claude-plugin/plugin.json', '{"name":"forge","version":"1.0.0-rc.1"}');
  assert.equal(readVersion(dir, '.claude-plugin/plugin.json').version, '1.0.0-rc.1');
  writeVersion(dir, '.claude-plugin/plugin.json', '1.0.0');
  assert.equal(read(dir, '.claude-plugin/plugin.json'), '{"name":"forge","version":"1.0.0"}');
  write(dir, 'composer.json', '{"name":"x","extra":{"version":"2.0.0"}}');
  const r = readVersion(dir, 'composer.json');
  assert.equal(r.version, null);
  assert.match(r.error, /version/);
});

test('pyproject.toml: [project] wins, [tool.poetry] is the fallback, other tables are ignored', () => {
  const dir = tempDir();
  write(dir, 'a/pyproject.toml', '[build-system]\nversion = "9"\n\n[project]\nname = "a"\nversion = "1.2.3"  # keep\n\n[tool.poetry]\nversion = "7.7.7"\n');
  assert.equal(readVersion(dir, 'a/pyproject.toml').version, '1.2.3');
  writeVersion(dir, 'a/pyproject.toml', '1.3.0');
  assert.equal(read(dir, 'a/pyproject.toml'), '[build-system]\nversion = "9"\n\n[project]\nname = "a"\nversion = "1.3.0"  # keep\n\n[tool.poetry]\nversion = "7.7.7"\n');

  write(dir, 'b/pyproject.toml', "[tool.poetry]\r\nname = 'b'\r\nversion = '0.1.0'\r\n");
  assert.equal(readVersion(dir, 'b/pyproject.toml').version, '0.1.0');
  writeVersion(dir, 'b/pyproject.toml', '0.2.0');
  assert.equal(read(dir, 'b/pyproject.toml'), "[tool.poetry]\r\nname = 'b'\r\nversion = '0.2.0'\r\n");

  write(dir, 'c/pyproject.toml', '[project]\nname = "c"\ndynamic = ["version"]\n[tool.other]\nversion = "5.0.0"\n');
  assert.equal(readVersion(dir, 'c/pyproject.toml').version, null);
});

test('Cargo.toml: version under [package] only', () => {
  const dir = tempDir();
  const src = '[dependencies]\nserde = { version = "1" }\nfoo = "2"\n\n[package]\nname = "x"\nversion = "0.5.1"\n\n[dev-dependencies]\nversion = "3"\n';
  write(dir, 'Cargo.toml', src);
  assert.equal(readVersion(dir, 'Cargo.toml').version, '0.5.1');
  writeVersion(dir, 'Cargo.toml', '0.6.0');
  assert.equal(read(dir, 'Cargo.toml'), src.replace('0.5.1', '0.6.0'));
  write(dir, 'ws/Cargo.toml', '[package]\nname = "x"\nversion.workspace = true\n');
  assert.equal(readVersion(dir, 'ws/Cargo.toml').version, null);
});

test('pom.xml: the project version, never the one in <parent> or <dependency>', () => {
  const dir = tempDir();
  const src = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <parent>
    <groupId>g</groupId>
    <version>9.9.9</version>
  </parent>
  <!-- <version>8.8.8</version> -->
  <artifactId>app</artifactId>
  <dependencies>
    <dependency><artifactId>d</artifactId><version>7.7.7</version></dependency>
  </dependencies>
  <version>1.4.0-SNAPSHOT</version>
</project>
`;
  write(dir, 'pom.xml', src);
  assert.equal(readVersion(dir, 'pom.xml').version, '1.4.0-SNAPSHOT');
  writeVersion(dir, 'pom.xml', '1.4.0');
  assert.equal(read(dir, 'pom.xml'), src.replace('1.4.0-SNAPSHOT', '1.4.0'));

  write(dir, 'inherit/pom.xml', '<project><parent><version>2.0.0</version></parent><artifactId>a</artifactId></project>');
  const r = readVersion(dir, 'inherit/pom.xml');
  assert.equal(r.version, null);
  assert.ok(r.error);
});

test('*.csproj: <Version>', () => {
  const dir = tempDir();
  const src = '<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup>\r\n    <TargetFramework>net8.0</TargetFramework>\r\n    <Version>2.1.0</Version>\r\n  </PropertyGroup>\r\n</Project>\r\n';
  write(dir, 'src/App.csproj', src);
  assert.equal(readVersion(dir, 'src/App.csproj').version, '2.1.0');
  writeVersion(dir, 'src/App.csproj', '2.2.0');
  assert.equal(read(dir, 'src/App.csproj'), src.replace('2.1.0', '2.2.0'));
});

test('*.csproj: only Project > PropertyGroup (no Condition) > Version; never a PackageReference', () => {
  const dir = tempDir();
  const src = `<Project Sdk="Microsoft.NET.Sdk">
  <!-- <Version>8.8.8</Version> -->
  <ItemGroup>
    <PackageReference Include="Lib"><Version>9.9.9</Version></PackageReference>
    <PackageReference Include="Other" Version="7.7.7" />
  </ItemGroup>
  <PropertyGroup Condition="'$(Configuration)' == 'Debug'">
    <Version>6.6.6</Version>
  </PropertyGroup>
  <PropertyGroup Label="Main">
    <TargetFramework>net8.0</TargetFramework>
    <Version>2.1.0</Version>
  </PropertyGroup>
  <PropertyGroup>
    <Version>3.0.0</Version>
  </PropertyGroup>
</Project>
`;
  write(dir, 'App.csproj', src);
  assert.equal(readVersion(dir, 'App.csproj').version, '2.1.0');
  writeVersion(dir, 'App.csproj', '2.2.0');
  assert.equal(read(dir, 'App.csproj'), src.replace('<Version>2.1.0', '<Version>2.2.0'));

  // no unconditional version of the project: an error, nothing written
  const only = `<Project><ItemGroup><PackageReference Include="L"><Version>1.0.0</Version></PackageReference></ItemGroup>
<PropertyGroup Condition="'$(X)'=='y'"><Version>1.2.3</Version></PropertyGroup>
<Target Name="t"><PropertyGroup><Version>4.0.0</Version></PropertyGroup></Target></Project>`;
  write(dir, 'Only.csproj', only);
  const r = readVersion(dir, 'Only.csproj');
  assert.equal(r.version, null);
  assert.match(r.error, /Version/);
  assert.throws(() => writeVersion(dir, 'Only.csproj', '2.0.0'), /Only\.csproj/);
  assert.equal(read(dir, 'Only.csproj'), only);
});

test('a version that is not SemVer is an error: ${revision}, 1.0, v1.0.0', () => {
  const dir = tempDir();
  write(dir, 'pom.xml', '<project><version>${revision}</version></project>');
  const r = readVersion(dir, 'pom.xml');
  assert.equal(r.version, null);
  assert.equal(r.error, 'версия не в формате SemVer: ${revision}');
  write(dir, 'a.csproj', '<Project><PropertyGroup><Version>1.0</Version></PropertyGroup></Project>');
  assert.equal(readVersion(dir, 'a.csproj').error, 'версия не в формате SemVer: 1.0');
  write(dir, 'package.json', '{"version":"v1.0.0"}');
  assert.equal(readVersion(dir, 'package.json').error, 'версия не в формате SemVer: v1.0.0');
  write(dir, 'Cargo.toml', '[package]\nversion = "2024.01.15"\n');
  assert.equal(readVersion(dir, 'Cargo.toml').error, 'версия не в формате SemVer: 2024.01.15');
  write(dir, 'README.md', 'version-1.0-blue');
  assert.match(readVersion(dir, { path: 'README.md', pattern: 'version-([\\d.]+)-' }).error, /SemVer: 1\.0$/);
  write(dir, 'ok.json', '{"version":"1.0.0-rc.1+b5"}');
  assert.equal(readVersion(dir, 'ok.json').version, '1.0.0-rc.1+b5');
});

test('pattern: every occurrence of the capture group is read and rewritten', () => {
  const dir = tempDir();
  const src = '[![v](https://img.shields.io/badge/version-0.3.0-blue)](CHANGELOG.md)\n\nText\n![again](https://x/version-0.3.0-green)\n';
  write(dir, 'README.md', src);
  const item = { path: 'README.md', pattern: 'version-(\\d+\\.\\d+\\.\\d+)-' };
  assert.deepEqual(readVersion(dir, item), { path: 'README.md', version: '0.3.0' });
  writeVersion(dir, item, '0.4.0');
  assert.equal(read(dir, 'README.md'), src.replaceAll('0.3.0', '0.4.0'));
  assert.deepEqual(readVersion(dir, { path: 'README.md', pattern: 'nothing-(\\d+)' }).version, null);
});

test('pattern: matches that disagree with each other are an error', () => {
  const dir = tempDir();
  write(dir, 'README.md', '![a](badge/version-0.3.0-blue)\n![b](badge/version-0.2.0-blue)\n![c](badge/version-0.3.0-green)\n');
  const item = { path: 'README.md', pattern: 'version-(\\d+\\.\\d+\\.\\d+)-' };
  const r = readVersion(dir, item);
  assert.equal(r.version, null);
  assert.match(r.error, /расходятся/);
  assert.match(r.error, /0\.3\.0/);
  assert.match(r.error, /0\.2\.0/);
  // a narrower pattern sees only one match
  assert.equal(readVersion(dir, { path: 'README.md', pattern: 'badge/version-(0\\.2\\.0)-' }).version, '0.2.0');
});

test('unknown file type, missing file and bad new version', () => {
  const dir = tempDir();
  write(dir, 'VERSION', '1.0.0\n');
  const r = readVersion(dir, 'VERSION');
  assert.equal(r.version, null);
  assert.equal(r.error, 'неизвестный тип файла версии, укажи pattern');
  assert.throws(() => writeVersion(dir, 'VERSION', '1.0.1'), /неизвестный тип файла версии, укажи pattern/);
  assert.match(readVersion(dir, 'package.json').error, /не найден/);
  write(dir, 'package.json', '{"version":"1.0.0"}');
  assert.throws(() => writeVersion(dir, 'package.json', '1"; evil'), /некорректная версия/);
  assert.equal(read(dir, 'package.json'), '{"version":"1.0.0"}');
});

test('readVersions goes through release.version_files', () => {
  const dir = tempDir();
  write(dir, 'package.json', '{"version":"1.0.0"}');
  write(dir, 'README.md', 'version-1.0.0-blue');
  const out = readVersions(dir, { version_files: ['package.json', { path: 'README.md', pattern: 'version-(\\d+\\.\\d+\\.\\d+)-' }] });
  assert.deepEqual(out.map((x) => x.version), ['1.0.0', '1.0.0']);
  assert.deepEqual(readVersions(dir, undefined), []);
});

test('git tags: highest semver per prefix, pre-releases below their release', () => {
  const dir = gitRepo();
  assert.deepEqual(listTags(dir), []);
  assert.equal(latestVersionTag(dir, 'v'), null);
  for (const t of ['v0.9.0', 'v0.10.0', 'v1.0.0-rc.1', 'v1.0.0-rc.2', 'nightly', '2.0.0', 'v0.10.0-beta']) git(dir, 'tag', t);
  assert.equal(listTags(dir).length, 7);
  assert.deepEqual(latestVersionTag(dir, 'v'), { tag: 'v1.0.0-rc.2', version: '1.0.0-rc.2' });
  assert.deepEqual(latestVersionTag(dir, ''), { tag: '2.0.0', version: '2.0.0' });
  git(dir, 'tag', 'v1.0.0');
  assert.deepEqual(latestVersionTag(dir, 'v'), { tag: 'v1.0.0', version: '1.0.0' });
  assert.equal(latestVersionTag(dir, 'rel-'), null);
  assert.equal(tagExists(dir, 'v1.0.0'), true);
  assert.equal(tagExists(dir, 'v3.0.0'), false);
  assert.equal(tagExists(dir, 'main'), false);
});

test('git: isClean ignores untracked files but sees staged and unstaged edits', () => {
  const dir = gitRepo();
  write(dir, 'a.txt', 'one');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'a');
  assert.equal(isClean(dir), true);
  write(dir, 'new.txt', 'untracked');
  assert.equal(isClean(dir), true);
  write(dir, 'a.txt', 'two');
  assert.equal(isClean(dir), false);
  git(dir, 'add', 'a.txt');
  assert.equal(isClean(dir), false);
  git(dir, 'commit', '-q', '-m', 'b');
  assert.equal(isClean(dir), true);
  assert.equal(isClean(tempDir()), false);
});

test('git: headSha and mergeBase', () => {
  const dir = gitRepo();
  const base = headSha(dir);
  assert.match(base, /^[0-9a-f]{40}$/);
  git(dir, 'checkout', '-q', '-b', 'feat');
  write(dir, 'f.txt', 'f');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', 'f');
  assert.notEqual(headSha(dir), base);
  assert.equal(mergeBase(dir, 'main', 'feat'), base);
  assert.equal(mergeBase(dir, 'main', 'nope'), null);
});
