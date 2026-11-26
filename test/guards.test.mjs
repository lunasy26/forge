import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBash, checkFile, branchMatches } from '../lib/guards.mjs';
import { pendingFindings } from '../lib/secrets.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';
import { setLang } from '../lib/i18n.mjs';
import { git, gitRepo, tempDir, write } from './helpers.mjs';

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

test('-u and -S take the rest of their cluster as a value, so an n there is not --no-verify', () => {
  // -u<mode> and -S<keyid> take an optional value glued to the letter
  assert.equal(decide('git commit -uno -m x'), 'allow');
  assert.equal(decide('git commit -m x -uno'), 'allow');
  assert.equal(decide('git commit -qunormal -m x'), 'allow');
  assert.equal(decide('git commit -Snokey -m x'), 'allow');
  assert.equal(decide('git commit -u -m x'), 'allow');
  // the value is glued only: the next word is not taken, so a following -n still counts
  assert.equal(decide('git commit -u -n -m x'), 'deny');
  assert.equal(decide('git commit -S -nm x'), 'deny');
  // an n before -u or -S is still --no-verify
  assert.equal(decide('git commit -nuno -m x'), 'deny');
  assert.equal(decide('git commit -qnS -m x'), 'deny');
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

// ---- secrets in git commit and git add ----
// Fixtures are assembled at run time: no complete token literal may appear in a source file,
// otherwise committing forge itself would trip this very guard.
const ghToken = 'gh' + 'p_' + 'A1b2'.repeat(9);
const awsKey = 'AK' + 'IA' + 'Q3X7K9M2P5R8T1VW';
const anthropicKey = 'sk' + '-ant-' + 'api03-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7';
const openaiKey = 'sk' + '-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8';
const slackToken = 'xo' + 'xb-' + '1234567890-abcdefghij';
const rsaHeader = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

const sctx = (repo, extra = {}) => ({ cwd: repo, root: repo, protectedBranches: [], secrets: { check: true, ignore: [] }, ...extra });
const scheck = (cmd, repo, extra) => checkBash(cmd, sctx(repo, extra));
/** A repository on a feature branch with these files written and staged. */
function stagedRepo(files = {}) {
  const repo = gitRepo('feature/x');
  for (const [rel, content] of Object.entries(files)) {
    write(repo, rel, content);
    git(repo, 'add', rel);
  }
  return repo;
}

test('secrets: a staged token asks, naming file, line and kind but never the value', () => {
  const repo = stagedRepo({ 'src/config.js': `const a = 1;\nconst token = '${ghToken}';\n` });
  const v = scheck('git commit -m "add config"', repo);
  assert.equal(v.decision, 'ask');
  assert.match(v.reason, /^forge: /);
  assert.match(v.reason, /src\/config\.js:2 — токен GitHub/);
  assert.ok(!v.reason.includes(ghToken), 'the value is not in the reason');
  assert.ok(!v.reason.includes('A1b2'), 'not even a part of it');
});

test('secrets: every kind is named in the reason', () => {
  for (const [content, name] of [
    [`k=${awsKey}`, 'ключ доступа AWS'],
    [`k=${ghToken}`, 'токен GitHub'],
    [`k=${anthropicKey}`, 'ключ API Anthropic'],
    [`k=${openaiKey}`, 'ключ API OpenAI'],
    [`k=${slackToken}`, 'токен Slack'],
    [`${rsaHeader}\nMIIE\n`, 'закрытый ключ'],
  ]) {
    const repo = stagedRepo({ 'a.txt': content });
    const v = scheck('git commit -m x', repo);
    assert.equal(v.decision, 'ask', name);
    assert.ok(v.reason.includes(`a.txt:1 — ${name}`), `${name}: ${v.reason}`);
  }
});

test('secrets: a staged .env file asks and is named without a line number', () => {
  const repo = stagedRepo({ '.env': 'DEBUG=1\n', 'config/.env.local': 'X=1\n' });
  const v = scheck('git commit -m x', repo);
  assert.equal(v.decision, 'ask');
  assert.match(v.reason, /\.env — файл \.env/);
  assert.match(v.reason, /config\/\.env\.local — файл \.env/);
  assert.doesNotMatch(v.reason, /:0/);
});

test('secrets: git add earlier in the same command line counts, untracked files included', () => {
  for (const cmd of [
    'git add -A && git commit -m x',
    'git add . ; git commit -m x',
    'git stage --all && git commit -m x',
    'bash -c "git add -A && git commit -m x"',
    'eval "git add -A" && git commit -m x',
    '(git add -A) && git commit -m x',
  ]) {
    const repo = gitRepo('feature/x');
    write(repo, '.env', 'DEBUG=1\n');
    const v = scheck(cmd, repo);
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /\.env — файл \.env/, cmd);
  }
  const repo = gitRepo('feature/x');
  write(repo, 'notes.txt', `token ${ghToken}\n`);
  assert.equal(scheck('git add -A && git commit -m x', repo).decision, 'ask', 'untracked content');
  // a commit before the add, or a commit without an add, does not take untracked files
  assert.equal(scheck('git commit -m x && git add src.js', repo).decision, 'allow');
  assert.equal(scheck('git commit -m x', repo).decision, 'allow');
});

test('secrets: commit -a, -i, -o and pathspecs take unstaged changes of tracked files', () => {
  const repo = stagedRepo({ 'src.js': 'one\n' });
  git(repo, 'commit', '-q', '-m', 'src');
  write(repo, 'src.js', `one\nkey = ${awsKey}\n`);
  for (const cmd of [
    'git commit -am x',
    'git commit -a -m x',
    'git commit --all -m x',
    'git commit -m x src.js',
    'git commit src.js -m x',
    'git commit -m x -- src.js',
    'git commit -i -m x src.js',
    'git commit --only -m x src.js',
    'git commit -qam x',
    'git commit -m x $files',
    'git commit --pathspec-from-file=list.txt -m x',
    'git commit --patch',
  ]) {
    const v = scheck(cmd, repo);
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /src\.js:2 — ключ доступа AWS/, cmd);
  }
  // only the index: the unstaged change stays out of the commit
  for (const cmd of [
    'git commit -m x',
    'git commit -m "all of it"',
    'git commit --message all',
    'git commit -F msg.txt',
    'git commit -C HEAD',
    'git commit --amend --no-edit',
    'git commit --author "A <a@b.c>" -m x',
    'git commit --fixup HEAD',
    'git commit -uall -m x',
    'git commit -m x --',
    'git commit --allow-empty -m x',
  ]) {
    assert.equal(scheck(cmd, repo).decision, 'allow', cmd);
  }
});

