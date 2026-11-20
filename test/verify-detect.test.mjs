import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, runSteps, summarize } from '../lib/verify.mjs';
import { detectProfile } from '../lib/detect.mjs';
import { defaultProfile } from '../lib/profile.mjs';
import { trimOutput } from '../lib/util.mjs';
import { tempDir, write } from './helpers.mjs';

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
