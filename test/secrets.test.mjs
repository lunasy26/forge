import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFF_ARGS, SECRET_KINDS, isSecretFile, parsePatch, pendingFindings, scanPatch, scanText } from '../lib/secrets.mjs';
import { git, gitRepo, symlinkSkip, tempDir, write } from './helpers.mjs';

// Fixtures are assembled at run time: no complete token literal may appear in a source file,
// otherwise committing forge itself would trip the secrets guard.
const aws = 'AK' + 'IA' + 'Q3X7K9M2P5R8T1VW';
const awsTemp = 'AS' + 'IA' + 'Q3X7K9M2P5R8T1VW';
const ghp = 'gh' + 'p_' + 'A1b2'.repeat(9);
const ghs = 'gh' + 's_' + 'Zy9x'.repeat(9);
const ghPat = 'github' + '_pat_' + 'A1b2C3d4'.repeat(4);
const anthropic = 'sk' + '-ant-' + 'api03-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7';
const openai = 'sk' + '-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8';
const openaiProj = 'sk' + '-proj-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8';
const openaiLong = 'sk' + '-' + 'Ab1Cd2Ef3Gh4'.repeat(4);
const openaiProjMixed = 'sk' + '-proj-' + 'Ab1_Cd2-Ef3Gh4Ij5Kl6Mn7Op8Qr9-St0_Uv1Wx2-Yz3';
const slack = 'xo' + 'xb-' + '1234567890-abcdefghij';
const rsaHeader = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

const kindsOf = (text) => scanText('f', text).map((f) => f.kind);

test('secrets: SECRET_KINDS lists every kind', () => {
  assert.deepEqual(SECRET_KINDS, ['aws', 'github', 'anthropic', 'openai', 'slack', 'privateKey', 'envFile']);
});

test('secrets: each content kind is found with its line number', () => {
  assert.deepEqual(scanText('a.txt', `ok\nkey = ${aws}\n`), [{ file: 'a.txt', line: 2, kind: 'aws' }]);
  assert.deepEqual(kindsOf(`k=${awsTemp}`), ['aws']);
  assert.deepEqual(kindsOf(`token: ${ghp}`), ['github']);
  assert.deepEqual(kindsOf(`token: ${ghs}`), ['github']);
  assert.deepEqual(kindsOf(`token: ${ghPat}`), ['github']);
  assert.deepEqual(kindsOf(`KEY=${anthropic}`), ['anthropic']);
  assert.deepEqual(kindsOf(`KEY=${openai}`), ['openai']);
  assert.deepEqual(kindsOf(`KEY="${openaiProj}"`), ['openai']);
  assert.deepEqual(kindsOf(`KEY=${openaiLong}`), ['openai']);
  assert.deepEqual(kindsOf(`KEY=${openaiProjMixed}`), ['openai']);
  assert.deepEqual(kindsOf(`KEY=${'sk' + '-svcacct-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8-x_y'}`), ['openai']);
  assert.deepEqual(kindsOf(`KEY=${'sk' + '-admin-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8'}`), ['openai']);
  assert.deepEqual(kindsOf(`KEY=${'sk' + '-None-' + 'Ab1Cd2Ef3Gh4'.repeat(4)}`), ['openai']);
  assert.deepEqual(kindsOf(`SLACK=${slack}`), ['slack']);
  assert.deepEqual(kindsOf(rsaHeader), ['privateKey']);
});

test('secrets: private key header variants', () => {
  for (const name of ['EC', 'OPENSSH', 'DSA', 'ENCRYPTED', '', 'PGP']) {
    const suffix = name === 'PGP' ? ' BLOCK' : '';
    const header = `-----BEGIN ${name ? name + ' ' : ''}PRIVATE KEY${suffix}-----`;
    assert.deepEqual(kindsOf(header), ['privateKey'], header);
  }
  assert.deepEqual(kindsOf('-----BEGIN ' + 'PUBLIC KEY-----'), []);
  assert.deepEqual(kindsOf('-----BEGIN ' + 'CERTIFICATE-----'), []);
});

test('secrets: an Anthropic key is not reported as OpenAI', () => {
  assert.deepEqual(kindsOf(anthropic), ['anthropic']);
});

test('secrets: both kinds on one line, one finding per kind and line', () => {
  assert.deepEqual(kindsOf(`${aws} ${ghp} ${aws}`), ['aws', 'github']);
});

