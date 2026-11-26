import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { bumpVersion, checkChangelog, compareVersions, parseChangelog, parseSemver, releaseChangelog, releaseSeparator, suggestBump, unreleasedEntryCount } from './changelog.mjs';
import { detectProfile } from './detect.mjs';
import { checkDocs, fixDocs } from './docs.mjs';
import { editsSize, filesSince, maybeRotate } from './edits.mjs';
import { addExcludes, currentBranch, defaultBranch, excludedLines, headSha, isClean, isGitRepo, latestVersionTag, tagExists } from './git.mjs';
import { defineCatalog, t } from './i18n.mjs';
import { initLang } from './lang.mjs';
import { forgePath, pluginRoot, projectRoot } from './paths.mjs';
import { MODES, WORK_PRESETS, commandSpec, loadProfile, profilePath, workPaths } from './profile.mjs';
import { checkModels, modelEnv, tableAliases } from './models.mjs';
import { readVersions, writeVersion } from './release.mjs';
import { effectiveTable, loadRouting, resolveRoute } from './route.mjs';
import { doctorShellLine, shellPath } from './sh.mjs';
import { superpowersEnabled } from './settings.mjs';
import { getPath, loadState, parseValue, saveState, setPath, updateState, validateStateValue } from './state.mjs';
import { errorLogPath, writeJsonAtomic } from './util.mjs';
import { failureReport, runSteps, summarize } from './verify.mjs';

export const EXCLUDES = ['.forge/state.json', '.forge/edits.jsonl', '.forge/work/', '.forge/log/'];

