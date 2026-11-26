import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { matchList } from './glob.mjs';

// Secret scanner for `git commit`: known token shapes in added lines and .env files.
// Pure parts (isSecretFile, scanText, parsePatch, scanPatch) have no I/O; pendingFindings runs short git calls.
// No user-facing strings here: the guard localizes kind names and builds the messages.

export const SECRET_KINDS = ['aws', 'github', 'anthropic', 'openai', 'slack', 'privateKey', 'envFile'];

const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const GIT_TIMEOUT_MS = 3000; // default runner timeout when called without one
const DEADLINE_MS = 6000; // budget of one pendingFindings call, well inside the 10 s hook timeout
// minified files: longer lines are scanned in overlapping windows, so every regex runs on bounded input
const MAX_LINE_LENGTH = 64 * 1024;
const WINDOW_OVERLAP = 512;

// templates committed on purpose: .env.example, .env.local.example, .env.dist, ...
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/;

/** `.env` and `.env.*` at any depth (both separators), case-insensitive, except templates (`.example`, `.sample`, `.template`, `.dist`). */
export function isSecretFile(path) {
  const base = String(path).split(/[\\/]/).pop().toLowerCase();
  if (ENV_TEMPLATE.test(base)) return false;
  return base === '.env' || (base.startsWith('.env.') && base.length > 5);
}

// All regexes are linear: bounded alternations, no nested quantifiers over overlapping classes.
const AWS = /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g;
const GITHUB = /(?<![A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g;
const GITHUB_PAT = /github_pat_[A-Za-z0-9_]{30,}/g;
const ANTHROPIC = /sk-ant-[A-Za-z0-9_-]{20,}/g;
// plain sk-: one alphanumeric run up to a token boundary; project, service account, admin and legacy
// user (sk-None-) keys may contain '-' and '_' (checked further by isOpenAiValue). sk-ant- never matches:
// 'ant' is followed by '-'.
const OPENAI = /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,}(?![A-Za-z0-9_-]))/g;
const OPENAI_PREFIXED = /^sk-(?:proj|svcacct|admin|None)-/;
const LONG_RUN = /[A-Za-z0-9_]{20}/;
const SLACK = /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PLACEHOLDER = /example|x{6,}|your|placeholder|dummy|fake/i;

/**
 * Whether some match of `re` in `line` is a real value (not a placeholder, passes `accept`). Matches that
 * start before `from` are skipped: at a window start the lookbehind cannot see the preceding character.
 */
function hasToken(line, re, accept, from = 0) {
  for (const m of line.matchAll(re)) {
    if (m.index < from) continue;
    const value = m[0];
    if (PLACEHOLDER.test(value)) continue;
    if (accept && !accept(value)) continue;
    return true;
  }
  return false;
}

const isOpenAiValue = (value) => {
  const prefix = OPENAI_PREFIXED.exec(value);
  const body = prefix ? value.slice(prefix[0].length) : value.slice(3);
  if (prefix && !LONG_RUN.test(body)) return false; // kebab-case words, not a key
  return /[A-Za-z]/.test(body) && /[0-9]/.test(body);
};

/** Kinds found in one window of a line; matches starting before `from` are skipped. */
function windowKinds(line, from, kinds) {
  if (hasToken(line, AWS, null, from)) kinds.add('aws');
  if (hasToken(line, GITHUB, null, from) || hasToken(line, GITHUB_PAT, null, from)) kinds.add('github');
  if (hasToken(line, ANTHROPIC, null, from)) kinds.add('anthropic');
  if (hasToken(line, OPENAI, isOpenAiValue, from)) kinds.add('openai');
  if (hasToken(line, SLACK, null, from)) kinds.add('slack');
  if (PRIVATE_KEY.test(line)) kinds.add('privateKey');
}

/**
 * Kinds of secrets found in one line of text (content kinds only, each once). A line longer than
 * MAX_LINE_LENGTH is scanned in windows overlapping by WINDOW_OVERLAP: a token up to that length is wholly
 * inside some window, and a match at a later window's first character was already judged, with its
 * preceding character visible, in the window before.
 */
function lineKinds(line) {
  const kinds = new Set();
  if (line.length <= MAX_LINE_LENGTH) {
    windowKinds(line, 0, kinds);
  } else {
    for (let start = 0; start < line.length; start += MAX_LINE_LENGTH - WINDOW_OVERLAP) {
      windowKinds(line.slice(start, start + MAX_LINE_LENGTH), start ? 1 : 0, kinds);
      if (start + MAX_LINE_LENGTH >= line.length) break;
    }
  }
  return [...kinds];
}

/** Scan the whole text of a file: `[{ file, line (1-based), kind }]`. */
export function scanText(file, text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    for (const kind of lineKinds(line)) out.push({ file, line: i + 1, kind });
  }
  return out;
}

