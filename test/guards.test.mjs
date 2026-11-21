import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBash, checkFile, branchMatches } from '../lib/guards.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';
import { setLang } from '../lib/i18n.mjs';

setLang('ru'); // the Russian texts are asserted below; English ones live in guards-en.test.mjs

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

test('git by path, with .exe or in capitals is still git', () => {
  for (const cmd of [
    '/usr/bin/git push origin main',
    '/usr/local/bin/git push --force origin feature/x',
    'git.exe push --force origin feature/x',
    'GIT push origin main',
    './bin/git.EXE commit --no-verify -m x',
    'command /usr/bin/git push origin main',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of ['/usr/bin/git push origin feature/x', 'git.exe status', 'gitk --all', 'git-lfs push origin main', 'legit push origin main']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('rm and shells by path or with .exe are still recognised', () => {
  assert.equal(decide('/bin/rm -rf /etc'), 'ask');
  assert.equal(decide('rm.exe -rf /etc'), 'ask');
  assert.equal(decide('/bin/bash -c "git push origin main"'), 'deny');
  assert.equal(decide('BASH -c "git push origin main"'), 'deny');
  assert.equal(decide('EVAL git push origin main'), 'deny');
  assert.equal(decide('/bin/rm -rf build'), 'allow');
  assert.equal(decide('rmdir /etc/x'), 'allow');
  assert.equal(decide('/bin/bash -c "git status"'), 'allow');
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
  assert.equal(decide('git push --force-if-includes --force-with-lease origin feature'), 'allow');
});

test('force push: --force or +refspec overrides the lease, so it is denied even with one', () => {
  assert.equal(decide('git push --force --force-with-lease origin feature'), 'deny');
  assert.equal(decide('git push --force-with-lease --force origin feature'), 'deny');
  assert.equal(decide('git push -f --force-with-lease origin feature'), 'deny');
  assert.equal(decide('git push -fu --force-with-lease origin feature'), 'deny');
  assert.equal(decide('git push --force-with-lease origin +feature'), 'deny');
  assert.equal(decide('git push --force-with-lease origin feature'), 'allow');
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
  assert.equal(decide(`rm -rf '${join(tmpdir(), 'forge-scratch')}'`), 'allow');
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

test('protected files match regardless of case, on every OS', () => {
  const opts = { root, protectedFiles: DEFAULT_PROTECTED_FILES };
  for (const f of ['.ENV', '.Env.local', 'sub/KEY.PEM', 'ID_RSA', '.EnvRc', 'apps/Id_Ed25519']) {
    assert.equal(checkFile(join(root, f), opts).decision, 'deny', f);
  }
  for (const f of ['.env.example', '.ENV.EXAMPLE', 'environment.ts', 'docs/env.md', 'src/Index.TS']) {
    assert.equal(checkFile(join(root, f), opts).decision, 'allow', f);
  }
  const custom = { root, protectedFiles: [...DEFAULT_PROTECTED_FILES, 'secrets/**'] };
  assert.equal(checkFile(join(root, 'Secrets/x'), custom).decision, 'deny');
  assert.equal(checkFile(join(root, 'secrets/x'), custom).decision, 'deny');
  assert.equal(checkFile(join(root, 'secret/x'), custom).decision, 'allow');
});

test('wrapper commands are seen through by path, case and .exe', () => {
  for (const cmd of [
    '/usr/bin/env git push origin main',
    'env.exe git push origin main',
    'SUDO git push origin main',
    '/usr/bin/sudo git push -f origin feature/x',
    '/usr/bin/env -i FOO=1 git push origin main',
    'sudo /usr/bin/env git push origin main',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of [
    '/usr/bin/env node script.js',
    'envsubst < a > b',
    'sudoku',
    'env git status',
    '/usr/bin/env git push origin feature/x',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('wrapper options and arguments are skipped, more wrappers are seen through', () => {
  for (const cmd of [
    'nice -n 5 git push origin main',
    'nice -n5 git push origin main',
    'nice --adjustment 5 git push origin main',
    'nice --adjustment=5 git push origin main',
    'sudo -u root git push -f',
    'sudo --user=root git push -f',
    'sudo --user root git push -f',
    'sudo -E -u root -g wheel git push origin main',
    'doas -u root git push origin main',
    'timeout 10 git push origin main',
    'timeout -s KILL 10 git push origin main',
    'timeout --signal=KILL --kill-after=5 10 git push origin main',
    'xargs git push origin main',
    'xargs -n 1 git push origin main',
    'xargs -I{} git push {} main',
    'stdbuf -o0 git push --force',
    'stdbuf -i0 -oL -eL git push origin main',
    'env -C /tmp git push origin main',
    'env -u HOME FOO=1 git push origin main',
    'env -S "git push origin main"',
    'ionice -c 3 git push origin main',
    'chrt 10 git push origin main',
    'chrt -f 10 git push origin main',
    'taskset 0x1 git push origin main',
    'taskset -c 0,1 git push origin main',
    'time -f %e git push origin main',
    'watch -n 5 git push origin main',
    "watch 'git push origin main'",
    'nohup timeout 10 nice -n 5 sudo -u root git push origin main',
    'timeout 10 rm -rf /etc/x',
    'nice -n 5 bash -c "git push origin main"',
    // safety net: an option the table does not know may take an argument
    'sudo --made-up value git push origin main',
    'nice --made-up 5 git push origin main',
  ]) {
    assert.notEqual(decide(cmd), 'allow', cmd);
  }
  for (const cmd of [
    'timeout 10 git push origin feature/x',
    'timeout 10 npm test',
    'nice -n 5 make',
    'sudo -u root ls',
    'sudo -u git ls',
    'sudo --user=git ls',
    'doas -u git ls',
    'xargs grep foo',
    'xargs -n 1 echo git push origin main',
    'sudo echo git push origin main',
    'env -u git ls',
    'timeout 10 echo git push origin main',
    'stdbuf -o0 cat git',
    'ionice -c 3 ls',
    'watch -n 5 ls',
    'watch git status',
    'nice -n 5 echo rm -rf /etc/x',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  assert.equal(decide('sudo -u root git push -f'), 'deny');
  assert.equal(decide('timeout 10 git push origin main'), 'deny');
  assert.equal(decide('xargs git push origin main'), 'deny');
});

test('commands inside substitutions are checked like top-level commands', () => {
  for (const [cmd, want] of [
    ['echo $(git push --force origin main)', 'deny'],
    ['echo `git push --force origin main`', 'deny'],
    ['x=$(git push origin main)', 'deny'],
    ['echo "$(git push --force origin main)"', 'deny'],
    ['echo "$(rm -rf /etc/x)"', 'ask'],
    ['echo $(echo $(git push --force origin main))', 'deny'],
    ['cat <(git push --force origin main)', 'deny'],
    ['diff <(git show HEAD) >(git push origin main)', 'deny'],
    ['echo "${x:-$(git push origin main)}"', 'deny'],
    ['ls > "$(git commit --no-verify -m x)"', 'deny'],
    ['cat <<EOF\n$(git push --force origin main)\nEOF', 'deny'],
    ['bash -c \'echo $(git push origin main)\'', 'deny'],
    ['echo $(rm -rf /etc/x) && git push origin main', 'deny'],
    ['echo "$(case $x in a) git push origin main;; esac)"', 'deny'],
    ['echo "$(true # )\ngit push origin main\n)"', 'deny'],
  ]) {
    assert.equal(decide(cmd), want, cmd);
  }
  assert.match(checkBash('echo $(git push origin main)', ctx()).reason, /main/);
  // same verdict as the bare command, whatever it is (/tmp counts as a scratch area)
  for (const inner of ['rm -rf /tmp/x', 'rm -rf ~', 'git push origin main', 'git status']) {
    assert.equal(decide(`echo "$(${inner})"`), decide(inner), inner);
  }
});

test('substitutions that are literal, harmless or not commands stay allowed', () => {
  for (const cmd of [
    "echo '$(git push --force origin main)'",
    'echo "\\$(git push --force origin main)"',
    'echo $((1 + 2))',
    'echo ${HOME}',
    'echo ${x:-$y}',
    'echo $(date)',
    'echo "today: $(date +%F)"',
    "cat <<'EOF'\n$(git push --force origin main)\nEOF",
    'cat <<"EOF"\n`git push --force origin main`\nEOF',
    'cat <<EOF\ngit push --force origin main\nEOF',
    "git commit -m \"$(cat <<'EOF'\nfix: don't push to main (yet)\nEOF\n)\"",
    'for f in $(git ls-files); do echo "$f"; done',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  assert.equal(decide('rm -rf $(pwd)/build'), 'ask', 'the outer word stays dynamic');
});

test('substitutions that cannot be inspected ask instead of allowing', () => {
  const unterminated = checkBash('echo $(git status', ctx());
  assert.equal(unterminated.decision, 'ask');
  assert.match(unterminated.reason, /подстановк/);
  const deep = checkBash('echo $(echo $(echo $(echo $(git status))))', ctx());
  assert.equal(deep.decision, 'ask');
  assert.match(deep.reason, /вложенност/);
  assert.equal(decide('echo $(echo $(echo $(git status)))'), 'allow', 'three levels are inspected');
  assert.equal(decide('bash -c "bash -c \\"bash -c \\\\\\"bash -c ls\\\\\\"\\""'), 'ask', 'bash -c past the limit asks too');
});

const P = 'git push --force origin main';
/** checkBash with a wall-clock measurement: pathological input must stay well under the 10 s hook timeout. */
const timed = (cmd) => {
  const started = performance.now();
  const { decision } = checkBash(cmd, ctx());
  return { decision, ms: performance.now() - started };
};

test('ANSI-C quotes $\'…\' escape their own quote and are decoded', () => {
  for (const [cmd, want] of [
    [`echo $'it\\'s' && ${P}`, 'deny'],
    [`echo $'\\'' "$(${P})"`, 'deny'],
    [`$'git' push --force origin main`, 'deny'],
    [`$'git' $'push' $'--force' origin feature/x`, 'deny'],
    [`echo "\${x:-$'}'}" $(${P})`, 'deny'],
    [`echo $(echo $'a\\'b')`, 'allow'],
    [`echo $'a\\tb\\n' "$'x'"`, 'allow'],
    [`echo "\${x:-$'}'}"`, 'allow'],
  ]) {
    assert.equal(decide(cmd), want, cmd);
  }
});

test('backslash-newline is removed before substitutions and heredoc delimiters are read', () => {
  for (const [cmd, want] of [
    [`echo "$\\\n(${P})"`, 'deny'],
    [`echo $\\\n(${P})`, 'deny'],
    [`cat <<EOF\n$\\\n(${P})\nEOF`, 'deny'],
    [`cat <<\\\nEOF\n$(${P})\nEOF`, 'deny'],
    [`cat <<E\\\nOF\n$(${P})\nEOF`, 'deny'],
    [`x="$\\\n(rm -rf ~)"`, 'ask'],
    [`echo "$(c\\\nase x in a) ${P};; esac)"`, 'deny'],
    // where bash does not join lines, neither may the guard
    [`echo a # note \\\n${P}`, 'deny'],
    [`echo a\\\\\n${P}`, 'deny'],
    [`cat <<'EOF'\nfoo\\\nEOF\n${P}\nEOF`, 'deny'],
    [`cat <<EOF\nfoo\\\nEOF\nit's\nEOF\n${P}\n'`, 'deny'],
    [`git push \\\n--force origin feature/x`, 'deny'],
    [`echo 'a\\\nb' && echo ok`, 'allow'],
  ]) {
    assert.equal(decide(cmd), want, JSON.stringify(cmd));
  }
});

test('heredocs: tab-indented terminator only for <<-, several heredocs on one line', () => {
  for (const [cmd, want] of [
    [`cat <<EOF\n\tEOF\nit's\nEOF\n${P}`, 'deny'],
    [`cat <<EOF\n\tEOF\nit's\nEOF\necho $(${P})`, 'deny'],
    [`cat <<-EOF\n\t${P}\n\tEOF\necho ok`, 'allow'],
    [`cat <<-EOF\n\t$(${P})\n\tEOF`, 'deny'],
    [`cat <<A <<'B'\n$(${P})\nA\nx\nB`, 'deny'],
    [`cat <<'A' <<B\nx\nA\n$(${P})\nB`, 'deny'],
    [`cat <<'A' <<'B'\n$(${P})\nA\n$(${P})\nB\necho ok`, 'allow'],
    [`cat <<A <<B\nit's\nA\nB\n${P}`, 'deny'],
  ]) {
    assert.equal(decide(cmd), want, JSON.stringify(cmd));
  }
});

test('arithmetic: no heredocs inside ((…)), single quotes do not protect, $((…)) stays allowed', () => {
  for (const [cmd, want] of [
    [`((x = 1 << 2))\n${P}\n`, 'deny'],
    [`for ((i=0; i<1<<2; i++)); do :; done\n${P}`, 'deny'],
    [`echo $(( '$(${P})' ))`, 'deny'],
    [`echo $((x<<2))\n${P}`, 'deny'],
    [`((x = $(${P})))`, 'deny'],
    ['echo $((1+2))', 'allow'],
    ['echo $((x<<2))', 'allow'],
    ['((x = 1 << 2)) && echo ok', 'allow'],
    ['for ((i=0; i<1<<2; i++)); do echo $i; done', 'allow'],
    [`((cd /; ${P}) )`, 'deny'],
  ]) {
    assert.equal(decide(cmd), want, JSON.stringify(cmd));
  }
});

test('case/esac count only at command position', () => {
  for (const cmd of [
    'x=$(grep -c case README.md)',
    'echo $(git log --grep case -1)',
    'echo "$(echo case x)" && echo ok',
    'echo $(for w in case esac; do echo $w; done)',
    'echo $(echo a; case x in x) echo b;; esac)',
    'echo $(if true; then case x in x) echo c;; esac; fi)',
    'echo "$(case $x in a) echo a;; (b) echo b;; esac)"',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  assert.equal(decide(`echo "$(echo a; case x in a) ${P};; esac)"`), 'deny');
  assert.equal(decide(`echo "$({ case x in a) ${P};; esac; })"`), 'deny');
  assert.equal(decide(`echo "$(case x in a|esac) ${P};; esac)"`), 'deny', 'esac after | is a pattern');
});

test('eval and shell -c option clusters are inspected like bash -c', () => {
  for (const cmd of [
    `eval "${P}"`,
    `eval ${P}`,
    `eval 'echo "$(${P})"'`,
    `bash -c -- '${P}'`,
    `bash -cx '${P}'`,
    `bash -xc '${P}'`,
    `sh -ec '${P}'`,
    `bash -lc '${P}'`,
    `bash -o pipefail -c '${P}'`,
    `bash -c -x '${P}'`,
    `/bin/zsh -c '${P}'`,
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  assert.equal(decide('eval "echo ok"'), 'allow');
  assert.equal(decide("bash -xc 'npm test'"), 'allow');
});

test('git long options are matched by unambiguous prefix, like git does', () => {
  for (const cmd of [
    'git push --forc origin feature/x',
    'git push --for origin feature/x',
    'git push --no-verif origin feature/x',
    'git push --mirro origin',
    'git push --dele origin main',
    'git push --force-with --forc origin feature/x',
    'git commit --no-verif -m x',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  assert.equal(decide('git push --al'), 'ask', 'any prefix counts, git rejects ambiguous ones itself');
  assert.equal(decide('git push --bra'), 'ask');
  assert.equal(decide('git reset --har HEAD~1'), 'ask');
  assert.equal(decide('git push --force-with origin feature/x'), 'allow', 'prefix of --force-with-lease');
  assert.equal(decide('git push --force-if-incl --force-with-lease origin feature/x'), 'allow');
  assert.equal(decide('git push --follow-tags origin feature/x'), 'allow');
  assert.equal(decide('git commit --no-edit --amend'), 'allow');
});

test('pathological nesting asks quickly instead of overflowing the stack or timing out', () => {
  for (const cmd of [
    'echo ' + '$('.repeat(3000) + 'x' + ')'.repeat(3000) + '; ' + P,
    'echo ' + '"$('.repeat(3000) + ')"'.repeat(3000) + '; ' + P,
    'echo ' + '${x:-'.repeat(10000) + '}'.repeat(10000) + '; ' + P,
    'echo ' + '$(( '.repeat(26) + 'x' + ' ) )'.repeat(26) + '; ' + P,
    'echo ' + '$((a) '.repeat(24) + ')'.repeat(24) + '; ' + P,
    '(('.repeat(5000) + 'x' + '))'.repeat(5000) + '\n' + P,
    'echo ' + '`'.repeat(9) + P,
  ]) {
    const { decision, ms } = timed(cmd);
    assert.ok(decision === 'ask' || decision === 'deny', `${decision} for ${cmd.slice(0, 40)}`);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${cmd.slice(0, 40)}`);
  }
  const { decision, ms } = timed('echo ' + '$('.repeat(60) + 'git status' + ')'.repeat(60));
  assert.equal(decision, 'ask', 'deep but finite nesting still asks (depth limit)');
  assert.ok(ms < 1000);
});

test('case: patterns, function bodies, time -p and coproc keep the case tracking right', () => {
  for (const cmd of [
    `echo "$(f() { case x in x) ${P};; esac; }; f)"`,
    `echo "$(function f { case x in x) ${P};; esac; }; f)"`,
    `echo "$(function f() { case x in x) ${P};; esac; }; f)"`,
    `echo "$(time -p case x in x) ${P};; esac)"`,
    `echo "$(coproc case x in x) ${P};; esac)"`,
    `echo "$(coproc w { case x in x) ${P};; esac; })"`,
    `echo "$(case x in (esac) ;; x) ${P};; esac)"`,
    `echo "$(case x in a) ;; case) ;; esac)" ; ${P} ; echo "; esac)"`,
    `echo "$(case x in a) ;;\ncase) ;; esac)" ; ${P} ; echo "; esac)"`,
    `echo "$(case x in (case) ;; esac)" ; ${P} ; echo "; esac)"`,
    `echo "$(case x in a) ;; in) ;; x) ${P};; esac)"`,
    `echo "$(case x in x) ${P} ;& esac)"`,
    `echo "$(case x in a) echo ;;& x) ${P};; esac)"`,
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of [
    'x=$(case $1 in -h|--help) echo help;; esac)',
    'x=$(f() { echo hi; }; f)',
    'x=$(time -p ls)',
    'echo "$(case $x in (a|b) echo ab;; (*) echo other;; esac)"',
    'echo "$(case $x in\n  a) echo a ;;\n  b|c) echo bc ;;\n  *) echo d ;;\nesac)"',
    'x=$(echo | case "$y" in a) echo 1;; esac)',
    'x=$(git log --format=%s | while read l; do case $l in feat*) echo $l;; esac; done)',
    'x=$(case $y in +(a|b)) echo ext;; esac)',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('heredoc terminator followed by ")" ends the body inside $(…)', () => {
  for (const cmd of [
    `echo "$(cat <<EOF\nEOF)" ; ${P} ; echo "\nEOF\n)"`,
    `echo "$(cat <<'EOF'\nEOF)" ; ${P} ; echo "\nEOF\n)"`,
    `x=$(cat <<EOF\nEOF)\n${P}\nEOF\n)`,
  ]) {
    assert.equal(decide(cmd), 'deny', JSON.stringify(cmd));
  }
  // bash versions disagree on these terminators: never allow
  for (const cmd of [
    `x=$(cat <<EOF\nfoo\\\nEOF\n)\n${P}\nEOF\n)`,
    `echo "$(cat <<EOF\nEOFx)" ; ${P} ; echo "\nEOF\n)"`,
  ]) {
    assert.notEqual(decide(cmd), 'allow', JSON.stringify(cmd));
  }
  for (const cmd of [
    `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`,
    `echo "[$(cat <<EOF\nab\nEOF)]"`,
    `x=$(cat <<EOF\ncmd \\\n  --flag\nEOF\n)`,
    `x=$(cat <<-EOF\n\tindented\n\tEOF\n)`,
  ]) {
    assert.equal(decide(cmd), 'allow', JSON.stringify(cmd));
  }
});

test('eval -- and short git option prefixes', () => {
  for (const cmd of [`eval -- '${P}'`, `builtin eval -- '${P}'`, 'git push --mi origin', 'git push --m origin', 'git push --forc origin feature/x', 'git push --dry origin main']) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  assert.equal(decide('git reset --ha HEAD~1'), 'ask');
  assert.equal(decide('git push --force-w origin feature/x'), 'allow');
  assert.equal(decide('git push --force-if --force-with-lease origin feature/x'), 'allow');
  assert.equal(decide('git push --dry-run origin main'), 'allow');
});

test('PowerShell and cmd started from Bash are checked with the PowerShell rules', () => {
  for (const cmd of [
    'pwsh -c "git push --force"',
    'pwsh -NoProfile -Command "git push origin main"',
    "powershell.exe -Command 'git commit --no-verify -m x'",
    'pwsh -c "iex \'git push -f\'"',
    'sudo pwsh -c "git push --force"',
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of [
    'pwsh -EncodedCommand ZQBjAGgAbwA=',
    'powershell -enc ZQBjAGgAbwA=',
    'pwsh -c "Remove-Item -Recurse /etc"',
    'pwsh -c "Get-ChildItem | Remove-Item -Recurse"',
    'cmd /c "git push -f"',
    'cmd //c "git push -f"',
    'cmd.exe /C "rd /s /q build"',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of ['pwsh -File build.ps1', 'pwsh -c "Get-Date"', "powershell -Command 'git status'", 'pwsh -NoLogo', 'cmd /c dir', 'cmd //c "echo hi"']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  assert.match(checkBash('pwsh -EncodedCommand ZQBjAGgAbwA=', ctx()).reason, /EncodedCommand/);
});

test('env -S is split with env rules, watch options and nested wrappers do not hide a command', () => {
  for (const cmd of [
    // env -S: \_ separates words, ; is an ordinary character, leading words are env options again
    "env -S 'git\\_push\\_--force'",
    "env -S 'git push -o ; --force'",
    "env -S 'git push -o' ';' --force",
    "env -S '-i git push --force'",
    "env -S '-- git push --force'",
    "env -S'-v' git push --force",
    "env -S 'git push --force'",
    // watch: -w takes no value, -q/--equexit takes one; an unknown option does not hide the command
    'watch -w git push --force origin main',
    'watch -q 5 git push --force',
    'watch --equexit 5 git push --force',
    'watch --made-up 5 git push --force',
    // nested wrappers after a known or an unknown option
    "env -P /usr/bin env -S 'git push --force'",
    "env -P /usr/bin watch 'git push --force'",
    "env --default-signal env -u git bash -c 'git push --force'",
    "env --made-up env -u git bash -c 'git push --force'",
    "sudo --made-up value env -u git bash -c 'git push --force'",
    "sudo --made-up value watch 'git push --force'",
  ]) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  // an -S string env cannot split asks instead of passing
  for (const cmd of ["env -S \"'git push --force\"", "env -S 'git push \"--force'", "env -S 'git push ${F'"]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of [
    "env -S 'node --inspect app.js'",
    "env -S 'FOO=1 npm test'",
    "env -S 'echo git push --force'",
    'watch -n 5 git status',
    'watch -w ls',
    'watch -q 3 make',
    'env -P /usr/bin ls',
    'env -u FOO npm test',
    'env --default-signal npm test',
    'env -u git ls',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('the wrapper safety net stays linear on long wrapper chains', () => {
  const n = Math.ceil(200_000 / 11);
  for (const cmd of [
    'env --x '.repeat(n) + 'ls '.repeat(n) + '; ' + P,
    'env ' + '-S -i '.repeat(n) + '; ' + P,
    'sudo --x v '.repeat(n) + P,
  ]) {
    const { decision, ms } = timed(cmd);
    assert.equal(decision, 'deny', cmd.slice(0, 40));
    assert.ok(ms < 500, `${ms.toFixed(0)} ms for ${cmd.slice(0, 40)}`);
  }
});

test('cmd /c lines are checked in linear time', () => {
  for (const [cmd, want] of [
    ['cmd /c ' + 'del '.repeat(100000) + '; git push --force', 'deny'],
    ['cmd /c ' + 'rd '.repeat(100000) + 'x', 'allow'],
    ['cmd /c ' + 'rd /q'.repeat(80000) + ' /s', 'ask'],
    ['cmd /c ' + 'del/q'.repeat(80000), 'allow'],
  ]) {
    const { decision, ms } = timed(cmd);
    assert.equal(decision, want, cmd.slice(0, 40));
    assert.ok(ms < 500, `${ms.toFixed(0)} ms for ${cmd.slice(0, 40)}`);
  }
});

test('xargs: arguments from the input may complete git push, commit, reset, a recursive rm or a shell script', () => {
  for (const cmd of [
    'echo --force | xargs git push',
    'xargs git push',
    'xargs -0 git push origin',
    'xargs -a list.txt git push',
    'xargs -I{} git push origin {}',
    'xargs git commit -m x',
    'xargs git reset --hard',
    'xargs git reset --keep',
    'xargs git reset --merge HEAD~1',
    'xargs git reset --kee',
    'echo --hard | xargs git reset',
    'git diff --name-only | xargs git reset',
    'xargs -I{} git reset {} -- x',
    'xargs git',
    'xargs git -C sub push',
    'sudo xargs git push',
    'xargs sudo git push',
    'xargs -n1 env git push',
    'find build -type d | xargs rm -rf',
    'xargs rm -r',
    'xargs -0 rm -R --',
    "echo 'git push -f' | xargs sh -c",
    'xargs bash -lc',
    'xargs pwsh -c',
    'xargs pwsh -Command Get-Date',
    'xargs cmd /c dir',
    'xargs wsl git status',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  assert.match(checkBash('echo --force | xargs git push', ctx()).reason, /xargs/);
  // a deny that is visible already wins
  for (const cmd of ['xargs git push --force', 'xargs git push origin main', 'xargs git commit --no-verify', 'xargs -n 1 git push -f origin x']) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of [
    'ls | xargs grep foo',
    'xargs -n1 echo',
    "find . -name '*.tmp' | xargs rm",
    'xargs rm -f',
    'git ls-files | xargs git add',
    'xargs git status',
    'xargs git log --oneline',
    'git diff --name-only | xargs git reset --',
    'xargs git reset HEAD --',
    'xargs -n 1 echo git push origin main',
    "xargs -I{} sh -c 'echo {}'",
    'xargs bash script.sh',
    'xargs pwsh -File build.ps1',
    'xargs wsl --list',
    'git push',
    'rm -rf build',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('an env -S string env cannot split gets its own reason', () => {
  for (const cmd of ["env -S \"'git push --force\"", "env -S 'git push \"--force'", "env -S 'git push ${F'", "env -S 'ls \\"]) {
    const v = checkBash(cmd, ctx());
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /env -S/, cmd);
    assert.doesNotMatch(v.reason, /подстановк/, cmd);
  }
});

test('git push without a branch in a directory known only at run time asks', () => {
  for (const cmd of [
    'cd $x; git push',
    'cd "$DIR" && git push origin',
    'cd - && git push',
    'cd $x && cd sub && git push',
    'cd $x; git push origin HEAD',
    'cd $x; git push -u origin @',
    'pushd $x; git push',
    'pushd /tmp && popd && popd; git push',
    'git -C "$repo" push',
    'cd $x && git -C sub push',
    'cd $x && rm -rf build',
    'cd $x; bash -c "git push"',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  assert.match(checkBash('cd $x; git push', ctx()).reason, /git push/);
  for (const cmd of ['cd $x; git push --force', 'cd $x; git push origin main', 'cd $x && git commit -n -m x']) {
    assert.equal(decide(cmd), 'deny', cmd);
  }
  for (const cmd of [
    'cd $x; git push origin feature/x',
    'cd $x; git status',
    // in Git Bash /work/project is under the Git install, not a known place: POSIX only
    ...(process.platform === 'win32' ? [] : ['cd $x; cd /work/project; git push']),
    'cd -P /work/project && git push',
    'cd -- sub && git push',
    'pushd sub && git push && popd',
    'git -C "$repo" push origin feature/x',
    'cd $x && rm -rf /tmp/build',
    'cd && git push',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  // a known directory is still where the branch is read
  const branchOf = (cwd) => (/[\\/]work[\\/]main-repo$/.test(cwd ?? '') ? 'main' : 'feature/x'); // D:\work\main-repo on Windows
  const at = (cmd) => checkBash(cmd, { ...ctx(), currentBranch: branchOf }).decision;
  assert.equal(at('cd /work/main-repo && git push'), 'deny');
  assert.equal(at('pushd /work/main-repo && popd && git push'), 'allow');
  assert.equal(at('cd -P /work/main-repo && git push'), 'deny');
});

test('git push origin $(git branch --show-current) pushes the current branch', () => {
  for (const cmd of [
    'git push origin $(git branch --show-current)',
    'git push -u origin "$(git branch --show-current)"',
    'git push origin `git branch --show-current`',
    'git push origin $(git rev-parse --abbrev-ref HEAD)',
    'git push origin HEAD:$(git branch --show-current)',
    'git push origin $( git  branch --show-current )',
  ]) {
    assert.equal(decide(cmd, 'main'), 'deny', cmd);
    assert.equal(decide(cmd, 'feature/x'), 'allow', cmd);
  }
  assert.match(checkBash('git push origin $(git branch --show-current)', ctx('main')).reason, /«main»/);
  // the substitution runs in the shell's directory, not in git -C's
  const branchOf = (cwd) => (cwd === root ? 'main' : 'feature/x');
  assert.equal(checkBash('git -C /work/other push origin $(git branch --show-current)', { ...ctx(), currentBranch: branchOf }).decision, 'deny');
  // unknown directory: the current branch is unknown too
  assert.equal(decide('cd $x; git push origin $(git branch --show-current)'), 'ask');
  // other run-time refspecs are left as they were
  for (const cmd of ['git push origin $BRANCH', 'git push origin $(cat branch.txt)', 'git push origin "$(git branch --show-current)-wip"']) {
    assert.equal(decide(cmd, 'main'), 'allow', cmd);
  }
});

test('cd "$(git rev-parse --show-toplevel)" stays in the same repository', () => {
  const top = 'cd "$(git rev-parse --show-toplevel)"';
  // the fake root is the top of its repository
  const atTop = (cmd, branch) => checkBash(cmd, { ...ctx(branch), isToplevel: () => true }).decision;
  assert.equal(atTop(`${top} && git push`, 'feature/x'), 'allow');
  assert.equal(atTop(`${top} && git push`, 'main'), 'deny');
  assert.equal(atTop(`${top} && git push origin main`), 'deny');
  assert.equal(atTop('cd `git rev-parse --show-toplevel` && rm -rf build'), 'allow');
  assert.equal(atTop(`${top} && rm -rf ../other`), 'ask');
  // any other run-time directory stays unknown
  assert.equal(atTop('cd "$(git rev-parse --git-dir)" && git push'), 'ask');
  assert.equal(atTop('cd "$(git rev-parse --show-toplevel)/sub" && git push'), 'ask');
  // from outside the project the top of "the current repository" is unknown
  assert.equal(atTop(`cd /elsewhere && ${top} && git push`, 'feature/x'), 'ask');
});

test('cd "$(git rev-parse --show-toplevel)" is the root only when the root is the top of its repository', () => {
  const top = 'cd "$(git rev-parse --show-toplevel)"';
  // a package in a monorepo: the toplevel is an ancestor of the root
  const inPackage = (cmd) => checkBash(cmd, { ...ctx(), isToplevel: () => false }).decision;
  assert.equal(inPackage(`${top} && rm -rf app`), 'ask');
  assert.equal(inPackage(`${top} && git push`), 'ask');
  assert.equal(inPackage(`${top} && rm -rf /tmp/x`), 'allow', 'an absolute target is judged on its own');
  // without the override: <root>/.git on disk
  const repo = mkdtempSync(join(tmpdir(), 'forge-top-'));
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'pkg'));
  const real = (cmd, at) => checkBash(cmd, { cwd: at, root: at, protectedBranches: ['main'], currentBranch: () => 'feature/x' }).decision;
  assert.equal(real(`${top} && rm -rf build`, repo), 'allow');
  assert.equal(real(`${top} && rm -rf build`, join(repo, 'pkg')), 'ask');
  rmSync(repo, { recursive: true, force: true });
});

test('cd, pushd and popd behind a wrapper run in a child process and leave the directory alone', () => {
  for (const cmd of [
    'sudo cd /tmp/x; rm -rf ../project',
    'env cd /tmp/x; rm -rf ../project',
    'env pushd /tmp/x; rm -rf ../project',
    'timeout 5 cd /tmp/x; rm -rf ../project',
    'nohup cd /tmp/x && rm -rf ../project',
    'cd /tmp/x; pushd /work/project; sudo popd; rm -rf ../project',
    'command -v cd /tmp/x; rm -rf ../project',
    // time may be the shell keyword (the cd happens) or /usr/bin/time (it does not): unknown
    'time cd /tmp/x; rm -rf build',
    'time cd /work/project; git push',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of [
    'sudo cd /tmp/x; rm -rf build',
    'env pushd /tmp/x; git push',
    'timeout 5 cd /tmp/x; rm -rf ./dist',
    // command and builtin still run the shell's own cd
    'command cd /tmp/x; rm -rf ../y',
    'builtin cd /tmp/x && rm -rf ../y',
    'FOO=1 cd /tmp/x; rm -rf ../y',
    'cd /tmp/x; rm -rf ../y',
    'time cd /tmp/x; rm -rf /tmp/y',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
  const branchOf = (cwd) => (/[\\/]work[\\/]main-repo$/.test(cwd ?? '') ? 'main' : 'feature/x'); // D:\work\main-repo on Windows
  const at = (cmd) => checkBash(cmd, { ...ctx(), currentBranch: branchOf }).decision;
  assert.equal(at('sudo cd /work/main-repo && git push'), 'allow');
  assert.equal(at('command cd /work/main-repo && git push'), 'deny');
});

test('xargs into a shell: the input as its script, options or -I words inside the script ask', () => {
  for (const cmd of [
    "echo main | xargs -I{} sh -c 'git push origin {}'",
    "xargs -I % bash -c 'rm -rf %'",
    "xargs -i sh -c 'git commit -m {}'",
    "xargs --replace=X sh -c 'git X --force-with-lease'",
    "xargs -I{} sh -c '{}'",
    "xargs -J % sh -c 'git push %'",
    "xargs -I{} git {} --dry",
    "xargs sh -c 'git push \"$@\"' _",
    "xargs bash -c 'rm -rf $1' _",
    "xargs sh -c 'git push origin ${1}' _",
    'echo "-c \'git push -f\'" | xargs sh',
    'xargs bash',
    'xargs bash -x',
    'echo "git push -f" | xargs wsl',
    'xargs wsl -d Ubuntu',
  ]) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  assert.match(checkBash("xargs -I{} sh -c 'git push origin {}'", ctx()).reason, /xargs/);
  for (const cmd of [
    "xargs -I{} sh -c 'echo {}'",
    "xargs -I{} sh -c 'git add {} && git status'",
    "xargs -I{} sh -c 'git push origin feature/x'",
    "xargs sh -c 'git add \"$@\"' _",
    "xargs -0 sh -c 'for f in \"$@\"; do eslint \"$f\"; done' _",
    'xargs bash script.sh',
    'xargs sh ./run.sh --verbose',
    'xargs wsl --list',
    'wsl',
  ]) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('cmd: ; , and = separate arguments like spaces', () => {
  for (const cmd of ['cmd /c "rd;/s /q C:\\x"', 'cmd /c "rd C:\\x,/s"', 'cmd /c "del=/s x"', 'cmd /c "rd\t/s x"', 'cmd /c "rd x;/q,/s"']) {
    assert.equal(decide(cmd), 'ask', cmd);
  }
  for (const cmd of ['cmd /c dir /s', 'cmd /c "dir;/s"', 'cmd /c "rd C:\\x;y"', 'cmd /c "rd build,dist /q"', 'cmd /c "set X=/s"']) {
    assert.equal(decide(cmd), 'allow', cmd);
  }
});

test('long chains of cd, pushd and git -C stay linear; an over-long directory is unknown', () => {
  const rep = (s, n) => s.repeat(n);
  for (const [cmd, want] of [
    [rep('cd a; ', 40000) + 'git push --force', 'deny'],
    [rep('pushd a; ', 40000) + 'git status', 'allow'],
    ['git ' + rep('-C a ', 40000) + 'push --force', 'deny'],
    [rep('cd a; ', 40000) + 'git push', 'ask'],
  ]) {
    const { decision, ms } = timed(cmd);
    assert.equal(decision, want, cmd.slice(0, 40));
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms for ${cmd.slice(0, 40)}`);
  }
  // past MAX_CWD (4096) the directory is unknown: a push without a branch asks, a short path does not
  assert.equal(decide('cd ' + 'a/'.repeat(2100) + ' && git push'), 'ask');
  assert.equal(decide('cd a/b/c && git push'), 'allow');
  // popping past the kept pushd entries is unknown too
  assert.equal(decide(rep('pushd /tmp; ', 100) + rep('popd; ', 100) + 'git push'), 'ask');
  assert.equal(decide(rep('pushd /tmp; ', 10) + rep('popd; ', 10) + 'git push'), 'allow');
});

test('the branch of a directory is read once per check, and not at all when force or --no-verify decide', () => {
  let calls = 0;
  const counting = { ...ctx(), currentBranch: () => (calls++, 'feature/x') };
  assert.equal(checkBash('git push origin ' + 'HEAD '.repeat(1000), counting).decision, 'allow');
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(checkBash('git push origin ' + '$(git branch --show-current) '.repeat(1000), counting).decision, 'allow');
  assert.equal(calls, 1);
  calls = 0;
  for (const cmd of ['git push -f origin HEAD', 'git push --no-verify', 'git push origin +HEAD', 'git push --force origin $(git branch --show-current)']) {
    assert.equal(checkBash(cmd, counting).decision, 'deny', cmd);
  }
  assert.equal(calls, 0);
  // a protected branch named outright is still reported as such
  assert.match(checkBash('git push --force origin main', ctx()).reason, /«main»/);
  assert.match(checkBash('git push --force', ctx('main')).reason, /--force/);
});