const MSG = defineCatalog({
  en: {
    help: `forge — forge plugin CLI

  forge init [--yes] [--force]    detect the stack and create .forge/profile.json (without --yes, preview only)
  forge init --work local|docs    where specs and plans go: local (.forge/work/) or docs (docs/specs, docs/plans)
  forge state [get [key]]         show the state (or a single field, e.g. task.slug)
  forge state set <key> <value>…  change fields: forge state set tier 2 stage plan
  forge state reset               reset the state
  forge mode [eco|normal|max]     show or switch the routing mode
  forge route <role> [--json]     model and effort for a role in the current mode
  forge route --table             the whole table for the current mode
  forge work <slug> [--json]      where the spec and plan of a feature live (work in the profile)
  forge verify [--fast] [--json]  run the verification steps from the profile
  forge docs [--fix] [--json]     check AGENTS.md/CLAUDE.md (--fix creates missing CLAUDE.md links)
  forge release [--check] [major|minor|patch|x.y.z] [--yes] [--date YYYY-MM-DD] [--json]
                                  release a version: --check validates the changelog, without --yes it is a preview,
                                  with --yes it moves [Unreleased] into the version, updates version files, commits and tags
  forge doctor                    check the installation and the profile`,
    unknownCommand: 'unknown command "{cmd}". forge help',
    internalError: 'internal error: {error}',
    unknownArg: 'unknown argument "{arg}"',
    extraArg: 'extra argument "{arg}"',

    stack: 'Stack: {stack}',
    initPreview: 'The profile will be written to {file}:',
    initPreviewExists: 'The profile will be written to {file} (already exists — --force required):',
    initWriteHint: '\nWrite it: {cmd}',
    initExists: '{file} already exists. Overwrite: forge init --yes --force',
    initWritten: 'Wrote {file} (stack: {stack}).',
    excludesAdded: 'Added to .git/info/exclude: {list}',
    excludesPresent: 'The .git/info/exclude entries are already in place.',
    notGitRepo: 'Not a git repository: no excludes were set up.',

    stateReset: 'State reset (mode and cursors kept).',
    statePairs: 'expected pairs: forge state set <key> <value> [<key> <value>…]',
    stateUnknown: 'unknown state command {sub}',

    modeLine: 'Mode: {mode}',
    modeInvalid: 'mode must be one of: {modes}',
    modeWarn: '! routing overrides from the profile were ignored: {warning}',
    routeWarn: 'forge: routing from the profile was ignored: {warning}',
    routeNeedRole: 'specify a role: forge route <role>',
    workNeedSlug: 'specify a feature slug: forge work <slug>',
    workBadSlug: 'invalid slug "{slug}": use lowercase latin letters, digits and single hyphens (e.g. add-login)',
    initWorkBad: '--work takes local or docs{got}',

    noProfile: 'no profile — run forge init first',
    noSteps: 'verify.steps is empty — nothing to verify',

    docsOk: 'Agent files are in order',
    docsCreated: 'created {path}',
    docsSkipped: 'skipped {path}: {reason}',

    notConfigured: 'the release section is not configured in the profile — forge init will suggest it if the project is released',
    changelogOk: 'Changelog is in order',
    changelogReadFail: 'could not read the file ({error})',
    changelogMissing: 'changelog file not found',
    versionUnreadable: 'version could not be read: {error}',
    versionMismatch: 'version is {found}, current is {current}',
    tagMissing: 'version {version} is released, but tag {tag} does not exist',

    dateInvalid: '--date: a date in YYYY-MM-DD format is required, got "{value}"',
    badLevel: 'level must be major, minor, patch or a version x.y.z, got "{arg}"',
    checkConflict: '--check cannot be combined with --yes, a level or --date',
    needTarget: 'specify a level or version: forge release <major|minor|patch|x.y.z> --yes',
    profileError: 'profile: {error}',
    profileFix: 'profile: {error} — fix the release section (forge release --check)',
    notRepo: 'this is not a git repository — nowhere to release',
    noCommits: 'the repository has no commits — make the first commit first',
    detached: 'HEAD is detached — switch to a branch',
    dirty: 'the working tree has uncommitted changes — commit or stash them',
    changelogUnreadable: '{file}: could not read ({error})',
    changelogNotFound: '{file}: changelog file not found',
    noUnreleased: 'no [Unreleased] section in {file}',
    emptyUnreleased: '[Unreleased] is empty — nothing to release',
    versionUnreadableAt: '{path}: version could not be read: {error}',
    versionOff: '{path}: version is {found}, current is {current} — reconcile the files: forge release --check',
    reasonVersion: 'version given explicitly',
    reasonLevel: 'level given explicitly',
    notGreater: 'version {next} is not greater than current {current}',
    tagExists: 'tag {tag} already exists',

    previewLevel: 'Level: {level} ({reason})',
    previewVersion: 'Version: {current} → {next}',
    previewDate: 'Date: {date}',
    previewFiles: 'Files:',
    tagLine: 'Tag: {tag}',
    commitLine: 'Commit: {commit}',
    releaseHint: 'Release: {command}',
    offBranch: '! releasing from a branch other than {main} (currently {branch})',
    rollbackFailed: 'Rollback failed: {error}',
    rollbackLeft: 'Left behind: commit {sha} {commit} is at HEAD, the files contain version {next}, no tag. Undo manually: git reset --hard {before}',
    rollbackIndex: 'Index not reset: {error}',
    rollbackIndexNote: 'The files were restored, but the index may still hold the staged versions — check git status; no tag was created.',
    rollbackDone: 'The files were restored, no tag was created.',
    gitAddFailed: 'git add failed: {error}',
    gitCommitFailed: 'git commit failed: {error}',
    gitTagFailed: 'git tag failed: {error}',
    released: 'Released version {next}',
    pushHint: 'Push: {command}',

    nodeOk: 'Node {version}',
    nodeOld: 'Node {version} (need ≥ 20)',
    pluginLine: 'Plugin: {path}',
    projectLine: 'Project: {path}',
    noProfileDoctor: 'No profile — forge init',
    profileInherited: 'Profile from the main checkout {path} (this worktree has none; forge init here creates its own)',
    profileValid: 'Profile is valid',
    commandMissing: 'command "{step}": executable not found in "{run}"',
    notExcluded: 'not excluded from git: {list} (forge init --yes --force or add them to .git/info/exclude)',
    excludedOk: 'Service files are excluded from git',
    routingWarn: 'routing: {warning}',
    routingOk: 'Routing table is valid',
    docsIssues: ({ mark, n }) => `${mark} Agent files: ${n} ${n === 1 ? 'issue' : 'issues'} — forge docs`,
    changelogIssues: ({ mark, n }) => `${mark} Changelog: ${n} ${n === 1 ? 'issue' : 'issues'} — forge release --check`,
    superpowers: 'Superpowers is enabled — disable it, it conflicts with forge',
    hookErrors: 'Recent hook errors:',
    noHookErrors: 'No hook errors',
  },
  ru: {
    help: `forge — CLI плагина forge

  forge init [--yes] [--force]    определить стек и создать .forge/profile.json (без --yes только показать)
  forge init --work local|docs    куда писать спеки и планы: local (.forge/work/) или docs (docs/specs, docs/plans)
  forge state [get [key]]         показать состояние (или одно поле, например task.slug)
  forge state set <key> <value>…  изменить поля: forge state set tier 2 stage plan
  forge state reset               сбросить состояние
  forge mode [eco|normal|max]     показать или переключить режим маршрутизации
  forge route <role> [--json]     модель и effort для роли в текущем режиме
  forge route --table             вся таблица текущего режима
  forge work <slug> [--json]      где лежат спека и план фичи (поле work профиля)
  forge verify [--fast] [--json]  прогнать шаги проверки из профиля
  forge docs [--fix] [--json]     проверить AGENTS.md/CLAUDE.md (--fix создаёт недостающие ссылки CLAUDE.md)
  forge release [--check] [major|minor|patch|x.y.z] [--yes] [--date YYYY-MM-DD] [--json]
                                  выпуск версии: --check проверяет журнал изменений, без --yes — предпросмотр,
                                  с --yes — переносит [Unreleased] в версию, правит файлы версий, коммит и тег
  forge doctor                    проверить установку и профиль`,
    unknownCommand: 'неизвестная команда «{cmd}». forge help',
    internalError: 'внутренняя ошибка: {error}',
    unknownArg: 'неизвестный аргумент «{arg}»',
    extraArg: 'лишний аргумент «{arg}»',

    stack: 'Стек: {stack}',
    initPreview: 'Профиль будет записан в {file}:',
    initPreviewExists: 'Профиль будет записан в {file} (уже существует — нужен --force):',
    initWriteHint: '\nЗаписать: {cmd}',
    initExists: '{file} уже существует. Перезаписать: forge init --yes --force',
    initWritten: 'Записан {file} (стек: {stack}).',
    excludesAdded: 'Добавлено в .git/info/exclude: {list}',
    excludesPresent: 'Исключения в .git/info/exclude уже настроены.',
    notGitRepo: 'Не git-репозиторий: исключения не настраивались.',

    stateReset: 'Состояние сброшено (режим и курсоры сохранены).',
    statePairs: 'ожидаются пары: forge state set <key> <value> [<key> <value>…]',
    stateUnknown: 'неизвестная команда state {sub}',

    modeLine: 'Режим: {mode}',
    modeInvalid: 'режим должен быть одним из: {modes}',
    modeWarn: '! переопределения routing из профиля проигнорированы: {warning}',
    routeWarn: 'forge: routing из профиля проигнорирован: {warning}',
    routeNeedRole: 'укажи роль: forge route <role>',
    workNeedSlug: 'укажи slug фичи: forge work <slug>',
    workBadSlug: 'некорректный slug «{slug}»: строчные латинские буквы, цифры и одиночные дефисы (например, add-login)',
    initWorkBad: '--work принимает local или docs{got}',

    noProfile: 'нет профиля — сначала forge init',
    noSteps: 'verify.steps пуст — нечего проверять',

    docsOk: 'Агентские файлы в порядке',
    docsCreated: 'создан {path}',
    docsSkipped: 'пропущен {path}: {reason}',

    notConfigured: 'раздел release в профиле не настроен — forge init предложит его, если проект выпускается',
    changelogOk: 'Журнал изменений в порядке',
    changelogReadFail: 'не удалось прочитать файл ({error})',
    changelogMissing: 'файл журнала изменений не найден',
    versionUnreadable: 'версия не прочитана: {error}',
    versionMismatch: 'версия {found}, а текущая {current}',
    tagMissing: 'версия {version} выпущена, а тега {tag} нет',

    dateInvalid: '--date: нужна дата ГГГГ-ММ-ДД, получено «{value}»',
    badLevel: 'уровень должен быть major, minor, patch или версия x.y.z, получено «{arg}»',
    checkConflict: '--check не сочетается с --yes, уровнем и --date',
    needTarget: 'укажи уровень или версию: forge release <major|minor|patch|x.y.z> --yes',
    profileError: 'профиль: {error}',
    profileFix: 'профиль: {error} — исправь раздел release (forge release --check)',
    notRepo: 'это не git-репозиторий — выпускать некуда',
    noCommits: 'в репозитории нет коммитов — сначала сделай первый коммит',
    detached: 'HEAD отсоединён — переключись на ветку',
    dirty: 'в рабочем дереве есть незакоммиченные изменения — закоммить или отложи их',
    changelogUnreadable: '{file}: не удалось прочитать ({error})',
    changelogNotFound: '{file}: файл журнала изменений не найден',
    noUnreleased: 'в {file} нет раздела [Unreleased]',
    emptyUnreleased: 'в [Unreleased] пусто — выпускать нечего',
    versionUnreadableAt: '{path}: версия не прочитана: {error}',
    versionOff: '{path}: версия {found}, а текущая {current} — сверь файлы: forge release --check',
    reasonVersion: 'версия задана явно',
    reasonLevel: 'уровень задан явно',
    notGreater: 'версия {next} не больше текущей {current}',
    tagExists: 'тег {tag} уже существует',

    previewLevel: 'Уровень: {level} ({reason})',
    previewVersion: 'Версия: {current} → {next}',
    previewDate: 'Дата: {date}',
    previewFiles: 'Файлы:',
    tagLine: 'Тег: {tag}',
    commitLine: 'Коммит: {commit}',
    releaseHint: 'Выпустить: {command}',
    offBranch: '! выпуск не с ветки {main} (сейчас {branch})',
    rollbackFailed: 'Откат не удался: {error}',
    rollbackLeft: 'Осталось: коммит {sha} {commit} лежит в HEAD, файлы содержат версию {next}, тега нет. Вернуть вручную: git reset --hard {before}',
    rollbackIndex: 'Индекс не сброшен: {error}',
    rollbackIndexNote: 'Файлы возвращены в исходное состояние, но в индексе могли остаться добавленные версии — проверь git status; тег не создан.',
    rollbackDone: 'Файлы возвращены в исходное состояние, тег не создан.',
    gitAddFailed: 'git add не удался: {error}',
    gitCommitFailed: 'git commit не удался: {error}',
    gitTagFailed: 'git tag не удался: {error}',
    released: 'Выпущена версия {next}',
    pushHint: 'Отправить: {command}',

    nodeOk: 'Node {version}',
    nodeOld: 'Node {version} (нужен ≥ 20)',
    pluginLine: 'Плагин: {path}',
    projectLine: 'Проект: {path}',
    noProfileDoctor: 'Профиля нет — forge init',
    profileInherited: 'Профиль из основного checkout {path} (в этом worktree своего нет; forge init здесь заведёт свой)',
    profileValid: 'Профиль валиден',
    commandMissing: 'команда «{step}»: не найден исполняемый файл в «{run}»',
    notExcluded: 'не исключены из git: {list} (forge init --yes --force или добавь в .git/info/exclude)',
    excludedOk: 'Служебные файлы исключены из git',
    routingWarn: 'routing: {warning}',
    routingOk: 'Таблица маршрутизации корректна',
    docsIssues: ({ mark, n }) => `${mark} Агентские файлы: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — forge docs`,
    changelogIssues: ({ mark, n }) => `${mark} Журнал изменений: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — forge release --check`,
    superpowers: 'Включён Superpowers — отключи его, он конфликтует с forge',
    hookErrors: 'Последние ошибки хуков:',
    noHookErrors: 'Ошибок хуков нет',
  },
});