const SIMPLE_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decode a C-quoted git path (the text between the quotes): \" \\ \t \n and octal bytes (UTF-8). */
function unquoteC(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = s[i + 1];
    if (next >= '0' && next <= '7') {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a "+++ " / "--- " operand (`b/x`, `"b/x"`, `/dev/null`); null for /dev/null or an unexpected shape. */
function headerPath(operand) {
  let s = operand.replace(/\t.*$/, ''); // git appends a tab after names that contain spaces
  if (s === '/dev/null') return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = unquoteC(s.slice(1, -1));
  return /^[ab]\//.test(s) ? s.slice(2) : null;
}

/** Destination path guess from a `diff --git a/P b/P` line (refined later by `+++`, `rename to`, `Binary files`). */
function diffGitPath(rest) {
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return unquoteC(quoted[1]);
  const p = (rest.length - 5) / 2; // "a/P b/P"
  if (Number.isInteger(p) && p > 0 && rest.slice(2, 2 + p) === rest.slice(2 + p + 3)) return rest.slice(2 + p + 3);
  const i = rest.lastIndexOf(' b/');
  return i >= 0 ? rest.slice(i + 3) : null;
}

/** Path from a `diff --cc P` / `diff --combined P` line: no a/ b/ prefixes, C-quoted when needed. */
function combinedPath(rest) {
  return rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2 ? unquoteC(rest.slice(1, -1)) : rest;
}

// A hunk header: N parents give N+1 '@' and N old ranges; the plain unified form is the case N = 1.
const HUNK = /^(@{2,}) ((?:-\S+ )+)\+(\d+)(?:,\d+)? \1(?: |$)/;

/**
 * Parse diff output (`-U0 --src-prefix=a/ --dst-prefix=b/`, plain or combined after a merge conflict):
 * `{ findings: [{ file, line, kind }], unparsed }`. Only added lines are scanned, `line` is the number in
 * the new file. A path that `isSecretFile` gives an `envFile` finding with `line: 0` (the name, not a
 * line); a deleted file gives none. `unparsed` is true when a line that starts with `@@` inside a file
 * block is not a hunk header this parser understands: the caller must not treat the result as clean.
 */
export function parsePatch(text) {
  const out = [];
  const seen = new Set();
  const add = (file, line, kind) => {
    const key = `${file}\0${line}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line, kind });
  };

  let name = null; // destination path of the current file block
  let inBlock = false;
  let deleted = false;
  let inHunk = false;
  let columns = 1; // prefix columns of hunk lines: the number of parents
  let scanning = false; // current file has a real destination (not /dev/null)
  let newLine = 0;
  let unparsed = false;

  const closeFile = () => {
    if (name && !deleted && isSecretFile(name)) add(name, 0, 'envFile');
  };
  const openFile = (path) => {
    closeFile();
    name = path;
    inBlock = true;
    deleted = false;
    inHunk = false;
    scanning = false;
  };

  for (const rawLine of String(text).split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      openFile(diffGitPath(rawLine.slice('diff --git '.length)));
      continue;
    }
    if (rawLine.startsWith('diff --cc ') || rawLine.startsWith('diff --combined ')) {
      openFile(combinedPath(rawLine.slice(rawLine.indexOf(' ', 5) + 1)));
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const m = HUNK.exec(rawLine);
      const parents = m ? m[2].split(' ').length - 1 : 0;
      if (m && parents === m[1].length - 1) {
        columns = parents;
        newLine = Number(m[3]);
        inHunk = true;
      } else if (inBlock) {
        unparsed = true;
        inHunk = false;
      }
      continue;
    }
    if (inHunk) {
      if (rawLine.startsWith('\\')) continue; // "\ No newline at end of file"
      // a line is in the new file unless some parent column says '-', added when some column says '+';
      // a blank line is context under diff.suppressBlankEmpty
      const prefix = rawLine.slice(0, columns);
      if (prefix.includes('-')) continue;
      if (prefix.includes('+') && scanning) {
        const body = rawLine.slice(columns);
        const line = body.endsWith('\r') ? body.slice(0, -1) : body;
        for (const kind of lineKinds(line)) add(name, newLine, kind);
      }
      newLine++;
      continue;
    }
    // file header lines (before the first hunk of a block)
    if (rawLine.startsWith('+++ ')) {
      const p = headerPath(rawLine.slice(4));
      if (p === null) {
        if (rawLine.slice(4).replace(/\t.*$/, '') === '/dev/null') deleted = true;
        scanning = false;
      } else {
        name = p;
        scanning = true;
      }
    } else if (rawLine.startsWith('deleted file mode')) {
      deleted = true;
    } else if (rawLine.startsWith('rename to ')) {
      const s = rawLine.slice('rename to '.length);
      name = s.startsWith('"') && s.endsWith('"') ? unquoteC(s.slice(1, -1)) : s;
    } else if (rawLine.startsWith('Binary files ') && rawLine.endsWith(' differ')) {
      const m = /^Binary files (?:"a\/(?:[^"\\]|\\.)*"|\S.*?) and (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+?)) differ$/.exec(rawLine);
      if (m) name = m[1] !== undefined ? unquoteC(m[1]) : m[2];
      else if (/ and \/dev\/null differ$/.test(rawLine)) deleted = true;
    }
  }
  closeFile();
  return { findings: out, unparsed };
}

/** Findings of `parsePatch` alone: `[{ file, line, kind }]` (see `parsePatch` for the unparsed signal). */
export function scanPatch(text) {
  return parsePatch(text).findings;
}

/** Default git runner: `(args, cwd, timeoutMs) => { status, stdout, stderr, error, signal }`, independent of locale and user config. */
function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES + 1,
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: '', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error, signal: r.signal };
}

/**
 * `git diff` of the working tree; `--cached` goes right after `diff`. Every option that user config could
 * change in a way the parser depends on is pinned: paths from the root and unquoted (diff.relative,
 * core.quotepath), no colors, external drivers or textconv, no context lines and no merged hunks
 * (diff.context, diff.interHunkContext), fixed prefixes (diff.noprefix, diff.mnemonicPrefix), no inlined
 * submodule history (diff.submodule).
 */
export const DIFF_ARGS = Object.freeze([
  '-c', 'core.quotepath=off', '-c', 'diff.relative=false', 'diff',
  '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--inter-hunk-context=0',
  '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=d', '--submodule=short',
]);
const CACHED_DIFF_ARGS = Object.freeze([...DIFF_ARGS.slice(0, 5), '--cached', ...DIFF_ARGS.slice(5)]);

const NOT_REPO = /not a git repository/i;

/**
 * Classify a failed or aborted git call: `{ unchecked }`, `{ notRepo }` or null when it succeeded.
 * `run` is used once more to tell "not a repository" from other failures (`git diff --cached` outside a
 * repository is parsed as `--no-index` and fails with a usage error that carries no such text).
 */
function failure(r, run, cwd) {
  if (r.error?.code === 'ENOBUFS') return { unchecked: 'tooLarge' };
  if (r.error || r.signal) return { unchecked: 'error' }; // timeout (ETIMEDOUT), killed, git missing
  if (r.status === 0) return null;
  if (NOT_REPO.test(r.stderr)) return { notRepo: true };
  const probe = run(['rev-parse', '--is-inside-work-tree'], cwd);
  if (probe.error || probe.signal) return { unchecked: 'error' };
  if (probe.status === 0) return probe.stdout.trim() === 'false' ? { notRepo: true } : { unchecked: 'error' };
  return NOT_REPO.test(probe.stderr) ? { notRepo: true } : { unchecked: 'error' };
}

const outcome = (bad) => (bad.notRepo ? { findings: [], notRepo: true } : bad);

/** The real path when it exists (macOS /var -> /private/var, Windows short names), else the resolved one. */
function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Read one untracked (or force-added) file into findings. Returns null on success, or `{ unchecked }`.
 * `budget.total` accumulates the text bytes read across files.
 */
function scanFile(root, rel, budget, push) {
  if (isSecretFile(rel)) push([{ file: rel, line: 0, kind: 'envFile' }]);
  const abs = resolve(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    // a non-UTF-8 name is mangled to U+FFFD by decoding: the file exists, it just cannot be named
    if (e.code === 'ENOENT' && !rel.includes('\uFFFD')) return null; // vanished since ls-files
    return { unchecked: 'error' };
  }
  if (!st.isFile()) return null; // symlinks, nested repositories (listed as "dir/")
  let buf;
  try {
    const fd = openSync(abs, 'r');
    try {
      buf = Buffer.alloc(Math.min(st.size, BINARY_PROBE_BYTES));
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { unchecked: 'error' };
  }
  if (buf.includes(0)) return null; // binary: only the name counts
  if (st.size > MAX_UNTRACKED_FILE_BYTES) return { unchecked: 'tooLarge' };
  budget.total += st.size;
  if (budget.total > MAX_UNTRACKED_TOTAL_BYTES) return { unchecked: 'tooLarge' };
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return { unchecked: 'error' };
  }
  push(scanText(rel, text));
  return null;
}

/**
 * What the next commit would add that looks like a secret.
 * - `worktree`: also unstaged changes of tracked files (`git diff`)
 * - `untracked`: also untracked, not ignored files: names always, content of text files read from disk
 * - `forced`: paths given to `git add -f` (absolute, or relative to `cwd`): untracked files under them are
 *   read like `untracked` ones even when git ignores them; the same limits apply to both sets together.
 *   A path outside the work tree makes git fail: `{ unchecked: 'error' }`
 * - `forcedAll`: `git add -f` of the whole work tree (`-A` without a path, or only exclude pathspecs):
 *   every untracked file is read, ignored ones included (which often exceeds the limits: `tooLarge`)
 * - `ignore`: protected_files-style globs; matches give no findings of any kind. Matched against the path
 *   relative to `base` when given (a file outside `base` is never ignored), else relative to the
 *   repository root
 * - `base`: absolute directory the `ignore` patterns are relative to (the project root)
 * - `deadlineMs`: time budget of the whole call (default 6000); each git call gets what is left as its
 *   timeout, and a spent budget or a timed-out call gives `{ unchecked: 'error' }`
 * - `git`: runner `(args, cwd, timeoutMs) => ({ status, stdout, stderr, error?, signal? })`, a seam for tests
 * Returns `{ findings }`, `{ findings: [], notRepo: true }` or `{ unchecked: 'error' | 'tooLarge' }`
 * (`error` also when the diff output cannot be parsed).
 * Findings are `{ file, line, kind }`; `file` is relative to the repository root with `/`, `line` is 0
 * for `envFile`.
 */
export function pendingFindings(cwd, {
  worktree = false,
  untracked = false,
  forced = [],
  forcedAll = false,
  ignore = [],
  base = null,
  deadlineMs = DEADLINE_MS,
  git: run = runGit,
} = {}) {
  const deadline = performance.now() + deadlineMs;
  const call = (args, dir) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) {
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }) };
    }
    return run(args, dir, remaining);
  };
  const git = (args, dir) => {
    const r = call(args, dir);
    const bad = failure(r, call, dir);
    return bad ? { bad: outcome(bad) } : { stdout: r.stdout };
  };

  const raw = [];
  for (const args of worktree ? [CACHED_DIFF_ARGS, DIFF_ARGS] : [CACHED_DIFF_ARGS]) {
    const r = git(args, cwd);
    if (r.bad) return r.bad;
    if (r.stdout.length > MAX_DIFF_BYTES) return { unchecked: 'tooLarge' };
    const parsed = parsePatch(r.stdout);
    if (parsed.unparsed) return { unchecked: 'error' };
    raw.push(...parsed.findings);
  }

  const reading = untracked || forced.length > 0 || forcedAll;
  let root = null;
  if (reading || (ignore.length && base)) {
    const top = git(['rev-parse', '--show-toplevel'], cwd);
    if (top.bad) return top.bad;
    root = top.stdout.trim();
    if (!root) return { unchecked: 'error' };
  }

  // ignore: relative to base (outside base: never), else relative to the repository root
  let ignored = () => false;
  if (ignore.length) {
    const realBase = base ? realPath(base) : null;
    const realRoot = base ? realPath(root) : null;
    ignored = (file) => {
      let rel = file;
      if (realBase) {
        rel = relative(realBase, resolve(realRoot, file));
        if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
        rel = rel.replace(/\\/g, '/');
      }
      return matchList(rel, ignore, { nocase: true });
    };
  }

  const found = [];
  const seen = new Set();
  const push = (list) => {
    for (const f of list) {
      if (ignored(f.file)) continue;
      const key = `${f.file}\0${f.line}\0${f.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
  };
  push(raw);

  if (reading) {
    // ls-files lists only the current directory's subtree: run it from the root
    const files = new Set();
    const list = (args) => {
      const r = git(['-c', 'core.quotepath=off', 'ls-files', '-z', '--others', '--full-name', ...args], root);
      if (r.bad) return r.bad;
      for (const f of r.stdout.split('\0')) if (f && !ignored(f)) files.add(f);
      return null;
    };
    if (forcedAll) {
      // no pathspec, no --exclude-standard: every untracked file, a superset of the other two lists
      const bad = list([]);
      if (bad) return bad;
    } else if (untracked) {
      const bad = list(['--exclude-standard']);
      if (bad) return bad;
    }
    if (forced.length && !forcedAll) {
      // no --exclude-standard: ignored files are what git add -f brings in; literal: no glob magic in names
      const spec = (p) => `:(literal)${sep === '\\' ? resolve(cwd, p).replace(/\\/g, '/') : resolve(cwd, p)}`;
      const bad = list(['--', ...forced.map(spec)]);
      if (bad) return bad;
    }
    if (files.size > MAX_UNTRACKED_FILES) return { unchecked: 'tooLarge' };
    const budget = { total: 0 };
    for (const rel of files) {
      if (performance.now() > deadline) return { unchecked: 'error' };
      const bad = scanFile(root, rel, budget, push);
      if (bad) return bad;
    }
  }

  return { findings: found };
}
