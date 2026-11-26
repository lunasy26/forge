import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeFinish, resolveBase, shq } from '../lib/finish.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { configureRepo, git, gitRepo, runCli, tempDir, write, writeProfile } from './helpers.mjs';

const PROFILE = { commands: { test: 'true' }, verify: { steps: ['test'] }, git: { protected_branches: ['main'] } };
const EMPTY_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n- First version\n';

/** A repo on main with a profile; .forge/ is excluded so the tree stays clean (state.json lands there too). */
function repo(profile = PROFILE) {
  const dir = gitRepo();
  writeProfile(dir, profile);
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '.forge/\n');
  return dir;
}

function commit(dir, files, message = 'change') {
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/** A repo with feat/x one commit ahead of main. */
function featureRepo(profile = PROFILE, files = { 'src/a.js': 'a\n' }) {
  const dir = repo(profile);
  git(dir, 'switch', '-q', '-c', 'feat/x');
  commit(dir, files, 'feat: a');
  return dir;
}

function finish(dir, args = []) {
  const r = runCli(['finish', '--json', ...args], { cwd: dir });
  return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

const ids = (r) => r.json.checks.map((c) => c.id);
const checkOf = (r, id) => r.json.checks.find((c) => c.id === id);
const cmds = (r, flow) => r.json.steps[flow].map((s) => s.cmd);
const noteIds = (r, flow) => r.json.notes.filter((n) => n.flow === flow).map((n) => n.id);

/** Run printed steps in order: they are plain `git <word>…` commands (no quoting needed in these fixtures). */
function runSteps(steps) {
  for (const { cmd, cwd } of steps) {
    const words = cmd.split(' ');
    assert.equal(words[0], 'git', cmd);
    git(cwd, ...words.slice(1));
  }
}

/** The path of a `git -C <path> …` step, unquoted (shq) — compared via realpath, not as a string. */
function dashCPath(cmd) {
  const m = /^git -C ('(?:[^']|'\\'')*'|\S+) /.exec(cmd);
  assert.ok(m, cmd);
  const arg = m[1];
  return arg.startsWith("'") ? arg.slice(1, -1).replace(/'\\''/g, "'") : arg;
}

const samePath = (a, b) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

/** A bare repository as origin, with main pushed and origin/HEAD set. */
function addOrigin(dir) {
  const bare = tempDir('forge-origin-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return bare;
}

test('finish: a ready branch — ok checks, verify recorded in state, merge steps without push when there is no origin', () => {
  const dir = featureRepo();
  const r = finish(dir);
  assert.equal(r.code, 0, r.stderr);
  const j = r.json;
  assert.equal(j.ok, true);
  assert.equal(j.branch, 'feat/x');
  assert.equal(j.base, 'main');
  assert.equal(j.base_source, 'protected');
  assert.equal(j.flow, null);
  assert.deepEqual([j.ahead, j.behind], [1, 0]);
  assert.deepEqual(ids(r), ['branch', 'clean', 'verify', 'flow-unset']);
  assert.equal(checkOf(r, 'branch').message, 'feat/x: 1 коммит для вливания в main');
  assert.equal(checkOf(r, 'verify').level, 'ok');
  assert.equal(j.verify.ok, true);
  assert.match(j.verify.summary, /test: ok/);
  assert.deepEqual(cmds(r, 'merge'), ['git switch main', 'git merge feat/x', 'git branch -d feat/x']);
  assert.ok(j.steps.merge.every((s) => s.cwd === dir));
  assert.deepEqual(j.steps.pr, []);
  assert.deepEqual(noteIds(r, 'pr'), ['no-origin']);
  const state = JSON.parse(readFileSync(join(dir, '.forge', 'state.json'), 'utf8'));
  assert.equal(state.verify.ok, true);
  assert.equal(state.failures.verify_streak, 0);
  // read-only: still on the branch, nothing merged
  assert.equal(git(dir, 'branch', '--show-current'), 'feat/x');
  assert.equal(git(dir, 'rev-list', '--count', 'main'), '1');
});

test('finish: verify runs over the branch files (not the edit log) and the full test, not test_fast', () => {
  const profile = {
    commands: {
      test: 'echo full > .forge/test.txt',
      test_fast: 'echo fast > .forge/test.txt',
      lint: { run: 'printf "%s\\n" {files} > .forge/lint.txt' },
    },
    verify: { steps: ['lint', 'test'] },
    git: { protected_branches: ['main'] },
  };
  const dir = featureRepo(profile, { 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  const r = finish(dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(join(dir, '.forge', 'lint.txt'), 'utf8').trim().split('\n'), ['src/a.js', 'src/b.js']);
  assert.equal(readFileSync(join(dir, '.forge', 'test.txt'), 'utf8').trim(), 'full');
});

test('finish: detached HEAD fails and stops', () => {
  const dir = featureRepo();
  git(dir, 'switch', '-q', '--detach');
  const r = finish(dir);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.deepEqual(ids(r), ['detached']);
  assert.equal(r.json.verify, null);
  assert.deepEqual(r.json.steps, { merge: [], pr: [] });
});

test('finish: on the base branch, and a branch with no commits ahead', () => {
  const dir = repo();
  let r = finish(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ['on-base']);
  git(dir, 'switch', '-q', '-c', 'feat/empty');
  r = finish(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ['no-commits']);
  assert.equal(r.json.ahead, 0);
  assert.equal(r.json.verify, null);
});

test('finish: uncommitted tracked change fails and verify is not run', () => {
  const dir = featureRepo();
  write(dir, 'src/a.js', 'changed\n');
  const r = finish(dir);
  assert.equal(r.code, 1);
  assert.equal(checkOf(r, 'dirty').level, 'fail');
  assert.equal(r.json.verify, null);
  assert.ok(!ids(r).includes('verify'));
  assert.ok(!existsSync(join(dir, '.forge', 'state.json')));
  // text mode: no commands until the ✗ are fixed
  const text = runCli(['finish'], { cwd: dir });
  assert.equal(text.code, 1);
  assert.match(text.stdout, /✗ в рабочем дереве есть незакоммиченные изменения/);
  assert.match(text.stdout, /Сначала исправь пункты с ✗/);
  assert.doesNotMatch(text.stdout, /git merge/);
});

test('finish: untracked files are a warning listing up to five names', () => {
  const dir = featureRepo();
  for (let i = 1; i <= 7; i++) write(dir, `new${i}.txt`, 'x');
  const r = finish(dir);
  assert.equal(r.code, 0);
  const c = checkOf(r, 'untracked');
  assert.equal(c.level, 'warn');
  assert.match(c.message, /new1\.txt, new2\.txt, new3\.txt, new4\.txt, new5\.txt и ещё 2$/);
});

test('finish: base moved ahead — behind warning with the count; rebase before push, merge after', () => {
  const dir = featureRepo();
  git(dir, 'switch', '-q', 'main');
  commit(dir, { 'm1.txt': '1' });
  commit(dir, { 'm2.txt': '2' });
  git(dir, 'switch', '-q', 'feat/x');
  let r = finish(dir);
  assert.equal(r.code, 0);
  assert.equal(r.json.behind, 2);
  let c = checkOf(r, 'behind');
  assert.equal(c.level, 'warn');
  assert.match(c.message, /в main 2 коммита, которых нет в feat\/x/);
  assert.match(c.message, /git rebase main/);
  addOrigin(dir);
  git(dir, 'push', '-q', '-u', 'origin', 'feat/x');
  r = finish(dir);
  c = checkOf(r, 'behind');
  assert.match(c.message, /git merge main/);
});

test('finish: a failing verify step fails the check and is recorded; --no-verify skips it', () => {
  const dir = featureRepo({ ...PROFILE, commands: { test: 'false' } });
  let r = finish(dir);
  assert.equal(r.code, 1);
  const c = checkOf(r, 'verify-failed');
  assert.equal(c.level, 'fail');
  assert.match(c.message, /«test»/);
  assert.equal(r.json.verify.ok, false);
  assert.equal(r.json.verify.failed_step, 'test');
  assert.equal(runCli(['state', 'get', 'verify.ok'], { cwd: dir }).stdout.trim(), 'false');
  r = finish(dir, ['--no-verify']);
  assert.equal(r.code, 0);
  assert.equal(checkOf(r, 'verify-skipped').level, 'warn');
  assert.equal(r.json.verify, null);
});

test('finish: empty verify.steps is a warning', () => {
  const dir = featureRepo({ git: { protected_branches: ['main'] } });
  const r = finish(dir);
  assert.equal(r.code, 0);
  assert.equal(checkOf(r, 'no-verify-steps').level, 'warn');
});

test('finish: --base — an existing branch is used, an unknown one fails', () => {
  const dir = featureRepo();
  git(dir, 'branch', 'develop', 'main');
  let r = finish(dir, ['--base', 'develop']);
  assert.equal(r.code, 0);
  assert.equal(r.json.base, 'develop');
  assert.equal(r.json.base_source, 'flag');
  r = finish(dir, ['--base=nope']);
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ['no-base']);
  assert.match(checkOf(r, 'no-base').message, /«nope»/);
});

test('finish: no base found — no origin and no protected branch exists locally', () => {
  const dir = featureRepo({ ...PROFILE, git: { protected_branches: ['release/*', 'trunk'] } });
  let r = finish(dir);
  assert.equal(r.code, 1);
  assert.deepEqual(ids(r), ['no-base']);
  assert.match(checkOf(r, 'no-base').message, /--base <ветка>/);
  // origin/HEAD exists but its branch is not local: the message covers that case too
  addOrigin(dir);
  git(dir, 'switch', '-q', 'feat/x');
  git(dir, 'branch', '-q', '-m', 'main', 'old-main');
  r = finish(dir);
  assert.deepEqual(ids(r), ['no-base']);
  assert.match(checkOf(r, 'no-base').message, /ветка по умолчанию у origin неизвестна или её нет локально/);
});

test('resolveBase: --base, then origin/HEAD, then the first plain protected branch that exists', () => {
  const dir = featureRepo();
  git(dir, 'branch', 'trunk', 'main');
  const profile = { git: { protected_branches: ['release/*', '!x', 'nope', 'trunk', 'main'] } };
  assert.deepEqual(resolveBase(dir, profile), { base: 'trunk', source: 'protected' });
  assert.deepEqual(resolveBase(dir, profile, 'main'), { base: 'main', source: 'flag' });
  assert.equal(resolveBase(dir, profile, 'missing'), null);
  addOrigin(dir);
  assert.deepEqual(resolveBase(dir, profile), { base: 'main', source: 'origin' });
});

test('finish: usage errors and no profile', () => {
  const dir = featureRepo();
  for (const args of [['--bogus'], ['extra'], ['--base']]) {
    const r = runCli(['finish', ...args], { cwd: dir });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /forge finish \[--base <ветка>\] \[--no-verify\] \[--json\]/);
  }
  const bare = gitRepo();
  const r = runCli(['finish'], { cwd: bare });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /нет профиля — сначала forge init/);
});

test('finish: with origin — push and remote delete steps, protected base note, pr steps, not-github note', () => {
  const dir = featureRepo();
  addOrigin(dir);
  git(dir, 'push', '-q', '-u', 'origin', 'feat/x');
  const r = finish(dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.base_source, 'origin');
  assert.deepEqual(cmds(r, 'merge'), [
    'git switch main',
    'git merge feat/x',
    'git push origin main',
    'git push origin --delete feat/x',
    'git branch -d feat/x',
  ]);
  assert.deepEqual(noteIds(r, 'merge'), ['base-protected']);
  assert.deepEqual(cmds(r, 'pr'), ['git push -u origin feat/x', 'gh pr create --base main --head feat/x --fill']);
  assert.ok(noteIds(r, 'pr').includes('not-github'));
});

test('analyzeFinish: gh missing is a pr note; a GitHub origin is not flagged; no remote delete without upstream', () => {
  const dir = featureRepo();
  git(dir, 'remote', 'add', 'origin', 'git@github.com:example/project.git');
  const { profile } = loadProfile(dir);
  const r = analyzeFinish(dir, profile, { verify: false, hasGh: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.filter((n) => n.flow === 'pr').map((n) => n.id), ['no-gh']);
  assert.deepEqual(r.steps.merge.map((s) => s.cmd), ['git switch main', 'git merge feat/x', 'git push origin main', 'git branch -d feat/x']);
  const withGh = analyzeFinish(dir, profile, { verify: false, hasGh: true });
  assert.deepEqual(withGh.notes.filter((n) => n.flow === 'pr'), []);
});

test('finish: base checked out in another worktree — merge there, no local delete, dirty base noted', () => {
  const main = repo();
  const wt = join(tempDir('forge-wt-'), 'feat');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'feat/x');
  commit(wt, { 'src/a.js': 'a\n' }, 'feat: a');
  let r = finish(wt);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.base, 'main');
  // git prints C:/… on Windows and macOS temp dirs are symlinks: compare the -C path by realpath
  const [step] = cmds(r, 'merge');
  assert.equal(cmds(r, 'merge').length, 1);
  assert.match(step, / merge feat\/x$/);
  assert.ok(samePath(dashCPath(step), main), step);
  assert.ok(r.json.steps.merge.every((s) => s.cwd === wt));
  assert.deepEqual(noteIds(r, 'merge'), ['branch-in-worktree']);
  const deleteHint = /(git -C .+ branch -d feat\/x)$/.exec(r.json.notes[0].message);
  assert.ok(deleteHint, r.json.notes[0].message);
  assert.ok(samePath(dashCPath(deleteHint[1]), main), deleteHint[1]);
  write(main, 'tracked.txt', 'x');
  git(main, 'add', 'tracked.txt');
  r = finish(wt);
  assert.deepEqual(noteIds(r, 'merge'), ['base-worktree-dirty', 'branch-in-worktree']);
});

test('finish: an upstream behind the branch — remote delete comes before git branch -d, and the steps run in order', () => {
  const dir = featureRepo();
  const bare = addOrigin(dir);
  git(dir, 'push', '-q', '-u', 'origin', 'feat/x');
  commit(dir, { 'src/b.js': 'b\n' }, 'feat: b'); // not pushed: origin/feat/x is behind
  const r = finish(dir, ['--no-verify']);
  assert.equal(r.code, 0, r.stderr);
  const steps = cmds(r, 'merge');
  assert.deepEqual(steps, [
    'git switch main',
    'git merge feat/x',
    'git push origin main',
    'git push origin --delete feat/x',
    'git branch -d feat/x',
  ]);
  runSteps(r.json.steps.merge);
  assert.equal(git(dir, 'branch', '--list', 'feat/x'), '');
  assert.equal(git(bare, 'branch', '--list', 'feat/x'), '');
  assert.equal(git(bare, 'rev-parse', 'main'), git(dir, 'rev-parse', 'main'));
});

test('finish: the remote delete uses the tracked remote and branch name', () => {
  const dir = featureRepo();
  addOrigin(dir);
  const fork = tempDir('forge-fork-');
  git(fork, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'fork', fork);
  git(dir, 'push', '-q', 'fork', 'feat/x:work/renamed');
  git(dir, 'branch', '-q', '-u', 'fork/work/renamed', 'feat/x');
  const r = finish(dir, ['--no-verify']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(cmds(r, 'merge'), [
    'git switch main',
    'git merge feat/x',
    'git push origin main',
    'git push fork --delete work/renamed',
    'git branch -d feat/x',
  ]);
  runSteps(r.json.steps.merge);
  assert.equal(git(fork, 'branch', '--list', 'work/renamed'), '');
});

test('finish: a local base behind its fetched upstream — base-stale warning; after updating the base, behind shows', () => {
  const dir = featureRepo();
  const bare = addOrigin(dir);
  git(dir, 'branch', '-q', '-u', 'origin/main', 'main');
  const other = join(tempDir('forge-other-'), 'clone');
  git(dir, 'clone', '-q', bare, other);
  configureRepo(other);
  commit(other, { 'upstream.txt': 'u\n' }, 'upstream change');
  git(other, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q');

  let r = finish(dir, ['--no-verify']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.behind, 0);
  const c = checkOf(r, 'base-stale');
  assert.equal(c.level, 'warn');
  assert.match(c.message, /^локальная main отстаёт от origin\/main на 1 коммит: /);
  assert.match(c.message, /git pull --ff-only на main/);
  assert.ok(!ids(r).includes('behind'));

  git(dir, 'fetch', '-q', 'origin', 'main:main');
  r = finish(dir, ['--no-verify']);
  assert.ok(!ids(r).includes('base-stale'));
  assert.equal(r.json.behind, 1);
  assert.equal(checkOf(r, 'behind').level, 'warn');
});

test('finish: a package with its own profile inside a repository — paths are relative to the package', () => {
  const dir = gitRepo();
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '.forge/\n');
  const pkg = join(dir, 'pkg');
  const profile = {
    commands: { test: 'true', lint: { run: 'printf "%s\\n" {files} > .forge/lint.txt' } },
    verify: { steps: ['lint', 'test'] },
    git: { protected_branches: ['main'] },
    release: { remind: false },
  };
  writeProfile(pkg, profile);
  commit(dir, { 'pkg/CHANGELOG.md': EMPTY_CHANGELOG, 'pkg/README.md': '# pkg\n' }, 'init pkg');
  git(dir, 'switch', '-q', '-c', 'feat/x');
  // only a changelog edit inside the package and a code change outside it
  commit(dir, { 'pkg/CHANGELOG.md': `${EMPTY_CHANGELOG}\n`, 'other/a.js': 'a\n' });
  let r = finish(pkg);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!ids(r).includes('unreleased-empty'), JSON.stringify(r.json.checks));
  assert.deepEqual(readFileSync(join(pkg, '.forge', 'lint.txt'), 'utf8').trim().split('\n'), ['CHANGELOG.md']);

  commit(dir, { 'pkg/src/b.js': 'b\n' });
  write(dir, 'pkg/new.txt', 'x');
  write(dir, 'outside.txt', 'x');
  r = finish(pkg);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(checkOf(r, 'unreleased-empty').message, /\(src\/b\.js\)/);
  assert.match(checkOf(r, 'untracked').message, /: new\.txt$/);
  assert.deepEqual(readFileSync(join(pkg, '.forge', 'lint.txt'), 'utf8').trim().split('\n'), ['CHANGELOG.md', 'src/b.js']);
});

test('finish: git.flow pr — text shows only the pr flow; flow unset — warning and both lists', () => {
  const dir = featureRepo({ ...PROFILE, git: { protected_branches: ['main'], flow: 'pr' } });
  addOrigin(dir);
  let r = runCli(['finish'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^forge finish: feat\/x → main \(origin\/HEAD\), впереди 1, позади 0$/m);
  assert.match(r.stdout, /Способ: pr \(git\.flow\)/);
  assert.match(r.stdout, /1\. git push -u origin feat\/x/);
  assert.match(r.stdout, /2\. gh pr create --base main --head feat\/x --fill/);
  assert.doesNotMatch(r.stdout, /git switch main/);
  assert.doesNotMatch(r.stdout, /способ вливания не выбран/);

  const plain = featureRepo();
  r = runCli(['finish'], { cwd: plain });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /! способ вливания не выбран \(git\.flow\)/);
  assert.match(r.stdout, /merge — слить локально:\n {2}1\. git switch main/);
  assert.match(r.stdout, /pr — pull request:\n {2}! нет удалённого репозитория origin/);
});

test('finish: unreleased-empty warns about code changes with an empty [Unreleased], not about docs-only branches', () => {
  const profile = { ...PROFILE, release: { remind: false } };
  const code = repo(profile);
  commit(code, { 'CHANGELOG.md': EMPTY_CHANGELOG }, 'docs: changelog');
  git(code, 'switch', '-q', '-c', 'feat/x');
  commit(code, { 'src/a.js': 'a\n' });
  let r = finish(code);
  assert.equal(r.code, 0);
  const c = checkOf(r, 'unreleased-empty');
  assert.equal(c.level, 'warn');
  assert.match(c.message, /src\/a\.js/);
  assert.match(c.message, /CHANGELOG\.md/);

  const docs = repo(profile);
  commit(docs, { 'CHANGELOG.md': EMPTY_CHANGELOG }, 'docs: changelog');
  git(docs, 'switch', '-q', '-c', 'docs/x');
  commit(docs, { 'docs/x.md': '# x\n' });
  r = finish(docs);
  assert.equal(r.code, 0);
  assert.ok(!ids(r).includes('unreleased-empty'));
});

test('shq: safe words stay bare, everything else is single-quoted', () => {
  assert.equal(shq('feat/x-1_2.3@a:b'), 'feat/x-1_2.3@a:b');
  assert.equal(shq('/tmp/my dir'), "'/tmp/my dir'");
  assert.equal(shq("it's"), "'it'\\''s'");
  assert.equal(shq('C:\\Users\\a'), "'C:\\Users\\a'");
});
