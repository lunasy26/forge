import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { compareSemver, parseSemver } from './semver.mjs';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** NUL-separated output (`-z`) split into entries; [] on error. Names stay unescaped, whatever core.quotePath says. */
function gitList(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

export function currentBranch(cwd) {
  return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
}

export function isGitRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** origin's default branch name, if known (e.g. "main"). */
export function defaultBranch(cwd) {
  const ref = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  return ref ? ref.replace(/^refs\/remotes\/origin\//, '') : null;
}

/** Add lines to .git/info/exclude (shared by all worktrees) without touching .gitignore. */
export function addExcludes(cwd, lines) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return [];
  const dir = isAbsolute(common) ? common : resolve(cwd, common);
  const file = join(dir, 'info', 'exclude');
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}# forge\n${missing.join('\n')}\n`);
  }
  return missing;
}

export function excludedLines(cwd) {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  const file = join(isAbsolute(common) ? common : resolve(cwd, common), 'info', 'exclude');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((l) => l.trim()) : [];
}

/** All tag names of the repository ([] outside a repo). */
export function listTags(cwd) {
  const out = git(cwd, ['tag', '--list']);
  return out ? out.split('\n').map((t) => t.trim()).filter(Boolean) : [];
}

/** Highest semver among "<prefix>x.y.z" tags (a pre-release sorts below its release), or null. */
export function latestVersionTag(cwd, prefix = '') {
  let best = null;
  for (const tag of listTags(cwd)) {
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    const parsed = parseSemver(version);
    if (parsed && (!best || compareSemver(parsed, best.parsed) > 0)) best = { tag, version, parsed };
  }
  return best && { tag: best.tag, version: best.version };
}

export function tagExists(cwd, tag) {
  return git(cwd, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]) !== null;
}

/** No staged or unstaged changes to tracked files; untracked files are ignored. */
export function isClean(cwd) {
  const out = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return out === '';
}

export function headSha(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function mergeBase(cwd, a, b) {
  return git(cwd, ['merge-base', a, b]);
}

/** True when the local branch refs/heads/<name> exists. */
export function branchExists(cwd, name) {
  return git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]) !== null;
}

/** Upstream of a local branch (e.g. "origin/main"), or null when none is set. */
export function upstreamOf(cwd, branch) {
  return git(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]) || null;
}

/**
 * Where a local branch tracks: { remote, branch } from branch.<name>.remote and branch.<name>.merge
 * (refs/heads/ stripped), or null without an upstream or when it tracks a local branch (remote ".").
 */
export function trackingOf(cwd, branch) {
  const remote = git(cwd, ['config', '--get', `branch.${branch}.remote`]);
  const merge = git(cwd, ['config', '--get', `branch.${branch}.merge`]);
  if (!remote || !merge || remote === '.') return null;
  return { remote, branch: merge.replace(/^refs\/heads\//, '') };
}

/** URL of a remote (default "origin"), or null when it does not exist. */
export function remoteUrl(cwd, name = 'origin') {
  return git(cwd, ['remote', 'get-url', name]) || null;
}

/** Names of all configured remotes ([] when there are none). */
export function remotes(cwd) {
  const out = git(cwd, ['remote']);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/** Commits in head not in base (ahead) and in base not in head (behind), or null when a ref is unknown. */
export function aheadBehind(cwd, base, head) {
  const out = git(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`]);
  if (!out) return null;
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : null;
}

/**
 * Files changed on head since it diverged from base (`base...head`), relative to cwd and limited to it
 * (a package inside a monorepo sees only its own files); [] on error.
 */
export function diffNames(cwd, base, head = 'HEAD') {
  return gitList(cwd, ['diff', '--name-only', '-z', '--relative', `${base}...${head}`]);
}

/** Untracked files that are not ignored, relative to cwd and limited to it ([] on error). */
export function untrackedFiles(cwd) {
  return gitList(cwd, ['ls-files', '-z', '--others', '--exclude-standard']);
}

/** Worktrees of the repository: native path (git prints C:/… on Windows), short branch name (null when detached or bare), bare and detached flags. */
export function worktreeList(cwd) {
  const out = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const list = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const entry = { path: '', branch: null, bare: false, detached: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) entry.path = resolve(line.slice('worktree '.length));
      else if (line.startsWith('branch ')) entry.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'bare') entry.bare = true;
      else if (line === 'detached') entry.detached = true;
    }
    if (entry.path) list.push(entry);
  }
  return list;
}
