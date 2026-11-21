import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfile } from '../lib/profile.mjs';
import { mainWorktree, projectRoot } from '../lib/paths.mjs';
import { git, gitRepo, runCli, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

/** A repo with a linked worktree nested like Claude Code's: <main>/.claude/worktrees/w. */
function repoWithWorktree(mainProfile) {
  const main = gitRepo('main');
  if (mainProfile) writeProfile(main, mainProfile);
  const wt = join(main, '.claude', 'worktrees', 'w');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
  return { main, wt };
}

function withoutProjectDir(fn) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

const UNPROTECTED = { git: { protected_branches: [] } };

test('mainWorktree: the main checkout for a linked worktree, null elsewhere', () => {
  const { main, wt } = repoWithWorktree();
  assert.equal(mainWorktree(wt), main);
  assert.equal(mainWorktree(main), null);
  assert.equal(mainWorktree(tempDir()), null);
  // a worktree outside the main checkout
  const sibling = join(tempDir(), 'side');
  git(main, 'worktree', 'add', '-q', '-b', 'side', sibling);
  assert.equal(mainWorktree(sibling), main);
});

test('mainWorktree: a worktree of a bare repository has no main checkout', () => {
  const src = gitRepo('main');
  const bare = join(tempDir(), 'repo.git');
  git(src, 'clone', '-q', '--bare', src, bare);
  const wt = join(tempDir(), 'w');
  git(bare, 'worktree', 'add', '-q', '-b', 'w', wt);
  assert.equal(mainWorktree(wt), null);
});

test('loadProfile: a worktree without its own profile reads the main checkout one', () => {
  const { main, wt } = repoWithWorktree({ ...UNPROTECTED, mode: 'eco' });
  const r = loadProfile(wt);
  assert.equal(r.exists, true);
  assert.equal(r.inherited, main);
  assert.equal(r.file, join(main, '.forge', 'profile.json'));
  assert.deepEqual(r.profile.git.protected_branches, []);
  assert.equal(r.profile.mode, 'eco');
});

test('loadProfile: the worktree own profile wins over the main checkout one', () => {
  const { wt } = repoWithWorktree({ ...UNPROTECTED, mode: 'eco' });
  writeProfile(wt, { mode: 'max' });
  const r = loadProfile(wt);
  assert.equal(r.inherited, null);
  assert.equal(r.file, join(wt, '.forge', 'profile.json'));
  assert.equal(r.profile.mode, 'max');
  assert.deepEqual(r.profile.git.protected_branches, ['main', 'master']);
});

test('loadProfile: no profile anywhere stays "no profile"', () => {
  const { wt } = repoWithWorktree();
  const r = loadProfile(wt);
  assert.equal(r.exists, false);
  assert.equal(r.inherited, null);
});

test('projectRoot: a worktree nested in the main checkout is its own root', () => {
  const { wt } = repoWithWorktree(UNPROTECTED);
  write(wt, 'src/a.txt', 'x');
  withoutProjectDir(() => {
    assert.equal(projectRoot(join(wt, 'src')), wt);
    assert.equal(projectRoot(wt), wt);
  });
});

test('pre-bash in a worktree follows the main checkout profile', () => {
  const push = { tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
  const bare = repoWithWorktree();
  const denied = runHookScript('pre-bash', { ...push, cwd: bare.wt }, { projectDir: bare.wt });
  assert.equal(denied.json?.hookSpecificOutput?.permissionDecision, 'deny');

  const { wt } = repoWithWorktree(UNPROTECTED);
  const allowed = runHookScript('pre-bash', { ...push, cwd: wt }, { projectDir: wt });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, '');
});

test('forge doctor in a worktree names the main checkout profile', () => {
  const { main, wt } = repoWithWorktree(UNPROTECTED);
  for (const env of [{}, { CLAUDE_PROJECT_DIR: wt }]) {
    const r = runCli(['doctor'], { cwd: wt, env });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(`✓ Проект: ${wt}\n`), r.stdout);
    assert.ok(r.stdout.includes(`✓ Профиль из основного checkout ${main}`), r.stdout);
    assert.match(r.stdout, /✓ Профиль валиден/);
    assert.doesNotMatch(r.stdout, /Профиля нет/);
  }
  const en = runCli(['doctor'], { cwd: wt, env: { FORGE_LANG: 'en' } });
  assert.ok(en.stdout.includes(`✓ Profile from the main checkout ${main}`), en.stdout);
});

test('forge doctor: a worktree own profile is not reported as inherited', () => {
  const { wt } = repoWithWorktree(UNPROTECTED);
  writeProfile(wt, UNPROTECTED);
  const r = runCli(['doctor'], { cwd: wt });
  assert.doesNotMatch(r.stdout, /основного checkout/);
  assert.match(r.stdout, /✓ Профиль валиден/);
});

test('session start in a worktree says where the profile comes from', () => {
  const { main, wt } = repoWithWorktree(UNPROTECTED);
  const r = runHookScript('session-start', { cwd: wt }, { projectDir: wt });
  const ctx = r.json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^forge: режим normal/);
  assert.ok(ctx.includes(`Профиль из основного checkout ${main}`), ctx);
});

test('state stays per worktree with an inherited profile', () => {
  const { main, wt } = repoWithWorktree(UNPROTECTED);
  const r = runCli(['state', 'set', 'stage', 'plan'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(wt, '.forge', 'state.json')));
  assert.ok(!existsSync(join(main, '.forge', 'state.json')));
});
