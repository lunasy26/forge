import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { checkBash } from '../lib/guards.mjs';
import { isInside } from '../lib/paths.mjs';
import { setLang } from '../lib/i18n.mjs';

setLang('ru');

// Windows behaviour is injected (ctx.platform, homedir, tmpdir), so it runs on every OS.
// Commands are what the model sends to Claude Code's Bash tool on Windows, i.e. Git Bash syntax:
// an unquoted backslash is an escape, so Windows paths are quoted or doubled.
const root = 'C:\\work\\project';
const ctx = (extra = {}) => ({
  cwd: root,
  root,
  platform: 'win32',
  homedir: 'C:\\Users\\me',
  tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp',
  protectedBranches: ['main', 'master', 'release/*'],
  currentBranch: () => 'feature/x',
  ...extra,
});
const decide = (cmd, extra) => checkBash(cmd, ctx(extra)).decision;

test('win32 rm -r: Git Bash /c/... paths map to the drive', () => {
  assert.equal(decide('rm -rf /c/work/project/build'), 'allow');
  assert.equal(decide('rm -rf /C/work/project/build'), 'allow');
  assert.equal(decide('rm -rf /c/work/other'), 'ask');
  assert.equal(decide('cd /c/work/project/sub && rm -rf ../build'), 'allow');
  assert.equal(decide('cd /c/work && rm -rf project/build'), 'allow');
  for (const cmd of ['rm -rf /c/', 'rm -rf /c', 'rm -rf /C', 'rm -rf /d/', 'rm -rf /c/work', 'rm -rf /c/work/project']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('win32 rm -r: the drive root, a UNC share root and home ask', () => {
  for (const cmd of [
    'rm -rf C:\\\\',
    "rm -rf 'C:\\'",
    'rm -rf "D:\\\\"',
    'rm -rf C:/',
    'rm -rf /',
    "rm -rf '\\\\server\\share'",
    "rm -rf '\\\\server\\share\\'",
    'rm -rf ~',
    'rm -rf ~/',
    'rm -rf ~\\\\',
    "rm -rf 'C:\\Users\\me'",
    "rm -rf 'c:\\USERS\\ME'",
    'rm -rf /c/Users/me',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('win32 rm -r: system folders and other drives ask, files on a share inside the project are fine', () => {
  for (const cmd of ["rm -rf 'C:\\Windows'", 'rm -rf "C:\\\\Program Files\\\\App"', 'rm -rf D:/data', "rm -rf '\\\\server\\share\\dir'"]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  const unc = '\\\\server\\share\\project';
  assert.equal(decide("rm -rf 'build'", { cwd: unc, root: unc }), 'allow');
  assert.equal(decide("rm -rf '\\\\server\\share\\project\\build'", { cwd: unc, root: unc }), 'allow');
});

test('win32 rm -r: the project is compared case-insensitively', () => {
  for (const cmd of ["rm -rf 'c:\\WORK\\Project\\build'", "rm -rf 'C:\\work\\project\\build'", 'rm -rf C:/Work/Project/build', 'rm -rf build']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  for (const cmd of ["rm -rf 'c:\\WORK\\Project'", "rm -rf 'C:\\Work'", "rm -rf 'c:\\work\\project\\'"]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('win32 rm -r: the temp dir and Git Bash /tmp are scratch areas, the temp dir itself is not', () => {
  for (const cmd of ['rm -rf /tmp/x', "rm -rf 'C:\\Users\\me\\AppData\\Local\\Temp\\x'", 'rm -rf ~/AppData/Local/Temp/x', 'rm -rf /c/users/me/appdata/local/temp/x']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  for (const cmd of ['rm -rf /tmp', 'rm -rf /tmp/', "rm -rf 'C:\\Users\\me\\AppData\\Local\\Temp'", 'rm -rf /private/tmp/x', 'rm -rf /var/folders/x']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
});

test('win32: a multi-letter first segment is not a drive', () => {
  // /cc/... and /tmpx are Git Bash paths under its install root, not C:\ — outside the project
  assert.equal(decide('rm -rf /cc/work/project/build'), 'ask');
  assert.equal(decide('rm -rf /tmpx/y'), 'ask');
});

test('win32: git -C with a Git Bash path finds the repository', () => {
  const branchOf = (cwd) => (win32.relative('C:\\work\\main-repo', cwd) === '' ? 'main' : 'feature/x');
  assert.equal(decide('git -C /c/work/main-repo push', { currentBranch: branchOf }), 'deny');
  assert.equal(decide('git -C /c/work/project push', { currentBranch: branchOf }), 'allow');
});

test('win32: git.exe and full Windows paths to git are git', () => {
  for (const cmd of [
    'git.exe push --force origin feature/x',
    'GIT.EXE push --force origin feature/x',
    'Git push origin main',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push origin main',
    "'C:\\Program Files\\Git\\cmd\\git.exe' push origin main",
    'C:/Program\\ Files/Git/cmd/git.exe push origin main',
    '/c/Program\\ Files/Git/cmd/git push origin main',
    'git.exe commit --no-verify -m x',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  assert.equal(decide('GIT push origin feature'), 'allow');
  assert.equal(decide('git.exe status'), 'allow');
  assert.equal(decide('"C:\\Program Files\\Git\\cmd\\git.exe" push origin feature/x'), 'allow');
});

test('win32: rm.exe and shells by full path are recognised', () => {
  assert.equal(decide("rm.exe -rf 'C:\\'"), 'ask');
  assert.equal(decide("/usr/bin/RM -rf 'C:\\'"), 'ask');
  assert.equal(decide('"C:\\Program Files\\Git\\bin\\bash.exe" -c "git push origin main"'), 'deny');
  assert.equal(decide('bash.exe -lc "git push --force"'), 'deny');
  assert.equal(decide('bash.exe -lc "git status"'), 'allow');
  assert.equal(decide('rm.exe -rf build'), 'allow');
  assert.equal(decide('rmdir.exe build'), 'allow');
  assert.equal(decide('gitk.exe --all'), 'allow');
});

test('win32: PowerShell started from Git Bash reads Windows paths', () => {
  assert.equal(decide('powershell.exe -Command "Remove-Item -Recurse C:\\\\"'), 'ask');
  assert.equal(decide("pwsh -c 'Remove-Item -Recurse -Force C:\\Windows'"), 'ask');
  assert.equal(decide("pwsh -c 'Remove-Item -Recurse .\\build'"), 'allow');
  assert.equal(decide("pwsh -c 'Remove-Item -Recurse C:\\work\\project\\out'"), 'allow');
  assert.equal(decide('cmd //c "rmdir /s /q C:\\\\data"'), 'ask');
});

test('git.exe and Windows paths to git are git on POSIX too', () => {
  const posix = { platform: 'linux', cwd: '/work/project', root: '/work/project', homedir: '/home/me', tmpdir: '/tmp' };
  assert.equal(decide('git.exe push --force origin feature/x', posix), 'deny');
  assert.equal(decide('"C:\\Program Files\\Git\\cmd\\git.exe" push origin main', posix), 'deny');
  assert.equal(decide('GIT push origin main', posix), 'deny');
  assert.equal(decide('GIT push origin feature', posix), 'allow');
  // on POSIX /c/... is an ordinary absolute path, and backslash paths are relative names
  assert.equal(decide('rm -rf /c/work/project/build', posix), 'ask');
  assert.equal(decide('rm -rf /tmp/x', posix), 'allow');
});

test('isInside takes an optional path API', () => {
  assert.equal(isInside('C:\\work\\project', 'c:\\Work\\Project\\x', win32), true);
  assert.equal(isInside('C:\\work\\project', 'D:\\work\\project\\x', win32), false);
  assert.equal(isInside('C:\\work\\project', 'C:\\work\\project-2', win32), false);
  assert.equal(isInside('/work/project', '/work/project/x'), true);
  assert.equal(isInside('/work/project', '/work/projectx'), false);
});

test('win32 cmd: carets, quotes, glued switches and /r do not hide git or a recursive delete', () => {
  for (const cmd of [
    'cmd //c g^it push --force',
    'cmd /c g^it push origin main',
    "cmd /c 'r^d /s /q C:\\'",
    'cmd //c rd/s/q C:/Users',
    'cmd //c rd /q/s C:/Users',
    'cmd //c del/f/s/q x',
    'cmd /c rd //s x',
    'cmd /c "RD /S x"',
    'cmd /c g\\"i\\"t push -f',
    'cmd /r git push -f',
    'cmd /R "git push -f"',
    'cmd /s /r "rd/s x"',
    'cmd /c "if exist x rd /s /q x"',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of ['cmd /c dir /s', 'cmd //c echo rd', 'cmd /c type README.md', 'cmd /c "echo rd & dir /s"', 'cmd /c rd build', 'cmd /c del /q x', 'cmd /c echo /rgit']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('win32 wsl: the Linux command line is checked with the Bash rules', () => {
  for (const cmd of [
    'wsl git push --force',
    'wsl -e git push --force',
    'wsl --exec git push -f',
    'wsl -- git push origin main',
    'wsl -d Ubuntu git push -f',
    'wsl --distribution Ubuntu --user me -e git commit --no-verify -m x',
    'wsl bash -c "git push -f"',
    'wsl.exe -u root git push -f',
    'wsl -e sudo git push -f',
    'wsl ~ git push -f',
    "wsl echo hi '&&' git push -f",
    'sudo wsl git push -f',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of ['wsl rm -rf /', 'wsl --cd /home/me git push', 'wsl ~ git push', 'wsl -e rm -rf ~']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of [
    'wsl --list',
    'wsl -l -v',
    'wsl --shutdown',
    'wsl --install -d Ubuntu',
    'wsl',
    'wsl ls',
    'wsl git status',
    'wsl -e ls -la',
    'wsl echo git push --force',
    'wsl -d Ubuntu git push origin feature/x',
    "wsl 'git push -f'",
    'wsl rm -rf build',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  assert.equal(decide('wsl git push', { currentBranch: () => 'main' }), 'deny');
  assert.equal(decide('wsl git push'), 'allow');
});
