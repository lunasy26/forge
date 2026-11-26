import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitRepo, runCli as run, write, writeProfile } from './helpers.mjs';

// English output of forge finish.
const runCli = (args, opts = {}) => run(args, { ...opts, env: { FORGE_LANG: 'en', ...opts.env } });
const CYRILLIC = /\p{Script=Cyrillic}/u;

function featureRepo(profile) {
  const dir = gitRepo();
  writeProfile(dir, { commands: { test: 'true' }, verify: { steps: ['test'] }, git: { protected_branches: ['main'] }, ...profile });
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '.forge/\n');
  git(dir, 'switch', '-q', '-c', 'feat/x');
  write(dir, 'src/a.js', 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat: a');
  return dir;
}

test('finish: English text output', () => {
  const dir = featureRepo();
  const r = runCli(['finish'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, CYRILLIC);
  assert.match(r.stdout, /^forge finish: feat\/x → main \(git\.protected_branches\), ahead 1, behind 0$/m);
  assert.match(r.stdout, /✓ feat\/x: 1 commit to integrate into main/);
  assert.match(r.stdout, /✓ Verification passed: test: ok/);
  assert.match(r.stdout, /merge — merge locally:\n {2}1\. git switch main/);
});

test('finish: English failures, usage error and help line', () => {
  const dir = featureRepo({ commands: { test: 'false' } });
  const r = runCli(['finish', '--json'], { cwd: dir });
  assert.equal(r.code, 1);
  const failed = JSON.parse(r.stdout).checks.find((c) => c.id === 'verify-failed');
  assert.match(failed.message, /^verification failed at step "test"/);
  const usage = runCli(['finish', '--nope'], { cwd: dir });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /unknown argument "--nope"\. forge finish \[--base <branch>\] \[--no-verify\] \[--json\]/);
  assert.match(runCli(['help'], { cwd: dir }).stdout, /forge finish \[--base <branch>\] \[--no-verify\] \[--json\]/);
});

test('finish: English no-base and base-stale messages', () => {
  const dir = featureRepo({ git: { protected_branches: ['trunk'] } });
  let r = runCli(['finish', '--json'], { cwd: dir });
  assert.equal(r.code, 1);
  const noBase = JSON.parse(r.stdout).checks.find((c) => c.id === 'no-base');
  assert.match(noBase.message, /origin's default branch is unknown or not a local branch, and no git\.protected_branches entry exists locally/);

  // main tracks a branch that has one commit main lacks
  writeProfile(dir, { commands: { test: 'true' }, verify: { steps: ['test'] }, git: { protected_branches: ['main'] } });
  git(dir, 'branch', '-q', 'ahead', 'main');
  git(dir, 'switch', '-q', 'ahead');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'ahead');
  git(dir, 'switch', '-q', 'feat/x');
  git(dir, 'config', 'branch.main.remote', '.');
  git(dir, 'config', 'branch.main.merge', 'refs/heads/ahead');
  r = runCli(['finish', '--json', '--no-verify'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const stale = JSON.parse(r.stdout).checks.find((c) => c.id === 'base-stale');
  assert.match(stale.message, /^the local main is 1 commit behind ahead: .*git pull --ff-only on main/);
});
