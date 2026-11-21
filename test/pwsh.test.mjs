import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPowerShell } from '../lib/pwsh.mjs';

const split = (src) => splitPowerShell(src).commands;
const texts = (src) => split(src).map((c) => c.words.map((w) => w.text));
const first = (src) => split(src)[0];

test('pwsh: statement separators ; newline | && || and background &', () => {
  assert.deepEqual(texts('git push origin main; Remove-Item -Recurse -Force C:\\tmp\\x'), [
    ['git', 'push', 'origin', 'main'],
    ['Remove-Item', '-Recurse', '-Force', 'C:\\tmp\\x'],
  ]);
  assert.deepEqual(texts('a 1 | b && c || d\ne\r\nf'), [['a', '1'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(texts('git push & git status'), [['git', 'push'], ['git', 'status']]);
  assert.deepEqual(texts('git push &'), [['git', 'push']]);
  assert.deepEqual(split('git status'), [{ words: [{ text: 'git', dynamic: false }, { text: 'status', dynamic: false }], subs: [], unterminated: false, call: false }]);
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('  ;\n ; '), []);
});

test('pwsh: call operator & and dot-sourcing mark call, the next word is the command', () => {
  assert.deepEqual(split('& git push'), [
    { words: [{ text: 'git', dynamic: false }, { text: 'push', dynamic: false }], subs: [], unterminated: false, call: true },
  ]);
  const quoted = first("& 'C:\\Program Files\\Git\\cmd\\git.exe' push --force");
  assert.equal(quoted.call, true);
  assert.deepEqual(quoted.words.map((w) => w.text), ['C:\\Program Files\\Git\\cmd\\git.exe', 'push', '--force']);
  const dq = first('& "git.exe" push');
  assert.equal(dq.call, true);
  assert.deepEqual(dq.words, [{ text: 'git.exe', dynamic: false }, { text: 'push', dynamic: false }]);
  const dyn = first('& $cmd push');
  assert.equal(dyn.call, true);
  assert.deepEqual(dyn.words, [{ text: '$cmd', dynamic: true }, { text: 'push', dynamic: false }]);
  assert.equal(first('&git push').call, true);
  assert.deepEqual(texts('&git push'), [['git', 'push']]);
  const block = first('& { git push -f }');
  assert.equal(block.call, true);
  assert.deepEqual(block.subs, [' git push -f ']);
  assert.equal(block.words[0].dynamic, true);
  // after a pipe a new statement starts
  const piped = split('Get-Item x | & git push');
  assert.equal(piped[0].call, false);
  assert.equal(piped[1].call, true);
  // dot-sourcing
  const dot = first('. .\\script.ps1 -Force');
  assert.equal(dot.call, true);
  assert.deepEqual(dot.words.map((w) => w.text), ['.\\script.ps1', '-Force']);
  assert.equal(first('.\\script.ps1').call, false);
  assert.deepEqual(texts('.\\script.ps1'), [['.\\script.ps1']]);
  assert.equal(first('. $profile').call, true);
  // a bare call operator has nothing to call: PowerShell refuses to parse it
  assert.equal(first('&').unterminated, true);
});

test('pwsh: single quotes are literal, doubled quote escapes', () => {
  assert.deepEqual(texts("echo 'it''s' 'a;b|c' '$x' 'C:\\a\\'"), [['echo', "it's", 'a;b|c', '$x', 'C:\\a\\']]);
  assert.equal(first("echo '$x'").words[1].dynamic, false);
  assert.deepEqual(texts("echo ''"), [['echo', '']]);
});

test('pwsh: double quotes expand: backtick escapes, doubled quote, variables, subexpressions', () => {
  assert.deepEqual(texts('echo "a `"b`" ``c" "x""y" "t`tn`n" "`$x"'), [['echo', 'a "b" `c', 'x"y', 't\tn\n', '$x']]);
  assert.equal(first('echo "`$x"').words[1].dynamic, false);
  assert.deepEqual(first('echo "$x"').words[1], { text: '$x', dynamic: true });
  assert.deepEqual(first('echo "${a b}"').words[1], { text: '${a b}', dynamic: true });
  assert.deepEqual(first('echo "$env:USERPROFILE\\x"').words[1], { text: '$env:USERPROFILE\\x', dynamic: true });
  assert.deepEqual(first('echo "price: $ 5"').words[1], { text: 'price: $ 5', dynamic: false });
  assert.deepEqual(first('echo "`u{263A}"').words[1].text, '\u263A');
  const sub = first('echo "pre $(git push -f) post"');
  assert.deepEqual(sub.subs, ['git push -f']);
  assert.deepEqual(sub.words[1], { text: 'pre $(git push -f) post', dynamic: true });
  // quotes inside the subexpression belong to it
  assert.deepEqual(first('echo "a $("b") c"').subs, ['"b"']);
  // backslashes are not escapes
  assert.deepEqual(texts('Remove-Item "C:\\Users\\x\\"'), [['Remove-Item', 'C:\\Users\\x\\']]);
});

test('pwsh: iex and pwsh -Command keep the script as one quoted word', () => {
  assert.deepEqual(split('iex "git push -f"'), [
    { words: [{ text: 'iex', dynamic: false }, { text: 'git push -f', dynamic: false }], subs: [], unterminated: false, call: false },
  ]);
  assert.deepEqual(texts('pwsh -Command "git push --force"'), [['pwsh', '-Command', 'git push --force']]);
  assert.deepEqual(texts("Invoke-Expression -Command 'git push'"), [['Invoke-Expression', '-Command', 'git push']]);
});

test('pwsh: a token that starts with a quote ends at the closing quote', () => {
  assert.deepEqual(texts('echo "a"b \'c\'d'), [['echo', 'a', 'b', 'c', 'd']]);
  // a quote inside an unquoted token joins it
  assert.deepEqual(texts('echo a"b c"d -m:"x y"'), [['echo', 'ab cd', '-m:x y']]);
});

test('pwsh: smart quotes work like ASCII quotes', () => {
  assert.deepEqual(texts('git push \u2018origin\u2019 \u201Cmain\u201D'), [['git', 'push', 'origin', 'main']]);
  assert.deepEqual(texts('echo \u2018it\u2019\u2019s\u2019'), [['echo', 'it\u2019s']]);
  assert.deepEqual(first('echo \u201C$x\u201D').words[1], { text: '$x', dynamic: true });
  assert.equal(first('echo \u201Copen').unterminated, true);
});

test('pwsh: here-strings, terminator only at line start', () => {
  assert.deepEqual(texts("iex @'\ngit push -f\n'@"), [['iex', 'git push -f']]);
  assert.deepEqual(texts('iex @"\r\ngit push "x" $y\r\n"@; git status'), [['iex', 'git push "x" $y'], ['git', 'status']]);
  assert.equal(first('iex @"\ngit push $y\n"@').words[1].dynamic, true);
  assert.equal(first("iex @'\ngit push $y\n'@").words[1].dynamic, false);
  assert.deepEqual(first('iex @"\n$(git push -f)\n"@').subs, ['git push -f']);
  assert.deepEqual(texts("echo @'\n'@"), [['echo', '']]);
  assert.deepEqual(texts('echo @\u201C\nx\n\u201D@'), [['echo', 'x']]);
  // a terminator that is not at line start does not end it
  assert.equal(first("iex @'\ngit push '@\n").unterminated, true);
  assert.equal(first("iex @'\ngit push").unterminated, true);
  assert.equal(first('iex @"\ngit push\n').unterminated, true);
  // text after the header is a parse error
  assert.equal(first("iex @'x\ny\n'@").unterminated, true);
});

test('pwsh: backtick outside quotes escapes one char; backtick-newline continues the line', () => {
  assert.deepEqual(texts('git `push C:\\a` b'), [['git', 'push', 'C:\\a b']]);
  assert.deepEqual(texts('git push `\n  --force'), [['git', 'push', '--force']]);
  assert.deepEqual(texts('git push `\r\n  --force'), [['git', 'push', '--force']]);
  assert.deepEqual(texts('echo a`;b a`|b a`&b'), [['echo', 'a;b', 'a|b', 'a&b']]);
  assert.equal(first('git push `').unterminated, true);
});

test('pwsh: comments hide nothing that runs', () => {
  assert.deepEqual(texts('git status # push --force'), [['git', 'status']]);
  assert.deepEqual(texts('# git push\ngit status'), [['git', 'status']]);
  assert.deepEqual(texts('git st#x'), [['git', 'st#x']]);
  assert.deepEqual(texts('<# git push #> git status'), [['git', 'status']]);
  assert.deepEqual(texts('git <# a\nb #> status'), [['git', 'status']]);
  assert.deepEqual(texts("echo 'a'#b\ngit status"), [['echo', 'a'], ['git', 'status']]);
  assert.equal(first('git status <# open').unterminated, true);
});

test('pwsh: variables and splatting are dynamic words', () => {
  assert.deepEqual(first('Remove-Item -Recurse $env:TEMP\\x').words[2], { text: '$env:TEMP\\x', dynamic: true });
  assert.deepEqual(
    first('echo $x ${a b} @args $_ $? $x.Name').words.slice(1),
    ['$x', '${a b}', '@args', '$_', '$?', '$x.Name'].map((text) => ({ text, dynamic: true })),
  );
  assert.deepEqual(first('echo a$x').words[1], { text: 'a$x', dynamic: true });
  assert.deepEqual(first('echo user@host $').words.slice(1), [{ text: 'user@host', dynamic: false }, { text: '$', dynamic: false }]);
  assert.equal(first('echo ${open').unterminated, true);
});

test('pwsh: subexpressions, arrays, script blocks and parentheses go to subs', () => {
  const sub = first('echo $(git push -f)');
  assert.deepEqual(sub.subs, ['git push -f']);
  assert.deepEqual(sub.words[1], { text: '$(git push -f)', dynamic: true });
  const named = first('git $(echo push) origin');
  assert.deepEqual(named.words.map((w) => w.dynamic), [false, true, false]);
  assert.deepEqual(named.subs, ['echo push']);
  assert.deepEqual(first('echo @(git push)').subs, ['git push']);
  assert.deepEqual(first('ForEach-Object { git push --force }').subs, [' git push --force ']);
  assert.deepEqual(first('(git push)').subs, ['git push']);
  assert.deepEqual(first('if ($x) { git push }').subs, ['$x', ' git push ']);
  // a parameter value glued with a colon stays one word
  const colon = first('Remove-Item -Path:(Join-Path a b) -Recurse');
  assert.deepEqual(colon.words, [
    { text: 'Remove-Item', dynamic: false },
    { text: '-Path:(Join-Path a b)', dynamic: true },
    { text: '-Recurse', dynamic: false },
  ]);
  // a group after a literal starts a new argument
  assert.deepEqual(first('echo a(b)').words.slice(1), [{ text: 'a', dynamic: false }, { text: '(b)', dynamic: true }]);
  // only the outermost substitution is collected; nested ones are found by splitting it again
  assert.deepEqual(first('echo $(a $(git push))').subs, ['a $(git push)']);
  assert.deepEqual(split('a $(git push)')[0].subs, ['git push']);
  // statements inside a group stay inside it
  assert.deepEqual(texts('echo $(a; b | c) d'), [['echo', '$(a; b | c)', 'd']]);
  const ht = first('Invoke-Thing @{ a = 1; b = (git push) }');
  assert.deepEqual(ht.words[1], { text: '@{ a = 1; b = (git push) }', dynamic: true });
  assert.deepEqual(ht.subs, [' a = 1; b = (git push) ']);
  // empty groups add nothing
  assert.deepEqual(first('echo $() @{}').subs, []);
});

test('pwsh: parameters are plain words as written', () => {
  assert.deepEqual(texts('Remove-Item -Recurse -Path:C:\\x --force -rec'), [['Remove-Item', '-Recurse', '-Path:C:\\x', '--force', '-rec']]);
});

test('pwsh: redirections are not words', () => {
  assert.deepEqual(texts('git push > out.txt 2>&1'), [['git', 'push']]);
  assert.deepEqual(texts('git status *> $null'), [['git', 'status']]);
  assert.deepEqual(texts('git status >>log.txt'), [['git', 'status']]);
  assert.deepEqual(texts('git log 2> err.txt origin'), [['git', 'log', 'origin']]);
  assert.deepEqual(texts('git push>x'), [['git', 'push']]);
  assert.deepEqual(texts('git status 3>&1 | echo'), [['git', 'status'], ['echo']]);
  // a redirection without a target does not parse
  assert.equal(first('git status >').unterminated, true);
});

test('pwsh: commas separate array elements', () => {
  assert.deepEqual(texts('Remove-Item -Recurse .\\build,C:\\'), [['Remove-Item', '-Recurse', '.\\build', 'C:\\']]);
  assert.deepEqual(texts("echo 'a,b'"), [['echo', 'a,b']]);
});

test('pwsh: assignments come out as <variable> = <command>', () => {
  assert.deepEqual(texts('$r = git push'), [['$r', '=', 'git', 'push']]);
  assert.deepEqual(texts('$r=git push'), [['$r', '=', 'git', 'push']]);
});

test('pwsh: --% passes the rest of the line verbatim, %VAR% is dynamic', () => {
  assert.deepEqual(texts('git --% push --force'), [['git', 'push', '--force']]);
  assert.deepEqual(texts('git --% push "a b"; x | git status'), [['git', 'push', 'a b;', 'x'], ['git', 'status']]);
  assert.deepEqual(first('cmd --% /c %X%').words[2], { text: '%X%', dynamic: true });
  assert.deepEqual(texts("echo '--%' a;b"), [['echo', '--%', 'a'], ['b']]);
});

test('pwsh: unbalanced constructs mark the command unterminated', () => {
  for (const src of [
    "git push 'origin",
    'git push "x',
    'echo $(git push',
    'ForEach-Object { git push',
    '(',
    'echo "$(x"',
    'echo "`',
    'echo )',
    'echo }',
    'echo ( } )',
    'echo < x',
  ]) {
    assert.ok(split(src).some((c) => c.unterminated), src);
  }
  assert.ok(split('echo $(a "b)').some((c) => c.unterminated));
  // the inner unterminated propagates to the command holding the group
  assert.equal(first('echo $(a $(b) "c)').unterminated, true);
  assert.equal(first('echo (git push)').unterminated, false);
});

test('pwsh: deep nesting and long input finish fast and are unterminated', () => {
  const t0 = Date.now();
  assert.ok(split('$('.repeat(20000)).some((c) => c.unterminated));
  assert.ok(split('('.repeat(100000)).some((c) => c.unterminated));
  assert.ok(split('"$('.repeat(5000)).some((c) => c.unterminated));
  assert.ok(split('{'.repeat(5000) + '}'.repeat(5000)).some((c) => c.unterminated));
  assert.equal(split('echo ' + 'a '.repeat(50000)).length, 1);
  assert.ok(Date.now() - t0 < 5000);
});

test('pwsh: random input never throws and keeps the shape', () => {
  const alphabet = ['a', 'b', ' ', '\n', '\r', '\t', ';', '|', '&', '$', '(', ')', '{', '}', '@', '#', '<', '>', "'", '"', '`', ',', '=', '.', '-', '%', ':', '\\', '1', '2', '*', '\u2018', '\u201C', '\u201D', '\uD83D', 'git', 'push', '--%', '@"\n', "\n'@", '<#', '#>', '$(', '${'];
  let seed = 42;
  const rand = (k) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % k;
  };
  for (let round = 0; round < 3000; round++) {
    let src = '';
    const len = rand(40);
    for (let k = 0; k < len; k++) src += alphabet[rand(alphabet.length)];
    const out = splitPowerShell(src);
    assert.ok(Array.isArray(out.commands), src);
    for (const c of out.commands) {
      assert.ok(Array.isArray(c.words) && Array.isArray(c.subs), src);
      assert.equal(typeof c.unterminated, 'boolean', src);
      assert.equal(typeof c.call, 'boolean', src);
      for (const w of c.words) assert.ok(typeof w.text === 'string' && typeof w.dynamic === 'boolean', src);
      for (const s of c.subs) assert.equal(typeof s, 'string', src);
    }
  }
  for (const bad of [undefined, null, 42, {}]) assert.deepEqual(splitPowerShell(bad), { commands: [] });
});
