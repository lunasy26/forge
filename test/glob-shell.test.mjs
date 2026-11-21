import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchList } from '../lib/glob.mjs';
import { splitCommands, stripWrappers } from '../lib/shell.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';

const texts = (cmds) => cmds.map((c) => c.map((w) => w.text));

test('glob: unanchored patterns match at any depth', () => {
  assert.ok(matchList('.env', ['.env']));
  assert.ok(matchList('apps/api/.env', ['.env']));
  assert.ok(matchList('certs/server.pem', ['**/*.pem']));
  assert.ok(matchList('a/b.tsx', ['*.{ts,tsx}']));
  assert.equal(matchList('a/b.js', ['*.{ts,tsx}']), null);
});

test('glob: patterns with a slash are anchored, ** crosses directories', () => {
  assert.ok(matchList('src/auth/token.ts', ['src/auth/**']));
  assert.equal(matchList('lib/src/auth/token.ts', ['src/auth/**']), null);
  assert.ok(matchList('db/migrations/001.sql', ['**/migrations/**']));
  assert.ok(matchList('migrations/001.sql', ['**/migrations/**']));
  assert.ok(matchList('.github/workflows/ci.yml', ['.github/workflows/**']));
});

test('glob: directory pattern covers its contents; last match wins with negation', () => {
  assert.ok(matchList('secrets/prod/key.txt', ['secrets']));
  assert.equal(matchList('.env.example', DEFAULT_PROTECTED_FILES), null);
  assert.ok(matchList('.env.local', DEFAULT_PROTECTED_FILES));
  assert.equal(matchList('config/dev.key', [...DEFAULT_PROTECTED_FILES, '!config/dev.key']), null);
});

test('glob: nocase matches regardless of case, including negations and anchored patterns', () => {
  const nc = { nocase: true };
  assert.equal(matchList('.ENV', ['.env']), null);
  assert.ok(matchList('.ENV', ['.env'], nc));
  assert.ok(matchList('Secrets/x', ['secrets/**'], nc));
  assert.equal(matchList('Secrets/x', ['secrets/**']), null);
  assert.equal(matchList('.ENV.EXAMPLE', DEFAULT_PROTECTED_FILES, nc), null);
  assert.ok(matchList('sub/KEY.PEM', DEFAULT_PROTECTED_FILES, nc));
  assert.equal(matchList('docs/ENV.md', DEFAULT_PROTECTED_FILES, nc), null);
  // the cache keeps the two flavours apart
  assert.equal(matchList('.ENV', ['.env']), null);
});

test('shell: separators split commands, quotes keep words together', () => {
  assert.deepEqual(texts(splitCommands('git add . && git commit -m "fix; push" || echo no')), [
    ['git', 'add', '.'],
    ['git', 'commit', '-m', 'fix; push'],
    ['echo', 'no'],
  ]);
  assert.deepEqual(texts(splitCommands("echo 'a | b' | wc -l; ls")), [['echo', 'a | b'], ['wc', '-l'], ['ls']]);
});

test('shell: redirections and heredoc bodies are not commands or arguments', () => {
  assert.deepEqual(texts(splitCommands('git push origin main 2>&1 | tee out.log')), [
    ['git', 'push', 'origin', 'main'],
    ['tee', 'out.log'],
  ]);
  assert.deepEqual(texts(splitCommands('cat > notes.md <<EOF\ngit push origin main\nEOF\necho ok')), [['cat'], ['echo', 'ok']]);
  assert.deepEqual(texts(splitCommands('cmd &>/dev/null')), [['cmd']]);
});

test('shell: dynamic words are marked, wrappers and env assignments stripped', () => {
  const [[, , dir]] = splitCommands('rm -rf "$DIR"');
  assert.equal(dir.dynamic, true);
  const [[, , sub]] = splitCommands('rm -rf $(pwd)/build');
  assert.equal(sub.dynamic, true);
  const [cmd] = splitCommands('FOO=1 sudo -E git push origin main');
  assert.deepEqual(stripWrappers(cmd).map((w) => w.text), ['git', 'push', 'origin', 'main']);
});

