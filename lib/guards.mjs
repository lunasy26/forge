import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { currentBranch } from './git.mjs';
import { matchList } from './glob.mjs';
import { defineCatalog, t } from './i18n.mjs';
import { isInside, relToRoot } from './paths.mjs';
import { splitPowerShell } from './pwsh.mjs';
import { commandName, GUARDED, SHELLS, splitCommands, stripWrappers } from './shell.mjs';

const MSG = defineCatalog({
  en: {
    pushMirror: 'forge: git push --mirror overwrites every branch of the remote repository — forbidden.',
    pushProtected:
      'forge: pushing to the protected branch "{branch}" is forbidden (git.protected_branches). ' +
      'Work in a separate branch and suggest a PR or a merge to the user.',
    pushForceLease:
      'forge: git push --force is forbidden, even together with --force-with-lease: {which} cancels the lease check. ' +
      'Use --force-with-lease only.',
    pushForce: 'forge: git push --force is forbidden. For your own branch use --force-with-lease.',
    pushNoVerify: 'forge: git push --no-verify bypasses the project git hooks — forbidden.',
    pushAll: 'forge: git push --all will push every local branch, including protected ones. Confirm.',
    pushUnknownDir:
      'forge: git push without an explicit branch, in a directory known only at run time — cannot tell which branch it pushes. ' +
      'Name the branch or confirm.',
    commitNoVerify: 'forge: git commit --no-verify bypasses the project pre-commit checks — forbidden.',
    commitN: 'forge: git commit -n (--no-verify) bypasses the project pre-commit checks — forbidden.',
    resetHard: 'forge: git reset --hard irreversibly wipes uncommitted changes. Confirm.',
    rmDynamic: '{path} (path is only known at run time)',
    rmOutside: 'forge: rm -r outside the project or on an unpredictable path: {problems}. Confirm.',
    tooDeep: 'forge: bash -c or $(...) substitutions are nested too deeply — cannot check the whole command. Confirm.',
    unterminated:
      'forge: unterminated substitution ($(...), `...`, ${...} or <(...)) — cannot check what it will run. Confirm.',
    envSplit:
      'forge: the env -S string cannot be read reliably (an unclosed quote or ${, a trailing backslash, -S nested too deeply) — ' +
      'cannot check what it will run. Confirm.',
    xargsArgs:
      'forge: xargs adds arguments from its input to {cmd} — they may hide --force, --no-verify, the branch, a path or a whole command. Confirm.',
    psTooDeep: 'forge: iex, pwsh -Command, script blocks or $(...) are nested too deeply — cannot check the whole command. Confirm.',
    psUnterminated:
      'forge: the PowerShell command does not parse (an unclosed quote, bracket, here-string or comment) — cannot check what it will run. Confirm.',
    psEncoded: 'forge: -EncodedCommand hides the command in base64 — cannot check it. Confirm.',
    psPipeline: 'forge: {cmd} takes its input from the pipeline — cannot check what it will run or delete. Confirm.',
    psDynamic: 'forge: {cmd} runs code known only at run time ({arg}) — cannot check it. Confirm.',
    psDynamicCall:
      'forge: the command name is only known at run time ({name}), and its arguments look like git push, reset, commit or a recursive delete. Confirm.',
    psScriptCode:
      'forge: the command builds code from a string at run time ([scriptblock]::Create, InvokeScript, AddScript) — cannot check it. Confirm.',
    psAlias: 'forge: an alias for "{name}" would hide a guarded command from the check — call the command by its own name. Confirm.',
    psSplat: 'forge: {cmd} takes its parameters from {arg} (splatting) — cannot check them. Confirm.',
    psGitArgs:
      'forge: {cmd} takes arguments from {arg}, known only at run time — they may hide --force, --no-verify or the branch. Confirm.',
    cmdRuns: 'forge: cmd /c runs git, a delete, rm or another shell — the guard does not read cmd syntax. Confirm.',
    removeOutside: 'forge: Remove-Item -Recurse outside the project or on an unpredictable path: {problems}. Confirm.',
    rmProvider: '{path} (not a file system path)',
    fileProtected:
      'forge: file "{rel}" is protected (pattern "{hit}" in protected_files). ' +
      'Do not edit it; if the change is really needed, ask the user.',
  },
  ru: {
    pushMirror: 'forge: git push --mirror перезаписывает все ветки удалённого репозитория — запрещено.',
    pushProtected:
      'forge: push в защищённую ветку «{branch}» запрещён (git.protected_branches). ' +
      'Работай в отдельной ветке и предложи пользователю PR или слияние.',
    pushForceLease:
      'forge: git push --force запрещён, даже вместе с --force-with-lease: {which} отменяет проверку аренды. ' +
      'Используй только --force-with-lease.',
    pushForce: 'forge: git push --force запрещён. Для своей ветки используй --force-with-lease.',
    pushNoVerify: 'forge: git push --no-verify обходит git-хуки проекта — запрещено.',
    pushAll: 'forge: git push --all отправит все локальные ветки, включая защищённые. Подтверди.',
    pushUnknownDir:
      'forge: git push без явной ветки в каталоге, известном только во время выполнения, — не могу понять, какую ветку он отправит. ' +
      'Укажи ветку или подтверди.',
    commitNoVerify: 'forge: git commit --no-verify обходит pre-commit проверки проекта — запрещено.',
    commitN: 'forge: git commit -n (--no-verify) обходит pre-commit проверки проекта — запрещено.',
    resetHard: 'forge: git reset --hard безвозвратно сотрёт незакоммиченные изменения. Подтверди.',
    rmDynamic: '{path} (путь известен только во время выполнения)',
    rmOutside: 'forge: rm -r за пределами проекта или по непредсказуемому пути: {problems}. Подтверди.',
    tooDeep: 'forge: слишком глубокая вложенность bash -c или подстановок $(...) — не могу проверить команду целиком. Подтверди.',
    unterminated:
      'forge: незакрытая подстановка ($(...), `...`, ${...} или <(...)) — не могу проверить, что она выполнит. Подтверди.',
    envSplit:
      'forge: строку env -S не удаётся надёжно разобрать (незакрытая кавычка или ${, обратная косая черта в конце, слишком глубокая вложенность -S) — ' +
      'не могу проверить, что она выполнит. Подтверди.',
    xargsArgs:
      'forge: xargs добавляет к {cmd} аргументы из своего входа — среди них могут оказаться --force, --no-verify, ветка, путь или целая команда. Подтверди.',
    psTooDeep: 'forge: слишком глубокая вложенность iex, pwsh -Command, блоков кода или $(...) — не могу проверить команду целиком. Подтверди.',
    psUnterminated:
      'forge: команда PowerShell не разбирается (незакрытая кавычка, скобка, here-string или комментарий) — не могу проверить, что она выполнит. Подтверди.',
    psEncoded: 'forge: -EncodedCommand прячет команду в base64 — не могу её проверить. Подтверди.',
    psPipeline: 'forge: {cmd} получает вход из конвейера — не могу проверить, что будет выполнено или удалено. Подтверди.',
    psDynamic: 'forge: {cmd} выполняет код, известный только во время выполнения ({arg}), — не могу его проверить. Подтверди.',
    psDynamicCall:
      'forge: имя команды известно только во время выполнения ({name}), а её аргументы похожи на git push, reset, commit или рекурсивное удаление. Подтверди.',
    psScriptCode:
      'forge: команда собирает код из строки во время выполнения ([scriptblock]::Create, InvokeScript, AddScript) — не могу его проверить. Подтверди.',
    psAlias: 'forge: псевдоним для «{name}» спрячет охраняемую команду от проверки — вызывай команду по её имени. Подтверди.',
    psSplat: 'forge: {cmd} получает параметры из {arg} (splatting) — не могу их проверить. Подтверди.',
    psGitArgs:
      'forge: {cmd} получает аргументы из {arg}, а их значение известно только во время выполнения — там могут прятаться --force, --no-verify или ветка. Подтверди.',
    cmdRuns: 'forge: cmd /c запускает git, удаление, rm или другую оболочку — синтаксис cmd охрана не разбирает. Подтверди.',
    removeOutside: 'forge: Remove-Item -Recurse за пределами проекта или по непредсказуемому пути: {problems}. Подтверди.',
    rmProvider: '{path} (не путь файловой системы)',
    fileProtected:
      'forge: файл «{rel}» защищён (паттерн «{hit}» в protected_files). ' +
      'Не редактируй его; если правка действительно нужна — попроси пользователя.',
  },
});

