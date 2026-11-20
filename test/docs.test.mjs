import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DOCS_WATCH, checkDocs, findAgentFiles, fixDocs, hasImport, isShim, rootDocStatus,
} from '../lib/docs.mjs';
import { DEFAULT_DOCS_MAX_LINES, defaultProfile, loadProfile, validateProfile } from '../lib/profile.mjs';
import { matchList } from '../lib/glob.mjs';
import { git, gitRepo, tempDir, write, writeProfile } from './helpers.mjs';

const LINK = '@AGENTS.md\n';
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
const codes = (issues) => issues.map((i) => i.code);
const find = (issues, code, path) => issues.find((i) => i.code === code && (path === undefined || i.path === path));

test('hasImport / isShim', () => {
  assert.equal(hasImport('@AGENTS.md\n'), true);
  assert.equal(hasImport('# Title\n\n  @AGENTS.md  \n\nmore'), true);
  assert.equal(hasImport('```\n@AGENTS.md\n```\n'), false);
  assert.equal(hasImport('~~~md\n@AGENTS.md\n~~~\n'), false);
  assert.equal(hasImport('```\ncode\n```\n@AGENTS.md\n'), true);
  assert.equal(hasImport('see @AGENTS.md here\n'), false);
  assert.equal(hasImport(''), false);
  assert.equal(isShim('@AGENTS.md\n'), true);
  assert.equal(isShim('@AGENTS.md'), true);
  assert.equal(isShim('@AGENTS.md\n\n'), false);
  assert.equal(isShim('# x\n@AGENTS.md\n'), false);
  assert.equal(isShim('  @AGENTS.md\n'), false);
});

test('missing-root: nothing at all, and root CLAUDE.md with content', () => {
  const empty = tempDir();
  const issue = find(checkDocs(empty, defaultProfile()), 'missing-root');
  assert.equal(issue.level, 'error');
  assert.equal(issue.fixable, false);
  assert.equal(issue.path, 'AGENTS.md');
  assert.doesNotMatch(issue.message, /перенеси/);

  const dir = tempDir();
  write(dir, 'CLAUDE.md', '# Rules\nDo things.\n');
  const moved = find(checkDocs(dir, defaultProfile()), 'missing-root');
  assert.match(moved.message, /перенеси/);
  assert.match(moved.message, /AGENTS\.md/);

  // a bare shim without AGENTS.md is "no AGENTS.md" too
  const shim = tempDir();
  write(shim, 'CLAUDE.md', LINK);
  const shimIssue = find(checkDocs(shim, defaultProfile()), 'missing-root');
  assert.doesNotMatch(shimIssue.message, /перенеси/);
  // the link plus blank lines is not content either
  write(shim, 'CLAUDE.md', '@AGENTS.md\n\n\n');
  assert.doesNotMatch(find(checkDocs(shim, defaultProfile()), 'missing-root').message, /перенеси/);

  const ok = tempDir();
  write(ok, 'AGENTS.md', '# x\n');
  write(ok, 'CLAUDE.md', LINK);
  assert.deepEqual(checkDocs(ok, defaultProfile()), []);
});

test('missing-shim for root and nested; fixDocs writes exactly the link', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', '# root\n| Area | File |\n|---|---|\n| backend | backend/AGENTS.md |\n');
  write(dir, 'backend/AGENTS.md', '# backend\n');
  const issues = checkDocs(dir, defaultProfile());
  const root = find(issues, 'missing-shim', 'CLAUDE.md');
  const nested = find(issues, 'missing-shim', 'backend/CLAUDE.md');
  assert.ok(root && nested);
  assert.equal(root.level, 'error');
  assert.equal(root.fixable, true);

  const created = fixDocs(dir, issues).written;
  assert.deepEqual(created.sort(), ['CLAUDE.md', 'backend/CLAUDE.md']);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), LINK);
  assert.equal(readFileSync(join(dir, 'backend/CLAUDE.md'), 'utf8'), LINK);
  assert.equal(codes(checkDocs(dir, defaultProfile())).includes('missing-shim'), false);
  assert.deepEqual(checkDocs(dir, defaultProfile()), []);
});

