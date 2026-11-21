import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPowerShell } from '../lib/guards.mjs';
import { setLang } from '../lib/i18n.mjs';

setLang('ru');

// Commands are what the model sends to Claude Code's PowerShell tool. Guards only reason about paths,
// so the roots are fake; Windows behaviour is injected (ctx.platform, homedir, tmpdir) and runs on any OS.
const posixRoot = '/work/project';
const winRoot = 'C:\\work\\project';
const posixCtx = (extra = {}) => ({
  cwd: posixRoot,
  root: posixRoot,
  platform: 'linux',
  homedir: '/home/me',
  tmpdir: '/tmp',
  protectedBranches: ['main', 'master', 'release/*'],
  currentBranch: () => 'feature/x',
  ...extra,
});
const winCtx = (extra = {}) => ({
  cwd: winRoot,
  root: winRoot,
  platform: 'win32',
  homedir: 'C:\\Users\\me',
  tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp',
  protectedBranches: ['main', 'master', 'release/*'],
  currentBranch: () => 'feature/x',
  ...extra,
});
const win = (cmd, extra) => checkPowerShell(cmd, winCtx(extra));
const nix = (cmd, extra) => checkPowerShell(cmd, posixCtx(extra));
/** The same verdict on Windows and on pwsh for macOS/Linux. */
const both = (cmd) => {
  const w = win(cmd).decision;
  const p = nix(cmd).decision;
  assert.equal(w, p, `${cmd}: win32 ${w}, posix ${p}`);
  return w;
};

test('pwsh git: protected push, force, --no-verify and reset --hard in every spelling', () => {
  for (const cmd of [
    'git push origin main',
    'git push --force',
    'git push -f origin feature/x',
    'GIT.EXE push -f origin x',
    'GIT push origin main',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' push origin main",
    '& "git.exe" push --force',
    '&git push origin main',
    'git commit --no-verify -m x',
    'git commit -nm x',
    'git push origin main # comment',
    '$x = git push origin main',
    '$x=git push origin main',
    '$a = $b = git push origin main',
    '$x += git push --force',
    '[void](git push --force)',
    'echo $(git push --force)',
    'Write-Host "done: $(git push --force)"',
    'Get-ChildItem | ForEach-Object { git push --force }',
    'if ($true) { foreach ($b in 1) { if ($b) { try { git push --force } catch {} } } }',
    'git status; git push origin main',
    'git status && git push origin main',
    'git --% push --force',
    'git push \u2013\u2013force',
    'Microsoft.PowerShell.Core\\git push origin main',
  ]) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  assert.equal(both('git reset --hard'), 'ask');
  assert.equal(both('git reset --hard HEAD~1'), 'ask');
  assert.match(win('git push origin main').reason, /защищённую ветку «main»/);
});

test('pwsh git: ordinary commands stay silent', () => {
  for (const cmd of [
    'git status',
    'git push origin feature/x',
    'git push --force-with-lease origin feature/x',
    'git commit -m "push --force later"',
    'git reset --soft HEAD~1',
    'npm test',
    'echo "git push --force"',
    "Write-Host 'git push origin main'",
    '$msg = "git push --force"',
    'git log --oneline | Select-Object -First 5',
    'gitk --all',
    '# git push --force',
    '<# git push --force #> git status',
  ]) {
    assert.deepEqual(both(cmd), 'allow', cmd);
  }
  assert.deepEqual(win('git status'), { decision: 'allow', reason: '' });
});

test('pwsh: an unterminated or unparseable command asks', () => {
  for (const cmd of ['git push "origin main', "git status 'x", 'echo $(git status', 'Get-ChildItem | ForEach-Object { git status', 'echo }']) {
    assert.equal(both(cmd), 'ask', cmd);
  }
  assert.match(win('git status "x').reason, /не разбирается/);
});