test('shell: wrappers are recognised by normalised name (path, case, .exe)', () => {
  const stripped = (src) => stripWrappers(splitCommands(src)[0]).map((w) => w.text);
  const want = ['git', 'push', 'origin', 'main'];
  for (const src of [
    '/usr/bin/env git push origin main',
    'env.exe git push origin main',
    'SUDO git push origin main',
    '/usr/bin/sudo -E git push origin main',
    "'C:\\Windows\\System32\\env.exe' git push origin main",
    'env -i FOO=1 git push origin main',
    'nohup /usr/bin/nice git push origin main',
  ]) {
    assert.deepEqual(stripped(src), want, src);
  }
  // not wrappers: similar names stay as the command; keywords match only exactly
  assert.deepEqual(stripped('envsubst < a > b'), ['envsubst']);
  assert.deepEqual(stripped('sudoku solve'), ['sudoku', 'solve']);
  assert.deepEqual(stripped('/usr/bin/env node script.js'), ['node', 'script.js']);
  assert.deepEqual(stripped('/usr/bin/if git push'), ['/usr/bin/if', 'git', 'push']);
});

test('shell: wrapper options with arguments are skipped per wrapper', () => {
  const stripped = (src) => stripWrappers(splitCommands(src)[0]).map((w) => w.text);
  const git = ['git', 'push', 'origin', 'main'];
  for (const src of [
    'nice -n 5 git push origin main',
    'nice -n5 git push origin main',
    'nice -5 git push origin main',
    'sudo -u root git push origin main',
    'sudo -uroot git push origin main',
    'sudo -Eu root git push origin main',
    'sudo --user=root git push origin main',
    'sudo --user root git push origin main',
    'sudo -- git push origin main',
    'timeout 10 git push origin main',
    'timeout -s KILL 10 git push origin main',
    'timeout -k 5 -s TERM 1.5s git push origin main',
    'xargs -n 1 -P 4 git push origin main',
    'xargs -I {} git push origin main',
    'stdbuf -oL -e0 git push origin main',
    'env -u FOO -C /tmp BAR=1 git push origin main',
    'ionice -c2 -n 7 git push origin main',
    'chrt -r 10 git push origin main',
    'taskset 0x3 git push origin main',
    'doas -u root git push origin main',
    'time -p git push origin main',
  ]) {
    assert.deepEqual(stripped(src), git, src);
  }
  // option arguments are not mistaken for the command
  assert.deepEqual(stripped('sudo -u git ls -l'), ['ls', '-l']);
  assert.deepEqual(stripped('nice -n 5 make all'), ['make', 'all']);
  assert.deepEqual(stripped('timeout 10 npm test'), ['npm', 'test']);
  assert.deepEqual(stripped('xargs grep foo'), ['grep', 'foo']);
  // a bare wrapper leaves nothing; an option argument is not skipped for a wrapper without that option
  assert.deepEqual(stripped('timeout'), []);
  assert.deepEqual(stripped('echo -n git push'), ['echo', '-n', 'git', 'push']);
});

test('shell: watch hands its line to a shell', () => {
  const stripped = (src) => stripWrappers(splitCommands(src)[0]).map((w) => w.text);
  assert.deepEqual(stripped('watch -n 2 git status'), ['sh', '-c', 'git status']);
  assert.deepEqual(stripped("watch 'git push origin main; ls'"), ['sh', '-c', 'git push origin main; ls']);
  // procps-ng: -w/--no-wrap takes no value, -q/--equexit takes one
  assert.deepEqual(stripped('watch -w git push'), ['sh', '-c', 'git push']);
  assert.deepEqual(stripped('watch --no-wrap git push'), ['sh', '-c', 'git push']);
  assert.deepEqual(stripped('watch -q 5 git push'), ['sh', '-c', 'git push']);
  assert.deepEqual(stripped('watch --equexit 5 git push'), ['sh', '-c', 'git push']);
  assert.deepEqual(stripped('watch -n 5 -q 3 -w ls'), ['sh', '-c', 'ls']);
  // an unknown option: its value is not taken for the command when a guarded one follows
  assert.deepEqual(stripped('watch --made-up 5 git push'), ['sh', '-c', 'git push']);
  assert.deepEqual(stripped('watch --made-up 5 ls'), ['sh', '-c', '5 ls']);
});