test('secrets: the scan runs where git runs (-C, cd), not repository is silent', () => {
  const outer = tempDir();
  const sub = join(outer, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'feature/x');
  write(sub, 'a.txt', `k=${ghToken}\n`);
  git(sub, 'add', 'a.txt');
  assert.equal(scheck('git commit -m x', outer).decision, 'allow', 'not a repository');
  assert.equal(scheck('git -C sub commit -m x', outer).decision, 'ask');
  assert.equal(scheck('cd sub && git commit -m x', outer).decision, 'ask');
  // quoted: unquoted backslashes of a Windows path are escapes in Bash (git would get D:a… too)
  assert.equal(scheck(`git -C '${sub}' commit -m x`, outer).decision, 'ask');
  // and a clean repository passes from a dirty one
  const clean = gitRepo('feature/x');
  assert.equal(scheck(`git -C '${clean}' commit -m x`, sub).decision, 'allow');
});

test('secrets: an unknown directory or repository asks', () => {
  const repo = stagedRepo({ 'a.txt': 'fine\n' });
  for (const cmd of [
    'cd "$X" && git commit -m x',
    'git -C "$dir" commit -m x',
    'git --git-dir=/elsewhere/.git commit -m x',
    'git --git-dir /elsewhere/.git commit -m x',
    'git --work-tree=/elsewhere commit -m x',
    'cd does-not-exist-yet && git commit -m x',
  ]) {
    const v = scheck(cmd, repo);
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /известном только во время выполнения/, cmd);
  }
  // -c values are harmless
  assert.equal(scheck('git -c user.name=x commit -m x', repo).decision, 'allow');
});

test('secrets: more than five findings are cut with "и ещё N"', () => {
  const files = {};
  for (let i = 1; i <= 7; i++) files[`f${i}.txt`] = `k=${ghToken}\n`;
  const v = scheck('git commit -m x', stagedRepo(files));
  assert.equal(v.decision, 'ask');
  assert.equal((v.reason.match(/токен GitHub/g) || []).length, 5);
  assert.match(v.reason, /и ещё 2/);
});