/** Message for a fatal error outside any command; bin/forge prints it after `forge: `. */
export function internalErrorMessage(err) {
  return t(MSG, 'internalError', { error: err?.stack || err });
}

/** `forge verify` exit code when the steps were skipped for lack of a shell (Windows without Git Bash). */
export const EXIT_NO_SHELL = 4;

function out(s = '') {
  process.stdout.write(s + '\n');
}

function fail(msg, code = 2) {
  process.stderr.write(`forge: ${msg}\n`);
  return code;
}

function currentMode(profile, state) {
  return state.mode || profile.mode || 'normal';
}

function routingContext(root) {
  const { profile } = loadProfile(root);
  const state = loadState(root);
  const routing = loadRouting();
  const { table, warnings } = effectiveTable(routing, profile.routing);
  return { profile, state, routing, table, warnings, mode: currentMode(profile, state) };
}

function formatTable(routing, table, mode) {
  return Object.keys(routing.roles)
    .map((role) => {
      const r = resolveRoute(routing, table, mode, role);
      return `  ${role.padEnd(12)} ${`${r.model}/${r.effort}`.padEnd(14)} agent=${r.agent}`;
    })
    .join('\n');
}

/** Value of `--work <v>` / `--work=<v>`: undefined when the flag is absent, null when it has no value. */
function workFlag(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--work') {
      const v = args[i + 1];
      return v === undefined || v.startsWith('--') ? null : v;
    }
    if (args[i].startsWith('--work=')) return args[i].slice('--work='.length) || null;
  }
  return undefined;
}