test('secrets: placeholders and look-alikes are safe', () => {
  const safe = [
    'AKIAIOSFODNN7' + 'EXAMPLE',
    'sk-abc',
    'sk-' + 'your-key-here-xxxxxxxxxxxx',
    'sk-' + 'proj-' + 'xxxxxxxxxxxxxxxxxxxxxxxx1',
    'task-assignment-number-2024-final',
    'desk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8',
    'risk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8',
    'sk-' + 'onlyletterslongenoughtomatch',
    'sk-' + '12345678901234567890123',
    'gh' + 'p_' + 'A1b2'.repeat(8), // too short
    'gh' + 'p_' + 'A1b2'.repeat(10), // too long
    'gh' + 'p_' + 'your'.repeat(9),
    'xo' + 'xb-' + 'placeholder-token-1',
    'xo' + 'xb-short',
    'github' + '_pat_' + 'short',
    'AK' + 'IA' + 'SHORT',
    'AB' + aws, // not at a token start
    'sk' + '-ant-' + 'short',
    'dummy ' + 'AK' + 'IA' + 'Q3X7K9M2P5DUMMY1',
    // kebab-case identifiers that start with sk-
    'sk-' + '1234-fix-login-redirect-bug',
    '.sk-' + 'circle-fade-delay-12',
    'sk-' + 'payments-api-v2-deployment',
    'sk-' + 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8-tail', // plain sk- body may not contain '-'
    'sk-' + 'proj-' + 'ab1-cd2-ef3-gh4-ij5-kl6-mn7-op8', // no run of 20 without '-'
    'sk-' + 'None-of-the-above-options-apply-2024',
    'sk-' + 'None-' + 'xxxxxxxxxxxxxxxxxxxxxxxx1',
    'sk-' + 'None-' + 'onlyletterslongenoughtomatchhere', // no digit
  ];
  for (const s of safe) assert.deepEqual(kindsOf(s), [], s);
});

test('secrets: CRLF line endings do not break the scan', () => {
  assert.deepEqual(scanText('a', `x\r\n${aws}\r\n`), [{ file: 'a', line: 2, kind: 'aws' }]);
});

test('secrets: a very long line is scanned in windows without blowing up', () => {
  const long = 'a'.repeat(200_000) + ' ' + aws;
  assert.deepEqual(kindsOf(long), ['aws']); // past the first 64 KB window
  // a token across a window boundary (64 KB - 512 chars overlap) is still found, once
  const step = 64 * 1024 - 512;
  for (const at of [step - 10, 64 * 1024 - 10, 2 * step - 5]) {
    assert.deepEqual(scanText('f', ' '.repeat(at) + aws + ' '.repeat(100_000)), [{ file: 'f', line: 1, kind: 'aws' }], String(at));
  }
  // the window start does not hide the preceding character from the lookbehind
  assert.deepEqual(kindsOf('B'.repeat(step) + aws.slice(0) + ' '.repeat(70_000)), []);
  const dense = 'sk-'.repeat(100_000);
  assert.deepEqual(kindsOf(dense), []);
});

test('secrets: isSecretFile', () => {
  for (const p of ['.env', '.env.local', '.env.production', 'config/.env.local', 'a/b/.env', 'a\\b\\.env', '.ENV', '.Env.Local']) {
    assert.equal(isSecretFile(p), true, p);
  }
  for (const p of ['.env.example', '.env.sample', '.env.template', 'x/.env.example', '.ENV.EXAMPLE', '.environment', 'env.js', 'my.env', '.envrc', 'env', '.env.',
    '.env.local.example', '.env.dist', '.env.production.sample', 'cfg/.env.prod.template', '.ENV.DIST']) {
    assert.equal(isSecretFile(p), false, p);
  }
});

// ---- scanPatch ----

const patch = (...lines) => lines.join('\n') + '\n';

test('scanPatch: only added lines, numbers come from the hunk headers', () => {
  const text = patch(
    'diff --git a/src/a.txt b/src/a.txt',
    'index 111..222 100644',
    '--- a/src/a.txt',
    '+++ b/src/a.txt',
    '@@ -3,0 +4,2 @@',
    '+first',
    `+${aws}`,
    '@@ -10 +12,3 @@',
    `-old ${ghp}`,
    '+x',
    '+y',
    `+${ghp}`,
    '\\ No newline at end of file',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    `-${anthropic}`,
    `+${openai}`,
  );
  assert.deepEqual(scanPatch(text), [
    { file: 'src/a.txt', line: 5, kind: 'aws' },
    { file: 'src/a.txt', line: 14, kind: 'github' },
    { file: 'b.txt', line: 1, kind: 'openai' },
  ]);
});