test('shell: env -S is split with env rules and its words are spliced in place', () => {
  const stripped = (src) => stripWrappers(splitCommands(src)[0]).map((w) => w.text);
  const push = ['git', 'push', '--force'];
  for (const src of [
    'env -S "git push --force"',
    "env -S 'git\\_push\\_--force'",
    "env --split-string='git push --force'",
    "env -S'git push' --force",
    "env -S '-i git push --force'",
    "env -S '-- git push --force'",
    "env -S'-v' git push --force",
    "env -vS 'FOO=1 git push' --force",
    "env -S '-S \"git push\"' --force",
    "env -S 'git push \"--force\"  # a comment'",
    "env -S 'g\\it push --force'",
  ]) {
    assert.deepEqual(stripped(src), push, src);
  }
  // ; | & are ordinary characters for env, not separators
  assert.deepEqual(stripped("env -S 'git push -o ; --force'"), ['git', 'push', '-o', ';', '--force']);
  assert.deepEqual(stripped("env -S 'git push -o' ';' --force"), ['git', 'push', '-o', ';', '--force']);
  // \_ is a space inside double quotes, single quotes keep backslashes except \\ and \'
  const envS = (value) => stripWrappers([{ text: 'env' }, { text: '-S' }, { text: value }]).map((w) => w.text);
  assert.deepEqual(envS(`echo "a\\_b" 'c\\'d' 'e\\\\f\\g' \\#h`), ['echo', 'a b', "c'd", 'e\\f\\g', '#h']);
  assert.deepEqual(envS('echo "\\t\\"\\$x"\\_y'), ['echo', '\t"$x', 'y']);
  assert.deepEqual(envS("printf '' x#y #z"), ['printf', '', 'x#y']);
  assert.deepEqual(stripped("env -S \"echo 'a\\nb'\""), ['echo', 'a\\nb']);
  // ${VAR} is expanded by env: the word is dynamic; \c ends the string
  const [cmd] = splitCommands("env -S 'node ${APP}/x.js \\c git push --force' --inspect");
  const words = stripWrappers(cmd);
  assert.deepEqual(words.map((w) => w.text), ['node', '${APP}/x.js', '--inspect']);
  assert.deepEqual(words.map((w) => w.dynamic), [false, true, false]);
  // a dynamic source word gives dynamic words
  assert.ok(stripWrappers(splitCommands('env -S "$CMD x"')[0]).every((w) => w.dynamic));
  assert.deepEqual(stripped("env -S 'node --inspect app.js'"), ['node', '--inspect', 'app.js']);
  assert.deepEqual(stripped("env -S 'FOO=1 npm test'"), ['npm', 'test']);
  // what env cannot split is handed over as an unterminated substitution, so the guard asks
  for (const src of ["env -S \"git push 'x\"", "env -S 'git push \"x'", "env -S 'git push \\'", "env -S 'echo ${X'"]) {
    const [, , script] = stripWrappers(splitCommands(src)[0]);
    assert.ok(splitCommands(script.text).some((c) => c.unterminated), src);
  }
});