test('fixDocs ignores non-fixable issues and never overwrites content', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  write(dir, 'CLAUDE.md', 'my precious text\n');
  const issues = checkDocs(dir, defaultProfile());
  assert.deepEqual(fixDocs(dir, issues), { written: [], skipped: [] });
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'my precious text\n');

  // a stale fixable issue must not clobber a file that gained content meanwhile — and says why it skipped
  const stale = [{ code: 'no-import', level: 'error', path: 'CLAUDE.md', message: '', fixable: true }];
  const r1 = fixDocs(dir, stale);
  assert.deepEqual(r1.written, []);
  assert.equal(r1.skipped.length, 1);
  assert.equal(r1.skipped[0].path, 'CLAUDE.md');
  assert.match(r1.skipped[0].reason, /не пуст/);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'my precious text\n');
  // and a fixable missing-shim must not clobber an existing file
  const stale2 = [{ code: 'missing-shim', level: 'error', path: 'CLAUDE.md', message: '', fixable: true }];
  const r2 = fixDocs(dir, stale2);
  assert.deepEqual(r2.written, []);
  assert.match(r2.skipped[0].reason, /уже существует/);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'my precious text\n');
});

test('no-import: text without import is an unfixable error, empty file is fixable', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  write(dir, 'CLAUDE.md', '# Claude only rules\n');
  let issue = find(checkDocs(dir, defaultProfile()), 'no-import');
  assert.equal(issue.level, 'error');
  assert.equal(issue.fixable, false);
  assert.equal(issue.path, 'CLAUDE.md');

  write(dir, 'CLAUDE.md', '');
  const issues = checkDocs(dir, defaultProfile());
  issue = find(issues, 'no-import');
  assert.equal(issue.fixable, true);
  assert.deepEqual(fixDocs(dir, issues), { written: ['CLAUDE.md'], skipped: [] });
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), LINK);
  assert.deepEqual(checkDocs(dir, defaultProfile()), []);
});

test('no-import: import inside a code fence does not count, padded import does', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  write(dir, 'CLAUDE.md', '# Notes\n```\n@AGENTS.md\n```\n');
  assert.ok(find(checkDocs(dir, defaultProfile()), 'no-import'));
  write(dir, 'CLAUDE.md', '# Notes\n\n  @AGENTS.md  \n');
  assert.equal(find(checkDocs(dir, defaultProfile()), 'no-import'), undefined);
});

test('claude-only: nested CLAUDE.md with content and no AGENTS.md', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\nsub/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'sub/CLAUDE.md', 'rules here\n');
  const issue = find(checkDocs(dir, defaultProfile()), 'claude-only');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.path, 'sub/CLAUDE.md');
  assert.equal(issue.fixable, false);

  write(dir, 'sub/CLAUDE.md', '');
  assert.equal(find(checkDocs(dir, defaultProfile()), 'claude-only'), undefined);
  // the root CLAUDE.md-only case is missing-root, not claude-only
  const rootOnly = tempDir();
  write(rootOnly, 'CLAUDE.md', 'rules\n');
  assert.equal(find(checkDocs(rootOnly, defaultProfile()), 'claude-only'), undefined);
});

test('fat-claude: more than 30 non-empty lines besides the import', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  write(dir, 'CLAUDE.md', `@AGENTS.md\n\n${lines(30)}\n\n`);
  assert.equal(find(checkDocs(dir, defaultProfile()), 'fat-claude'), undefined);
  write(dir, 'CLAUDE.md', `@AGENTS.md\n\n${lines(31)}`);
  const issue = find(checkDocs(dir, defaultProfile()), 'fat-claude');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.path, 'CLAUDE.md');
  assert.equal(issue.fixable, false);
});

test('too-long: agent file longer than docs.max_lines', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', lines(200));
  write(dir, 'CLAUDE.md', LINK);
  assert.equal(find(checkDocs(dir, defaultProfile()), 'too-long'), undefined);
  write(dir, 'AGENTS.md', lines(201));
  const issue = find(checkDocs(dir, defaultProfile()), 'too-long');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.path, 'AGENTS.md');

  const small = defaultProfile();
  small.docs.max_lines = 250;
  assert.equal(find(checkDocs(dir, small), 'too-long'), undefined);
  small.docs.max_lines = 100;
  write(dir, 'AGENTS.md', lines(101));
  assert.ok(find(checkDocs(dir, small), 'too-long'));
});