function cmdInit(root, args) {
  const write = args.includes('--yes');
  const force = args.includes('--force');
  const workArg = workFlag(args);
  if (workArg !== undefined && !Object.hasOwn(WORK_PRESETS, workArg ?? '')) {
    return fail(t(MSG, 'initWorkBad', { got: workArg == null ? '' : ` (got "${workArg}")` }));
  }
  const { stack, profile, notes: detected, workNote } = detectProfile(root);
  // An explicit --work makes the "found docs/plans/" note moot; without it the note explains the proposal.
  const notes = workArg === undefined && workNote ? [workNote, ...detected] : detected;
  if (workArg !== undefined) profile.work = { ...WORK_PRESETS[workArg] };
  const file = profilePath(root);
  if (!write) {
    out(t(MSG, 'stack', { stack }));
    out(t(MSG, existsSync(file) ? 'initPreviewExists' : 'initPreview', { file }));
    out(JSON.stringify(profile, null, 2));
    for (const n of notes) out(`• ${n}`);
    out(t(MSG, 'initWriteHint', { cmd: `forge init --yes${workArg === undefined ? '' : ` --work ${workArg}`}` }));
    return 0;
  }
  if (existsSync(file) && !force) return fail(t(MSG, 'initExists', { file }), 1);
  mkdirSync(forgePath(root), { recursive: true });
  copyFileSync(join(pluginRoot(), 'config', 'profile.schema.json'), forgePath(root, 'profile.schema.json'));
  writeJsonAtomic(file, profile);
  out(t(MSG, 'initWritten', { file, stack }));
  if (isGitRepo(root)) {
    const added = addExcludes(root, EXCLUDES);
    out(added.length ? t(MSG, 'excludesAdded', { list: added.join(', ') }) : t(MSG, 'excludesPresent'));
  } else {
    out(t(MSG, 'notGitRepo'));
  }
  for (const n of notes) out(`• ${n}`);
  return 0;
}

function cmdState(root, args) {
  const [sub = 'get', ...rest] = args;
  if (sub === 'get') {
    const state = loadState(root);
    const value = rest[0] ? getPath(state, rest[0]) : state;
    out(typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2));
    return 0;
  }
  if (sub === 'reset') {
    saveState(root, { ...loadState(root), tier: 1, stage: null, task: null, artifacts: {}, failures: { verify_streak: 0 } });
    out(t(MSG, 'stateReset'));
    return 0;
  }
  if (sub === 'set') {
    if (!rest.length || rest.length % 2) return fail(t(MSG, 'statePairs'));
    const pairs = [];
    for (let i = 0; i < rest.length; i += 2) {
      const value = parseValue(rest[i + 1]);
      const err = validateStateValue(rest[i], value);
      if (err) return fail(err);
      pairs.push([rest[i], value]);
    }
    updateState(root, (s) => {
      for (const [k, v] of pairs) setPath(s, k, v);
    });
    out(pairs.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n'));
    return 0;
  }
  return fail(t(MSG, 'stateUnknown', { sub }));
}

function cmdMode(root, args) {
  const ctx = routingContext(root);
  const next = args[0];
  if (next) {
    if (!MODES.includes(next)) return fail(t(MSG, 'modeInvalid', { modes: MODES.join(', ') }));
    updateState(root, (s) => {
      s.mode = next;
    });
    out(t(MSG, 'modeLine', { mode: next }));
  } else {
    out(t(MSG, 'modeLine', { mode: ctx.mode }));
  }
  out(formatTable(ctx.routing, ctx.table, next || ctx.mode));
  for (const w of ctx.warnings) out(t(MSG, 'modeWarn', { warning: w }));
  return 0;
}

