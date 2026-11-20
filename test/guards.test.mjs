import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBash, checkFile, branchMatches } from '../lib/guards.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';

// Guards only reason about paths, so a fake root outside the temp dir keeps "outside the project" meaningful.
const root = '/work/project';
const ctx = (branch = 'feature/x') => ({
  cwd: root,
  root,
  protectedBranches: ['main', 'master', 'release/*'],
  currentBranch: () => branch,
});
const decide = (cmd, branch) => checkBash(cmd, ctx(branch)).decision;

test('branch patterns', () => {
  assert.equal(branchMatches('main', ['main']), 'main');
  assert.equal(branchMatches('feature/main', ['main']), null);
  assert.equal(branchMatches('release/1.2', ['release/*']), 'release/*');
  assert.equal(branchMatches('release/1.2/hotfix', ['release/*']), null);
});

test('push to a protected branch is denied in every spelling', () => {
  for (const cmd of [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin feature/x:refs/heads/master',
    'git push origin release/1.2',
    'git push origin :main',
    'git -C sub push origin main',
    'cd sub && git push origin main',
    'bash -c "git push origin main"',
    'GIT_TRACE=1 git push origin main',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  assert.equal(decide('git push', 'main'), 'deny', 'bare push from main');
  assert.equal(decide('git push origin HEAD', 'master'), 'deny', 'HEAD on master');
});

test('normal pushes are allowed', () => {
  for (const cmd of ['git push', 'git push -u origin feature/x', 'git push origin feature/x', 'git push --tags', 'git push --dry-run origin main']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('force push: denied unless --force-with-lease to an unprotected branch', () => {
  assert.equal(decide('git push --force origin feature/x'), 'deny');
  assert.equal(decide('git push -f'), 'deny');
  assert.equal(decide('git push origin +feature/x'), 'deny');
  assert.equal(decide('git push --force-with-lease origin feature/x'), 'allow');
  assert.equal(decide('git push --force-with-lease origin main'), 'deny');
});

test('skipping git hooks is denied', () => {
  assert.equal(decide('git commit -m "msg" --no-verify'), 'deny');
  assert.equal(decide('git commit -nm "msg"'), 'deny');
  assert.equal(decide('git push --no-verify origin feature/x'), 'deny');
  assert.equal(decide('git commit -am "no hooks skipped here"'), 'allow');
  assert.equal(decide('git commit -m -n'), 'allow');
});

test('destructive commands ask for confirmation', () => {
  assert.equal(decide('git reset --hard HEAD~1'), 'ask');
  assert.equal(decide('git reset --soft HEAD~1'), 'allow');
  assert.equal(decide('git push --all'), 'ask');
});

test('rm -r: inside the project is fine, outside or unpredictable asks', () => {
  assert.equal(decide('rm -rf node_modules dist'), 'allow');
  assert.equal(decide('rm -r build/*'), 'allow');
  assert.equal(decide('rm file.txt'), 'allow');
  assert.equal(decide(`rm -rf ${join(tmpdir(), 'forge-scratch')}`), 'allow');
  for (const cmd of ['rm -rf /', 'rm -rf ~', 'rm -rf "$DIR"', 'rm -rf ../other', 'rm -rf *', 'rm -rf .', 'rm -Rf /etc']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('mentions inside arguments and heredocs are not commands', () => {
  assert.equal(decide('echo "git push origin main"'), 'allow');
  assert.equal(decide('cat > doc.md <<EOF\ngit push --force origin main\nEOF'), 'allow');
  assert.equal(decide('grep -r "rm -rf /" .'), 'allow');
});

test('deny wins over ask in a compound command', () => {
  const v = checkBash('git reset --hard && git push origin main', ctx());
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /main/);
});

test('protected files', () => {
  const opts = { root, protectedFiles: DEFAULT_PROTECTED_FILES };
  assert.equal(checkFile(join(root, '.env'), opts).decision, 'deny');
  assert.equal(checkFile(join(root, 'apps/api/.env.production'), opts).decision, 'deny');
  assert.equal(checkFile(join(root, '.env.example'), opts).decision, 'allow');
  assert.equal(checkFile(join(root, 'src/index.ts'), opts).decision, 'allow');
  assert.equal(checkFile('/Users/someone/.ssh/id_ed25519', opts).decision, 'deny');
});