test('pwsh Remove-Item -Recurse: outside the project, roots and home ask', () => {
  for (const cmd of [
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item C:\\ -Recurse',
    'rm -r -fo ~\\',
    'rm -r ~',
    'ri -Rec ..\\..',
    'del -r ..',
    'erase -recurse C:\\Windows',
    'rd /s C:\\Windows -Recurse',
    'rmdir -Recurse D:\\data',
    'Remove-Item -Path:C:\\Windows -Recurse',
    'Remove-Item -Path C:\\Windows -Recurse',
    'Remove-Item -LiteralPath C:\\Windows -Recurse',
    'Remove-Item -lp C:\\Windows -r',
    'Remove-Item -Recurse:$true C:\\Windows',
    'Remove-Item -RECURSE C:\\Users\\me',
    'Remove-Item -Recurse .\\build,C:\\',
    'Remove-Item -Recurse -Filter *.tmp -Path C:\\data',
    'Remove-Item -Recurse -Include x -Exclude y -ErrorAction SilentlyContinue C:\\data',
    'Remove-Item -Recurse C:\\*',
    'Remove-Item -Recurse $env:TEMP\\x',
    'Remove-Item -Recurse "$HOME\\x"',
    'Remove-Item -Recurse -Path:$p',
    'Remove-Item -Recurse \\\\server\\share',
    'Remove-Item -Recurse HKLM:\\Software\\Vendor',
    'Remove-Item -Recurse Registry::HKEY_CURRENT_USER\\Software\\x',
    'Remove-Item -Recurse FileSystem::C:\\Windows',
    'Microsoft.PowerShell.Management\\Remove-Item -Recurse C:\\',
    'Remove-Item \u2013Recurse C:\\',
    'Set-Location C:\\; Remove-Item -Recurse Windows',
    'cd ..; Remove-Item -Recurse project',
    'Set-Location $env:TEMP; Remove-Item -Recurse x',
    'Push-Location C:\\Windows; Remove-Item -Recurse System32',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('Remove-Item -Recurse -Force C:\\').reason, /Remove-Item -Recurse за пределами проекта.*C:\\/);
});

test('pwsh Remove-Item: recursive deletes inside the project or temp, and non-recursive ones, are silent', () => {
  for (const cmd of [
    'Remove-Item .\\build -Recurse -Force',
    'Remove-Item -Recurse -Force build, dist',
    'Remove-Item -Recurse -Path:.\\out',
    'Remove-Item -Recurse C:\\work\\project\\node_modules',
    'Remove-Item -Recurse c:\\WORK\\project\\node_modules',
    'Remove-Item -Recurse C:\\Users\\me\\AppData\\Local\\Temp\\forge-x',
    'Remove-Item -Recurse:$false C:\\x',
    'Remove-Item C:\\x\\file.txt',
    'Remove-Item -Force C:\\Windows\\x.log',
    'rm C:\\x\\file.txt',
    'Get-ChildItem -Recurse',
    'Get-ChildItem -Recurse C:\\ | Measure-Object',
    'Copy-Item -Recurse C:\\src .\\dst',
    'Set-Location sub; Remove-Item -Recurse ..\\build',
    'Push-Location C:\\Windows; Pop-Location; Remove-Item -Recurse build',
    "Write-Host 'rm -r C:\\'",
    'echo "Remove-Item -Recurse C:\\"',
    'Remove-Item -Recurse -Filter *.tmp .\\build',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh Remove-Item: pipeline input cannot be checked', () => {
  for (const cmd of ['Get-ChildItem x | Remove-Item -Recurse', 'ls C:\\ | rm -r -Force', '$items | Remove-Item -Recurse']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('Get-ChildItem x | Remove-Item -Recurse').reason, /конвейер/);
  // without -Recurse nothing is recursive
  assert.equal(win('Get-ChildItem *.log | Remove-Item').decision, 'allow');
});

test('pwsh on macOS/Linux: rm is /bin/rm, paths use / and \\ alike', () => {
  for (const cmd of ['rm -rf /', 'rm -rf ~', 'rm -rf ..', 'Remove-Item -Recurse /etc', 'Remove-Item -Recurse ~\\', 'Remove-Item -Recurse ..\\..']) {
    assert.equal(nix(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ['rm -rf build', 'rm -rf /tmp/forge-x', 'Remove-Item -Recurse ./build', 'Remove-Item -Recurse .\\build', 'rmdir empty']) {
    assert.equal(nix(cmd).decision, 'allow', cmd);
  }
});

test('pwsh iex: a literal script is checked again, a dynamic or piped one asks', () => {
  for (const cmd of [
    'iex "git push -f origin main"',
    'Invoke-Expression "git push --force"',
    "Invoke-Expression -Command 'git push --force'",
    "iex -Command:'git push --force'",
    "iex @'\ngit push --force\n'@",
    'iex "iex \'git push --force\'"',
  ]) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  for (const cmd of ['"git push -f" | iex', 'iex $cmd', 'iex "git $sub --force"', 'Get-Content x.ps1 -Raw | Invoke-Expression']) {
    assert.equal(both(cmd), 'ask', cmd);
  }
  assert.match(win('"git push -f" | iex').reason, /конвейер/);
  assert.match(win('iex $cmd').reason, /во время выполнения/);
  assert.equal(both('iex "git status"'), 'allow');
  assert.equal(both("iex 'Get-Date'"), 'allow');
});

test('pwsh -Command, -EncodedCommand and -File', () => {
  for (const cmd of [
    'pwsh -c "git push --force"',
    'pwsh -NoProfile -Command "git push --force"',
    "powershell -Command 'git push origin main'",
    'powershell.exe -nop -c git push --force',
    "pwsh -Command:'git push --force'",
    'pwsh /c "git push --force"',
    'powershell "git push --force"',
    'pwsh -ExecutionPolicy Bypass -c "iex \'git push -f\'"',
  ]) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  for (const cmd of ['powershell -EncodedCommand ZQBjAGgAbwA=', 'pwsh -enc ZQBjAGgAbwA=', 'pwsh -e ZQBjAGgAbwA=', 'pwsh -ec ZQBjAGgAbwA=', 'pwsh -c $script', 'pwsh -Command -']) {
    assert.equal(both(cmd), 'ask', cmd);
  }
  assert.match(win('powershell -EncodedCommand ZQBjAGgAbwA=').reason, /EncodedCommand/);
  for (const cmd of ['pwsh -File build.ps1', 'pwsh -NoProfile -File .\\build.ps1 -Force', 'pwsh -f build.ps1 push', 'pwsh -c "Get-Date"', 'pwsh -NoLogo', 'pwsh']) {
    assert.equal(both(cmd), 'allow', cmd);
  }
  assert.equal(win('pwsh -c "Remove-Item -Recurse C:\\"').decision, 'ask');
});

test('pwsh: bash -c and cmd /c', () => {
  for (const cmd of ['bash -c "git push --force"', 'bash.exe -lc "git push origin main"', "sh -c 'git commit --no-verify -m x'"]) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  assert.equal(nix('bash -c "rm -rf /"').decision, 'ask');
  for (const cmd of ['cmd /c "git push -f"', 'cmd.exe /C git push origin main', 'cmd /k "rd /s /q C:\\data"', 'cmd /c del /s /q x', 'cmd /c "powershell -enc ZQBjAGgAbwA="', 'cmd --% /c git push -f']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('cmd /c "git push -f"').reason, /cmd/);
  for (const cmd of ['cmd /c dir', 'cmd /c "echo hello"', 'bash -c "ls -la"', 'cmd /c mklink /d a b', 'cmd /c "digit"']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh Start-Process: git or a shell with literal arguments is checked, dynamic ones ask', () => {
  for (const cmd of [
    "Start-Process git -ArgumentList 'push','--force'",
    "Start-Process -FilePath git.exe -ArgumentList 'push origin main'",
    "saps git 'push','-f' -NoNewWindow -Wait",
    "start 'C:\\Program Files\\Git\\cmd\\git.exe' -ArgumentList push,--force",
    "Start-Process pwsh -ArgumentList '-c','git push --force'",
    'Start-Process bash -ArgumentList \'-c\',\'"git push --force"\'',
  ]) {
    assert.equal(win(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['Start-Process git -ArgumentList $args', "Start-Process $exe -ArgumentList 'push','--force'", "Start-Process cmd '/c','git push -f'"]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  for (const cmd of [
    "Start-Process git -ArgumentList 'status'",
    "Start-Process notepad -ArgumentList 'push.txt'",
    'Start-Process notepad $file',
    'Start-Process https://example.com',
    "Start-Process $exe -ArgumentList 'build'",
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh Invoke-Command and script blocks: the block is checked, -FilePath runs a script', () => {
  assert.equal(win('Invoke-Command -ScriptBlock { git push --force }').decision, 'deny');
  assert.equal(win('icm { Remove-Item -Recurse C:\\ }').decision, 'ask');
  assert.equal(win('Invoke-Command -FilePath .\\deploy.ps1').decision, 'allow');
  assert.equal(win('Invoke-Command -ScriptBlock { git status }').decision, 'allow');
  // code built from a string at run time
  for (const cmd of ["& ([scriptblock]::Create('git push --force'))", 'Invoke-Command ([ScriptBlock]::Create($s))', '$ExecutionContext.InvokeCommand.InvokeScript($s)']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
});

test('pwsh dynamic command names ask only when the arguments look dangerous', () => {
  for (const cmd of ['& $git push origin main', '& $exe reset --hard', '& $tool commit -m x', '& $rm -Recurse C:\\', '& $cmd -rf /', '& $pw -c "git push"', '& (Get-Command git) push --force']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ['& $exe --version', '& $python script.py', '& $env:ComSpec /c dir', '. $profile', '. .\\env.ps1']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh aliases pointing at guarded commands ask', () => {
  for (const cmd of ['Set-Alias g git; g push --force', 'New-Alias -Name x -Value Remove-Item', 'sal run iex']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.equal(win('Set-Alias ll Get-ChildItem').decision, 'allow');
});

test('pwsh: pathological nesting asks quickly', () => {
  const t0 = Date.now();
  for (const cmd of [
    'echo ' + '$('.repeat(3000) + 'x' + ')'.repeat(3000) + '; git status',
    '{ '.repeat(40) + 'git status' + ' }'.repeat(40),
    'iex "iex \'iex \\"git status\\"\'"'.repeat(1),
  ]) {
    assert.notEqual(win(cmd).decision, 'deny', cmd.slice(0, 30));
  }
  assert.equal(win('echo ' + '$('.repeat(3000) + 'x' + ')'.repeat(3000)).decision, 'ask');
  assert.equal(win('{ '.repeat(40) + 'git status' + ' }'.repeat(40)).decision, 'ask');
  assert.ok(Date.now() - t0 < 5000);
});

test('pwsh: garbage input never throws', () => {
  for (const cmd of ['', '   ', ';;;', '&', '|', '$', '@', '-', '--', '& ""', "''", 'Remove-Item', 'Remove-Item -Recurse', 'pwsh -c', 'iex', 'cmd /c', 'Start-Process']) {
    const v = win(cmd);
    assert.ok(['allow', 'ask', 'deny'].includes(v.decision), cmd);
  }
});