test('shell: safety net — an unknown option before a guarded command does not hide it', () => {
  const stripped = (src) => stripWrappers(splitCommands(src)[0]).map((w) => w.text);
  assert.deepEqual(stripped('sudo --made-up value git push origin main'), ['git', 'push', 'origin', 'main']);
  assert.deepEqual(stripped('nice --made-up 5 rm -rf x'), ['rm', '-rf', 'x']);
  // PowerShell and cmd started from Bash are guarded too
  assert.deepEqual(stripped('sudo --made-up value pwsh -c x'), ['pwsh', '-c', 'x']);
  assert.deepEqual(stripped('sudo --made-up value powershell.exe -c x'), ['powershell.exe', '-c', 'x']);
  assert.deepEqual(stripped('nice --made-up 5 cmd /c x'), ['cmd', '/c', 'x']);
  // known options: no jump, the guarded word stays an ordinary argument
  assert.deepEqual(stripped('sudo -E echo git push'), ['echo', 'git', 'push']);
  assert.deepEqual(stripped('sudo --made-up value echo hi'), ['value', 'echo', 'hi']);
  // the jump also lands on a nested wrapper, which is then stripped with its own options
  assert.deepEqual(stripped('sudo --made-up value env -u git bash -c x'), ['bash', '-c', 'x']);
  assert.deepEqual(stripped("sudo --made-up value env -S 'git push'"), ['git', 'push']);
  assert.deepEqual(stripped('env --made-up env -u git bash -c x'), ['bash', '-c', 'x']);
  assert.deepEqual(stripped("env --made-up /usr/bin watch 'git push'"), ['sh', '-c', 'git push']);
  // known env options: macOS -P altpath, GNU signal options
  assert.deepEqual(stripped('env -P /usr/bin git push'), ['git', 'push']);
  assert.deepEqual(stripped('env --default-signal env -u git bash -c x'), ['bash', '-c', 'x']);
  assert.deepEqual(stripped('env --ignore-signal=INT npm test'), ['npm', 'test']);
  // words named like Object.prototype members are not wrappers
  assert.deepEqual(stripped('constructor git push'), ['constructor', 'git', 'push']);
  assert.deepEqual(stripped('toString --x git push'), ['toString', '--x', 'git', 'push']);
});

test('shell: the wrapper safety net runs in linear time', () => {
  for (const n of [2000, 20000]) {
    const src = 'env --x '.repeat(n) + 'ls '.repeat(n) + 'git push';
    const started = performance.now();
    const words = stripWrappers(splitCommands(src)[0]);
    const ms = performance.now() - started;
    assert.deepEqual(words.map((w) => w.text), ['git', 'push']);
    assert.ok(ms < 500, `${ms.toFixed(0)} ms for n=${n}`);
  }
  const started = performance.now();
  stripWrappers(splitCommands('env ' + '-S -i '.repeat(20000) + 'ls')[0]);
  assert.ok(performance.now() - started < 500, 'chained env -S');
});

const subs = (src) => splitCommands(src).flatMap((c) => c.subs);

test('shell: command substitutions are collected for inspection, words stay dynamic', () => {
  const cmds = splitCommands('echo $(git push --force origin main) done');
  assert.deepEqual(texts(cmds), [['echo', '$(git push --force origin main)', 'done']]);
  assert.equal(cmds[0][1].dynamic, true);
  assert.deepEqual(cmds[0].subs, ['git push --force origin main']);
  assert.deepEqual(subs('echo `git push origin main`'), ['git push origin main']);
  assert.deepEqual(subs('x=$(git push origin main)'), ['git push origin main']);
  assert.deepEqual(subs('echo "$(rm -rf /tmp/x)"'), ['rm -rf /tmp/x']);
  assert.deepEqual(subs('echo "a \'$(git push)\' b"'), ['git push'], 'single quotes inside double quotes do not protect');
  assert.deepEqual(subs('ls > $(git push)'), ['git push'], 'redirection targets are expanded too');
  assert.deepEqual(subs('echo ok'), []);
});

test('shell: nested, quoted and escaped substitutions find the right closing paren', () => {
  assert.deepEqual(subs('echo $(echo $(git push --force origin main))'), ['echo $(git push --force origin main)']);
  assert.deepEqual(subs('echo $(echo ")" \\) \')\') tail'), ['echo ")" \\) \')\'']);
  assert.deepEqual(subs('echo "$(echo "a)b")"'), ['echo "a)b"']);
  assert.deepEqual(subs('echo `echo \\`git push\\``'), ['echo `git push`'], 'escaped backticks nest');
  assert.deepEqual(subs('echo ${x:-$(git push)} ${HOME} ${y:-$z}'), ['git push']);
  const [cmd] = splitCommands('echo $(git push origin main');
  assert.equal(cmd.unterminated, true);
});

