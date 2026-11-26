// forge finish: a read-only readiness check before integrating a finished branch. It never merges, pushes,
// deletes or fetches: it prints the commands, and the session runs them through Bash so the guard hooks see them.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fitList } from './docs.mjs';
import {
  aheadBehind, branchExists, currentBranch, defaultBranch, diffNames, isClean, remoteUrl, trackingOf, untrackedFiles,
  upstreamOf, worktreeList,
} from './git.mjs';
import { branchMatches } from './guards.mjs';
import { defineCatalog, t } from './i18n.mjs';
import { unreleasedGap } from './release.mjs';
import { summarize } from './verify.mjs';

const UNTRACKED_SHOWN = 5;

/** Russian plural form: 1 коммит, 2 коммита, 5 коммитов (21 коммит, 11 коммитов). */
function plural(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

const MSG = defineCatalog({
  en: {
    header: 'forge finish: {branch} → {base} ({source}), ahead {ahead}, behind {behind}',
    headerShort: 'forge finish: {branch}',
    detached: 'HEAD is detached — switch to the branch you want to integrate',
    noBaseFlag: 'branch "{base}" does not exist locally — specify an existing one: --base <branch>',
    noBase: "could not determine the base branch: origin's default branch is unknown or not a local branch, and no git.protected_branches entry exists locally — specify it: forge finish --base <branch>",
    onBase: 'you are on the base branch {base} itself — switch to the branch you want to integrate',
    noCommits: '{branch} has no commits that are not in {base} — nothing to integrate',
    branch: ({ branch, base, n }) => `${branch}: ${n} ${n === 1 ? 'commit' : 'commits'} to integrate into ${base}`,
    dirty: 'the working tree has uncommitted changes — commit or stash them: they would not get into {base}',
    clean: 'No uncommitted changes',
    untracked: 'untracked files will not get into the branch: {list}',
    more: '{list} and {rest} more',
    behindRebase: ({ base, branch, n }) =>
      `${base} has ${n} ${n === 1 ? 'commit' : 'commits'} that ${branch} lacks: the merge result has not been tested. Bring them in — git rebase ${base} (the branch is not pushed yet) — and run forge finish again`,
    behindMerge: ({ base, branch, n }) =>
      `${base} has ${n} ${n === 1 ? 'commit' : 'commits'} that ${branch} lacks: the merge result has not been tested. Bring them in — git merge ${base} (the branch is already pushed, do not rewrite it) — and run forge finish again`,
    baseStale: ({ base, upstream, n }) =>
      `the local ${base} is ${n} ${n === 1 ? 'commit' : 'commits'} behind ${upstream}: the branch is compared with a stale base. Update it — git pull --ff-only on ${base} — and run forge finish again`,
    verifySkipped: 'verification skipped (--no-verify)',
    noVerifySteps: 'verify.steps is empty — nothing verified the branch',
    verifyOk: 'Verification passed: {summary}',
    verifyFailed: 'verification failed at step "{step}": {summary} — details: forge verify',
    verifyNoShell: 'verification skipped — no shell to run the commands: {summary}',
    unreleasedEmpty: 'the branch changes code ({files}), but [Unreleased] in {changelog} is empty — add an entry if the change is noticeable to users',
    flowUnset: 'the integration flow is not chosen (git.flow): merge — merge locally, pr — open a pull request; the choice can be saved in .forge/profile.json, field git.flow',
    baseWorktreeDirty: '{base} is checked out in {path} and has uncommitted changes there — commit or stash them before merging',
    branchInWorktree: '{branch} is checked out in this worktree, so it can be deleted only after switching or removing it: git -C {path} branch -d {branch}',
    baseProtected: '{base} is protected (git.protected_branches): forge will refuse the push, so the merge stays local — or choose the pr flow',
    noOrigin: 'there is no origin remote — nowhere to open a pull request',
    noGh: 'the gh CLI is not available — install it and run gh auth login, or open the pull request in the browser',
    notGithub: 'origin is not on GitHub ({url}) — gh pr create works only with GitHub; open the request in your hosting instead',
    fixFirst: 'Fix the ✗ items first — the commands will be shown after that.',
    flowLine: 'Flow: {flow} (git.flow)',
    mergeHeading: 'merge — merge locally:',
    prHeading: 'pr — pull request:',
    usage: 'forge finish [--base <branch>] [--no-verify] [--json]',
    needBase: '--base needs a branch name',
  },
  ru: {
    header: 'forge finish: {branch} → {base} ({source}), впереди {ahead}, позади {behind}',
    headerShort: 'forge finish: {branch}',
    detached: 'HEAD отсоединён — переключись на ветку, которую нужно влить',
    noBaseFlag: 'ветки «{base}» нет локально — укажи существующую: --base <ветка>',
    noBase: 'не удалось определить базовую ветку: ветка по умолчанию у origin неизвестна или её нет локально, и ни одной ветки из git.protected_branches нет локально — укажи её: forge finish --base <ветка>',
    onBase: 'ты на самой базовой ветке {base} — переключись на ветку, которую нужно влить',
    noCommits: 'в {branch} нет коммитов, которых нет в {base}, — вливать нечего',
    branch: ({ branch, base, n }) => `${branch}: ${n} ${plural(n, 'коммит', 'коммита', 'коммитов')} для вливания в ${base}`,
    dirty: 'в рабочем дереве есть незакоммиченные изменения — закоммить или отложи их: в {base} они не попадут',
    clean: 'Незакоммиченных изменений нет',
    untracked: 'неотслеживаемые файлы не попадут в ветку: {list}',
    more: '{list} и ещё {rest}',
    behindRebase: ({ base, branch, n }) =>
      `в ${base} ${n} ${plural(n, 'коммит', 'коммита', 'коммитов')}, которых нет в ${branch}: результат слияния не проверен. Подтяни их — git rebase ${base} (ветка ещё не отправлена) — и запусти forge finish снова`,
    behindMerge: ({ base, branch, n }) =>
      `в ${base} ${n} ${plural(n, 'коммит', 'коммита', 'коммитов')}, которых нет в ${branch}: результат слияния не проверен. Подтяни их — git merge ${base} (ветка уже отправлена, не переписывай её) — и запусти forge finish снова`,
    baseStale: ({ base, upstream, n }) =>
      `локальная ${base} отстаёт от ${upstream} на ${n} ${plural(n, 'коммит', 'коммита', 'коммитов')}: ветка сравнивается с устаревшей базой. Обнови её — git pull --ff-only на ${base} — и запусти forge finish снова`,
    verifySkipped: 'проверка пропущена (--no-verify)',
    noVerifySteps: 'verify.steps пуст — ветку ничто не проверило',
    verifyOk: 'Проверка прошла: {summary}',
    verifyFailed: 'проверка упала на шаге «{step}»: {summary} — подробности: forge verify',
    verifyNoShell: 'проверка пропущена — нет оболочки для команд: {summary}',
    unreleasedEmpty: 'ветка меняет код ({files}), а [Unreleased] в {changelog} пуст — добавь запись, если изменение заметно пользователям',
    flowUnset: 'способ вливания не выбран (git.flow): merge — слить локально, pr — открыть pull request; выбор можно сохранить в .forge/profile.json, поле git.flow',
    baseWorktreeDirty: '{base} выбрана в {path}, и там есть незакоммиченные изменения — закоммить или отложи их перед слиянием',
    branchInWorktree: '{branch} выбрана в этом worktree, поэтому удалить её можно только после переключения или удаления worktree: git -C {path} branch -d {branch}',
    baseProtected: '{base} защищена (git.protected_branches): forge не даст её отправить, слияние останется локальным — или выбери способ pr',
    noOrigin: 'нет удалённого репозитория origin — открывать pull request негде',
    noGh: 'gh CLI недоступен — установи его и выполни gh auth login или открой pull request в браузере',
    notGithub: 'origin не на GitHub ({url}) — gh pr create работает только с GitHub; открой запрос в своём хостинге',
    fixFirst: 'Сначала исправь пункты с ✗ — команды появятся после этого.',
    flowLine: 'Способ: {flow} (git.flow)',
    mergeHeading: 'merge — слить локально:',
    prHeading: 'pr — pull request:',
    usage: 'forge finish [--base <ветка>] [--no-verify] [--json]',
    needBase: '--base: нужно имя ветки',
  },
});

/** Message lookup for cmdFinish (text output and usage errors). */
export const finishText = (key, params) => t(MSG, key, params);

/** POSIX sh quoting for a printed command argument: bare when safe, else single quotes. */
export function shq(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_./:@-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const ra = real(a);
  const rb = real(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function ghAvailable() {
  try {
    return spawnSync('gh', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function listUntracked(files) {
  const shown = files.slice(0, UNTRACKED_SHOWN).join(', ');
  const rest = files.length - UNTRACKED_SHOWN;
  return rest > 0 ? t(MSG, 'more', { list: shown, rest }) : shown;
}

/**
 * The branch to integrate into: --base (must exist locally), else origin's default branch when it exists
 * locally, else the first plain (no "*", no "!") entry of git.protected_branches that exists locally.
 * Returns { base, source } (source: 'flag' | 'origin' | 'protected') or null.
 */
export function resolveBase(root, profile, explicit) {
  if (explicit) return branchExists(root, explicit) ? { base: explicit, source: 'flag' } : null;
  const origin = defaultBranch(root);
  if (origin && branchExists(root, origin)) return { base: origin, source: 'origin' };
  for (const name of profile?.git?.protected_branches || []) {
    if (!name.includes('*') && !name.startsWith('!') && branchExists(root, name)) return { base: name, source: 'protected' };
  }
  return null;
}

function mergeSteps(root, profile, branch, base, hasOrigin, notes) {
  const steps = [];
  const step = (cmd) => steps.push({ cmd, cwd: root });
  const note = (id, key, params) => notes.push({ id, flow: 'merge', message: t(MSG, key, params) });
  const baseWt = worktreeList(root).find((w) => w.branch === base && !w.bare && !samePath(w.path, root));
  const at = baseWt ? `git -C ${shq(baseWt.path)}` : 'git';
  if (baseWt) {
    step(`${at} merge ${shq(branch)}`);
    if (!isClean(baseWt.path)) note('base-worktree-dirty', 'baseWorktreeDirty', { base, path: baseWt.path });
    note('branch-in-worktree', 'branchInWorktree', { branch: shq(branch), path: shq(baseWt.path) });
  } else {
    step(`git switch ${shq(base)}`);
    step(`git merge ${shq(branch)}`);
  }
  if (hasOrigin) {
    step(`${at} push origin ${shq(base)}`);
    if (branchMatches(base, profile.git.protected_branches)) note('base-protected', 'baseProtected', { base });
  }
  // The remote branch goes before the local one: with an upstream behind the branch, git branch -d refuses
  // ("not yet merged to refs/remotes/…") until the push --delete has removed the remote-tracking ref.
  const tracking = trackingOf(root, branch);
  if (tracking) step(`${at} push ${shq(tracking.remote)} --delete ${shq(tracking.branch)}`);
  if (!baseWt) step(`git branch -d ${shq(branch)}`);
  return steps;
}

function prSteps(root, branch, base, originUrl, hasGh, notes) {
  const note = (id, key, params) => notes.push({ id, flow: 'pr', message: t(MSG, key, params) });
  if (originUrl === null) {
    note('no-origin', 'noOrigin');
    return [];
  }
  if (!(hasGh ?? ghAvailable())) note('no-gh', 'noGh');
  if (!/github\.com[:/]/.test(originUrl)) note('not-github', 'notGithub', { url: originUrl });
  return [
    { cmd: `git push -u origin ${shq(branch)}`, cwd: root },
    { cmd: `gh pr create --base ${shq(base)} --head ${shq(branch)} --fill`, cwd: root },
  ];
}

/**
 * Everything needed before integrating the current branch: checks, the verify result and the commands of
 * both flows. Read-only apart from recording the verify result in state (as forge verify does).
 * opts: base (explicit --base), verify (false for --no-verify), runVerify(files) → { result } (verifyAndRecord,
 * passed in by the CLI so this module does not import it back), hasGh (skip the gh probe).
 */
export function analyzeFinish(root, profile, { base: explicit, verify = true, runVerify, hasGh } = {}) {
  const result = {
    ok: false,
    branch: currentBranch(root),
    base: null,
    base_source: null,
    flow: profile.git?.flow ?? null,
    ahead: null,
    behind: null,
    checks: [],
    verify: null,
    steps: { merge: [], pr: [] },
    notes: [],
  };
  const check = (id, level, key, params) => result.checks.push({ id, level, message: t(MSG, key, params) });
  const done = () => {
    result.ok = !result.checks.some((c) => c.level === 'fail');
    return result;
  };
  const { branch } = result;

  // 1. branch and base: nothing else makes sense without them
  if (!branch) {
    check('detached', 'fail', 'detached');
    return done();
  }
  const resolved = resolveBase(root, profile, explicit);
  if (!resolved) {
    if (explicit) check('no-base', 'fail', 'noBaseFlag', { base: explicit });
    else check('no-base', 'fail', 'noBase');
    return done();
  }
  const { base } = resolved;
  result.base = base;
  result.base_source = resolved.source;
  if (branch === base) {
    check('on-base', 'fail', 'onBase', { base });
    return done();
  }
  const counts = aheadBehind(root, base, branch) || { ahead: 0, behind: 0 };
  result.ahead = counts.ahead;
  result.behind = counts.behind;
  if (!counts.ahead) {
    check('no-commits', 'fail', 'noCommits', { branch, base });
    return done();
  }
  check('branch', 'ok', 'branch', { branch, base, n: counts.ahead });

  // 2. the working tree
  if (isClean(root)) check('clean', 'ok', 'clean');
  else check('dirty', 'fail', 'dirty', { base });
  const untracked = untrackedFiles(root);
  if (untracked.length) check('untracked', 'warn', 'untracked', { list: listUntracked(untracked) });
  if (counts.behind) {
    const key = upstreamOf(root, branch) ? 'behindMerge' : 'behindRebase';
    check('behind', 'warn', key, { base, branch, n: counts.behind });
  }
  // git fetch moves only origin/<base>: a local base behind its upstream hides the real "behind"
  const baseUpstream = upstreamOf(root, base);
  const stale = baseUpstream ? aheadBehind(root, base, baseUpstream) : null;
  if (stale?.ahead) check('base-stale', 'warn', 'baseStale', { base, upstream: baseUpstream, n: stale.ahead });

  // 3. verification of the whole branch (full test, not test_fast)
  const changed = diffNames(root, base);
  if (!verify) check('verify-skipped', 'warn', 'verifySkipped');
  else if (result.checks.some((c) => c.level === 'fail')) result.verify = null;
  else if (!profile.verify.steps.length || !runVerify) check('no-verify-steps', 'warn', 'noVerifySteps');
  else {
    // deleted files can't be linted: only the ones still present go to {files}
    const files = changed.filter((f) => existsSync(join(root, f)));
    const { result: run } = runVerify(files);
    const summary = summarize(run);
    const ok = run.shellMissing ? null : run.ok;
    result.verify = { ok, summary, failed_step: run.failed?.step ?? null };
    if (ok === true) check('verify', 'ok', 'verifyOk', { summary });
    else if (ok === false) check('verify-failed', 'fail', 'verifyFailed', { summary, step: run.failed?.step ?? '?' });
    else check('verify-no-shell', 'warn', 'verifyNoShell', { summary });
  }

  // 4. changelog and flow
  const gap = profile.release ? unreleasedGap(root, profile.release, changed) : null;
  if (gap) check('unreleased-empty', 'warn', 'unreleasedEmpty', { files: fitList(gap.relevant, 100), changelog: gap.changelog });
  if (!result.flow) check('flow-unset', 'warn', 'flowUnset');

  // 5. commands for both flows: the skill may override the profile's choice
  const originUrl = remoteUrl(root, 'origin');
  result.steps.merge = mergeSteps(root, profile, branch, base, originUrl !== null, result.notes);
  result.steps.pr = prSteps(root, branch, base, originUrl, hasGh, result.notes);
  return done();
}
