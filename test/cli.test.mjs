import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.match(bad.stdout, /✗ Агентские файлы: 1 замечаний — forge docs/);
  write(dir, 'AGENTS.md', '# Проект\n');
  write(dir, 'CLAUDE.md', '@AGENTS.md\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /✓ Агентские файлы в порядке/);
  write(dir, 'AGENTS.md', '# Проект\n[x](nope.md)\n');
  assert.match(runCli(['doctor'], { cwd: dir }).stdout, /! Агентские файлы: 1 замечаний — forge docs/);
});