test('shell: heredocs, comments and case patterns inside $(...) do not close it', () => {
  const msg = "git commit -m \"$(cat <<'EOF'\nfix: don't break (things)\nEOF\n)\"";
  assert.deepEqual(subs(msg), ["cat <<'EOF'\nfix: don't break (things)\nEOF\n"]);
  assert.deepEqual(subs('echo "$(case $x in a) git push;; esac)"'), ['case $x in a) git push;; esac']);
  assert.deepEqual(subs("echo $(true # don't )\ngit push\n)"), ["true # don't )\ngit push\n"]);
  assert.deepEqual(subs('echo $(cat <<< "a)b") $(echo case)'), ['cat <<< "a)b"', 'echo case']);
});

test('shell: literal text, arithmetic and process substitution', () => {
  assert.deepEqual(subs("echo '$(git push --force origin main)'"), []);
  assert.deepEqual(subs('echo \\$(git push)'), [], 'escaped $ is literal');
  assert.deepEqual(subs('echo $((1 + 2)) $(( (3) * 4 ))'), []);
  assert.deepEqual(subs('echo $((1 + $(git push)))'), ['git push'], 'substitution inside arithmetic still runs');
  assert.deepEqual(subs('echo $((git push --force origin main) )'), ['(git push --force origin main) '], 'subshell, not arithmetic');
  const cmds = splitCommands('cat <(git push --force origin main) >(tee log)');
  assert.deepEqual(texts(cmds), [['cat', '<(git push --force origin main)', '>(tee log)']]);
  assert.deepEqual(cmds[0].subs, ['git push --force origin main', 'tee log']);
});

test('shell: heredoc bodies expand only with an unquoted delimiter', () => {
  assert.deepEqual(subs("cat <<EOF\nnote '$(git push origin main)'\n`date`\nEOF\necho ok"), ['git push origin main', 'date']);
  assert.deepEqual(subs("cat <<'EOF'\n$(git push origin main)\nEOF"), []);
  assert.deepEqual(subs('cat <<"EOF"\n$(git push origin main)\nEOF'), []);
  assert.deepEqual(subs('cat <<\\EOF\n$(git push origin main)\nEOF'), []);
  assert.deepEqual(subs('cat <<EOF\n\\$(git push origin main)\nEOF'), [], 'escaped $ in a heredoc body');
});

test('shell: ANSI-C quotes are their own quoted form', () => {
  assert.deepEqual(texts(splitCommands("echo $'it\\'s' && git push")), [['echo', "it's"], ['git', 'push']]);
  const [[git, push]] = splitCommands("$'git' $'pu\\x73h'");
  assert.deepEqual([git.text, git.dynamic], ['git', false]);
  assert.equal(push.dynamic, true, 'escapes that are not decoded make the word dynamic');
  assert.deepEqual(texts(splitCommands("echo $'a\\tb\\\\c\\\"d' x")), [['echo', 'a\tb\\c"d', 'x']]);
  assert.deepEqual(subs("echo $(echo $'a\\'b)') $(date)"), ["echo $'a\\'b)'", 'date']);
  assert.deepEqual(subs('echo "$\'x\'"'), [], "$'…' is literal inside double quotes");
});

test('shell: backslash-newline joins lines except in single quotes, comments and quoted heredocs', () => {
  assert.deepEqual(texts(splitCommands('git push \\\n--force')), [['git', 'push', '--force']]);
  assert.deepEqual(subs('echo "$\\\n(git push)"'), ['git push']);
  assert.deepEqual(subs('cat <<\\\nEOF\n$(git push)\nEOF'), ['git push'], 'the delimiter stays unquoted');
  assert.deepEqual(subs('cat <<EOF\n$\\\n(git push)\nEOF'), ['git push']);
  assert.deepEqual(texts(splitCommands('echo a # x \\\ngit push')), [['echo', 'a'], ['git', 'push']]);
  assert.deepEqual(texts(splitCommands('echo a\\\\\ngit push')), [['echo', 'a\\'], ['git', 'push']]);
  assert.deepEqual(texts(splitCommands("cat <<'EOF'\nfoo\\\nEOF\ngit push")), [['cat'], ['git', 'push']]);
  assert.deepEqual(texts(splitCommands('cat <<EOF\nfoo\\\nEOF\nEOF\ngit push')), [['cat'], ['git', 'push']], 'unquoted body lines join');
});