test('secrets: a scanner that cannot answer asks with its own reason', () => {
  const dir = tempDir();
  const err = checkBash('git commit -m x', sctx(dir, { scanSecrets: () => ({ unchecked: 'error' }) }));
  assert.equal(err.decision, 'ask');
  assert.match(err.reason, /git не ответил/);
  const big = checkBash('git commit -m x', sctx(dir, { scanSecrets: () => ({ unchecked: 'tooLarge' }) }));
  assert.equal(big.decision, 'ask');
  assert.match(big.reason, /слишком велик/);
  // what the scanner is asked for (the time budget is checked below)
  const calls = [];
  const spy = (cwd, { deadlineMs, ...opts }) => (calls.push([cwd, opts]), { findings: [] });
  checkBash('git commit -m x', sctx(dir, { scanSecrets: spy, secrets: { check: true, ignore: ['vendor/**'] } }));
  checkBash('git commit -am x', sctx(dir, { scanSecrets: spy }));
  checkBash('git add src.js && git commit -m x', sctx(dir, { scanSecrets: spy }));
  assert.deepEqual(calls, [
    [dir, { worktree: false, untracked: false, forced: [], forcedAll: false, ignore: ['vendor/**'], base: dir }],
    [dir, { worktree: true, untracked: false, forced: [], forcedAll: false, ignore: [], base: dir }],
    [dir, { worktree: true, untracked: true, forced: [], forcedAll: false, ignore: [], base: dir }],
  ]);
});

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('secrets: one time budget for every commit scan of a command line', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 'b'));
  const cmd = 'git commit -m x; git -C a commit -m y; git -C b commit -m z';
  const seen = [];
  const slow = (cwd, opts) => {
    seen.push(opts.deadlineMs);
    sleep(40);
    return { findings: [] };
  };
  assert.equal(checkBash(cmd, sctx(dir, { scanSecrets: slow, secretsBudgetMs: 2000 })).decision, 'allow');
  assert.equal(seen.length, 3);
  assert.ok(seen[0] > 0 && seen[0] <= 2000, seen.join(','));
  assert.ok(seen[1] <= seen[0] - 40 && seen[2] <= seen[1] - 40, seen.join(','));
  // the default budget fits the 10 s hook timeout
  seen.length = 0;
  checkBash('git commit -m x', sctx(dir, { scanSecrets: slow }));
  assert.ok(seen[0] > 5000 && seen[0] <= 6000, String(seen[0]));
  // a spent budget gives the next scan nothing, and the real scanner then cannot answer: ask
  seen.length = 0;
  const first = (cwd, opts) => {
    seen.push(opts.deadlineMs);
    if (seen.length === 1) {
      sleep(60);
      return { findings: [] };
    }
    return pendingFindings(cwd, opts);
  };
  const v = checkBash(cmd, sctx(dir, { scanSecrets: first, secretsBudgetMs: 30 }));
  assert.equal(v.decision, 'ask');
  assert.match(v.reason, /git не ответил/);
  assert.equal(seen[1], 0);
});

test('secrets: the scan runs only for git commit, once per directory and mode, not when --no-verify denies', () => {
  const dir = tempDir();
  let calls = 0;
  const counting = sctx(dir, { scanSecrets: () => (calls++, { findings: [] }) });
  for (const cmd of ['git status', 'git log -p', 'git add src.js', 'git diff --cached', 'ls && git push origin feature/x']) {
    assert.equal(checkBash(cmd, counting).decision, 'allow', cmd);
  }
  assert.equal(calls, 0);
  assert.equal(checkBash('git commit -m a; git commit -m b; bash -c "git commit -m c"', counting).decision, 'allow');
  assert.equal(calls, 1);
  calls = 0;
  const found = sctx(dir, { scanSecrets: () => (calls++, { findings: [{ file: 'a', line: 1, kind: 'aws' }] }) });
  assert.equal(checkBash('git commit --no-verify -m x', found).decision, 'deny');
  assert.equal(checkBash('git commit -nm x', found).decision, 'deny');
  assert.equal(calls, 0);
  // without ctx.secrets (callers that do not opt in) nothing is scanned
  assert.equal(checkBash('git commit -m x', { cwd: dir, root: dir, protectedBranches: [] }).decision, 'allow');
});