test('too-long measures CLAUDE.md only when it is the directory agent file', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\nsub/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'sub/CLAUDE.md', lines(201));
  const issues = checkDocs(dir, defaultProfile());
  assert.ok(find(issues, 'too-long', 'sub/CLAUDE.md'));
});

test('unlisted: nested AGENTS.md must be mentioned by its path, not just a parent dir', () => {
  const dir = tempDir();
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'a/b/AGENTS.md', '# b\n');
  write(dir, 'a/b/CLAUDE.md', LINK);

  write(dir, 'AGENTS.md', '# root\nsee a/ for things\n');
  let issue = find(checkDocs(dir, defaultProfile()), 'unlisted');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.path, 'a/b/AGENTS.md');
  assert.equal(issue.fixable, false);

  for (const text of ['see a/b/ here\n', 'see a/b/AGENTS.md here\n', 'see `a/b` here\n', '| x | [b](./a/b/AGENTS.md) |\n']) {
    write(dir, 'AGENTS.md', `# root\n${text}`);
    assert.equal(find(checkDocs(dir, defaultProfile()), 'unlisted'), undefined, text);
  }
  // not a suffix of a longer path
  write(dir, 'AGENTS.md', '# root\nsee x/a/b/ here\n');
  assert.ok(find(checkDocs(dir, defaultProfile()), 'unlisted'));
});

test('unlisted: mention may be relative to the nearest ancestor agent file', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\na/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'a/AGENTS.md', '# a\nb/\n');
  write(dir, 'a/CLAUDE.md', LINK);
  write(dir, 'a/b/AGENTS.md', '# b\n');
  write(dir, 'a/b/CLAUDE.md', LINK);
  const issues = checkDocs(dir, defaultProfile());
  assert.equal(find(issues, 'unlisted'), undefined);

  write(dir, 'a/AGENTS.md', '# a\nnothing\n');
  assert.ok(find(checkDocs(dir, defaultProfile()), 'unlisted', 'a/b/AGENTS.md'));
});

test('broken-link: relative markdown links to missing paths', () => {
  const dir = tempDir();
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'docs/guide.md', '# g\n');
  write(dir, 'AGENTS.md', [
    '# root',
    '[ok](docs/guide.md) [ok2](docs/guide.md#section) [dir](docs/) [web](https://example.com/x)',
    '[anchor](#top) [mail](mailto:a@b.c) [titled](docs/guide.md "Guide")',
    '`[inline](nope-inline.md)`',
    '```',
    '[fenced](nope-fenced.md)',
    '```',
    '[bad](docs/missing.md) [bad2](./gone/readme.md#x)',
    '',
  ].join('\n'));
  const broken = checkDocs(dir, defaultProfile()).filter((i) => i.code === 'broken-link');
  assert.equal(broken.length, 2);
  assert.ok(broken.every((i) => i.level === 'warn' && i.path === 'AGENTS.md' && i.fixable === false));
  assert.ok(broken.some((i) => i.message.includes('docs/missing.md')));
  assert.ok(broken.some((i) => i.message.includes('gone/readme.md')));
});

test('broken-link: nested links resolve from the file directory', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\nsub/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'sub/AGENTS.md', '[up](../README.md) [here](notes.md) [rootrel](/README.md)\n');
  write(dir, 'sub/CLAUDE.md', LINK);
  write(dir, 'README.md', '# r\n');
  write(dir, 'sub/notes.md', '# n\n');
  assert.equal(find(checkDocs(dir, defaultProfile()), 'broken-link'), undefined);
  write(dir, 'sub/AGENTS.md', '[up](../MISSING.md)\n');
  assert.ok(find(checkDocs(dir, defaultProfile()), 'broken-link', 'sub/AGENTS.md'));
});

function profileWithVerify(commands) {
  const profile = defaultProfile();
  profile.commands = commands;
  profile.verify.steps = Object.keys(commands);
  return profile;
}