test('shell: heredoc terminators — tabs only for <<-, several heredocs per line', () => {
  assert.deepEqual(texts(splitCommands("cat <<EOF\n\tEOF\nit's\nEOF\ngit push")), [['cat'], ['git', 'push']]);
  assert.deepEqual(texts(splitCommands('cat <<-EOF\n\tbody\n\tEOF\necho ok')), [['cat'], ['echo', 'ok']]);
  assert.deepEqual(subs("cat <<A <<'B' <<C\n$(a)\nA\n$(b)\nB\n$(c)\nC\necho ok"), ['a', 'c']);
  assert.deepEqual(subs("echo $(cat <<A <<'B'\n)\nA\n)\nB\n)"), ["cat <<A <<'B'\n)\nA\n)\nB\n"]);
});

test('shell: arithmetic commands and expansions', () => {
  assert.deepEqual(texts(splitCommands('((x = 1 << 2))\ngit push')), [['git', 'push']]);
  assert.deepEqual(texts(splitCommands('for ((i=0; i<1<<2; i++)); do :; done\ngit push')), [['for'], ['do', ':'], ['done'], ['git', 'push']]);
  assert.deepEqual(subs('echo $((1+2)) $((x<<2)) $(( (3) * 4 ))'), []);
  assert.deepEqual(subs("echo $(( '$(git push)' ))"), ['git push'], 'single quotes are not quotes in arithmetic');
  assert.deepEqual(subs('((x = $(git push)))'), ['git push']);
  assert.deepEqual(texts(splitCommands('((git push) )')), [['git', 'push']], 'a subshell, not arithmetic');
});

test('shell: case/esac only at command position', () => {
  for (const src of ['x=$(grep -c case README.md)', 'echo $(git log --grep case -1)', 'echo "$(echo case x)" && echo ok']) {
    const cmds = splitCommands(src);
    assert.ok(cmds.every((c) => !c.unterminated), src);
  }
  assert.deepEqual(subs('echo "$(echo a; case $x in a) git push;; esac)"'), ['echo a; case $x in a) git push;; esac']);
  assert.deepEqual(subs('echo $(c\\\nase x in a) git push;; esac)'), ['c\\\nase x in a) git push;; esac']);
});

test('shell: pathological nesting is cut off as unterminated, in linear time', () => {
  for (const src of [
    'echo ' + '$('.repeat(3000) + 'x' + ')'.repeat(3000),
    'echo ' + '"$('.repeat(3000) + ')"'.repeat(3000),
    'echo ' + '${x:-'.repeat(10000) + '}'.repeat(10000),
  ]) {
    const started = performance.now();
    const cmds = splitCommands(src);
    assert.ok(performance.now() - started < 1000);
    assert.ok(cmds.some((c) => c.unterminated), src.slice(0, 20));
  }
  const started = performance.now();
  const cmds = splitCommands('echo ' + '$(( '.repeat(26) + 'x' + ' ) )'.repeat(26) + '; git push');
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(texts(cmds).at(-1), ['git', 'push']);
  assert.ok(cmds.every((c) => !c.unterminated), 'nesting below the cap still parses');
});

test('shell: stripWrappers marks words that xargs completes and env -S strings it cannot split', () => {
  const strip = (src) => stripWrappers(splitCommands(src)[0]);
  for (const src of ['xargs git push', 'sudo xargs -0 git push', 'xargs sudo git push', 'xargs -- rm -r']) {
    assert.equal(strip(src).stdinArgs, true, src);
  }
  for (const src of ['git push', 'sudo git push', 'env -S "git push"', 'echo xargs git push']) {
    assert.ok(!strip(src).stdinArgs, src);
  }
  const broken = strip("env -S 'git push \"x'");
  assert.equal(broken.envSplit, true);
  assert.ok(!strip("env -S 'git push x'").envSplit);
});