export const ALLOW = { decision: 'allow', reason: '' };
const deny = (reason) => ({ decision: 'deny', reason });
const ask = (reason) => ({ decision: 'ask', reason });

const POSIX_TMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

/**
 * How paths read on the platform the command runs on. ctx.platform, ctx.homedir and ctx.tmpdir default
 * to this machine's; tests inject them so Windows rules run on any OS.
 */
function pathEnv(ctx) {
  const win = (ctx.platform || process.platform) === 'win32';
  const api = win ? win32 : posix;
  const home = ctx.homedir || homedir();
  const tmp = ctx.tmpdir || tmpdir();
  return { win, api, home, tmp, tmpRoots: win ? [tmp] : [...new Set([tmp, ...POSIX_TMP_ROOTS])] };
}

/** deny beats ask beats allow; reasons of the winning level are joined. */
export function combine(verdicts) {
  for (const level of ['deny', 'ask']) {
    const hits = verdicts.filter((v) => v.decision === level);
    if (hits.length) return { decision: level, reason: [...new Set(hits.map((h) => h.reason))].join('\n') };
  }
  return ALLOW;
}

/** Branch globs: "*" stays within a segment, "**" crosses segments, anchored at both ends. */
export function branchMatches(branch, patterns = []) {
  return patterns.find((p) => {
    const re = p
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^$()|[\]{}\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${re}$`).test(branch);
  }) || null;
}

/**
 * Absolute form of a path argument. On Windows the Bash tool is Git Bash, so besides C:\… and C:/…
 * it accepts ~\…, /c/… (a single drive-letter segment) and /tmp (mounted on the user temp dir).
 * PowerShell (env.pwsh) has no such mounts: there /c/x is \c\x on the current drive.
 */
function resolvePath(p, cwd, env) {
  const { win, api, home } = env;
  if (p === '~' || p.startsWith('~/') || (win && p.startsWith('~\\'))) return api.resolve(home, p.slice(2) || '.');
  if (win && !env.pwsh) {
    const drive = /^\/([A-Za-z])(?:\/|$)/.exec(p);
    if (drive) return api.resolve(`${drive[1].toUpperCase()}:\\`, p.slice(3));
    if (p === '/tmp' || p.startsWith('/tmp/')) return api.resolve(env.tmp, p.slice(5));
  }
  // cwd null (unknown): callers only get here with an absolute p
  return cwd == null ? api.resolve(p) : api.resolve(cwd, p);
}

/** Same path after normalisation; case-insensitive on Windows (path.win32.relative ignores case). */
function samePath(a, b, api) {
  return api.relative(a, b) === '';
}

function branchAt(ctx, cwd) {
  return (ctx.currentBranch || currentBranch)(cwd);
}

/**
 * git accepts any unambiguous prefix of a long option (--no-verif, --mi). Any prefix of a guarded
 * option is read as that option — git rejects ambiguous ones itself, so reading them as dangerous costs
 * nothing; on ambiguity the first one listed wins, so put the most dangerous first. --dry-run is never
 * guessed: a prefix must not turn a command into an allow.
 */
function longOption(t, guarded) {
  const name = t.split('=')[0];
  if (guarded.includes(name) || name.length < 3) return name;
  return guarded.find((g) => g.startsWith(name)) || name;
}

const PUSH_OPTIONS = ['--force', '--force-with-lease', '--force-if-includes', '--no-verify', '--mirror', '--all', '--branches', '--delete'];

/**
 * `git branch --show-current` and `git rev-parse --abbrev-ref HEAD` in a substitution: $( ) or ` ` in
 * Bash, ( ) or $( ) in PowerShell. As a refspec they mean the current branch, so they are read as it.
 */
const BRANCH_QUERY = String.raw`\s*git(?:\.exe)?\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD)\s*`;
const CURRENT_BRANCH_SUB = new RegExp(String.raw`\$?\(${BRANCH_QUERY}\)|\`${BRANCH_QUERY}\``, 'g');
const CURRENT_BRANCH_GROUP = new RegExp(String.raw`^\$?\(${BRANCH_QUERY}\)$`);

/**
 * The text of a refspec word, with current-branch substitutions replaced by the branch of shellCwd — the
 * substitution runs in the shell's directory, not in git -C's. null when that directory is unknown. A word
 * that stays dynamic after the replacement (or a directory without a branch) keeps its own text.
 */
function refText(word, ctx, shellCwd) {
  if (!word.dynamic || !word.text.match(CURRENT_BRANCH_SUB)) return word.text;
  if (shellCwd == null) return null;
  const branch = branchAt(ctx, shellCwd);
  const text = branch ? word.text.replace(CURRENT_BRANCH_SUB, () => branch) : word.text;
  return /[$`(]/.test(text) ? word.text : text;
}

/**
 * cwd: where git runs (after -C); shellCwd: the shell's directory. Either is null when unknown — then a
 * push whose target is the current branch (no refspec, HEAD, @) asks, unless something else denies.
 */
function checkPush(args, ctx, cwd, shellCwd = cwd) {
  let force = false;
  let lease = false;
  let noVerify = false;
  let all = false;
  let mirror = false;
  let deleting = false;
  const positional = [];
  const valueOpts = new Set(['--repo', '--push-option', '--receive-pack', '--exec']);
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith('--')) {
      const name = longOption(t, PUSH_OPTIONS);
      if (name === '--force') force = true;
      else if (name === '--force-with-lease' || name === '--force-if-includes') lease = true;
      else if (name === '--no-verify') noVerify = true;
      else if (name === '--all' || name === '--branches') all = true;
      else if (name === '--mirror') mirror = true;
      else if (name === '--delete') deleting = true;
      else if (name === '--dry-run') return ALLOW;
      else if (valueOpts.has(name) && !t.includes('=')) i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      const flags = t.slice(1);
      if (flags.includes('n')) return ALLOW; // dry run
      if (flags.includes('f')) force = true;
      if (flags.includes('d')) deleting = true;
      if (flags.endsWith('o')) i++;
      continue;
    }
    positional.push(args[i]);
  }
  if (mirror) return deny(t(MSG, 'pushMirror'));

  const refspecs = positional.slice(1);
  const targets = [];
  let forcedRef = false;
  let unknownDir = false;
  if (!refspecs.length && !all) {
    if (cwd == null) unknownDir = true;
    else {
      const b = branchAt(ctx, cwd);
      if (b) targets.push(b);
    }
  }
  for (const spec of refspecs) {
    let s = refText(spec, ctx, shellCwd);
    if (s === null) {
      unknownDir = true;
      continue;
    }
    if (s.startsWith('+')) {
      forcedRef = true;
      s = s.slice(1);
    }
    if (s === ':') continue;
    let dst = s;
    if (s.includes(':')) {
      const idx = s.indexOf(':');
      dst = s.slice(idx + 1) || s.slice(0, idx);
      if (idx === 0) deleting = true;
    }
    if (dst === 'HEAD' || dst === '@') {
      if (cwd == null) {
        unknownDir = true;
        continue;
      }
      dst = branchAt(ctx, cwd) || dst;
    }
    targets.push(dst.replace(/^refs\/heads\//, ''));
  }

  const hit = targets.find((t) => branchMatches(t, ctx.protectedBranches));
  if (hit) {
    return deny(t(MSG, 'pushProtected', { branch: hit }));
  }
  if (force || forcedRef) {
    if (lease) {
      return deny(t(MSG, 'pushForceLease', { which: force ? '--force' : '+refspec' }));
    }
    return deny(t(MSG, 'pushForce'));
  }
  if (noVerify) return deny(t(MSG, 'pushNoVerify'));
  if (all) return ask(t(MSG, 'pushAll'));
  if (unknownDir) return ask(t(MSG, 'pushUnknownDir'));
  return ALLOW;
}

function checkCommit(args) {
  const valueLetters = 'mFCct';
  for (let i = 0; i < args.length; i++) {
    const tok = args[i].text;
    if (tok === '--') break;
    if (longOption(tok, ['--no-verify']) === '--no-verify') return deny(t(MSG, 'commitNoVerify'));
    if (tok.startsWith('--')) {
      if (['--message', '--file', '--author', '--reuse-message', '--reedit-message', '--template', '--date', '--fixup', '--squash', '--trailer'].includes(tok)) i++;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const letters = tok.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const l = letters[k];
        if (l === 'n') return deny(t(MSG, 'commitN'));
        if (valueLetters.includes(l)) {
          if (k === letters.length - 1) i++;
          break;
        }
      }
    }
  }
  return ALLOW;
}

/** git's global options that take a value as the next word. */
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'];

/** Index of git's subcommand among its arguments (args.length when there is none). */
function gitSubIndex(args) {
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) i += GIT_VALUE_OPTIONS.includes(args[i].text) ? 2 : 1;
  return Math.min(i, args.length);
}

/**
 * The directory a Bash path word leads to from cwd, or null when it is unknown: a run-time value or a
 * relative path from an unknown directory.
 */
function shLocation(word, cwd, env) {
  if (!word || word.dynamic || (cwd == null && !isAbsoluteFor(word.text, env))) return null;
  return resolvePath(word.text, cwd, env);
}

/** cwdIn: the shell's directory, null when unknown; git -C moves git, not the shell. */
function checkGit(args, ctx, cwdIn) {
  const env = pathEnv(ctx);
  let cwd = cwdIn;
  const i = gitSubIndex(args);
  for (let k = 0; k < i; k++) {
    if (args[k].text === '-C' && args[k + 1]) cwd = shLocation(args[k + 1], cwd, env);
    if (GIT_VALUE_OPTIONS.includes(args[k].text)) k++;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (sub === 'push') return checkPush(rest, ctx, cwd, cwdIn);
  if (sub === 'commit') return checkCommit(rest);
  if (sub === 'reset' && rest.some((a) => longOption(a.text, ['--hard']) === '--hard')) {
    return ask(t(MSG, 'resetHard'));
  }
  return ALLOW;
}

/** True when p names a fixed place without a working directory: ~, a drive or UNC path, or / on POSIX. */
function isAbsoluteFor(p, env) {
  if (p === '~' || p.startsWith('~/') || (env.win && p.startsWith('~\\'))) return true;
  return env.win ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(p) : p.startsWith('/');
}

/**
 * Why a recursive delete of these targets is risky: one entry per target that is dynamic, outside the
 * project and temp, or the project / home / a filesystem root itself. cwd null means the working
 * directory is unknown (a PowerShell Set-Location to a run-time path), so relative targets count too.
 * normalize maps a target's text to a file system path, or null when it is not one (PowerShell providers).
 */
function deleteProblems(targets, ctx, cwd, env, normalize = (p) => p) {
  const { api } = env;
  const problems = [];
  for (const target of targets) {
    if (target.dynamic) {
      problems.push(t(MSG, 'rmDynamic', { path: target.text }));
      continue;
    }
    let p = normalize(target.text);
    if (p === null) {
      problems.push(t(MSG, 'rmProvider', { path: target.text }));
      continue;
    }
    const glob = p.search(/[*?[]/);
    if (glob !== -1) p = p.slice(0, glob);
    if (cwd == null && !isAbsoluteFor(p, env)) {
      problems.push(t(MSG, 'rmDynamic', { path: target.text }));
      continue;
    }
    const abs = resolvePath(p || '.', cwd, env);
    if (api.parse(abs).root === abs || samePath(abs, env.home, api) || isInside(abs, ctx.root, api)) {
      // a filesystem root (/, C:\, \\server\share\), home, the project itself or one of its ancestors
      problems.push(`${target.text} → ${abs}`);
      continue;
    }
    if (isInside(ctx.root, abs, api)) continue;
    if (env.tmpRoots.some((r) => isInside(r, abs, api) && !samePath(r, abs, api))) continue;
    problems.push(`${target.text} → ${abs}`);
  }
  return problems;
}

/** rm's arguments: { recursive, targets }. */
function rmArgs(args) {
  let recursive = false;
  let endOpts = false;
  const targets = [];
  for (const a of args) {
    if (!endOpts && a.text === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.text.startsWith('-') && a.text.length > 1) {
      if (a.text === '--recursive' || (!a.text.startsWith('--') && /[rR]/.test(a.text))) recursive = true;
      continue;
    }
    targets.push(a);
  }
  return { recursive, targets };
}

function checkRm(args, ctx, cwd) {
  const { recursive, targets } = rmArgs(args);
  if (!recursive) return ALLOW;
  const problems = deleteProblems(targets, ctx, cwd, pathEnv(ctx));
  if (!problems.length) return ALLOW;
  return ask(t(MSG, 'rmOutside', { problems: problems.join(', ') }));
}

/**
 * How deep nested scripts are inspected; deeper ones ask. Bash: bash -c, eval and $(...) / `...` / <(...).
 * PowerShell: iex, pwsh -Command, groups and script blocks — blocks nest in ordinary code (a loop in an
 * if in a ForEach-Object), hence the larger limit. When one shell starts the other the depth is shared,
 * so the mutual recursion is bounded too.
 */
const MAX_DEPTH = 3;
const PS_MAX_DEPTH = 8;

/** cwd null (unknown) stays unknown in the nested script. */
function nestedBash(script, ctx, cwd, depth) {
  return depth < MAX_DEPTH ? checkBash(script, { ...ctx, cwd }, depth + 1) : ask(t(MSG, 'tooDeep'));
}

/** A nested PowerShell check: { verdict, moved } — moved: the script may change the location (see psRun). */
function nestedPsRun(script, ctx, cwd, depth) {
  return depth < PS_MAX_DEPTH ? psRun(script, { ...ctx, cwd }, depth + 1) : { verdict: ask(t(MSG, 'psTooDeep')), moved: true };
}

function nestedPs(script, ctx, cwd, depth) {
  return nestedPsRun(script, ctx, cwd, depth).verdict;
}

/**
 * `bash -c script`: { command: -c is given, script: its text or null }. -c may sit in any short-option
 * cluster (-lc, -xc, -cx), -o/-O take a value, and the script is the first argument after the options
 * (or after "--").
 */
function shellCommand(args) {
  let command = false;
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (t === '--' || t === '-') {
      i++;
      break;
    }
    if (/^--./.test(t)) {
      if (t === '--rcfile' || t === '--init-file') i++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(t)) break;
    if (t[0] === '-' && t.includes('c')) command = true;
    i += (t.match(/[oO]/g) || []).length;
  }
  return { command, script: command && i < args.length ? args[i].text : null };
}

/** pwsh / powershell.exe parameters that take a value (full names and their documented aliases). */
const PWSH_VALUE_NAMES = [
  'executionpolicy', 'inputformat', 'outputformat', 'windowstyle', 'workingdirectory', 'configurationname',
  'configurationfile', 'custompipename', 'settingsfile', 'psconsolefile', 'version',
];
const PWSH_VALUE_ALIASES = new Set(['ex', 'ep', 'inp', 'if', 'o', 'of', 'w', 'wd', 'config', 'v']);

/**
 * What a pwsh / powershell.exe argument is. Parameters start with -, -- or / and match by prefix,
 * case-insensitively; the value may be glued with a colon (-Command:'x'). Returns null for a positional
 * word, else { kind: 'command' | 'encoded' | 'file' | 'value' | 'switch', attached, wd? }; wd marks
 * -WorkingDirectory. An empty attached value (-File: x) takes the next word, as PowerShell does.
 */
function pwshOption(text) {
  const m = /^(?:--?|\/)([A-Za-z][A-Za-z0-9]*)(?::([\s\S]*))?$/.exec(text);
  if (!m || (text[0] === '/' && m[2] !== undefined)) return null;
  const n = m[1].toLowerCase();
  const attached = m[2];
  if (n === 'c' || n === 'cwa' || (n.length >= 2 && ('command'.startsWith(n) || 'commandwithargs'.startsWith(n)))) {
    return { kind: 'command', attached };
  }
  if (n === 'wd' || (n.length >= 2 && 'workingdirectory'.startsWith(n))) return { kind: 'value', attached, wd: true };
  if (PWSH_VALUE_ALIASES.has(n)) return { kind: 'value', attached };
  if (n === 'ec' || n === 'ea' || 'encodedcommand'.startsWith(n) || 'encodedarguments'.startsWith(n)) return { kind: 'encoded', attached };
  if (n === 'f' || 'file'.startsWith(n)) return { kind: 'file', attached };
  if (n.length >= 2 && PWSH_VALUE_NAMES.some((v) => v.startsWith(n))) return { kind: 'value', attached };
  return { kind: 'switch', attached };
}

/**
 * pwsh / powershell.exe started from either shell: -Command (and the rest of the line) is checked as
 * PowerShell, -EncodedCommand asks, -File runs a script (allowed, like running a script from Bash) unless
 * the script is `-` (read from the pipeline). A first positional word is a command for powershell.exe
 * and a script file for pwsh; it is checked as a command either way, which costs nothing for a file name.
 * -WorkingDirectory becomes the directory of the nested check (unknown when it is a run-time value).
 */
function checkPwsh(args, ctx, cwdIn, depth) {
  const env = { ...pathEnv(ctx), pwsh: true };
  let cwd = cwdIn;
  const script = (words) => {
    if (!words.length) return ALLOW;
    if (words.length === 1 && words[0].text === '-') return ask(t(MSG, 'psPipeline', { cmd: 'pwsh -Command -' }));
    const dyn = words.find((w) => w.dynamic);
    if (dyn) return ask(t(MSG, 'psDynamic', { cmd: 'pwsh -Command', arg: dyn.text }));
    return nestedPs(words.map((w) => w.text).join(' '), ctx, cwd, depth);
  };
  for (let i = 0; i < args.length; i++) {
    const opt = pwshOption(args[i].text);
    if (!opt) return script(args.slice(i));
    const attached = opt.attached ? { text: opt.attached, dynamic: args[i].dynamic } : null;
    if (opt.kind === 'command') return script([...(attached ? [attached] : []), ...args.slice(i + 1)]);
    if (opt.kind === 'encoded') return ask(t(MSG, 'psEncoded'));
    if (opt.kind === 'file') {
      const file = attached || args[i + 1];
      return file?.text === '-' ? ask(t(MSG, 'psPipeline', { cmd: 'pwsh -File -' })) : ALLOW;
    }
    if (opt.kind === 'value') {
      const value = attached || args[++i];
      if (opt.wd) cwd = psLocation(value, cwd, env);
    }
  }
  return ALLOW;
}

const NOT_PART = '(?<![\\w.-])';
const NOT_PART_AFTER = '(?![\\w.-])';
const CMD_GUARDED = new RegExp(`${NOT_PART}(?:git|rm|bash|sh|zsh|wsl|pwsh|powershell|cmd)(?:\\.exe)?${NOT_PART_AFTER}`, 'i');
const CMD_DELETE = new RegExp(`${NOT_PART}(?:rd|rmdir|del|erase)${NOT_PART_AFTER}`, 'i');
/** The switch that hands the rest of the line to cmd: /c, /k or /r (= /c), with MSYS's //c spelling. */
const CMD_RUN = /^\/{1,2}[ckr]/i;
/** A /s switch, alone or glued to other switches: /s, //s, /q/s, /S/Q (and rd/s, once split off the name). */
const isSwitchS = (tok) => tok[0] === '/' && tok.split('/').some((p) => p === 's' || p === 'S');

/**
 * The commands of a cmd line, split on & and | outside "…"; carets and quotes are dropped, as cmd drops
 * them (g^it and g"i"t run git). Carets go inside quotes too: cmd /c strips the outer quotes of its line
 * before parsing it. One pass, so a long line stays linear.
 */
function cmdSegments(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === '^') {
      if (!quoted && i + 1 < line.length) cur += line[++i];
    } else if (!quoted && (c === '&' || c === '|' || c === '\n')) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * cmd /c, /k or /r runs the rest with cmd's own syntax, which the guards do not parse. Ask when a command
 * of it mentions git, rm or another shell, or a delete name (rd, del…) with a /s switch after it; anything
 * else (cmd /c dir /s) passes, so ordinary Windows commands stay quiet. //c is how Git Bash users keep
 * MSYS from turning /c into C:/. Only the words after the first such switch are cmd's command line.
 */
function checkCmd(args) {
  const at = args.findIndex((a) => CMD_RUN.test(a.text));
  if (at === -1) return ALLOW;
  const dyn = args.find((a) => a.dynamic);
  if (dyn) return ask(t(MSG, 'psDynamic', { cmd: 'cmd /c', arg: dyn.text }));
  const line = [args[at].text.replace(CMD_RUN, ''), ...args.slice(at + 1).map((a) => a.text)].join(' ');
  for (const segment of cmdSegments(line)) {
    if (CMD_GUARDED.test(segment)) return ask(t(MSG, 'cmdRuns'));
    const m = CMD_DELETE.exec(segment);
    if (m && segment.slice(m.index + m[0].length).split(/\s+/).some(isSwitchS)) return ask(t(MSG, 'cmdRuns'));
  }
  return ALLOW;
}

/** wsl options that take a value. */
const WSL_VALUE_OPTIONS = new Set(['-d', '--distribution', '-u', '--user', '--cd', '--shell-type', '--distribution-id']);

/**
 * What `wsl …` runs: { kind: 'none' } for management commands (--list, --shutdown…) and a bare wsl;
 * { kind: 'exec', words, cwd } for -e/--exec (the words run directly); { kind: 'shell', words, cwd } for
 * a command line after the options or after `--`, which the Linux shell reads. --cd and a leading ~ move
 * the command to a directory the guard does not know (cwd null).
 */
function wslCommand(args, cwdIn) {
  let cwd = cwdIn;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '~' && i === 0) cwd = null;
    else if (t === '--') return { kind: 'shell', words: args.slice(i + 1), cwd };
    else if (t === '-e' || t === '--exec') return { kind: 'exec', words: args.slice(i + 1), cwd };
    else if (WSL_VALUE_OPTIONS.has(t)) {
      if (t === '--cd') cwd = null;
      i++;
    } else if (t === '--system') continue;
    else if (t.startsWith('-')) return { kind: 'none' };
    else return { kind: 'shell', words: args.slice(i), cwd };
  }
  return { kind: 'none' };
}

/**
 * A word as wsl hands it to the Linux shell: the Windows command line quotes a word with whitespace (and
 * escapes its quotes), anything else goes as it is — so `wsl echo a '&&' git push` runs git push.
 */
const wslWord = (w) => {
  const text = w.text.replace(/"/g, '\\"');
  return text === '' || /\s/.test(text) ? `"${text}"` : text;
};

/** wsl from Bash or PowerShell: the command it runs is checked with the Bash rules. */
function checkWsl(args, ctx, cwd, depth) {
  const run = wslCommand(args, cwd);
  if (run.kind === 'none' || !run.words.length) return ALLOW;
  if (run.kind === 'shell') return nestedBash(run.words.map(wslWord).join(' '), ctx, run.cwd, depth);
  if (depth >= MAX_DEPTH) return ask(t(MSG, 'tooDeep'));
  const words = stripWrappers(run.words);
  if (words.envSplit) return ask(t(MSG, 'envSplit'));
  return words.length ? checkCommand(words, ctx, run.cwd, depth + 1) : ALLOW;
}

/** pwsh / powershell.exe that only runs a script file (-File), so extra arguments are the script's. */
function pwshRunsFile(args) {
  for (let i = 0; i < args.length; i++) {
    const opt = pwshOption(args[i].text);
    if (!opt || opt.kind === 'command' || opt.kind === 'encoded') return false;
    if (opt.kind === 'file') return true;
    if (opt.kind === 'value' && !opt.attached) i++;
  }
  return false;
}

const XARGS_GIT = new Set(['push', 'commit', 'reset']);

/**
 * xargs appends words from its input to the command, and the guard cannot see them: `echo --force |
 * xargs git push`. Ask where such words change the verdict — git push, commit and reset (or a git whose
 * subcommand comes from the input), rm -r (its targets come from the input), a shell -c without a script,
 * pwsh other than -File, cmd and wsl running a command. Plain `xargs rm` stays as quiet as plain rm.
 */
function xargsVerdict(name, args) {
  const unknown = (cmd) => ask(t(MSG, 'xargsArgs', { cmd }));
  if (name === 'git') {
    const sub = args[gitSubIndex(args)];
    if (!sub) return unknown('git');
    return XARGS_GIT.has(sub.text) ? unknown(`git ${sub.text}`) : ALLOW;
  }
  if (name === 'rm') return rmArgs(args).recursive ? unknown('rm -r') : ALLOW;
  if (SHELLS.has(name)) {
    const sh = shellCommand(args);
    return sh.command && sh.script === null ? unknown(`${name} -c`) : ALLOW;
  }
  if (name === 'pwsh' || name === 'powershell') return pwshRunsFile(args) ? ALLOW : unknown(name);
  if (name === 'cmd') return unknown(name);
  if (name === 'wsl') return wslCommand(args, null).kind === 'none' ? ALLOW : unknown(name);
  return ALLOW;
}

/** One command after stripWrappers: the shared rules, plus what xargs' input may add to it. */
function checkCommand(words, ctx, cwd, depth) {
  const name = commandName(words[0].text);
  const args = words.slice(1);
  const verdict = checkWords(name, args, ctx, cwd, depth);
  return words.stdinArgs ? combine([verdict, xargsVerdict(name, args)]) : verdict;
}

/**
 * Rules shared by the Bash and the PowerShell guard, by normalised command name (see GUARDED in
 * shell.mjs). depth is the shared nesting depth; cwd may be null (unknown) in PowerShell.
 */
function checkWords(name, args, ctx, cwd, depth) {
  if (SHELLS.has(name)) {
    const { script } = shellCommand(args);
    return script === null ? ALLOW : nestedBash(script, ctx, cwd, depth);
  }
  if (name === 'eval') {
    const script = args[0]?.text === '--' ? args.slice(1) : args;
    return script.length ? nestedBash(script.map((a) => a.text).join(' '), ctx, cwd, depth) : ALLOW;
  }
  if (name === 'pwsh' || name === 'powershell') return checkPwsh(args, ctx, cwd, depth);
  if (name === 'cmd') return checkCmd(args);
  if (name === 'wsl') return checkWsl(args, ctx, cwd, depth);
  if (name === 'git') return checkGit(args, ctx, cwd);
  if (name === 'rm') return checkRm(args, ctx, cwd);
  return ALLOW;
}

/**
 * Where `cd args` leads from cwd: home without a target, null (unknown) for `cd -`, a run-time path or a
 * relative path from an unknown directory. -L/-P/-e/-@ and `--` are skipped.
 */
function bashCd(args, cwd, env, ctx) {
  let i = 0;
  while (args[i] && /^-[LPe@]+$/.test(args[i].text)) i++;
  if (args[i]?.text === '--') i++;
  if (!args[i]) return env.home;
  if (args[i].dynamic && TOPLEVEL_SUB.test(args[i].text)) return toplevelOf(cwd, env, ctx);
  return args[i].text === '-' ? null : shLocation(args[i], cwd, env);
}

/** `$(git rev-parse --show-toplevel)` (or backticks) as a whole word: the top of the current repository. */
const TOPLEVEL_SUB = /^(?:\$\(\s*git(?:\.exe)?\s+rev-parse\s+--show-toplevel\s*\)|`\s*git(?:\.exe)?\s+rev-parse\s+--show-toplevel\s*`)$/;

/** The project root when cwd is inside it (same repository, same branch); otherwise unknown. */
function toplevelOf(cwd, env, ctx) {
  if (cwd === null || !ctx.root) return null;
  return isInside(ctx.root, cwd, env.api) ? ctx.root : null;
}

/**
 * ctx: { cwd, root, protectedBranches, currentBranch?, platform?, homedir?, tmpdir? (overrides for tests) }
 * ctx.cwd null means the directory is unknown (a nested script after a cd to a run-time path).
 * Returns { decision: 'allow' | 'ask' | 'deny', reason }.
 */
export function checkBash(command, ctx, depth = 0) {
  const verdicts = [];
  const env = pathEnv(ctx);
  let cwd = ctx.cwd === null ? null : ctx.cwd || ctx.root;
  const stack = [];
  for (const raw of splitCommands(command)) {
    // substitutions run before the command itself, whatever the command is
    for (const sub of raw.subs) verdicts.push(nestedBash(sub, ctx, cwd, depth));
    if (raw.unterminated) verdicts.push(ask(t(MSG, 'unterminated')));
    const words = stripWrappers(raw);
    if (words.envSplit) {
      verdicts.push(ask(t(MSG, 'envSplit')));
      continue;
    }
    if (!words.length) continue;
    const head = words[0].text;
    const args = words.slice(1);
    // cd, pushd and popd are builtins: only the exact name changes the shell's directory (/usr/bin/cd or CD do not)
    if (head === 'cd') {
      cwd = bashCd(args, cwd, env, ctx);
      continue;
    }
    if (head === 'pushd') {
      // pushd DIR; without a directory (or with +N / -N / -n) it rotates the stack: unknown
      const target = args.length === 1 && !/^[-+]/.test(args[0].text) ? args[0] : null;
      stack.push(cwd);
      cwd = target ? shLocation(target, cwd, env) : null;
      if (!target) stack.length = 0;
      continue;
    }
    if (head === 'popd') {
      cwd = !args.length && stack.length ? stack.pop() : null;
      if (cwd === null) stack.length = 0;
      continue;
    }
    verdicts.push(checkCommand(words, ctx, cwd, depth));
  }
  return combine(verdicts);
}

// ---------------------------------------------------------------------------------------------------
// PowerShell

/** Common parameters every cmdlet accepts. */
const COMMON_VALUES = {
  erroraction: ['ea'], warningaction: ['wa'], informationaction: ['infa'], errorvariable: ['ev'], warningvariable: ['wv'],
  informationvariable: ['iv'], outvariable: ['ov'], outbuffer: ['ob'], pipelinevariable: ['pv'], progressaction: ['proga'],
};
const COMMON_SWITCHES = { verbose: ['vb'], debug: ['db'], whatif: ['wi'], confirm: ['cf'] };
const paramSpec = (values, switches, targets) => ({
  values: { ...COMMON_VALUES, ...values },
  switches: { ...COMMON_SWITCHES, ...switches },
  targets,
});
const REMOVE_PARAMS = paramSpec(
  { path: [], literalpath: ['pspath', 'lp'], filter: [], include: [], exclude: [], credential: [], stream: [] },
  { recurse: [], force: [] },
  ['path', 'literalpath'],
);
const LOCATION_PARAMS = paramSpec({ path: [], literalpath: ['pspath', 'lp'], stackname: [] }, { passthru: [] }, ['path', 'literalpath']);
const START_PARAMS = paramSpec(
  {
    filepath: ['path', 'pspath'], argumentlist: ['args'], workingdirectory: [], credential: ['runas'], verb: [], windowstyle: [],
    redirectstandarderror: ['rse'], redirectstandardinput: ['rsi'], redirectstandardoutput: ['rso'], environment: [],
  },
  { wait: [], passthru: [], nonewwindow: ['nnw'], usenewenvironment: [], loaduserprofile: ['lup'] },
  ['filepath'],
);
const IEX_PARAMS = paramSpec({ command: [] }, {}, ['command']);
const ALIAS_PARAMS = paramSpec({ name: [], value: [], description: [], option: [], scope: [] }, { passthru: [], force: [] }, ['value']);

/**
 * How PowerShell binds a parameter word: by its full name or an alias, else by an unambiguous prefix,
 * case-insensitively. An ambiguous prefix (PowerShell refuses it) or an unknown name is read as a
 * switch, so the word after it still counts as a positional argument — a path stays a delete target
 * instead of being skipped as a value. A prefix shared by a target parameter and others binds to the target.
 */
function bindParam(n, spec, exact) {
  for (const [kind, table] of [['switch', spec.switches], ['value', spec.values]]) {
    for (const [name, aliases] of Object.entries(table)) if (name === n || aliases.includes(n)) return { kind, name };
  }
  if (exact) return null;
  const sw = Object.keys(spec.switches).filter((k) => k.startsWith(n));
  if (sw.length) return { kind: 'switch', name: sw[0] };
  const vals = Object.keys(spec.values).filter((k) => k.startsWith(n));
  if (!vals.length) return { kind: 'switch', name: n };
  return { kind: 'value', name: vals.find((k) => spec.targets.includes(k)) || vals[0] };
}

/**
 * A cmdlet's arguments as PowerShell binds them: { switches: [{ name, value? }], values: [{ name, word,
 * index }], positional: [{ word, index }], targets: words of target parameters and positional words }.
 * `--` ends the parameters; --name is not a cmdlet parameter, so it is positional. With `exact`, only
 * full names and aliases are parameters and any other -word is positional (see checkStartProcess).
 */
function psBind(args, spec, exact = false) {
  const switches = [];
  const values = [];
  const positional = [];
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!endOpts && w.text === '--') {
      endOpts = true;
      continue;
    }
    const m = endOpts ? null : /^-([A-Za-z_][\w-]*)(?::([\s\S]*))?$/.exec(w.text);
    if (!m) {
      positional.push({ word: w, index: i });
      continue;
    }
    // `-Path: build` — an empty value after the colon is the next word
    const attached = m[2] ? { text: m[2], dynamic: w.dynamic } : undefined;
    const p = bindParam(m[1].toLowerCase(), spec, exact);
    if (!p) {
      positional.push({ word: w, index: i });
      continue;
    }
    if (p.kind === 'switch') {
      // `-Recurse: $false`: only a boolean-looking word is taken, anything else stays positional (stricter)
      const next = m[2] === '' && args[i + 1] && /^(?:\$(?:true|false|null)|[01])$/i.test(args[i + 1].text) ? args[++i] : undefined;
      switches.push({ name: p.name, value: attached ?? next });
      continue;
    }
    const value = attached ?? args[++i];
    if (value) values.push({ name: p.name, word: value, index: i });
  }
  const targets = [...values.filter((v) => spec.targets.includes(v.name)), ...positional].sort((a, b) => a.index - b.index);
  return { switches, values, positional, targets: targets.map((x) => x.word) };
}

/** A switch is on unless it is explicitly set to false (-Recurse:$false, -Recurse:0). */
function switchOn(s) {
  return !s.value || !['$false', '0', '$null'].includes(s.value.text.toLowerCase());
}

/**
 * A PowerShell path argument as a file system path for deleteProblems, or null when it names another
 * provider: Registry::…, HKLM:\…, Env:, Cert:, Temp: (any drive name longer than a letter). On macOS/Linux
 * PowerShell takes \ as a separator too.
 */
function psPath(text, env) {
  let p = text;
  const prov = /^(?:[\w.]+\\)?([\w.]+)::([\s\S]*)$/.exec(p);
  if (prov) {
    if (prov[1].toLowerCase() !== 'filesystem') return null;
    p = prov[2];
  }
  if (/^[^\\/:]{2,}:/.test(p)) return null;
  return env.win ? p : p.replace(/\\/g, '/');
}

const PS_DELETE = new Set(['remove-item', 'rm', 'del', 'erase', 'ri', 'rd', 'rmdir']);
/** On macOS/Linux PowerShell drops the aliases that shadow native commands: rm and rmdir run /bin/rm and rmdir. */
const UNIX_NATIVE = new Set(['rm', 'rmdir']);
const PS_CD = new Set(['set-location', 'cd', 'sl', 'chdir']);
const PS_PUSHD = new Set(['push-location', 'pushd']);
const PS_POPD = new Set(['pop-location', 'popd']);
const PS_IEX = new Set(['invoke-expression', 'iex']);
const PS_START = new Set(['start-process', 'saps', 'start']);
const PS_ALIAS = new Set(['set-alias', 'sal', 'new-alias', 'nal']);
/** New-Item / Set-Item on the alias: drive define aliases too. */
const PS_ITEM = new Set(['new-item', 'ni', 'set-item', 'si']);
/** Alias targets that would hide a guarded command behind a new name. */
const PS_ALIAS_TARGETS = new Set([...GUARDED, ...PS_DELETE, ...PS_IEX, ...PS_START, 'invoke-command', 'icm']);
/**
 * Code built from a string at run time: the guard cannot see what it will run. Tested on the statement's
 * words joined with spaces, because a member call splits into words (`.AddScript`, `('…')`).
 */
const DYNAMIC_CODE =
  /\[(?:system\.)?(?:management\.)?(?:automation\.)?scriptblock\]\s*::\s*create\b|\.invokecommand\s*\.\s*(?:invokescript|newscriptblock)\b|\.add(?:script|command)\s*\(/i;
/** `$x =`, `$x +=`, `$x ??=` … in front of a command. */
const ASSIGN_OP = /^(?:[-+*/%]|\?\?)?=$/;
/** Keywords that take a pipeline after them: `return git push` runs git push. */
const PS_FLOW = new Set(['return', 'throw', 'exit']);
/**
 * PowerShell keywords that are also shell keywords in stripWrappers: their next word is a condition or
 * a block, not a command, so wrappers are not stripped after them.
 */
const PS_NO_STRIP = new Set(['if', 'while', 'do', 'until', 'else', '!', '{', '}', 'then', 'elif']);
/** `$alias:g` / `${alias:g}`: assigning to it defines an alias. */
const ALIAS_VARIABLE = /^\$\{?alias:/i;
/** A path on the alias: drive (alias:g, alias:\g, Alias::g, Microsoft.PowerShell.Core\Alias::g). */
const ALIAS_PATH = /^(?:[\w.]+\\)?alias::?/i;

const ITEM_PARAMS = paramSpec(
  { path: [], literalpath: ['pspath', 'lp'], name: [], itemtype: ['type'], value: [], filter: [], include: [], exclude: [], credential: [] },
  { force: [], passthru: [] },
  ['path', 'literalpath'],
);

/** PowerShell reads an en dash, em dash or horizontal bar as the parameter dash. */
const normDash = (w) => (/^[–—―]/.test(w.text) || /^-[–—―]/.test(w.text)
  ? { ...w, text: w.text.replace(/^[-–—―]+/, (m) => '-'.repeat(m.length)) }
  : w);

/** `@name`: a hashtable or array splatted into parameters, invisible to the check. */
const isSplat = (w) => w.dynamic && /^@[\p{L}\p{N}_]/u.test(w.text);

const LITERAL_ITEM = `'(?:[^']|'')*'|"[^"\`$]*"`;
const LITERAL_LIST = new RegExp(`^\\s*(?:(?:${LITERAL_ITEM})(?:\\s*,\\s*(?:${LITERAL_ITEM}))*)?\\s*$`);

/**
 * The elements of an `@( )` or `( )` argument made only of quoted literals ('push','origin'), which a
 * native command receives as separate arguments; null for any other word.
 */
function literalGroup(w) {
  const m = w.dynamic ? /^@?\(([\s\S]*)\)$/.exec(w.text) : null;
  if (!m || !LITERAL_LIST.test(m[1])) return null;
  return [...m[1].matchAll(new RegExp(LITERAL_ITEM, 'g'))].map(([q]) => ({
    text: q[0] === "'" ? q.slice(1, -1).replace(/''/g, "'") : q.slice(1, -1),
    dynamic: false,
  }));
}

/**
 * The directory a location word leads to from cwd, or null when it is unknown: no word, a run-time
 * value, history (- / +), another provider, or a relative path from an unknown directory.
 */
function psLocation(word, cwd, env) {
  const p = word && !word.dynamic && word.text !== '-' && word.text !== '+' ? psPath(word.text, env) : null;
  return p === null || (cwd === null && !isAbsoluteFor(p, env)) ? null : resolvePath(p, cwd, env);
}

function isRecurseFlag(tok) {
  const name = tok.slice(1).split(':')[0];
  return tok === '--recursive' || (/^-[a-z]{1,3}$/.test(tok) && tok.includes('r')) || (tok.startsWith('-') && name.length > 0 && 'recurse'.startsWith(name));
}

/**
 * A command whose name is only known at run time (`& $exe …`, Start-Process $exe) asks only when its
 * arguments look like the guarded operations: a git push/reset/commit subcommand or a recursive-delete
 * flag. Variables holding tool paths (`& $python script.py`, `& $msbuild /m`) are everyday PowerShell;
 * asking on all of them would train the user to click through, while the dangerous calls still read as
 * dangerous from their arguments alone.
 */
function looksDangerous(args) {
  const tokens = args.flatMap((a) => a.text.split(/\s+/)).map((s) => s.toLowerCase().replace(/^[–—―]/, '-'));
  return tokens.some((tok) => ['push', 'reset', 'commit'].includes(tok) || isRecurseFlag(tok));
}

/**
 * Remove-Item and its aliases: with -Recurse the targets go through the same rule as rm -r. A splat
 * may carry -Recurse and the path, so it asks unless recursion is explicitly off (-Recurse:$false).
 */
function checkRemoveItem(display, args, ctx, cwd, env) {
  const b = psBind(args, REMOVE_PARAMS);
  const recurse = b.switches.filter((s) => s.name === 'recurse');
  const splat = args.find(isSplat);
  if (splat && !recurse.some((s) => !switchOn(s))) return ask(t(MSG, 'psSplat', { cmd: display, arg: splat.text }));
  if (!recurse.some(switchOn)) return ALLOW;
  if (!b.targets.length) return ask(t(MSG, 'psPipeline', { cmd: `${display} -Recurse` }));
  const problems = deleteProblems(b.targets, ctx, cwd, env, (p) => psPath(p, env));
  return problems.length ? ask(t(MSG, 'removeOutside', { problems: problems.join(', ') })) : ALLOW;
}

/**
 * git from PowerShell: an argument made of quoted literals in @( ) or ( ) is passed as its elements
 * (git @('push','origin','main') is git push origin main) and checked as such. A splat or any other
 * group may hide a flag or the branch, so it asks when the subcommand is push, commit or reset, or is
 * itself hidden. Variables and $( ) pass, as in the Bash guard.
 */
function checkPsGit(args, ctx, cwd) {
  const words = [];
  const opaque = [];
  for (const a of args) {
    const items = literalGroup(a);
    if (items) {
      words.push(...items);
      continue;
    }
    // (git branch --show-current) is read by checkPush as the current branch
    if (isSplat(a) || (a.dynamic && /^@?\(/.test(a.text) && !CURRENT_BRANCH_GROUP.test(a.text))) opaque.push(a);
    words.push(a);
  }
  const verdict = checkGit(words, ctx, cwd);
  if (!opaque.length) return verdict;
  const sub = words[gitSubIndex(words)];
  if (!sub || (!opaque.includes(sub) && !['push', 'commit', 'reset'].includes(sub.text))) return verdict;
  const cmd = opaque.includes(sub) ? 'git' : `git ${sub.text}`;
  return combine([verdict, ask(t(MSG, 'psGitArgs', { cmd, arg: opaque[0].text }))]);
}

/**
 * Invoke-Expression: a literal script is checked again; a dynamic one or pipeline input asks.
 * Returns { verdict, moved }: the script runs in the current scope, so its Set-Location counts.
 */
function checkIex(display, args, ctx, cwd, depth) {
  const b = psBind(args, IEX_PARAMS);
  const words = b.targets;
  if (!words.length) return { verdict: ask(t(MSG, 'psPipeline', { cmd: display })), moved: false };
  const dyn = words.find((w) => w.dynamic);
  if (dyn) return { verdict: ask(t(MSG, 'psDynamic', { cmd: display, arg: dyn.text })), moved: true };
  return nestedPsRun(words.map((w) => w.text).join(' '), ctx, cwd, depth);
}

/**
 * Start-Process: the program (-FilePath or the first positional word) runs with -ArgumentList (or the
 * other positional words) as its command line, in -WorkingDirectory when given. With literal values that
 * line is checked as a PowerShell call, so git, the shells, pwsh and cmd get their usual rules; any other
 * program passes. A splat may carry the program and its arguments, so it asks.
 */
function checkStartProcess(args, ctx, cwd, depth) {
  const splat = args.find(isSplat);
  if (splat) return ask(t(MSG, 'psSplat', { cmd: 'Start-Process', arg: splat.text }));
  // The splitter drops quotes, so the '-f' of `saps git 'push','-f'` looks like a -FilePath prefix:
  // read the words both with prefix binding and with exact names only, and keep the stricter verdict.
  return combine([startProcessLine(psBind(args, START_PARAMS), ctx, cwd, depth), startProcessLine(psBind(args, START_PARAMS, true), ctx, cwd, depth)]);
}

function startProcessLine(b, ctx, cwd, depth) {
  const named = b.values.find((v) => v.name === 'filepath');
  const file = named ? named.word : b.positional[0]?.word;
  if (!file) return ALLOW;
  const argItems = [...b.values.filter((v) => v.name === 'argumentlist'), ...b.positional.filter((p) => p.word !== file)];
  const argWords = argItems.sort((a, c) => a.index - c.index).map((x) => x.word);
  if (file.dynamic) return looksDangerous(argWords) ? ask(t(MSG, 'psDynamicCall', { name: file.text })) : ALLOW;
  const name = commandName(file.text);
  const dyn = argWords.find((w) => w.dynamic);
  if (dyn) return GUARDED.has(name) ? ask(t(MSG, 'psDynamic', { cmd: `Start-Process ${file.text}`, arg: dyn.text })) : ALLOW;
  const wd = b.values.find((v) => v.name === 'workingdirectory');
  const runCwd = wd ? psLocation(wd.word, cwd, { ...pathEnv(ctx), pwsh: true }) : cwd;
  const line = `& '${file.text.replace(/'/g, "''")}' ${argWords.map((w) => w.text).join(' ')}`;
  return nestedPs(line, ctx, runCwd, depth);
}

/** An alias value that is run-time or a guarded command would let a later call slip past the name check. */
function aliasVerdict(value) {
  return value.dynamic || PS_ALIAS_TARGETS.has(commandName(value.text)) ? ask(t(MSG, 'psAlias', { name: value.text })) : ALLOW;
}

/** Set-Alias / New-Alias pointing at a guarded command. */
function checkAlias(args) {
  const splat = args.find(isSplat);
  if (splat) return ask(t(MSG, 'psSplat', { cmd: 'Set-Alias', arg: splat.text }));
  const b = psBind(args, ALIAS_PARAMS);
  const named = b.values.find((v) => v.name === 'value');
  const hasName = b.values.some((v) => v.name === 'name');
  const value = named ? named.word : b.positional[hasName ? 0 : 1]?.word;
  return value ? aliasVerdict(value) : ALLOW;
}

/** New-Item / Set-Item alias:name value — the same as Set-Alias; other paths pass. */
function checkItem(display, args) {
  const b = psBind(args, ITEM_PARAMS);
  const named = b.values.filter((v) => ['path', 'literalpath', 'name'].includes(v.name)).map((v) => v.word);
  const paths = named.length ? named : b.positional.slice(0, 1).map((p) => p.word);
  if (!paths.some((w) => ALIAS_PATH.test(w.text))) return ALLOW;
  const value = b.values.find((v) => v.name === 'value')?.word ?? b.positional.map((p) => p.word).find((w) => !paths.includes(w));
  return value ? aliasVerdict(value) : ask(t(MSG, 'psPipeline', { cmd: display }));
}

/**
 * The guard for Claude Code's PowerShell tool: the same rules as checkBash (protected push, force,
 * --no-verify, reset --hard, recursive delete) read through PowerShell syntax (lib/pwsh.mjs). Anything
 * it cannot read statically — an unparseable script, encoded or piped code, code built at run time —
 * asks rather than passes. ctx as in checkBash; ctx.cwd null means the directory is unknown.
 */
export function checkPowerShell(command, ctx, depth = 0) {
  return psRun(command, ctx, depth).verdict;
}

/**
 * checkPowerShell plus `moved`: the script may change the location. The location belongs to the whole
 * session, not to a scope, so a Set-Location inside a block, a group or iex moves the caller too —
 * whether the block runs or not is unknown, so after such a statement the directory is unknown (null).
 */
function psRun(command, ctx, depth) {
  const verdicts = [];
  const env = { ...pathEnv(ctx), pwsh: true };
  let cwd = ctx.cwd === null ? null : ctx.cwd || ctx.root;
  let moved = false;
  const stack = [];
  const lost = () => {
    cwd = null;
    stack.length = 0;
    moved = true;
  };
  for (const raw of splitPowerShell(command).commands) {
    // groups and script blocks: checked where they are written, whether they run now or later
    let subMoved = false;
    for (const sub of raw.subs) {
      const r = nestedPsRun(sub, ctx, cwd, depth);
      verdicts.push(r.verdict);
      subMoved ||= r.moved;
    }
    if (subMoved) lost();
    if (raw.unterminated) verdicts.push(ask(t(MSG, 'psUnterminated')));
    let words = raw.words.map(normDash);
    if (DYNAMIC_CODE.test(words.map((w) => w.text).join(' '))) verdicts.push(ask(t(MSG, 'psScriptCode')));
    let k = 0;
    for (;;) {
      const w = words[k];
      if (w && w.dynamic && w.text.includes('$') && words[k + 1] && ASSIGN_OP.test(words[k + 1].text)) {
        if (ALIAS_VARIABLE.test(w.text) && words[k + 2]) verdicts.push(aliasVerdict(words[k + 2]));
        k += 2;
      } else if (w && !w.dynamic && PS_FLOW.has(w.text.toLowerCase())) k++;
      else break;
    }
    words = words.slice(k);
    if (words.length && !words[0].dynamic && !PS_NO_STRIP.has(words[0].text.toLowerCase())) words = stripWrappers(words);
    if (words.envSplit) {
      verdicts.push(ask(t(MSG, 'envSplit')));
      continue;
    }
    if (!words.length) continue;
    const head = words[0];
    const args = words.slice(1);
    if (words.stdinArgs && !head.dynamic) verdicts.push(xargsVerdict(commandName(head.text), args));
    if (head.dynamic) {
      if (looksDangerous(args)) verdicts.push(ask(t(MSG, 'psDynamicCall', { name: head.text })));
      continue;
    }
    const name = commandName(head.text);
    if (PS_CD.has(name) || PS_PUSHD.has(name)) {
      if (PS_PUSHD.has(name)) stack.push(cwd);
      cwd = psLocation(psBind(args, LOCATION_PARAMS).targets[0], cwd, env);
      moved = true;
      continue;
    }
    if (PS_POPD.has(name)) {
      cwd = stack.length ? stack.pop() : null;
      moved = true;
      continue;
    }
    if (PS_DELETE.has(name) && (env.win || !UNIX_NATIVE.has(name))) verdicts.push(checkRemoveItem(head.text, args, ctx, cwd, env));
    else if (PS_IEX.has(name)) {
      const r = checkIex(head.text, args, ctx, cwd, depth);
      verdicts.push(r.verdict);
      if (r.moved) lost();
    } else if (PS_START.has(name)) verdicts.push(checkStartProcess(args, ctx, cwd, depth));
    else if (PS_ALIAS.has(name)) verdicts.push(checkAlias(args));
    else if (PS_ITEM.has(name)) verdicts.push(checkItem(head.text, args));
    else if (name === 'git') verdicts.push(checkPsGit(args, ctx, cwd));
    else verdicts.push(checkWords(name, args, ctx, cwd, depth));
  }
  return { verdict: combine(verdicts), moved };
}

/** Case-insensitive on every OS: Windows and default macOS file systems treat .ENV and .env as one file. */
export function checkFile(file, { root, protectedFiles }) {
  const rel = relToRoot(root, file);
  const hit = matchList(rel, protectedFiles, { nocase: true });
  if (!hit) return ALLOW;
  return deny(t(MSG, 'fileProtected', { rel, hit }));
}