test('scanPatch: context lines advance the new-file line number', () => {
  const text = patch(
    'diff --git a/a b/a',
    '--- a/a',
    '+++ b/a',
    '@@ -1,6 +1,7 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '', // a blank context line under diff.suppressBlankEmpty
    ' five',
    `+${aws}`,
    ' six',
    '\\ No newline at end of file',
    '@@ -20 +21 @@',
    `+${ghp}`,
  );
  assert.deepEqual(scanPatch(text), [
    { file: 'a', line: 6, kind: 'aws' },
    { file: 'a', line: 21, kind: 'github' },
  ]);
});

test('scanPatch: combined diff after a merge conflict', () => {
  const text = patch(
    'diff --cc src/f.txt',
    'index a9d058a,94235ab..0000000',
    '--- a/src/f.txt',
    '+++ b/src/f.txt',
    '@@@ -1,5 -1,5 +1,7 @@@',
    '  a',
    `- B2 ${aws}`,
    ` -B1 ${aws}`,
    `++${ghp}`,
    '  c',
    ` +${slack}`,
    `+ ${anthropic}`,
    '  d',
    '\\ No newline at end of file',
    '@@@ -9,0 -9,0 +11,1 @@@',
    `++${openai}`,
    'diff --combined my dir/.env',
    '--- a/my dir/.env',
    '+++ b/my dir/.env',
    '@@@@ -1 -1 -1 +1 @@@@',
    `+++${aws}`,
    'diff --cc "q\\"x.txt"',
    '--- a/q"x.txt',
    '+++ b/q"x.txt',
    '@@@ -1 -1 +1 @@@',
    `++${ghs}`,
  );
  assert.deepEqual(parsePatch(text), {
    findings: [
      { file: 'src/f.txt', line: 2, kind: 'github' },
      { file: 'src/f.txt', line: 4, kind: 'slack' },
      { file: 'src/f.txt', line: 5, kind: 'anthropic' },
      { file: 'src/f.txt', line: 11, kind: 'openai' },
      { file: 'my dir/.env', line: 1, kind: 'aws' },
      { file: 'my dir/.env', line: 0, kind: 'envFile' },
      { file: 'q"x.txt', line: 1, kind: 'github' },
    ],
    unparsed: false,
  });
});