test('verify-undocumented: command keys derived from verify steps', () => {
  const dir = tempDir();
  write(dir, 'CLAUDE.md', LINK);
  const profile = profileWithVerify({
    test_fast: 'npm test -- {files}',
    lint: { run: 'pytest -q', ext: ['.py'] },
    swift: 'swift test --parallel',
  });

  write(dir, 'AGENTS.md', '# x\nRun `npm test` and `swift test`.\n');
  const issues = checkDocs(dir, profile).filter((i) => i.code === 'verify-undocumented');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warn');
  assert.equal(issues[0].fixable, false);
  assert.match(issues[0].message, /pytest/);
  assert.doesNotMatch(issues[0].message, /pytest -q/);

  write(dir, 'AGENTS.md', '# x\nRun `npm test`, `swift test` and pytest.\n');
  assert.equal(find(checkDocs(dir, profile), 'verify-undocumented'), undefined);

  // "npm test -- {files}" documents as "npm test", not "npm test --"
  write(dir, 'AGENTS.md', '# x\nnpm test only.\n');
  const only = checkDocs(dir, profileWithVerify({ test_fast: 'npm test -- {files}' }));
  assert.equal(find(only, 'verify-undocumented'), undefined);
});

test('verify-undocumented: any agent file counts, and no agent files means no noise', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\nsub/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'sub/AGENTS.md', 'use go test\n');
  write(dir, 'sub/CLAUDE.md', LINK);
  assert.equal(find(checkDocs(dir, profileWithVerify({ t: 'go test ./...' })), 'verify-undocumented'), undefined);

  const bare = tempDir();
  assert.equal(find(checkDocs(bare, profileWithVerify({ t: 'go test ./...' })), 'verify-undocumented'), undefined);
});

test('claude-only dirs count as agent files for verify-undocumented', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# root\nsub/\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'sub/CLAUDE.md', 'cargo test here\n');
  assert.equal(find(checkDocs(dir, profileWithVerify({ t: 'cargo test' })), 'verify-undocumented'), undefined);
});

test('findAgentFiles in git: tracked and untracked, honours .gitignore, sorted', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', 'ignored/\n');
  write(dir, 'z/AGENTS.md', 'z');
  write(dir, 'AGENTS.md', 'r');
  write(dir, 'a/CLAUDE.md', 'a');
  write(dir, 'ignored/AGENTS.md', 'no');
  write(dir, 'a/other.md', 'no');
  assert.deepEqual(findAgentFiles(dir), { files: ['AGENTS.md', 'a/CLAUDE.md', 'z/AGENTS.md'], complete: true });
});

test('findAgentFiles in git: files under .forge/ are skipped even when not ignored', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', 'r');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, '.forge/work/x/AGENTS.md', 'backup');
  write(dir, '.forge/work/x/CLAUDE.md', '# backup\nold text\n');
  write(dir, 'pkg/.forge/work/y/AGENTS.md', 'nested backup');
  assert.deepEqual(findAgentFiles(dir).files, ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(checkDocs(dir, defaultProfile()), []);
});

test('findAgentFiles in git: files deleted from the worktree are not reported', () => {
  const dir = gitRepo();
  write(dir, 'AGENTS.md', 'r');
  write(dir, 'gone/AGENTS.md', 'g');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'x');
  rmSync(join(dir, 'gone'), { recursive: true });
  assert.deepEqual(findAgentFiles(dir).files, ['AGENTS.md']);
});

test('findAgentFiles without git: skip list, hidden dirs, depth, sorted', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', 'r');
  write(dir, 'b/CLAUDE.md', 'b');
  write(dir, 'a/AGENTS.md', 'a');
  for (const skipped of ['node_modules', 'vendor', 'dist', 'build', 'target', 'bin', 'obj', '.venv', 'venv',
    '__pycache__', 'Pods', 'DerivedData', '.git', '.forge', '.hidden']) {
    write(dir, `${skipped}/AGENTS.md`, 'x');
    write(dir, `x/${skipped}/CLAUDE.md`, 'x');
  }
  write(dir, 'a/b/c/d/e/f/AGENTS.md', 'depth 6');
  write(dir, 'a/b/c/d/e/f/g/AGENTS.md', 'depth 7');
  const result = findAgentFiles(dir);
  assert.equal(result.complete, true);
  assert.deepEqual(result.files, ['AGENTS.md', 'a/AGENTS.md', 'a/b/c/d/e/f/AGENTS.md', 'b/CLAUDE.md']);
});

test('findAgentFiles without git: entry limit marks the scan incomplete', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', 'r');
  for (let i = 0; i < 30; i++) write(dir, `d${i}/file.txt`, 'x');
  const limited = findAgentFiles(dir, 10);
  assert.equal(limited.complete, false);
  assert.equal(findAgentFiles(dir).complete, true);
});

