import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { currentBranch } from './git.mjs';
import { matchList } from './glob.mjs';
import { isInside, relToRoot } from './paths.mjs';
import { splitCommands, stripWrappers } from './shell.mjs';

export const ALLOW = { decision: 'allow', reason: '' };
const deny = (reason) => ({ decision: 'deny', reason });
const ask = (reason) => ({ decision: 'ask', reason });

const TMP_ROOTS = [...new Set([tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'])];

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

function resolvePath(p, cwd) {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
  return resolve(cwd, p);
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

function checkPush(args, ctx, cwd) {
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
      positional.push(...args.slice(i + 1).map((a) => a.text));
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
    positional.push(t);
  }
  if (mirror) return deny('forge: git push --mirror перезаписывает все ветки удалённого репозитория — запрещено.');

  const refspecs = positional.slice(1);
  const targets = [];
  let forcedRef = false;
  if (!refspecs.length && !all) {
    const b = branchAt(ctx, cwd);
    if (b) targets.push(b);
  }
  for (const spec of refspecs) {
    let s = spec;
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
    if (dst === 'HEAD' || dst === '@') dst = branchAt(ctx, cwd) || dst;
    targets.push(dst.replace(/^refs\/heads\//, ''));
  }

  const hit = targets.find((t) => branchMatches(t, ctx.protectedBranches));
  if (hit) {
    return deny(
      `forge: push в защищённую ветку «${hit}» запрещён (git.protected_branches). ` +
        'Работай в отдельной ветке и предложи пользователю PR или слияние.',
    );
  }
  if (force || forcedRef) {
    if (lease) {
      return deny(
        `forge: git push --force запрещён, даже вместе с --force-with-lease: ${force ? '--force' : '+refspec'} отменяет проверку аренды. ` +
          'Используй только --force-with-lease.',
      );
    }
    return deny('forge: git push --force запрещён. Для своей ветки используй --force-with-lease.');
  }
  if (noVerify) return deny('forge: git push --no-verify обходит git-хуки проекта — запрещено.');
  if (all) return ask('forge: git push --all отправит все локальные ветки, включая защищённые. Подтверди.');
  return ALLOW;
}

function checkCommit(args) {
  const valueLetters = 'mFCct';
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '--') break;
    if (longOption(t, ['--no-verify']) === '--no-verify') return deny('forge: git commit --no-verify обходит pre-commit проверки проекта — запрещено.');
    if (t.startsWith('--')) {
      if (['--message', '--file', '--author', '--reuse-message', '--reedit-message', '--template', '--date', '--fixup', '--squash', '--trailer'].includes(t)) i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const l = letters[k];
        if (l === 'n') return deny('forge: git commit -n (--no-verify) обходит pre-commit проверки проекта — запрещено.');
        if (valueLetters.includes(l)) {
          if (k === letters.length - 1) i++;
          break;
        }
      }
    }
  }
  return ALLOW;
}

function checkGit(args, ctx, cwdIn) {
  let cwd = cwdIn;
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const t = args[i].text;
    if (t === '-C' && args[i + 1]) {
      cwd = resolvePath(args[i + 1].text, cwd);
      i += 2;
      continue;
    }
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(t)) {
      i += 2;
      continue;
    }
    i++;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1);
  if (sub === 'push') return checkPush(rest, ctx, cwd);
  if (sub === 'commit') return checkCommit(rest);
  if (sub === 'reset' && rest.some((a) => longOption(a.text, ['--hard']) === '--hard')) {
    return ask('forge: git reset --hard безвозвратно сотрёт незакоммиченные изменения. Подтверди.');
  }
  return ALLOW;
}

function checkRm(args, ctx, cwd) {
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
  if (!recursive) return ALLOW;
  const problems = [];
  for (const t of targets) {
    if (t.dynamic) {
      problems.push(`${t.text} (путь известен только во время выполнения)`);
      continue;
    }
    let p = t.text;
    const glob = p.search(/[*?[]/);
    if (glob !== -1) p = p.slice(0, glob);
    const abs = resolvePath(p || '.', cwd);
    if (abs === '/' || abs === homedir() || isInside(abs, ctx.root)) {
      // the filesystem root, home, the project itself or one of its ancestors
      problems.push(`${t.text} → ${abs}`);
      continue;
    }
    if (isInside(ctx.root, abs)) continue;
    if (TMP_ROOTS.some((r) => isInside(r, abs) && abs !== r)) continue;
    problems.push(`${t.text} → ${abs}`);
  }
  if (!problems.length) return ALLOW;
  return ask(`forge: rm -r за пределами проекта или по непредсказуемому пути: ${problems.join(', ')}. Подтверди.`);
}

/** How deep bash -c scripts and $(...) / `...` / <(...) substitutions are inspected; deeper ones ask. */
const MAX_DEPTH = 3;
const TOO_DEEP = 'forge: слишком глубокая вложенность bash -c или подстановок $(...) — не могу проверить команду целиком. Подтверди.';
const UNTERMINATED =
  'forge: незакрытая подстановка ($(...), `...`, ${...} или <(...)) — не могу проверить, что она выполнит. Подтверди.';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/**
 * The script of `bash -c script`: -c may sit in any short-option cluster (-lc, -xc, -cx), -o/-O take
 * a value, and the script is the first argument after the options (or after "--"). null without -c.
 */
function shellScript(args) {
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
  return command && i < args.length ? args[i].text : null;
}

/**
 * ctx: { cwd, root, protectedBranches, currentBranch? (override for tests) }
 * Returns { decision: 'allow' | 'ask' | 'deny', reason }.
 */
export function checkBash(command, ctx, depth = 0) {
  const verdicts = [];
  let cwd = ctx.cwd || ctx.root;
  const nested = (script) => (depth < MAX_DEPTH ? checkBash(script, { ...ctx, cwd }, depth + 1) : ask(TOO_DEEP));
  for (const raw of splitCommands(command)) {
    // substitutions run before the command itself, whatever the command is
    for (const sub of raw.subs) verdicts.push(nested(sub));
    if (raw.unterminated) verdicts.push(ask(UNTERMINATED));
    const words = stripWrappers(raw);
    if (!words.length) continue;
    const name = basename(words[0].text);
    const args = words.slice(1);
    if (name === 'cd') {
      if (args[0] && !args[0].dynamic) cwd = resolvePath(args[0].text, cwd);
      continue;
    }
    if (SHELLS.has(name)) {
      const script = shellScript(args);
      if (script !== null) verdicts.push(nested(script));
      continue;
    }
    if (name === 'eval') {
      const script = args[0]?.text === '--' ? args.slice(1) : args;
      if (script.length) verdicts.push(nested(script.map((a) => a.text).join(' ')));
      continue;
    }
    if (name === 'git') verdicts.push(checkGit(args, ctx, cwd));
    else if (name === 'rm') verdicts.push(checkRm(args, ctx, cwd));
  }
  return combine(verdicts);
}

export function checkFile(file, { root, protectedFiles }) {
  const rel = relToRoot(root, file);
  const hit = matchList(rel, protectedFiles);
  if (!hit) return ALLOW;
  return deny(
    `forge: файл «${rel}» защищён (паттерн «${hit}» в protected_files). ` +
      'Не редактируй его; если правка действительно нужна — попроси пользователя.',
  );
}