function cmdRoute(root, args) {
  const ctx = routingContext(root);
  for (const w of ctx.warnings) process.stderr.write(`${t(MSG, 'routeWarn', { warning: w })}\n`);
  if (args.includes('--table')) {
    out(t(MSG, 'modeLine', { mode: ctx.mode }));
    out(formatTable(ctx.routing, ctx.table, ctx.mode));
    return 0;
  }
  const role = args.find((a) => !a.startsWith('--'));
  if (!role) return fail(t(MSG, 'routeNeedRole'));
  let r;
  try {
    r = resolveRoute(ctx.routing, ctx.table, ctx.mode, role);
  } catch (err) {
    return fail(err.message);
  }
  out(args.includes('--json') ? JSON.stringify(r) : `role=${r.role} mode=${r.mode} agent=${r.agent} model=${r.model} effort=${r.effort}`);
  return 0;
}

function cmdWork(root, args) {
  const slug = args.find((a) => !a.startsWith('--'));
  if (!slug) return fail(t(MSG, 'workNeedSlug'));
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(t(MSG, 'workBadSlug', { slug }));
  const paths = workPaths(loadProfile(root).profile.work, slug);
  out(args.includes('--json') ? JSON.stringify(paths) : `spec=${paths.spec} plan=${paths.plan}`);
  return 0;
}

/** Shared by the CLI and the Stop hook: run verify, record the result in state. */
export function verifyAndRecord(root, profile, { fast = false, shell } = {}) {
  const state = loadState(root);
  const offset = state.verify?.edits_offset ?? 0;
  const size = editsSize(root);
  const from = 0 < offset && offset <= size ? offset : 0;
  const files = filesSince(root, from);
  const result = runSteps(root, profile, profile.verify.steps, { files, fast, ...(shell !== undefined && { shell }) });
  const ran = result.results.some((r) => !r.skipped);
  const next = updateState(root, (s) => {
    // No shell is an environment problem, not a failed check: ok is null (neither passed nor failed), the
    // user has nothing to be told about a failure (notified), and the failure streak does not move. The
    // cursor stays where it was: nothing was checked, so these edits are verified once the shell is there.
    s.verify = {
      at: new Date().toISOString(),
      ok: result.shellMissing ? null : result.ok,
      summary: summarize(result),
      failed_step: result.failed?.step ?? null,
      edits_offset: result.shellMissing ? from : size,
      notified: Boolean(result.shellMissing),
    };
    if (!result.shellMissing) {
      s.failures = { ...(s.failures || {}), verify_streak: result.ok ? 0 : (s.failures?.verify_streak || 0) + 1 };
      if (ran) delete s.shell_missing_notified; // commands run again: a later loss is news again
    }
  });
  // An absent docs cursor is not a consumer: the Stop hook sets it on first use and drops it when docs.remind is false.
  const docsOffset = Number.isInteger(next.docs?.offset) ? [next.docs.offset] : [];
  // Without a shell the verify cursor waits, but it must not hold the log forever (a machine may never get
  // Git Bash): at the size limit the log still rotates, and only those waiting edits are not verified later.
  const verifyOffset = result.shellMissing ? size : next.verify.edits_offset;
  if (maybeRotate(root, [verifyOffset, next.lint_offset, ...docsOffset])) {
    updateState(root, (s) => {
      s.verify.edits_offset = 0;
      s.lint_offset = 0;
      if (Number.isInteger(s.docs?.offset)) s.docs.offset = 0;
    });
  }
  return { result, streak: next.failures.verify_streak };
}

function cmdVerify(root, args) {
  const { exists, profile } = loadProfile(root);
  if (!exists) return fail(t(MSG, 'noProfile'), 1);
  if (!profile.verify.steps.length) return fail(t(MSG, 'noSteps'), 1);
  const { result, streak } = verifyAndRecord(root, profile, { fast: args.includes('--fast') });
  if (args.includes('--json')) {
    out(JSON.stringify({ ok: result.ok, summary: summarize(result), failed: result.failed?.step ?? null, streak, ...(result.shellMissing && { shell_missing: true }) }));
  } else {
    out(`${result.ok ? 'OK' : result.shellMissing ? 'SKIPPED' : 'FAIL'}: ${summarize(result)}`);
    if (!result.ok) out(failureReport(result));
  }
  if (result.shellMissing) return EXIT_NO_SHELL;
  return result.ok ? 0 : 1;
}

function reportDocs(issues) {
  if (!issues.length) {
    out(`✓ ${t(MSG, 'docsOk')}`);
    return;
  }
  for (const i of issues) out(`${i.level === 'error' ? '✗' : '!'} ${i.path}: ${i.message} [${i.code}]`);
}