test('checkDocs reports incomplete-scan as a warning', () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  write(dir, 'CLAUDE.md', LINK);
  for (let i = 0; i < 30; i++) write(dir, `d${i}/file.txt`, 'x');
  assert.equal(find(checkDocs(dir, defaultProfile()), 'incomplete-scan'), undefined);
  const issue = find(checkDocs(dir, defaultProfile(), { limit: 10 }), 'incomplete-scan');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.fixable, false);
});

test('rootDocStatus', () => {
  const dir = tempDir();
  assert.equal(rootDocStatus(dir), 'missing');
  write(dir, 'CLAUDE.md', 'rules\n');
  assert.equal(rootDocStatus(dir), 'missing');
  write(dir, 'CLAUDE.md', LINK); // link without AGENTS.md
  assert.equal(rootDocStatus(dir), 'missing');
  write(dir, 'AGENTS.md', '# x\n');
  assert.equal(rootDocStatus(dir), 'ok');
  write(dir, 'CLAUDE.md', 'rules without import\n');
  assert.equal(rootDocStatus(dir), 'no-import');
  write(dir, 'CLAUDE.md', '```\n@AGENTS.md\n```\n');
  assert.equal(rootDocStatus(dir), 'no-import');
  write(dir, 'CLAUDE.md', '# c\n@AGENTS.md\n');
  assert.equal(rootDocStatus(dir), 'ok');
  // only AGENTS.md: fixable by --fix, not a session-start concern
  const agentsOnly = tempDir();
  write(agentsOnly, 'AGENTS.md', '# x\n');
  assert.equal(rootDocStatus(agentsOnly), 'ok');
});

test('profile: docs defaults', () => {
  const profile = defaultProfile();
  assert.equal(DEFAULT_DOCS_MAX_LINES, 200);
  assert.deepEqual(profile.docs, { remind: true, max_lines: DEFAULT_DOCS_MAX_LINES, watch: [...DEFAULT_DOCS_WATCH] });
  assert.deepEqual(DEFAULT_DOCS_WATCH, [
    'package.json', 'pyproject.toml', 'Cargo.toml', '*.sln', 'Makefile', 'justfile', 'Taskfile.yml',
    'docker-compose*.yml', 'compose*.yml', '.github/workflows/**', '.gitlab-ci.yml',
  ]);
  const dir = tempDir();
  assert.deepEqual(loadProfile(dir).profile.docs, profile.docs);
  writeProfile(dir, {});
  const loaded = loadProfile(dir);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.profile.docs, profile.docs);
});

test('profile: docs.watch is appended to the built-in list and ! removes a built-in', () => {
  const dir = tempDir();
  writeProfile(dir, { docs: { remind: false, max_lines: 120, watch: ['tools/*.sh', '!Makefile'] } });
  const { profile, errors } = loadProfile(dir);
  assert.deepEqual(errors, []);
  assert.equal(profile.docs.remind, false);
  assert.equal(profile.docs.max_lines, 120);
  assert.deepEqual(profile.docs.watch, [...DEFAULT_DOCS_WATCH, 'tools/*.sh', '!Makefile']);
  assert.ok(matchList('tools/build.sh', profile.docs.watch));
  assert.ok(matchList('package.json', profile.docs.watch));
  assert.ok(matchList('sub/package.json', profile.docs.watch));
  assert.ok(matchList('.github/workflows/test.yml', profile.docs.watch));
  assert.equal(matchList('Makefile', profile.docs.watch), null);
  assert.equal(matchList('README.md', profile.docs.watch), null);
});

