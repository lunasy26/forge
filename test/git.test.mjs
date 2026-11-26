import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aheadBehind, branchExists, diffNames, remoteUrl, remotes, trackingOf, untrackedFiles, upstreamOf, worktreeList,
} from '../lib/git.mjs';
import { git, gitRepo, tempDir, write } from './helpers.mjs';

function commitFile(dir, rel, msg) {
  write(dir, rel, msg);
  git(dir, 'add', rel);
  git(dir, 'commit', '-q', '-m', msg);
}

test('aheadBehind and diffNames compare a branch with its base', () => {
  const dir = gitRepo('main');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commitFile(dir, 'feature.txt', 'feature');
  git(dir, 'checkout', '-q', 'main');
  commitFile(dir, 'base.txt', 'base');
  git(dir, 'checkout', '-q', 'feat');
  assert.deepEqual(aheadBehind(dir, 'main', 'feat'), { ahead: 1, behind: 1 });
  assert.deepEqual(aheadBehind(dir, 'feat', 'main'), { ahead: 1, behind: 1 });
  assert.equal(aheadBehind(dir, 'main', 'nope'), null);
  assert.deepEqual(diffNames(dir, 'main'), ['feature.txt']);
  assert.deepEqual(diffNames(dir, 'main', 'feat'), ['feature.txt']);
  assert.deepEqual(diffNames(dir, 'nope'), []);
});

test('aheadBehind counts one-sided differences', () => {
  const dir = gitRepo('main');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commitFile(dir, 'a.txt', 'a');
  commitFile(dir, 'b.txt', 'b');
  assert.deepEqual(aheadBehind(dir, 'main', 'HEAD'), { ahead: 2, behind: 0 });
});

test('untrackedFiles lists untracked files and skips ignored ones', () => {
  const dir = gitRepo('main');
  assert.deepEqual(untrackedFiles(dir), []);
  commitFile(dir, '.gitignore', 'ignored.txt\n');
  write(dir, 'new.txt', 'x');
  write(dir, 'ignored.txt', 'x');
  write(dir, 'sub/deep.txt', 'x');
  assert.deepEqual(untrackedFiles(dir).sort(), ['new.txt', 'sub/deep.txt']);
});

test('diffNames and untrackedFiles return non-ASCII names unescaped (core.quotePath)', () => {
  const dir = gitRepo('main');
  git(dir, 'config', 'core.quotePath', 'true');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commitFile(dir, 'src/файл.js', 'x');
  write(dir, 'новый файл.txt', 'x');
  assert.deepEqual(diffNames(dir, 'main'), ['src/файл.js']);
  assert.deepEqual(untrackedFiles(dir), ['новый файл.txt']);
});

test('diffNames and untrackedFiles in a subdirectory are relative to it and limited to it', () => {
  const dir = gitRepo('main');
  git(dir, 'checkout', '-q', '-b', 'feat');
  commitFile(dir, 'pkg/src/a.js', 'a');
  commitFile(dir, 'other/b.js', 'b');
  write(dir, 'pkg/new.txt', 'x');
  write(dir, 'top.txt', 'x');
  const pkg = join(dir, 'pkg');
  assert.deepEqual(diffNames(pkg, 'main'), ['src/a.js']);
  assert.deepEqual(untrackedFiles(pkg), ['new.txt']);
  assert.deepEqual(diffNames(dir, 'main').sort(), ['other/b.js', 'pkg/src/a.js']);
});

test('trackingOf reads the upstream remote and branch name from the branch config', () => {
  const dir = gitRepo('main');
  assert.equal(trackingOf(dir, 'main'), null);
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'fork', remote);
  git(dir, 'branch', 'feat/x');
  git(dir, 'push', '-q', 'fork', 'feat/x:work/other');
  git(dir, 'branch', '-q', '-u', 'fork/work/other', 'feat/x');
  assert.deepEqual(trackingOf(dir, 'feat/x'), { remote: 'fork', branch: 'work/other' });
  // tracking a local branch (remote ".") has no remote branch to delete
  git(dir, 'branch', '-q', '-u', 'main', 'feat/x');
  assert.equal(trackingOf(dir, 'feat/x'), null);
});

test('branchExists checks local branches only', () => {
  const dir = gitRepo('main');
  git(dir, 'branch', 'feat/x');
  assert.equal(branchExists(dir, 'main'), true);
  assert.equal(branchExists(dir, 'feat/x'), true);
  assert.equal(branchExists(dir, 'nope'), false);
});

test('upstreamOf is null without an upstream and names it when set', () => {
  const dir = gitRepo('main');
  assert.equal(upstreamOf(dir, 'main'), null);
  const remote = tempDir();
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  assert.equal(upstreamOf(dir, 'main'), 'origin/main');
});

test('remotes and remoteUrl', () => {
  const dir = gitRepo('main');
  assert.deepEqual(remotes(dir), []);
  assert.equal(remoteUrl(dir), null);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git(dir, 'remote', 'add', 'other', 'https://example.com/other.git');
  assert.deepEqual(remotes(dir).sort(), ['origin', 'other']);
  assert.equal(remoteUrl(dir), 'https://github.com/example/repo.git');
  assert.equal(remoteUrl(dir, 'other'), 'https://example.com/other.git');
  assert.equal(remoteUrl(dir, 'missing'), null);
});

test('worktreeList reports the main and linked worktrees', () => {
  const dir = gitRepo('main');
  const linked = join(tempDir(), 'wt');
  git(dir, 'worktree', 'add', '-q', linked, '-b', 'feat');
  const list = worktreeList(dir);
  assert.equal(list.length, 2);
  const main = list.find((w) => realpathSync(w.path) === realpathSync(dir));
  const feat = list.find((w) => realpathSync(w.path) === realpathSync(linked));
  assert.deepEqual([main.branch, main.bare, main.detached], ['main', false, false]);
  assert.deepEqual([feat.branch, feat.bare, feat.detached], ['feat', false, false]);
  // native form: git prints C:/… on Windows, path.resolve turns it into C:\…
  assert.ok(list.every((w) => w.path === resolve(w.path)));
  git(linked, 'checkout', '-q', '--detach');
  const detached = worktreeList(dir).find((w) => realpathSync(w.path) === realpathSync(linked));
  assert.deepEqual([detached.branch, detached.detached], [null, true]);
  assert.deepEqual(worktreeList(tempDir()), []);
});