test('parsePatch: an unparseable hunk header is flagged, scanPatch keeps returning an array', () => {
  const text = patch('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', `+${aws}`, '@@ weird @@', `+${ghp}`);
  const r = parsePatch(text);
  assert.equal(r.unparsed, true);
  assert.ok(Array.isArray(scanPatch(text)));
  assert.equal(parsePatch(patch('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '+x')).unparsed, false);
  assert.equal(parsePatch(patch('diff --cc a', '--- a/a', '+++ b/a', '@@@ -1 +1 @@@', '++x')).unparsed, true); // three @ but one parent range
});

test('scanPatch: removed lines and context lines are never scanned', () => {
  const text = patch(
    'diff --git a/a b/a',
    '--- a/a',
    '+++ b/a',
    '@@ -1,2 +1 @@',
    `-${aws}`,
    ` ${ghp}`,
  );
  assert.deepEqual(scanPatch(text), []);
});

test('scanPatch: an added line that starts with ++ is content, not a header', () => {
  const text = patch('diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -0,0 +1,2 @@', '+++ x', `+++${aws}`);
  assert.deepEqual(scanPatch(text), [{ file: 'a', line: 2, kind: 'aws' }]);
});

test('scanPatch: a deleted file and +++ /dev/null give no findings', () => {
  const text = patch(
    'diff --git a/.env b/.env',
    'deleted file mode 100644',
    'index 111..000',
    '--- a/.env',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-KEY=${aws}`,
  );
  assert.deepEqual(scanPatch(text), []);
});

test('scanPatch: secret file names are findings with line 0, examples are not', () => {
  const text = patch(
    'diff --git a/.env b/.env',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+PLAIN=1',
    'diff --git a/cfg/.env.local b/cfg/.env.local',
    'new file mode 100644',
    'diff --git a/.env.example b/.env.example',
    '--- /dev/null',
    '+++ b/.env.example',
    '@@ -0,0 +1 @@',
    '+A=1',
  );
  assert.deepEqual(scanPatch(text), [
    { file: '.env', line: 0, kind: 'envFile' },
    { file: 'cfg/.env.local', line: 0, kind: 'envFile' },
  ]);
});

test('scanPatch: binary files and mode changes still report the env name', () => {
  const text = patch(
    'diff --git a/.env.prod b/.env.prod',
    'new file mode 100644',
    'index 0000000..abc',
    'Binary files /dev/null and b/.env.prod differ',
    'diff --git a/sub/.env b/sub/.env',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/gone/.env b/gone/.env',
    'deleted file mode 100644',
    'Binary files a/gone/.env and /dev/null differ',
  );
  assert.deepEqual(scanPatch(text), [
    { file: '.env.prod', line: 0, kind: 'envFile' },
    { file: 'sub/.env', line: 0, kind: 'envFile' },
  ]);
});

test('scanPatch: paths with spaces and C-quoted names', () => {
  const text = patch(
    'diff --git a/my dir/k.txt b/my dir/k.txt',
    '--- a/my dir/k.txt\t',
    '+++ b/my dir/k.txt\t',
    '@@ -0,0 +1 @@',
    `+${aws}`,
    'diff --git "a/q\\"x\\tz.txt" "b/q\\"x\\tz.txt"',
    '--- /dev/null',
    '+++ "b/q\\"x\\tz.txt"',
    '@@ -0,0 +1 @@',
    `+${ghp}`,
    'diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"',
    'new file mode 100644',
  );
  assert.deepEqual(scanPatch(text), [
    { file: 'my dir/k.txt', line: 1, kind: 'aws' },
    { file: 'q"x\tz.txt', line: 1, kind: 'github' },
    { file: 'café/.env', line: 0, kind: 'envFile' },
  ]);
});

test('scanPatch: renames report the destination', () => {
  const text = patch(
    'diff --git a/old.txt b/dir/new.txt',
    'similarity index 90%',
    'rename from old.txt',
    'rename to dir/new.txt',
    '--- a/old.txt',
    '+++ b/dir/new.txt',
    '@@ -1 +1 @@',
    `+${slack}`,
  );
  assert.deepEqual(scanPatch(text), [{ file: 'dir/new.txt', line: 1, kind: 'slack' }]);
});

test('scanPatch: empty input', () => {
  assert.deepEqual(scanPatch(''), []);
});

// ---- pendingFindings on real repositories ----

const stage = (dir, ...paths) => git(dir, 'add', '--', ...paths);
const summary = (r) => (r.findings ?? []).map((f) => `${f.file}:${f.line}:${f.kind}`).sort();

test('pendingFindings: a staged secret is found, with and without HEAD', () => {
  const dir = gitRepo();
  write(dir, 'src/a.txt', `one\nKEY=${aws}\n`);
  stage(dir, 'src/a.txt');
  assert.deepEqual(pendingFindings(dir), { findings: [{ file: 'src/a.txt', line: 2, kind: 'aws' }] });

  const fresh = tempDir();
  git(fresh, 'init', '-q', '-b', 'main');
  write(fresh, 'k.txt', `${ghp}\n`);
  stage(fresh, 'k.txt');
  assert.deepEqual(pendingFindings(fresh), { findings: [{ file: 'k.txt', line: 1, kind: 'github' }] });
});

test('pendingFindings: paths are relative to the repository root when run from a subdirectory', () => {
  const dir = gitRepo();
  write(dir, 'src/deep/a.txt', `${aws}\n`);
  write(dir, 'top.txt', `${aws}\n`);
  stage(dir, 'src/deep/a.txt');
  const sub = join(dir, 'src');
  assert.deepEqual(summary(pendingFindings(sub)), ['src/deep/a.txt:1:aws']);
  assert.deepEqual(summary(pendingFindings(sub, { untracked: true })), ['src/deep/a.txt:1:aws', 'top.txt:1:aws']);
});

test('pendingFindings: safe staged changes give no findings; a clean index too', () => {
  const dir = gitRepo();
  assert.deepEqual(pendingFindings(dir), { findings: [] });
  write(dir, 'a.txt', 'AKIAIOSFODNN7' + 'EXAMPLE\nsk-abc\n');
  write(dir, '.env.example', 'A=1\n');
  stage(dir, 'a.txt', '.env.example');
  assert.deepEqual(pendingFindings(dir), { findings: [] });
});

test('pendingFindings: a secret in a removed line is not a finding', () => {
  const dir = gitRepo();
  write(dir, 'a.txt', `${aws}\n`);
  stage(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', 'add');
  write(dir, 'a.txt', 'clean\n');
  stage(dir, 'a.txt');
  assert.deepEqual(pendingFindings(dir), { findings: [] });
});

test('pendingFindings: a staged .env is a finding, git rm --cached .env is not', () => {
  const dir = gitRepo();
  write(dir, '.env', 'A=1\n');
  git(dir, 'add', '-f', '.env');
  assert.deepEqual(pendingFindings(dir), { findings: [{ file: '.env', line: 0, kind: 'envFile' }] });
  git(dir, 'commit', '-q', '-m', 'oops');
  git(dir, 'rm', '-q', '--cached', '.env');
  assert.deepEqual(pendingFindings(dir), { findings: [] });
});

test('pendingFindings: unstaged changes of tracked files only with worktree', () => {
  const dir = gitRepo();
  write(dir, 'a.txt', 'clean\n');
  stage(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', 'add');
  write(dir, 'a.txt', `clean\n${ghp}\n`);
  assert.deepEqual(pendingFindings(dir), { findings: [] });
  assert.deepEqual(pendingFindings(dir, { worktree: true }), { findings: [{ file: 'a.txt', line: 2, kind: 'github' }] });
});

test('pendingFindings: staged and unstaged findings are merged without duplicates', () => {
  const dir = gitRepo();
  write(dir, 'a.txt', 'clean\n');
  stage(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', 'add');
  write(dir, 'a.txt', `clean\n${aws}\n`);
  stage(dir, 'a.txt');
  write(dir, 'a.txt', `clean\n${aws}\n${ghp}\n`);
  const r = pendingFindings(dir, { worktree: true });
  assert.deepEqual(summary(r), ['a.txt:2:aws', 'a.txt:3:github']);
});

test('pendingFindings: untracked files only with untracked', () => {
  const dir = gitRepo();
  write(dir, 'cfg/.env', 'A=1\n');
  write(dir, 'notes.txt', `x\n${anthropic}\n`);
  write(dir, '.env.example', 'A=1\n');
  assert.deepEqual(pendingFindings(dir, { worktree: true }), { findings: [] });
  assert.deepEqual(summary(pendingFindings(dir, { untracked: true })), ['cfg/.env:0:envFile', 'notes.txt:2:anthropic']);
});

test('pendingFindings: gitignored untracked files are not reported', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', '.env\nsecret.txt\n');
  write(dir, '.env', 'A=1\n');
  write(dir, 'secret.txt', `${aws}\n`);
  assert.deepEqual(pendingFindings(dir, { untracked: true }), { findings: [] });
});

test('pendingFindings: ignore globs silence names and content', () => {
  const dir = gitRepo();
  write(dir, 'fixtures/keys.txt', `${aws}\n`);
  write(dir, 'fixtures/.env', 'A=1\n');
  write(dir, 'src/a.txt', `${ghp}\n`);
  stage(dir, 'fixtures', 'src');
  const open = pendingFindings(dir);
  assert.deepEqual(summary(open), ['fixtures/.env:0:envFile', 'fixtures/keys.txt:1:aws', 'src/a.txt:1:github']);
  assert.deepEqual(summary(pendingFindings(dir, { ignore: ['fixtures/**'] })), ['src/a.txt:1:github']);
  assert.deepEqual(summary(pendingFindings(dir, { ignore: ['fixtures'] })), ['src/a.txt:1:github']);
  assert.deepEqual(summary(pendingFindings(dir, { ignore: ['.env', 'keys.txt', '*.txt'] })), []);

  write(dir, 'loose/.env', 'A=1\n');
  write(dir, 'loose/k.txt', `${aws}\n`);
  assert.deepEqual(
    summary(pendingFindings(dir, { untracked: true, ignore: ['fixtures', 'src', 'loose/**'] })),
    [],
  );
});

test('pendingFindings: not a repository', () => {
  const dir = tempDir();
  assert.deepEqual(pendingFindings(dir), { findings: [], notRepo: true });
  assert.deepEqual(pendingFindings(dir, { worktree: true, untracked: true }), { findings: [], notRepo: true });
});

test('pendingFindings: a binary untracked file is checked by name only', () => {
  const dir = gitRepo();
  writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${aws}\n`)]));
  writeFileSync(join(dir, '.env.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(`${aws}\n`)]));
  assert.deepEqual(summary(pendingFindings(dir, { untracked: true })), ['.env.bin:0:envFile']);
});

test('pendingFindings: an oversized untracked text file is tooLarge', () => {
  const dir = gitRepo();
  write(dir, 'big.txt', 'a'.repeat(300 * 1024));
  assert.deepEqual(pendingFindings(dir, { untracked: true }), { unchecked: 'tooLarge' });
  assert.deepEqual(pendingFindings(dir, { untracked: true, ignore: ['big.txt'] }), { findings: [] });
  assert.deepEqual(pendingFindings(dir), { findings: [] }); // not looked at without untracked
});

test('pendingFindings: a huge binary untracked file is not a problem', () => {
  const dir = gitRepo();
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(1024 * 1024));
  assert.deepEqual(pendingFindings(dir, { untracked: true }), { findings: [] });
});

test('pendingFindings: too many or too large in total untracked files is tooLarge', () => {
  const many = gitRepo();
  for (let i = 0; i < 201; i++) write(many, `f/${i}.txt`, 'x\n');
  assert.deepEqual(pendingFindings(many, { untracked: true }), { unchecked: 'tooLarge' });

  const heavy = gitRepo();
  for (let i = 0; i < 17; i++) write(heavy, `h/${i}.txt`, 'a'.repeat(250 * 1024));
  assert.deepEqual(pendingFindings(heavy, { untracked: true }), { unchecked: 'tooLarge' });
});

test('pendingFindings: a diff over the limit is tooLarge', () => {
  const dir = gitRepo();
  const line = 'a'.repeat(1000) + '\n';
  write(dir, 'huge.txt', line.repeat(4500));
  stage(dir, 'huge.txt');
  assert.deepEqual(pendingFindings(dir), { unchecked: 'tooLarge' });
});

test('pendingFindings: git failures are unchecked, not findings', () => {
  const dir = gitRepo();
  const failing = (over) => () => ({ status: 1, stdout: '', stderr: 'boom', ...over });
  assert.deepEqual(pendingFindings(dir, { git: failing() }), { unchecked: 'error' });
  assert.deepEqual(pendingFindings(dir, { git: failing({ status: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) }), { unchecked: 'error' });
  assert.deepEqual(pendingFindings(dir, { git: failing({ status: null, signal: 'SIGTERM' }) }), { unchecked: 'error' });
  assert.deepEqual(pendingFindings(dir, { git: failing({ status: null, error: Object.assign(new Error('b'), { code: 'ENOBUFS' }) }) }), { unchecked: 'tooLarge' });
  assert.deepEqual(pendingFindings(dir, { git: failing({ stderr: 'fatal: not a git repository (or any of the parent directories): .git' }) }), { findings: [], notRepo: true });
});

test('pendingFindings: git runs with a fixed command line and an injected runner is used', () => {
  const head = ['-c', 'core.quotepath=off', '-c', 'diff.relative=false', 'diff'];
  const tail = [
    '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--inter-hunk-context=0',
    '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=d', '--submodule=short',
  ];
  assert.deepEqual([...DIFF_ARGS], [...head, ...tail]);
  const calls = [];
  const runner = (args, cwd, timeoutMs) => {
    calls.push({ args, cwd, timeoutMs });
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(pendingFindings('/somewhere', { git: runner }), { findings: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [...head, '--cached', ...tail]);
  assert.equal(calls[0].cwd, '/somewhere');
  assert.ok(Number.isInteger(calls[0].timeoutMs) && calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 6000, String(calls[0].timeoutMs));
  calls.length = 0;
  pendingFindings('/somewhere', { worktree: true, git: runner });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [...head, ...tail]);
  // base without ignore needs no toplevel
  calls.length = 0;
  pendingFindings('/somewhere', { base: '/somewhere', git: runner });
  assert.equal(calls.length, 1);
});

test('pendingFindings: diff.relative=true does not hide staged files outside the subdirectory', () => {
  const dir = gitRepo();
  git(dir, 'config', 'diff.relative', 'true');
  write(dir, 'top.txt', `${aws}\n`);
  write(dir, 'sub/x.txt', 'x\n');
  stage(dir, 'top.txt', 'sub/x.txt');
  assert.deepEqual(pendingFindings(join(dir, 'sub')), { findings: [{ file: 'top.txt', line: 1, kind: 'aws' }] });
  git(dir, 'commit', '-q', '-m', 'c');
  write(dir, 'top.txt', `${aws}\n${ghp}\n`);
  assert.deepEqual(pendingFindings(join(dir, 'sub'), { worktree: true }), { findings: [{ file: 'top.txt', line: 2, kind: 'github' }] });
});

test('pendingFindings: diff.interHunkContext does not shift line numbers', () => {
  const dir = gitRepo();
  git(dir, 'config', 'diff.interHunkContext', '5');
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
  write(dir, 'a.txt', lines.join('\n') + '\n');
  stage(dir, 'a.txt');
  git(dir, 'commit', '-q', '-m', 'c');
  const changed = [...lines];
  changed[1] = 'changed';
  changed[4] = `KEY=${aws}`;
  write(dir, 'a.txt', changed.join('\n') + '\n');
  stage(dir, 'a.txt');
  assert.deepEqual(pendingFindings(dir), { findings: [{ file: 'a.txt', line: 5, kind: 'aws' }] });
});

test('pendingFindings: a merge conflict resolved with a secret is found (combined diff)', () => {
  const dir = gitRepo();
  write(dir, 'f.txt', 'a\nb\nc\nd\ne\n');
  stage(dir, 'f.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'f.txt', 'a\nB1\nc\nd\ne\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'f.txt', 'a\nB2\nc\nd\ne\n');
  git(dir, 'commit', '-q', '-am', 'main');
  const merge = spawnSync('git', ['merge', 'side'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(merge.status, 0, 'the merge must conflict');
  write(dir, 'f.txt', `a\nKEY=${aws}\nc\nd\n${ghp}\ne\n`);
  const expected = { findings: [{ file: 'f.txt', line: 2, kind: 'aws' }, { file: 'f.txt', line: 5, kind: 'github' }] };
  assert.deepEqual(pendingFindings(dir, { worktree: true }), expected);
  assert.deepEqual(pendingFindings(dir, { worktree: true, untracked: true }), expected);
});

test('pendingFindings: an unparseable diff is unchecked, not clean', () => {
  const runner = () => ({ status: 0, stdout: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ what @@\n+x\n', stderr: '' });
  assert.deepEqual(pendingFindings('/somewhere', { git: runner }), { unchecked: 'error' });
});

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('pendingFindings: one deadline for the whole call', () => {
  const seen = [];
  const slow = (args, cwd, timeoutMs) => {
    seen.push(timeoutMs);
    sleep(40);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(pendingFindings('/somewhere', { worktree: true, deadlineMs: 25, git: slow }), { unchecked: 'error' });
  assert.equal(seen.length, 1); // the second diff is not started once the budget is spent
  assert.ok(seen[0] > 0 && seen[0] <= 25, String(seen[0]));

  // each call gets what is left of the budget
  seen.length = 0;
  const steady = (args, cwd, timeoutMs) => {
    seen.push(timeoutMs);
    sleep(30);
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.deepEqual(pendingFindings('/somewhere', { worktree: true, deadlineMs: 5000, git: steady }), { findings: [] });
  assert.equal(seen.length, 2);
  assert.ok(seen[1] < seen[0] && seen[0] <= 5000, seen.join(','));

  const timedOut = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
  assert.deepEqual(pendingFindings('/somewhere', { deadlineMs: 5000, git: timedOut }), { unchecked: 'error' });
  assert.deepEqual(pendingFindings('/somewhere', { deadlineMs: 0, git: steady }), { unchecked: 'error' });
});

test('pendingFindings: forced paths bring in ignored files', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', 'secret.txt\nvault/\n');
  write(dir, 'secret.txt', `x\n${aws}\n`);
  write(dir, 'vault/a.txt', `${ghp}\n`);
  write(dir, 'vault/.env', 'A=1\n');
  write(dir, 'loose.txt', `${slack}\n`);
  assert.deepEqual(pendingFindings(dir, { worktree: true, untracked: true }), { findings: [{ file: 'loose.txt', line: 1, kind: 'slack' }] });
  assert.deepEqual(
    summary(pendingFindings(dir, { worktree: true, untracked: true, forced: [join(dir, 'secret.txt')] })),
    ['loose.txt:1:slack', 'secret.txt:2:aws'],
  );
  // without untracked: only the forced paths
  assert.deepEqual(summary(pendingFindings(dir, { worktree: true, forced: [join(dir, 'secret.txt')] })), ['secret.txt:2:aws']);
  // a forced directory lists the ignored files inside it
  assert.deepEqual(summary(pendingFindings(join(dir, 'vault'), { forced: [join(dir, 'vault')] })), ['vault/.env:0:envFile', 'vault/a.txt:1:github']);
  // a forced path that is also untracked is read once
  assert.deepEqual(summary(pendingFindings(dir, { untracked: true, forced: [join(dir, 'loose.txt')] })), ['loose.txt:1:slack']);
  // ignore still applies
  assert.deepEqual(pendingFindings(dir, { forced: [join(dir, 'secret.txt')], ignore: ['secret.txt'] }), { findings: [] });
  // a path outside the work tree makes git fail: unchecked
  assert.deepEqual(pendingFindings(dir, { forced: [tempDir()] }), { unchecked: 'error' });
});

test('pendingFindings: forced and untracked files share the limits', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', 'ign/\n');
  for (let i = 0; i < 150; i++) write(dir, `u/${i}.txt`, 'x\n');
  for (let i = 0; i < 60; i++) write(dir, `ign/${i}.txt`, 'x\n');
  assert.deepEqual(pendingFindings(dir, { untracked: true }), { findings: [] });
  assert.deepEqual(pendingFindings(dir, { untracked: true, forced: [join(dir, 'ign')] }), { unchecked: 'tooLarge' });
});

test('pendingFindings: ignore is relative to base when given', () => {
  const dir = gitRepo();
  write(dir, 'packages/app/fixtures/k.txt', `${aws}\n`);
  write(dir, 'fixtures/k.txt', `${ghp}\n`);
  stage(dir, 'packages', 'fixtures');
  const base = join(dir, 'packages', 'app');
  const opts = { ignore: ['fixtures/**'], base };
  assert.deepEqual(summary(pendingFindings(dir, opts)), ['fixtures/k.txt:1:github']);
  assert.deepEqual(summary(pendingFindings(base, opts)), ['fixtures/k.txt:1:github']);
  // anchored patterns are anchored at base; a file outside base is never ignored
  assert.deepEqual(summary(pendingFindings(dir, { ignore: ['/fixtures', '**/k.txt'], base })), ['fixtures/k.txt:1:github']);
  // without base: relative to the repository root, as before
  assert.deepEqual(summary(pendingFindings(dir, { ignore: ['fixtures/**'] })), ['packages/app/fixtures/k.txt:1:aws']);
  // untracked files too
  write(dir, 'packages/app/fixtures/u.txt', `${slack}\n`);
  write(dir, 'fixtures/u.txt', `${slack}\n`);
  assert.deepEqual(summary(pendingFindings(dir, { ...opts, untracked: true })), ['fixtures/k.txt:1:github', 'fixtures/u.txt:1:slack']);
  // a base spelled through a symlinked directory (macOS /var -> /private/var) still works
  if (dir.startsWith('/private/')) {
    assert.deepEqual(summary(pendingFindings(dir, { ignore: ['fixtures/**'], base: base.slice('/private'.length) })), ['fixtures/k.txt:1:github']);
  }
});

test('pendingFindings: an untracked symlink is skipped, not read', { skip: symlinkSkip() }, () => {
  const outside = tempDir();
  write(outside, 'target.txt', `${aws}\n`);
  const dir = gitRepo();
  symlinkSync(join(outside, 'target.txt'), join(dir, 'link.txt'));
  assert.deepEqual(pendingFindings(dir, { untracked: true }), { findings: [] });
});

test('pendingFindings: an untracked file that vanished is skipped', () => {
  const dir = gitRepo();
  write(dir, 'here.txt', `${aws}\n`);
  const runner = (args) => {
    if (args.includes('diff')) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('--show-toplevel')) return { status: 0, stdout: dir + '\n', stderr: '' };
    if (args.includes('ls-files')) return { status: 0, stdout: 'gone.txt\0here.txt\0', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.deepEqual(pendingFindings(dir, { untracked: true, git: runner }), { findings: [{ file: 'here.txt', line: 1, kind: 'aws' }] });
});

test('pendingFindings: a name mangled by UTF-8 decoding is unchecked, not skipped', () => {
  const dir = gitRepo();
  const runner = (args) => {
    if (args.includes('diff')) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('--show-toplevel')) return { status: 0, stdout: dir + '\n', stderr: '' };
    if (args.includes('ls-files')) return { status: 0, stdout: 'caf\uFFFD.txt\0', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.deepEqual(pendingFindings(dir, { untracked: true, git: runner }), { unchecked: 'error' });
});

test('pendingFindings: forcedAll lists every untracked file of the work tree, ignored ones included', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', '*.local.json\nvault/\n');
  stage(dir, '.gitignore');
  git(dir, 'commit', '-q', '-m', 'ignore');
  write(dir, 'creds.local.json', `${aws}\n`);
  write(dir, 'vault/a.txt', `${ghp}\n`);
  write(dir, 'sub/plain.txt', `${slack}\n`);
  const sub = join(dir, 'sub');
  assert.deepEqual(summary(pendingFindings(sub, { untracked: true })), ['sub/plain.txt:1:slack']);
  const all = ['creds.local.json:1:aws', 'sub/plain.txt:1:slack', 'vault/a.txt:1:github'];
  assert.deepEqual(summary(pendingFindings(sub, { forcedAll: true })), all);
  assert.deepEqual(summary(pendingFindings(sub, { untracked: true, forced: [join(dir, 'vault')], forcedAll: true })), all);
  // ls-files from the root, no pathspec, no --exclude-standard
  const calls = [];
  const spy = (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('--show-toplevel')) return { status: 0, stdout: dir + '\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  pendingFindings(sub, { untracked: true, forced: [join(dir, 'vault')], forcedAll: true, git: spy });
  const ls = calls.filter((c) => c.args.includes('ls-files'));
  assert.equal(ls.length, 1);
  assert.equal(ls[0].cwd, dir);
  assert.deepEqual(ls[0].args, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--others', '--full-name']);
  // a tree full of ignored files is over the limit
  for (let i = 0; i < 201; i++) write(dir, `vault/m${i}.txt`, 'x\n');
  assert.deepEqual(pendingFindings(sub, { forcedAll: true }), { unchecked: 'tooLarge' });
});