test('profile: invalid docs values report errors and fall back to defaults', () => {
  assert.ok(validateProfile({ docs: 'yes' }).some((e) => e.startsWith('docs')));
  assert.ok(validateProfile({ docs: { remind: 'yes' } }).some((e) => e.startsWith('docs.remind')));
  assert.ok(validateProfile({ docs: { max_lines: 0 } }).some((e) => e.startsWith('docs.max_lines')));
  assert.ok(validateProfile({ docs: { max_lines: 1.5 } }).some((e) => e.startsWith('docs.max_lines')));
  assert.ok(validateProfile({ docs: { max_lines: '200' } }).some((e) => e.startsWith('docs.max_lines')));
  assert.ok(validateProfile({ docs: { watch: 'Makefile' } }).some((e) => e.startsWith('docs.watch')));
  assert.ok(validateProfile({ docs: { watch: [1] } }).some((e) => e.startsWith('docs.watch')));
  assert.deepEqual(validateProfile({ docs: { remind: true, max_lines: 50, watch: ['x'] } }), []);

  const dir = tempDir();
  writeProfile(dir, { docs: { remind: 'no', max_lines: -3, watch: 'Makefile' } });
  const { profile, errors } = loadProfile(dir);
  assert.equal(errors.length, 3);
  assert.deepEqual(profile.docs, defaultProfile().docs);

  writeProfile(dir, { docs: 5 });
  const bad = loadProfile(dir);
  assert.equal(bad.errors.length, 1);
  assert.deepEqual(bad.profile.docs, defaultProfile().docs);

  // a valid field survives its invalid sibling
  writeProfile(dir, { docs: { remind: false, max_lines: 'x' } });
  const mixed = loadProfile(dir);
  assert.equal(mixed.profile.docs.remind, false);
  assert.equal(mixed.profile.docs.max_lines, 200);
});

const unix = process.platform !== 'win32';
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

for (const useGit of [true, false]) {
  test(`symlinked CLAUDE.md -> AGENTS.md is a valid link (${useGit ? 'git' : 'no git'})`, { skip: !unix }, () => {
    const dir = useGit ? gitRepo() : tempDir();
    write(dir, 'AGENTS.md', '# root\n`sub/` — area\n');
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    write(dir, 'sub/AGENTS.md', '# sub\n');
    symlinkSync('AGENTS.md', join(dir, 'sub/CLAUDE.md'));
    // a symlinked directory is never followed
    symlinkSync(join(dir, 'sub'), join(dir, 'loop'), 'dir');
    const { files } = findAgentFiles(dir);
    assert.ok(files.includes('CLAUDE.md') && files.includes('sub/CLAUDE.md'), files.join(','));
    assert.ok(!files.some((f) => f.startsWith('loop/')), files.join(','));
    assert.deepEqual(checkDocs(dir, defaultProfile()), []);
    assert.equal(rootDocStatus(dir), 'ok');
    // a symlink to some other file is read as that file
    write(dir, 'other.md', '# not an import\n');
    rmSync(join(dir, 'CLAUDE.md'));
    symlinkSync('other.md', join(dir, 'CLAUDE.md'));
    assert.ok(find(checkDocs(dir, defaultProfile()), 'no-import', 'CLAUDE.md'));
    assert.equal(rootDocStatus(dir), 'no-import');
  });
}

test('ignored but present siblings count: no permanent missing-shim', () => {
  const dir = gitRepo();
  write(dir, '.gitignore', 'CLAUDE.md\nbackend/CLAUDE.md\n');
  write(dir, 'AGENTS.md', '# root\n`backend/` — api\n');
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'backend/AGENTS.md', '# backend\n');
  write(dir, 'backend/CLAUDE.md', '# backend notes without the import\n');
  const issues = checkDocs(dir, defaultProfile());
  assert.equal(find(issues, 'missing-shim'), undefined, JSON.stringify(issues));
  assert.ok(find(issues, 'no-import', 'backend/CLAUDE.md'), 'the ignored file is read and checked');

  // an ignored root AGENTS.md is still the root AGENTS.md
  const root = gitRepo();
  write(root, '.gitignore', 'AGENTS.md\n');
  write(root, 'AGENTS.md', '# root\n');
  write(root, 'CLAUDE.md', LINK);
  assert.deepEqual(checkDocs(root, defaultProfile()), []);
});

test('fixDocs: unreadable CLAUDE.md is never treated as empty', { skip: !unix || asRoot }, () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  const file = write(dir, 'CLAUDE.md', 'secret text\n');
  chmodSync(file, 0o200);
  try {
    const issue = find(checkDocs(dir, defaultProfile()), 'no-import', 'CLAUDE.md');
    assert.ok(issue);
    assert.equal(issue.fixable, false);
    assert.match(issue.message, /прочитать/);
    const forced = [{ ...issue, fixable: true }];
    const r = fixDocs(dir, forced);
    assert.deepEqual(r.written, []);
    assert.match(r.skipped[0].reason, /не удалось прочитать CLAUDE\.md/);
  } finally {
    chmodSync(file, 0o600);
  }
  assert.equal(readFileSync(file, 'utf8'), 'secret text\n');
});