function cmdDocs(root, args) {
  const unknown = args.filter((a) => a !== '--fix' && a !== '--json');
  if (unknown.length) return fail(`${t(MSG, 'unknownArg', { arg: unknown[0] })}. forge docs [--fix] [--json]`);
  const { profile } = loadProfile(root);
  const json = args.includes('--json');
  let issues = checkDocs(root, profile);
  if (args.includes('--fix')) {
    const { written, skipped } = fixDocs(root, issues);
    for (const p of written) if (!json) out(t(MSG, 'docsCreated', { path: p }));
    // stderr in --json mode keeps stdout parseable
    for (const s of skipped) (json ? (l) => process.stderr.write(`${l}\n`) : out)(t(MSG, 'docsSkipped', { path: s.path, reason: s.reason }));
    issues = checkDocs(root, profile);
  }
  if (json) out(JSON.stringify(issues));
  else reportDocs(issues);
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

/** Russian plural form (the ru catalog only): 1 замечание, 2 замечания, 5 замечаний (21 замечание, 11 замечаний). */
function plural(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

// ---- release ------------------------------------------------------------------------------

const RELEASE_LEVELS = ['major', 'minor', 'patch'];

const versionFilePath = (item) => (typeof item === 'object' && item ? item.path : item);

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Profile errors about the release section (release.* fields, or release itself not being an object). */
const releaseProfileErrors = (errors) => errors.filter((e) => /^release[.:]/.test(e));

/**
 * Changelog text and the current version: latest release in the changelog, else the latest version tag,
 * else the highest version among the version files, else 0.0.0.
 */
function readReleaseState(root, release) {
  const state = { text: null, parsed: null, readError: null, latestReleased: null, current: '0.0.0', source: null };
  const file = join(root, release.changelog);
  if (existsSync(file)) {
    try {
      state.text = readFileSync(file, 'utf8');
      state.parsed = parseChangelog(state.text);
    } catch (err) {
      state.readError = err.message;
    }
  }
  const versions = (state.parsed?.releases ?? []).map((r) => r.version).sort((a, b) => compareVersions(b, a));
  state.latestReleased = versions[0] ?? null;
  if (state.latestReleased) {
    state.current = state.latestReleased;
    state.source = 'changelog';
  } else {
    const tag = latestVersionTag(root, release.tag_prefix);
    if (tag) {
      state.current = tag.version;
      state.source = 'tag';
    } else {
      const fromFiles = readVersions(root, release)
        .filter((v) => !v.error && parseSemver(v.version))
        .map((v) => v.version)
        .sort((a, b) => compareVersions(b, a));
      if (fromFiles.length) {
        state.current = fromFiles[0];
        state.source = 'files';
      }
    }
  }
  return state;
}

/** Problems of the changelog and version files: [{ code, level, path?, message }]. */
function checkRelease(root, release, profileErrors = [], state = readReleaseState(root, release)) {
  const issues = releaseProfileErrors(profileErrors).map((message) => ({ code: 'profile-invalid', level: 'error', path: '.forge/profile.json', message }));
  if (state.text === null) {
    issues.push({
      code: 'changelog-missing',
      level: 'error',
      path: release.changelog,
      message: state.readError ? t(MSG, 'changelogReadFail', { error: state.readError }) : t(MSG, 'changelogMissing'),
    });
  } else {
    for (const i of checkChangelog(state.text)) issues.push({ ...i, path: release.changelog });
  }
  for (const v of readVersions(root, release)) {
    if (v.error) {
      issues.push({ code: 'version-file-unreadable', level: 'error', path: v.path, message: t(MSG, 'versionUnreadable', { error: v.error }) });
    } else if (v.version !== state.current) {
      issues.push({ code: 'version-mismatch', level: 'error', path: v.path, message: t(MSG, 'versionMismatch', { found: v.version, current: state.current }) });
    }
  }
  if (state.latestReleased && isGitRepo(root)) {
    const tag = `${release.tag_prefix}${state.latestReleased}`;
    if (!tagExists(root, tag)) {
      issues.push({ code: 'tag-missing', level: 'warn', message: t(MSG, 'tagMissing', { version: state.latestReleased, tag }) });
    }
  }
  return issues;
}

function cmdReleaseCheck(root, release, profileErrors, json) {
  const issues = checkRelease(root, release, profileErrors);
  if (json) out(JSON.stringify(issues));
  else if (!issues.length) out(`✓ ${t(MSG, 'changelogOk')}`);
  else for (const i of issues) out(`${i.level === 'error' ? '✗' : '!'} ${i.path ? `${i.path}: ` : ''}${i.message} [${i.code}]`);
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

function parseReleaseArgs(args) {
  const opts = { check: false, yes: false, json: false, date: null, target: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') opts.check = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--date' || a.startsWith('--date=')) {
      const value = a === '--date' ? args[++i] : a.slice('--date='.length);
      if (value === undefined || !isValidDate(value)) return { error: t(MSG, 'dateInvalid', { value: value ?? '' }) };
      opts.date = value;
    } else if (a.startsWith('-')) return { error: t(MSG, 'unknownArg', { arg: a }) };
    else if (opts.target) return { error: t(MSG, 'extraArg', { arg: a }) };
    else if (RELEASE_LEVELS.includes(a) || parseSemver(a)) opts.target = a;
    else return { error: t(MSG, 'badLevel', { arg: a }) };
  }
  return { opts };
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function cmdRelease(root, args) {
  const parsedArgs = parseReleaseArgs(args);
  if (parsedArgs.error) return fail(`${parsedArgs.error}. forge release [--check] [major|minor|patch|x.y.z] [--yes] [--date YYYY-MM-DD] [--json]`);
  const { opts } = parsedArgs;
  const { profile, errors: profileErrors } = loadProfile(root);
  const release = profile.release;
  if (!release) {
    const broken = releaseProfileErrors(profileErrors);
    if (broken.length) for (const e of broken) out(`✗ ${t(MSG, 'profileError', { error: e })}`);
    else out(`✗ ${t(MSG, 'notConfigured')}`);
    return 1;
  }
  if (opts.check) {
    if (opts.yes || opts.target || opts.date) return fail(t(MSG, 'checkConflict'));
    return cmdReleaseCheck(root, release, profileErrors, opts.json);
  }
  if (opts.yes && !opts.target) return fail(t(MSG, 'needTarget'));

  const refuse = (msg) => {
    out(`✗ ${msg}`);
    return 1;
  };
  const badProfile = releaseProfileErrors(profileErrors);
  if (badProfile.length) {
    for (const e of badProfile.slice(1)) out(`✗ ${t(MSG, 'profileError', { error: e })}`);
    return refuse(t(MSG, 'profileFix', { error: badProfile[0] }));
  }
  const inRepo = isGitRepo(root);
  if (opts.yes) {
    if (!inRepo) return refuse(t(MSG, 'notRepo'));
    // a release commit without a parent can't be undone with `git reset HEAD~1`, and there is nothing to be on
    if (!headSha(root)) return refuse(t(MSG, 'noCommits'));
    if (!currentBranch(root)) return refuse(t(MSG, 'detached'));
    if (!isClean(root)) return refuse(t(MSG, 'dirty'));
  }
  const state = readReleaseState(root, release);
  if (state.text === null) return refuse(t(MSG, state.readError ? 'changelogUnreadable' : 'changelogNotFound', { file: release.changelog, error: state.readError }));
  if (!state.parsed.unreleased) return refuse(t(MSG, 'noUnreleased', { file: release.changelog }));
  if (!unreleasedEntryCount(state.parsed)) return refuse(t(MSG, 'emptyUnreleased'));

  const versions = readVersions(root, release);
  const broken = versions.find((v) => v.error);
  if (broken) return refuse(t(MSG, 'versionUnreadableAt', { path: broken.path, error: broken.error }));
  if (opts.yes) {
    // never release over a mismatch: the new number would silently replace (maybe downgrade) a file's version
    const off = versions.find((v) => v.version !== state.current);
    if (off) return refuse(t(MSG, 'versionOff', { path: off.path, found: off.version, current: state.current }));
  }

  let level;
  let reason;
  let next;
  if (opts.target && parseSemver(opts.target)) {
    level = opts.target;
    reason = t(MSG, 'reasonVersion');
    next = opts.target;
  } else if (opts.target) {
    level = opts.target;
    reason = t(MSG, 'reasonLevel');
    next = bumpVersion(state.current, level);
  } else {
    ({ level, reason } = suggestBump(state.parsed, state.current));
    next = bumpVersion(state.current, level);
  }
  if (compareVersions(next, state.current) <= 0) return refuse(t(MSG, 'notGreater', { next, current: state.current }));
  const tag = `${release.tag_prefix}${next}`;
  if (inRepo && tagExists(root, tag)) return refuse(t(MSG, 'tagExists', { tag }));

  const date = opts.date || localToday();
  const commit = `chore(release): ${next}`;
  const files = [
    { path: release.changelog, from: '[Unreleased]', to: `[${next}]${releaseSeparator(state.text)}${date}` },
    ...versions.map((v) => ({ path: v.path, from: v.version, to: next })),
  ];
  let newChangelog;
  try {
    newChangelog = releaseChangelog(state.text, { version: next, date, tagPrefix: release.tag_prefix });
  } catch (err) {
    return refuse(err.message);
  }

  if (!opts.yes) {
    if (opts.json) {
      out(JSON.stringify({ level, reason, current: state.current, next, tag, files, commit }));
      return 0;
    }
    out(t(MSG, 'previewLevel', { level, reason }));
    out(t(MSG, 'previewVersion', { current: state.current, next }));
    out(t(MSG, 'previewDate', { date }));
    out(t(MSG, 'previewFiles'));
    for (const f of files) out(`  ${f.path}: ${f.from} → ${f.to}`);
    out(t(MSG, 'tagLine', { tag }));
    out(t(MSG, 'commitLine', { commit }));
    out('');
    out(t(MSG, 'releaseHint', { command: `forge release ${level}${opts.date ? ` --date ${opts.date}` : ''} --yes` }));
    return 0;
  }

  const branch = currentBranch(root);
  const main = defaultBranch(root);
  // like releaseReminderKey: without origin/HEAD, main and master are the default branches
  if (!(main ? branch === main : ['main', 'master'].includes(branch))) {
    out(t(MSG, 'offBranch', { main: main ?? 'main/master', branch }));
  }

  // Snapshot to restore byte-for-byte if any step fails after files were changed.
  const paths = files.map((f) => f.path);
  const originals = paths.map((p) => readFileSync(join(root, p)));
  const before = headSha(root);
  let committed = false;
  const rollback = (why) => {
    out(`✗ ${why}`);
    // mixed reset to the saved HEAD: drops the release commit (if any) and unstages, the files stay as written
    const reset = committed ? git(root, ['reset', '-q', before]) : git(root, ['reset', '-q', '--', ...paths]);
    if (!reset.ok && committed) {
      out(`✗ ${t(MSG, 'rollbackFailed', { error: reset.stderr || reset.stdout })}`);
      out(t(MSG, 'rollbackLeft', { sha: headSha(root)?.slice(0, 7) ?? '?', commit, next, before: before.slice(0, 7) }));
      return 1;
    }
    paths.forEach((p, i) => writeFileSync(join(root, p), originals[i]));
    if (!reset.ok) {
      out(`✗ ${t(MSG, 'rollbackIndex', { error: reset.stderr || reset.stdout })}`);
      out(t(MSG, 'rollbackIndexNote'));
      return 1;
    }
    out(t(MSG, 'rollbackDone'));
    return 1;
  };
  try {
    writeFileSync(join(root, release.changelog), newChangelog);
    for (const item of release.version_files) writeVersion(root, item, next);
  } catch (err) {
    return rollback(err.message);
  }
  const add = git(root, ['add', '--', ...paths]);
  if (!add.ok) return rollback(t(MSG, 'gitAddFailed', { error: add.stderr }));
  const com = git(root, ['commit', '-q', '-m', commit]);
  if (!com.ok) return rollback(t(MSG, 'gitCommitFailed', { error: com.stderr || com.stdout }));
  committed = true;
  const tagged = git(root, ['tag', '-a', tag, '-m', `release ${next}`]);
  if (!tagged.ok) return rollback(t(MSG, 'gitTagFailed', { error: tagged.stderr }));

  const sha = headSha(root) || '';
  if (opts.json) {
    out(JSON.stringify({ level, reason, current: state.current, next, tag, files, commit, sha, branch }));
    return 0;
  }
  out(`✓ ${t(MSG, 'released', { next })}`);
  out(t(MSG, 'commitLine', { commit: `${sha.slice(0, 7)} ${commit}` }));
  out(t(MSG, 'tagLine', { tag }));
  out(t(MSG, 'pushHint', { command: `git push origin ${branch} && git push origin ${tag}` }));
  return 0;
}

function binaryExists(command) {
  const first = command.trim().split(/\s+/)[0];
  if (!first || first.includes('=')) return true;
  const shell = shellPath();
  if (!shell) return true; // no shell to ask: unknown, not missing
  return spawnSync(shell, ['-c', `command -v ${first}`], { encoding: 'utf8' }).status === 0;
}

function tailLines(file, n) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter((l) => /^\d{4}-/.test(l)).slice(-n);
}

function cmdDoctor(root) {
  const ok = (s) => out(`✓ ${s}`);
  const bad = (s) => out(`✗ ${s}`);
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 20 ? ok : bad)(t(MSG, major >= 20 ? 'nodeOk' : 'nodeOld', { version: process.versions.node }));
  ok(t(MSG, 'pluginLine', { path: pluginRoot() }));
  ok(t(MSG, 'projectLine', { path: root }));
  const { exists, profile, errors, inherited } = loadProfile(root);
  if (inherited) ok(t(MSG, 'profileInherited', { path: inherited }));
  if (!exists) bad(t(MSG, 'noProfileDoctor'));
  else if (errors.length) errors.forEach((e) => bad(t(MSG, 'profileError', { error: e })));
  else ok(t(MSG, 'profileValid'));
  if (exists) {
    const shellLine = doctorShellLine();
    if (shellLine) (shellLine.ok ? ok : bad)(shellLine.text);
    for (const step of profile.verify.steps) {
      const spec = commandSpec(profile.commands[step]);
      if (spec && !binaryExists(spec.run)) bad(t(MSG, 'commandMissing', { step, run: spec.run }));
    }
    if (isGitRepo(root)) {
      const lines = excludedLines(root) || [];
      const missing = EXCLUDES.filter((e) => !lines.includes(e));
      if (missing.length) bad(t(MSG, 'notExcluded', { list: missing.join(', ') }));
      else ok(t(MSG, 'excludedOk'));
    }
  }
  const routing = loadRouting();
  const { table, warnings } = effectiveTable(routing, profile.routing);
  if (warnings.length) warnings.forEach((w) => bad(t(MSG, 'routingWarn', { warning: w })));
  else ok(t(MSG, 'routingOk'));
  const aliases = tableAliases(routing, table, currentMode(profile, loadState(root)));
  for (const issue of checkModels({ env: modelEnv(root), aliases })) (issue.level === 'ok' ? ok : (s) => out(`! ${s}`))(issue.message);
  const docIssues = checkDocs(root, profile);
  if (!docIssues.length) ok(t(MSG, 'docsOk'));
  else {
    const n = docIssues.length;
    out(t(MSG, 'docsIssues', { mark: docIssues.some((i) => i.level === 'error') ? '✗' : '!', n }));
  }
  if (profile.release) {
    const issues = checkRelease(root, profile.release, errors);
    if (!issues.length) ok(t(MSG, 'changelogOk'));
    else {
      const n = issues.length;
      out(t(MSG, 'changelogIssues', { mark: issues.some((i) => i.level === 'error') ? '✗' : '!', n }));
    }
  }
  if (superpowersEnabled(root)) bad(t(MSG, 'superpowers'));
  const logs = [...new Set([errorLogPath(root), join(tmpdir(), 'forge-errors.log')])];
  const recent = logs.flatMap((f) => tailLines(f, 5));
  if (recent.length) {
    bad(t(MSG, 'hookErrors'));
    recent.forEach((l) => out(`    ${l}`));
  } else {
    ok(t(MSG, 'noHookErrors'));
  }
  return 0;
}

export function main(argv) {
  const [cmd, ...args] = argv;
  const root = projectRoot(process.cwd());
  initLang(root);
  switch (cmd) {
    case 'init':
      return cmdInit(root, args);
    case 'state':
      return cmdState(root, args);
    case 'mode':
      return cmdMode(root, args);
    case 'route':
      return cmdRoute(root, args);
    case 'work':
      return cmdWork(root, args);
    case 'verify':
      return cmdVerify(root, args);
    case 'docs':
      return cmdDocs(root, args);
    case 'release':
      return cmdRelease(root, args);
    case 'doctor':
      return cmdDoctor(root);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(t(MSG, 'help'));
      return 0;
    default:
      return fail(t(MSG, 'unknownCommand', { cmd }));
  }
}