test('secrets: look-alikes and what stays out of the commit pass', () => {
  const cases = [
    ['.env.example', { '.env.example': 'TOKEN=\n', '.env.sample': 'X=\n', 'config/.env.template': 'Y=\n' }],
    ['AWS example key', { 'docs.md': 'AKIAIOSFODNN7' + 'EXAMPLE\n' }],
    ['short sk-', { 'a.js': 'const s = "sk-abc";\n' }],
    ['.envrc and env.js', { '.envrc': 'use nix\n', 'env.js': 'x\n' }],
  ];
  for (const [name, files] of cases) {
    assert.equal(scheck('git commit -m x', stagedRepo(files)).decision, 'allow', name);
  }
  assert.equal(scheck('git commit -m x', gitRepo('feature/x')).decision, 'allow', 'empty index');

  // a secret only in a deleted line
  const removed = stagedRepo({ 'a.txt': `keep\nk=${ghToken}\n` });
  git(removed, 'commit', '-q', '-m', 'old');
  write(removed, 'a.txt', 'keep\n');
  git(removed, 'add', 'a.txt');
  assert.equal(scheck('git commit -m x', removed).decision, 'allow', 'deleted line');

  // .env taken out of the index
  const untracked = stagedRepo({ '.env': 'X=1\n' });
  git(untracked, 'commit', '-q', '-m', 'oops');
  git(untracked, 'rm', '-q', '--cached', '.env');
  assert.equal(scheck('git commit -m x', untracked).decision, 'allow', 'git rm --cached .env');

  // an unrelated unstaged secret in a tracked file, without -a
  const tracked = stagedRepo({ 'a.txt': 'one\n' });
  git(tracked, 'commit', '-q', '-m', 'a');
  write(tracked, 'a.txt', `k=${awsKey}\n`);
  write(tracked, 'b.txt', 'two\n');
  git(tracked, 'add', 'b.txt');
  assert.equal(scheck('git commit -m x', tracked).decision, 'allow', 'unstaged change without -a');
  assert.equal(scheck('git status && git log', tracked).decision, 'allow');
});

test('secrets: secrets.ignore and secrets.check: false', () => {
  const repo = stagedRepo({ 'fixtures/keys.txt': `k=${ghToken}\n`, '.env': 'X=1\n' });
  assert.equal(scheck('git commit -m x', repo, { secrets: { check: true, ignore: ['fixtures/**', '.env'] } }).decision, 'allow');
  assert.equal(scheck('git commit -m x', repo, { secrets: { check: true, ignore: ['fixtures/**'] } }).decision, 'ask');
  assert.equal(scheck('git commit -m x', repo, { secrets: { check: false, ignore: [] } }).decision, 'allow');
  assert.equal(scheck('git add .env', repo, { secrets: { check: false, ignore: [] } }).decision, 'allow');
  assert.equal(scheck('git add .env', repo, { secrets: { check: true, ignore: ['.env'] } }).decision, 'allow');
  assert.equal(scheck('git add config/.env', repo, { secrets: { check: true, ignore: ['config/*'] } }).decision, 'allow');
  assert.equal(scheck('cd config && git add .env', repo, { secrets: { check: true, ignore: ['config/.env'] } }).decision, 'allow');
});

test('secrets: git add with a .env path asks at once, without git', () => {
  // the fake root does not exist: no git call can be behind these verdicts
  const fake = { cwd: root, root, protectedBranches: [], secrets: { check: true, ignore: [] } };
  for (const [cmd, file] of [
    ['git add .env', '.env'],
    ['git add -f .env', '.env'],
    ['git add --force -- config/.env.local', 'config/.env.local'],
    ['git stage .env.production', '.env.production'],
    ['git add src.js .ENV', '.ENV'],
    ["git add '.env*'", '.env*'],
    ['git add :/.env', '.env'],
    ['git -C sub add .env', '.env'],
    ['git add .env.local', '.env.local'],
    ['git add -f .env.local', '.env.local'],
  ]) {
    const v = checkBash(cmd, fake);
    assert.equal(v.decision, 'ask', cmd);
    assert.ok(v.reason.includes(`«${file}»`), `${cmd}: ${v.reason}`);
    assert.match(v.reason, /обычно хранят секреты/, cmd);
  }
  // without ctx.secrets the rule is on too: it needs no git call
  assert.equal(checkBash('git add .env', ctx()).decision, 'ask');
  for (const cmd of [
    'git add .env.example',
    'git add config/.env.sample .env.template',
    "git add '.env.example*'",
    'git add .env.local.example',
    'git add .env.dist config/.env.production.sample',
    "git add '.env.*.example' '.env.dist*' '.env.*.template'",
    'git add src.js',
    'git add -A',
    'git add .',
    "git add -A ':!.env'",
    "git add . ':(exclude).env'",
    'git add -n .env',
    'git add --dry-run .env',
    'git add .envrc',
    'git add "$file"',
    'git add --chmod +x run.sh',
    'git status .env',
    'git diff .env',
    'echo git add .env',
  ]) {
    assert.equal(checkBash(cmd, fake).decision, 'allow', cmd);
  }
});