test('fixDocs: an unwritable empty CLAUDE.md is reported, not thrown', { skip: !unix || asRoot }, () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  const file = write(dir, 'CLAUDE.md', '');
  chmodSync(file, 0o400);
  try {
    const issues = checkDocs(dir, defaultProfile());
    assert.equal(find(issues, 'no-import').fixable, true);
    const r = fixDocs(dir, issues);
    assert.deepEqual(r.written, []);
    assert.match(r.skipped[0].reason, /не удалось записать CLAUDE\.md/);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('fixDocs: a dangling CLAUDE.md symlink is skipped with a reason', { skip: !unix }, () => {
  const dir = tempDir();
  write(dir, 'AGENTS.md', '# x\n');
  symlinkSync('nowhere.md', join(dir, 'CLAUDE.md'));
  const issues = checkDocs(dir, defaultProfile());
  assert.ok(find(issues, 'missing-shim', 'CLAUDE.md'));
  const r = fixDocs(dir, issues);
  assert.deepEqual(r.written, []);
  assert.match(r.skipped[0].reason, /уже существует/);
});

test('verify-undocumented: env assignments, cd prefixes and "run <script>" in command keys', () => {
  const dir = tempDir();
  write(dir, 'CLAUDE.md', LINK);
  const profile = profileWithVerify({
    a: 'CI=1 FOO=bar npm test',
    b: 'cd web && npm run lint -- {files}',
    c: 'cd api && CI=1 pytest -q',
    d: 'yarn run build:ci',
    e: 'bun run --silent check',
  });
  write(dir, 'AGENTS.md', '# x\n');
  const messages = checkDocs(dir, profile).filter((i) => i.code === 'verify-undocumented').map((i) => i.message);
  for (const key of ['"npm test"', '"npm run lint"', '"pytest"', '"yarn run build:ci"', '"bun run"']) {
    assert.ok(messages.some((m) => m.includes(key)), `${key} in ${messages.join(' | ')}`);
  }
  assert.ok(!messages.some((m) => /CI=1|"cd /.test(m)), messages.join(' | '));

  write(dir, 'AGENTS.md', '# x\n`npm test`, `npm run lint`, `pytest`, `yarn run build:ci`, `bun run check`\n');
  assert.equal(find(checkDocs(dir, profile), 'verify-undocumented'), undefined);
});

test('broken-link: targets with balanced parentheses', () => {
  const dir = tempDir();
  write(dir, 'CLAUDE.md', LINK);
  write(dir, 'docs/foo(bar).md', '# f\n');
  write(dir, 'AGENTS.md', '# root\n[ok](docs/foo(bar).md) [bad](docs/baz(qux).md) (see [t](docs/foo(bar).md "T"))\n');
  const broken = checkDocs(dir, defaultProfile()).filter((i) => i.code === 'broken-link');
  assert.equal(broken.length, 1, JSON.stringify(broken));
  assert.match(broken[0].message, /docs\/baz\(qux\)\.md$/);
});

test('CRLF and BOM agent files', () => {
  assert.equal(isShim('@AGENTS.md\r\n'), true);
  const dir = tempDir();
  write(dir, 'AGENTS.md', '﻿# root\r\n`sub/` — area\r\n');
  write(dir, 'CLAUDE.md', '﻿@AGENTS.md\r\n');
  write(dir, 'sub/AGENTS.md', '﻿# sub\r\n');
  write(dir, 'sub/CLAUDE.md', '# Claude notes\r\n\r\n@AGENTS.md\r\n');
  assert.deepEqual(checkDocs(dir, defaultProfile()), []);
  assert.equal(rootDocStatus(dir), 'ok');
  write(dir, 'AGENTS.md', `﻿${lines(DEFAULT_DOCS_MAX_LINES).replace(/\n/g, '\r\n')}\`sub/\`\r\n`);
  const long = find(checkDocs(dir, defaultProfile()), 'too-long', 'AGENTS.md');
  assert.ok(long);
  assert.match(long.message, new RegExp(`${DEFAULT_DOCS_MAX_LINES + 1} строк`));
});
