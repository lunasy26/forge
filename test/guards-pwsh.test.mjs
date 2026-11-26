import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPowerShell } from '../lib/guards.mjs';
import { setLang } from '../lib/i18n.mjs';
import { git, gitRepo, write } from './helpers.mjs';

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

test('pwsh: Set-Location inside a block, group or iex leaves the directory unknown', () => {
  for (const cmd of [
    'if (Test-Path ..) { cd .. }; Remove-Item -Recurse -Force project',
    '& { Set-Location C:\\Users\\me }; Remove-Item -Recurse -Force Documents',
    '(Set-Location ~); Remove-Item -Recurse Documents',
    'Get-ChildItem | ForEach-Object { Push-Location .. }; Remove-Item -Recurse project',
    'if ($x) { if ($y) { sl .. } }; Remove-Item -Recurse project',
    "iex 'cd ..'; Remove-Item -Recurse project",
    'Push-Location sub; & { Pop-Location }; Pop-Location; Remove-Item -Recurse project',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('& { cd .. }; Remove-Item -Recurse project').reason, /во время выполнения/);
  for (const cmd of [
    'if (x) { Write-Host hi }; Remove-Item -Recurse .\\build',
    '& { cd .. }; Remove-Item -Recurse C:\\work\\project\\build',
    'Get-ChildItem | ForEach-Object { $_.Name }; Remove-Item -Recurse build',
    "iex 'Get-Date'; Remove-Item -Recurse build",
    'pwsh -c "cd .."; Remove-Item -Recurse build',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  // an absolute target is still judged on its own
  assert.equal(win('& { cd .. }; Remove-Item -Recurse C:\\Windows').decision, 'ask');
});

test('pwsh: sudo, env, nohup and timeout are stripped before the check', () => {
  assert.equal(win('sudo git push origin main').decision, 'deny');
  assert.equal(win('sudo Remove-Item -Recurse C:\\').decision, 'ask');
  assert.equal(win('sudo --inline git push -f').decision, 'deny');
  for (const cmd of ['sudo rm -rf /', 'env rm -rf /', 'nohup rm -rf ~', 'sudo -u root rm -rf /etc']) {
    assert.equal(nix(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ['timeout 5 git push -f', 'env FOO=1 git push --force', 'nohup git push origin main']) {
    assert.equal(nix(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['sudo npm install -g x', 'sudo Remove-Item -Recurse .\\build', 'timeout /t 5', 'env | Sort-Object']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  assert.equal(nix('sudo rm -rf build').decision, 'allow');
  assert.equal(nix('nohup npm start').decision, 'allow');
  // if/while are keywords, not wrappers: the block after them is checked, the condition is not a command
  assert.equal(win('if ($x) { git commit -m "push later" }').decision, 'allow');
});

test('pwsh: splatting and array or group arguments cannot hide flags', () => {
  for (const cmd of [
    "$p=@{Recurse=$true; Path='C:\\'}; Remove-Item @p",
    'Remove-Item @p',
    'rm -Force @args',
    'Remove-Item -Recurse:$true @p',
    'git push @p',
    'git push @args origin',
    'git @p',
    'git commit @opts -m x',
    'git reset @a',
    'git push origin (Get-Branch)',
    'git push $remote @(Get-Refs)',
    "Start-Process @p",
    'Set-Alias @p',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('Remove-Item @p').reason, /splatting/);
  assert.match(win('git push @p').reason, /git push.*@p/);
  // literal arrays and groups are read through
  for (const cmd of ["git @('push','origin','main')", "git push origin ('main')", "git push ('-f')", 'git push @("--force")', "git @('commit', '--no-verify')"]) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  for (const cmd of [
    "$p=@{Path='.\\x'}; Get-ChildItem @p",
    "git @('status')",
    "git push origin ('feature/x')",
    'git log @p',
    'git status @args',
    'git push origin $branch',
    'Remove-Item -Recurse:$false @p',
    'Remove-Item -Recurse: $false @p',
    'Copy-Item @p',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: return, throw and exit run the command after them', () => {
  for (const cmd of ['return git push origin main', 'throw git push origin main', 'exit git push -f', 'function f { return git push -f }; f', 'RETURN git push -f', '$x = return git push -f']) {
    assert.equal(both(cmd), 'deny', cmd);
  }
  assert.equal(win('return Remove-Item -Recurse C:\\').decision, 'ask');
  for (const cmd of ['return 5', 'return', 'exit 1', 'throw "push failed"', 'function f { return $x }', 'Write-Host return git push -f']) {
    assert.equal(both(cmd), 'allow', cmd);
  }
});

test('pwsh -File - reads the script from the pipeline', () => {
  for (const cmd of ["'git push -f' | pwsh -File -", 'pwsh -f -', 'powershell -NoProfile -File -', 'pwsh -File: -', 'pwsh -File:-']) {
    assert.equal(both(cmd), 'ask', cmd);
  }
  assert.match(win('pwsh -f -').reason, /конвейер/);
  for (const cmd of ['pwsh -File build.ps1', 'pwsh -File: build.ps1', 'pwsh -f build.ps1 -']) {
    assert.equal(both(cmd), 'allow', cmd);
  }
});

test('pwsh: aliases defined through the alias: drive ask like Set-Alias', () => {
  for (const cmd of [
    'New-Item alias:g -Value git; g push origin main',
    'Set-Item alias:g git; g push origin main',
    'ni alias:g -Value git',
    'si alias:\\g git',
    'New-Item -Path Alias::x -Value Remove-Item',
    'New-Item -Path alias: -Name g -Value git',
    'Set-Item -Path alias:g -Value $cmd',
    "${alias:g} = 'git'",
    '$alias:g = "git"',
    '$alias:r = "Remove-Item"',
    "'git' | New-Item alias:g",
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('Set-Item alias:g git').reason, /псевдоним для «git»/);
  for (const cmd of [
    'New-Item alias:ll -Value Get-ChildItem',
    'Set-Item alias:ll Get-ChildItem',
    "${alias:ll} = 'Get-ChildItem'",
    'New-Item -ItemType Directory build',
    'New-Item .\\git -ItemType File',
    'Set-Item env:GIT_DIR x',
    'ni git.txt -Value git',
    '$x = "git"',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: code built through the PowerShell API asks', () => {
  for (const cmd of [
    "[powershell]::Create().AddScript('git push -f').Invoke()",
    "[Management.Automation.ScriptBlock]::Create('git push -f')",
    "[System.Management.Automation.ScriptBlock]::Create('x')",
    "[Automation.ScriptBlock]::Create('x')",
    "$ps = [powershell]::Create(); $ps.AddCommand('git').AddArgument('push').Invoke()",
    "[PowerShell]::Create().AddScript( 'x' )",
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win("[powershell]::Create().AddScript('x').Invoke()").reason, /AddScript/);
  for (const cmd of ["$ExecutionContext.InvokeCommand.ExpandString('$(git push -f)')", '$ExecutionContext.InvokeCommand.ExpandString($s)', '$ExecutionContext.InvokeCommand. ExpandString ("x")']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win("$ExecutionContext.InvokeCommand.ExpandString('x')").reason, /ExpandString/);
  for (const cmd of ["$ExecutionContext.InvokeCommand.GetCommand('git', 'Application')", 'Write-Host ExpandString', "$s.ExpandStrings('x')"]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  for (const cmd of ["$list.Add('git push')", '[powershell]::Create()', "$sb.AppendLine('x')", '$x.AddRange(@(1,2))']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: -WorkingDirectory is where the nested command runs', () => {
  const branch = (cwd) => (/[\\/]other$/.test(cwd) ? 'main' : 'feature/x');
  for (const cmd of [
    "Start-Process git -ArgumentList 'push' -WorkingDirectory ..\\other",
    "Start-Process git -WorkingDirectory C:\\work\\other -ArgumentList 'push'",
    'pwsh -WorkingDirectory ..\\other -c "git push"',
    'pwsh -wd ..\\other -c "git push"',
    'pwsh -WorkingDirectory:..\\other -c "git push"',
  ]) {
    assert.equal(win(cmd, { currentBranch: branch }).decision, 'deny', cmd);
  }
  assert.equal(nix('pwsh -wd ../other -c "git push"', { currentBranch: branch }).decision, 'deny');
  // relative deletes in a run-time or relative-from-unknown directory ask
  for (const cmd of [
    "Start-Process pwsh -ArgumentList '-c','Remove-Item -Recurse project' -WorkingDirectory ..",
    'pwsh -wd .. -c "Remove-Item -Recurse project"',
    'pwsh -wd $dir -c "Remove-Item -Recurse build"',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  for (const cmd of [
    'Start-Process notepad -WorkingDirectory C:\\x',
    "Start-Process git -ArgumentList 'push' -WorkingDirectory .\\sub",
    'pwsh -wd .\\sub -c "git push"',
    'pwsh -WindowStyle Hidden -c "git status"',
  ]) {
    assert.equal(win(cmd, { currentBranch: branch }).decision, 'allow', cmd);
  }
});

test('pwsh Remove-Item: an empty value after the colon takes the next word', () => {
  for (const cmd of ['Remove-Item -Path: build -Recurse', 'Remove-Item -LiteralPath: .\\out -Recurse', 'Remove-Item -Recurse: $true build']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  for (const cmd of ['Remove-Item -Path: C:\\Windows -Recurse', 'Remove-Item -Recurse -Path: ..', 'Remove-Item -Recurse: C:\\']) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.equal(win('Remove-Item -Recurse: $false C:\\').decision, 'allow');
});

test('pwsh cmd: carets, glued switches and /r do not hide git or a recursive delete', () => {
  for (const cmd of [
    'cmd /c g^it push --force',
    'cmd /c g^it push origin main',
    'cmd /c r^d /s /q C:\\',
    'cmd /c rd/s/q C:\\Users',
    'cmd /c rd /q/s C:\\Users',
    'cmd /r git push -f',
    'cmd.exe /R "git push -f"',
    "cmd /c 'rd /S /Q x & echo done'",
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ['cmd /c dir /s', 'cmd /c echo rd', 'cmd /c type README.md', 'cmd /c rd build']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh wsl: the Linux command line is checked with the Bash rules', () => {
  for (const cmd of [
    'wsl git push --force',
    'wsl -e git push --force',
    'wsl --exec git push -f',
    'wsl -- git push origin main',
    'wsl -d Ubuntu git push -f',
    'wsl bash -c "git push -f"',
    "Start-Process wsl -ArgumentList 'git','push','-f'",
  ]) {
    assert.equal(win(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['wsl --list', 'wsl -l -v', 'wsl --shutdown', 'wsl ls', 'wsl git status']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: git push without a branch in a location known only at run time asks', () => {
  for (const cmd of [
    'Set-Location $dir; git push',
    'cd $dir; git push origin',
    'Push-Location $d; git push; Pop-Location',
    'Start-Process git -ArgumentList push -WorkingDirectory $dir',
    'pwsh -wd $dir -c "git push"',
    'git -C $repo push',
    'Set-Location $dir; git push origin HEAD',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('Set-Location $dir; git push').reason, /git push/);
  for (const cmd of ['Set-Location $dir; git push --force', 'Set-Location $dir; git push origin main']) {
    assert.equal(win(cmd).decision, 'deny', cmd);
  }
  for (const cmd of ['Set-Location $dir; git push origin feature/x', 'Set-Location $dir; git status', 'Set-Location $dir; Set-Location C:\\work\\project; git push']) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: (git branch --show-current) as the refspec is the current branch', () => {
  const main = { currentBranch: () => 'main' };
  for (const cmd of [
    'git push origin (git branch --show-current)',
    'git push origin $(git branch --show-current)',
    'git push -u origin (git rev-parse --abbrev-ref HEAD)',
    'git push origin $(git rev-parse --abbrev-ref HEAD)',
  ]) {
    assert.equal(win(cmd, main).decision, 'deny', cmd);
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  assert.equal(win('Set-Location $d; git push origin (git branch --show-current)').decision, 'ask');
  // other groups still hide the branch
  assert.equal(win('git push origin (Get-Branch)').decision, 'ask');
  assert.equal(win('git push origin $(Get-Branch)', main).decision, 'allow');
});

test('pwsh: Set-Location, Push-Location and Pop-Location behind a wrapper leave the location alone', () => {
  for (const cmd of [
    'sudo cd C:\\Users\\me\\AppData\\Local\\Temp\\x; Remove-Item -Recurse -Force ..\\project',
    'sudo Set-Location C:\\Users\\me\\AppData\\Local\\Temp\\x; Remove-Item -Recurse ..\\project',
    'env Push-Location C:\\Users\\me\\AppData\\Local\\Temp\\x; Remove-Item -Recurse ..\\project',
    'cd C:\\Users\\me\\AppData\\Local\\Temp\\x; Push-Location C:\\work\\project; sudo Pop-Location; Remove-Item -Recurse ..\\project',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ['sudo cd /tmp/x; Remove-Item -Recurse -Force ../project', 'timeout 5 Set-Location /tmp/x; Remove-Item -Recurse ../project']) {
    assert.equal(nix(cmd).decision, 'ask', cmd);
  }
  for (const cmd of [
    'sudo cd C:\\Users\\me\\AppData\\Local\\Temp\\x; Remove-Item -Recurse build',
    'cd C:\\Users\\me\\AppData\\Local\\Temp\\x; Remove-Item -Recurse ..\\y',
    'sudo Set-Location C:\\Windows; git push',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: the built-in functions cd.. and cd\\ change the location', () => {
  for (const cmd of [
    'cd..; Remove-Item -Recurse -Force project',
    'CD..; Remove-Item -Recurse project',
    'cd\; Remove-Item -Recurse Windows',
    'cd..; cd..; Remove-Item -Recurse work',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.equal(nix('cd\; Remove-Item -Recurse etc').decision, 'ask');
  for (const cmd of [
    'cd..; Remove-Item -Recurse project\\build',
    'cd\; Remove-Item -Recurse C:\\work\\project\\build',
    'cd..; cd project; Remove-Item -Recurse build',
    // not a function: an unknown command, the location stays
    'cd\\work; Remove-Item -Recurse build',
    'sudo cd..; Remove-Item -Recurse build',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: group and splat arguments of bash, cmd, wsl, pwsh and rm cannot hide -c, /c, the script or -rf', () => {
  for (const cmd of ["bash -c ('git push -f')", "bash ('-c') 'git push -f'", "wsl ('git') push -f", "sh @('-c', 'git push origin main')", "pwsh -c ('git push --force')"]) {
    assert.equal(win(cmd).decision, 'deny', cmd);
  }
  for (const cmd of [
    "$a='-c','git push -f'; bash @a",
    "cmd ('/c') 'git push -f'",
    "cmd @('/c','rd /s /q C:\\Users')",
    'cmd @args',
    'bash -c (Get-Content s.sh)',
    'wsl @a',
    'pwsh @p',
    'bash script.sh (Get-Date)',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
  assert.match(win('bash @a').reason, /bash.*@a/);
  assert.equal(nix("rm ('-rf') ~").decision, 'ask');
  assert.equal(nix('rm @a').decision, 'ask');
  for (const cmd of ["bash -c ('echo hi')", "bash ('script.sh')", "cmd ('/c') 'dir'", "wsl ('ls') -la", 'bash script.sh $x', 'npm run (Get-Task)', 'node @args', "python ('x.py')"]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  assert.equal(nix("rm ('-f') x.tmp").decision, 'allow');
});

test('pwsh: a block that pushes and pops the location keeps the caller\'s', () => {
  for (const cmd of [
    "foreach ($d in 'a','b') { Push-Location $d; npm test; Pop-Location }; git push",
    "foreach ($d in 'a','b') { pushd $d; npm test; popd }; Remove-Item -Recurse build",
    '& { cd sub; cd .. }; Remove-Item -Recurse build',
    'if ($x) { Push-Location C:\\Windows; Push-Location ..; Pop-Location; Pop-Location }; Remove-Item -Recurse build',
  ]) {
    assert.equal(win(cmd).decision, 'allow', cmd);
  }
  for (const cmd of [
    "foreach ($d in 'a','b') { Push-Location $d; npm test }; git push",
    "foreach ($d in 'a','b') { Push-Location $d; Pop-Location; Pop-Location }; Remove-Item -Recurse project",
    '& { Push-Location C:\\Windows; Set-Location $x; Pop-Location; cd $y }; git push',
    '& { Pop-Location; Push-Location .. }; Remove-Item -Recurse project',
  ]) {
    assert.equal(win(cmd).decision, 'ask', cmd);
  }
});

test('pwsh: xargs into a shell or a bare wsl asks', () => {
  for (const cmd of ["'git push -f' | xargs wsl", "xargs -I{} sh -c 'git push origin {}'", 'xargs sh']) {
    assert.equal(nix(cmd).decision, 'ask', cmd);
  }
  for (const cmd of ["xargs -I{} sh -c 'echo {}'", 'xargs wsl --list', 'git diff --name-only | xargs git reset --']) {
    assert.equal(nix(cmd).decision, 'allow', cmd);
  }
});

test('pwsh: long chains of Set-Location, Push-Location, -WorkingDirectory and git -C stay linear', () => {
  const rep = (s, n) => s.repeat(n);
  for (const [cmd, want] of [
    [rep('cd a; ', 40000) + 'git push --force', 'deny'],
    [rep('Push-Location a; ', 15000) + 'git status', 'allow'],
    ['pwsh ' + rep('-wd a ', 40000) + '-c "git push -f"', 'deny'],
    ['git ' + rep('-C a ', 40000) + 'push --force', 'deny'],
  ]) {
    const started = performance.now();
    const { decision } = win(cmd);
    const ms = performance.now() - started;
    assert.equal(decision, want, cmd.slice(0, 40));
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms for ${cmd.slice(0, 40)}`);
  }
});

test('secrets: git commit and git add .env from PowerShell are checked like from Bash', () => {
  const token = 'gh' + 'p_' + 'A1b2'.repeat(9); // built at run time: no token literal in a source file
  const repo = gitRepo('feature/x');
  const sctx = { cwd: repo, root: repo, protectedBranches: [], secrets: { check: true, ignore: [] } };
  write(repo, '.env', 'X=1\n');
  const add = checkPowerShell('git add .env; git commit -m x', sctx);
  assert.equal(add.decision, 'ask');
  assert.match(add.reason, /«\.env»/);
  assert.match(add.reason, /\.env — файл \.env/, 'the commit after the add sees the untracked .env');
  assert.equal(checkPowerShell('git add -A; git commit -m x', sctx).decision, 'ask');
  assert.equal(checkPowerShell('git commit -m x', sctx).decision, 'allow', 'untracked .env stays out without an add');

  write(repo, 'a.txt', `k=${token}\n`);
  git(repo, 'add', 'a.txt');
  const staged = checkPowerShell('git commit -m x', sctx);
  assert.equal(staged.decision, 'ask');
  assert.match(staged.reason, /a\.txt:1 — токен GitHub/);
  assert.ok(!staged.reason.includes(token));
  assert.equal(checkPowerShell("git @('commit', '-m', 'x')", sctx).decision, 'ask');
  assert.match(checkPowerShell('Set-Location $dir; git commit -m x', sctx).reason, /известном только во время выполнения/);
  assert.equal(checkPowerShell('git commit -m x', { ...sctx, secrets: { check: false, ignore: [] } }).decision, 'allow');
  assert.equal(nix('git add .env').decision, 'ask', 'no git call needed');
  assert.equal(nix('git add .env.example').decision, 'allow');
});