test('secrets: git add -f scans ignored files it force-adds', () => {
  const repo = gitRepo('feature/x');
  write(repo, '.gitignore', 'secret.txt\nnotes.txt\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'ignore');
  write(repo, 'secret.txt', `k=${ghToken}\n`);
  write(repo, 'notes.txt', 'nothing here\n');
  for (const cmd of [
    'git add -f secret.txt && git commit -m x',
    'git add --force secret.txt && git commit -m x',
    'git add -fA secret.txt && git commit -m x',
    'git add --forc secret.txt && git commit -m x',
    'git add -f -- secret.txt && git commit -m x',
    'git add -f ./secret.txt && git commit -m x',
    'git add -f . && git commit -m x',
    'bash -c "git add -f secret.txt && git commit -m x"',
    'git add -f secret.txt; git commit -m x',
  ]) {
    const v = scheck(cmd, repo);
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /secret\.txt:1 — токен GitHub/, cmd);
    assert.ok(!v.reason.includes(ghToken), cmd);
  }
  // an absolute path, and from another directory
  mkdirSync(join(repo, 'sub'));
  assert.equal(scheck(`git add -f '${join(repo, 'secret.txt')}' && git commit -m x`, repo).decision, 'ask');
  assert.equal(scheck('cd sub && git add -f ../secret.txt && git commit -m x', repo).decision, 'ask');
  assert.equal(scheck('git -C sub add -f ../secret.txt && git commit -m x', repo).decision, 'ask');
  // without -f the ignored file stays out (git add would refuse it anyway); other ignored files are fine
  assert.equal(scheck('git add secret.txt && git commit -m x', repo).decision, 'allow');
  assert.equal(scheck('git add -f notes.txt && git commit -m x', repo).decision, 'allow');
  assert.equal(scheck('git add -f -- notes.txt && git commit -m x', repo).decision, 'allow');
  assert.equal(scheck("git add -f ':!secret.txt' notes.txt && git commit -m x", repo).decision, 'allow');
  // a commit before the add does not take it
  assert.equal(scheck('git commit -m x && git add -f secret.txt', repo).decision, 'allow');
  // -n adds nothing; git add -f without a path adds nothing either ("Nothing specified")
  assert.equal(scheck('git add -fn secret.txt && git commit -m x', repo).decision, 'allow');
  assert.equal(scheck('git add -f && git commit -m x', repo).decision, 'allow');
  // secrets.ignore applies to forced files
  assert.equal(
    scheck('git add -f secret.txt && git commit -m x', repo, { secrets: { check: true, ignore: ['secret.txt'] } }).decision,
    'allow',
  );
});

test('secrets: git add -f of the whole tree (-A, --all, only excludes) reads every ignored file', () => {
  const repo = gitRepo('feature/x');
  write(repo, '.gitignore', '*.local.json\n');
  write(repo, 'README', 'readme\n');
  git(repo, 'add', '.gitignore', 'README');
  git(repo, 'commit', '-q', '-m', 'ignore');
  write(repo, 'creds.local.json', `{"k": "${ghToken}"}\n`);
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  const fromSub = (cmd, extra) => checkBash(cmd, sctx(repo, { cwd: sub, ...extra }));
  for (const cmd of [
    'git add -Af && git commit -m wip',
    'git add -f --all && git commit -m x',
    'git add -A -f && git commit -m x',
    'git add --forc --al && git commit -m x',
    'git add --no-ignore-removal -f && git commit -m x',
    "git add -f ':!README' && git commit -m x",
    "git add -f ':(exclude)README' ':^sub' && git commit -m x",
    "git add -f -- ':!README' && git commit -m x",
  ]) {
    for (const v of [fromSub(cmd), scheck(cmd, repo)]) {
      assert.equal(v.decision, 'ask', cmd);
      assert.match(v.reason, /creds\.local\.json:1 — токен GitHub/, cmd);
    }
  }
  // -u adds no new files, a bare -f adds nothing, -A with a path stays within it, --no-all undoes -A
  for (const cmd of [
    'git add -uf && git commit -m x',
    'git add -u -f creds.local.json && git commit -m x',
    'git add --update --force && git commit -m x',
    'git add -f && git commit -m x',
    'git add -Af README && git commit -m x',
    'git add -A --no-all -f && git commit -m x',
    'git add -A && git commit -m x',
  ]) {
    assert.equal(fromSub(cmd).decision, 'allow', cmd);
  }
  // the add runs in a repository known only at run time: cannot tell what it forces in
  assert.match(scheck('git -C "$X" add -Af && git commit -m x', repo).reason, /git add -f/);
  // many ignored files (node_modules) are too many to read: ask, not allow
  for (let i = 0; i < 201; i++) write(repo, `deps/m${i}.local.json`, '{}\n');
  rmSync(join(repo, 'creds.local.json'));
  const big = fromSub('git add -Af && git commit -m x');
  assert.equal(big.decision, 'ask');
  assert.match(big.reason, /слишком велик/);
});

