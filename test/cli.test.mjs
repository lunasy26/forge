import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