test('secrets: git add -f with a path known only at run time asks', () => {
  const repo = gitRepo('feature/x');
  for (const cmd of [
    'git add -f "$f" && git commit -m x',
    'git add -f $(ls) && git commit -m x',
    "git add -f 'sec*' && git commit -m x",
    'git add -f :/secret.txt && git commit -m x',
    'git add -f --pathspec-from-file=list.txt && git commit -m x',
    'git add -f ok.txt "$f" && git commit -m x',
    'cd "$X" && git add -f a.txt && git commit -m x',
  ]) {
    const v = scheck(cmd, repo);
    assert.equal(v.decision, 'ask', cmd);
    assert.match(v.reason, /(известном только во время выполнения|git add -f)/, cmd);
  }
  assert.match(scheck('git add -f "$f" && git commit -m x', repo).reason, /git add -f с путём/);
  // without -f a run-time path is nothing special, and no commit means no question
  assert.equal(scheck('git add "$f" && git commit -m x', repo).decision, 'allow');
  assert.equal(scheck('git add -f "$f"', repo).decision, 'allow');
});

test('secrets: git add -f of a .env file asks at the add itself', () => {
  const repo = gitRepo('feature/x');
  write(repo, '.gitignore', '.env.local\n');
  write(repo, '.env.local', 'X=1\n');
  const v = scheck('git add -f .env.local && git commit -m x', repo);
  assert.equal(v.decision, 'ask');
  assert.match(v.reason, /«\.env\.local»/);
});

test('secrets: secrets.ignore is relative to the project root, not to the shell directory', () => {
  const repo = gitRepo('feature/x');
  mkdirSync(join(repo, 'sub/fixtures'), { recursive: true });
  const withIgnore = (...ignore) => ({ secrets: { check: true, ignore } });
  assert.equal(scheck('cd sub && git add .env', repo, withIgnore('/.env')).decision, 'ask', 'sub/.env is not /.env');
  assert.equal(scheck('git add .env', repo, withIgnore('/.env')).decision, 'allow');
  assert.equal(scheck('cd sub && git add fixtures/.env', repo, withIgnore('fixtures/**')).decision, 'ask');
  assert.equal(scheck('cd sub && git add fixtures/.env', repo, withIgnore('sub/fixtures/**')).decision, 'allow');
  assert.equal(scheck('git -C sub add fixtures/.env', repo, withIgnore('sub/fixtures/**')).decision, 'allow');
  // outside the project: never ignored
  assert.equal(scheck('git add ../x/.env', repo, withIgnore('**/.env')).decision, 'ask');
});

test('secrets: the commit scan matches secrets.ignore from the project root (monorepo)', () => {
  const top = gitRepo('feature/x');
  const app = join(top, 'packages/app');
  mkdirSync(app, { recursive: true });
  write(top, 'packages/app/fixtures/key.txt', `k=${ghToken}\n`);
  git(top, 'add', '.');
  const extra = { cwd: app, root: app, secrets: { check: true, ignore: ['fixtures/**'] } };
  assert.equal(checkBash('git commit -m x', sctx(app, extra)).decision, 'allow', 'inside the project root');
  write(top, 'other/key.txt', `k=${ghToken}\n`);
  git(top, 'add', 'other/key.txt');
  const v = checkBash('git commit -m x', sctx(app, extra));
  assert.equal(v.decision, 'ask', 'outside the project root');
  assert.match(v.reason, /other\/key\.txt:1/);
  assert.doesNotMatch(v.reason, /fixtures/);
});
