import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { bumpVersion, checkChangelog, compareVersions, parseChangelog, parseSemver, releaseChangelog, suggestBump, unreleasedEntryCount } from './changelog.mjs';
import { detectProfile } from './detect.mjs';
import { checkDocs, fixDocs } from './docs.mjs';
import { editsSize, filesSince, maybeRotate } from './edits.mjs';
import { addExcludes, currentBranch, defaultBranch, excludedLines, headSha, isClean, isGitRepo, latestVersionTag, tagExists } from './git.mjs';
import { forgePath, pluginRoot, projectRoot } from './paths.mjs';
import { MODES, commandSpec, loadProfile, profilePath } from './profile.mjs';
import { readVersions, writeVersion } from './release.mjs';
import { effectiveTable, loadRouting, resolveRoute } from './route.mjs';
import { superpowersEnabled } from './settings.mjs';
import { getPath, loadState, parseValue, saveState, setPath, updateState, validateStateValue } from './state.mjs';
import { errorLogPath, writeJsonAtomic } from './util.mjs';
import { failureReport, runSteps, summarize } from './verify.mjs';

export const EXCLUDES = ['.forge/state.json', '.forge/edits.jsonl', '.forge/work/', '.forge/log/'];

const HELP = `forge — CLI плагина forge

  forge init [--yes] [--force]    определить стек и создать .forge/profile.json (без --yes только показать)
  forge state [get [key]]         показать состояние (или одно поле, например task.slug)
  forge state set <key> <value>…  изменить поля: forge state set tier 2 stage plan
  forge state reset               сбросить состояние
  forge mode [eco|normal|max]     показать или переключить режим маршрутизации
  forge route <role> [--json]     модель и effort для роли в текущем режиме
  forge route --table             вся таблица текущего режима
  forge verify [--fast] [--json]  прогнать шаги проверки из профиля
  forge docs [--fix] [--json]     проверить AGENTS.md/CLAUDE.md (--fix создаёт недостающие ссылки CLAUDE.md)
  forge release [--check] [major|minor|patch|x.y.z] [--yes] [--date YYYY-MM-DD] [--json]
                                  выпуск версии: --check проверяет журнал изменений, без --yes — предпросмотр,
                                  с --yes — переносит [Unreleased] в версию, правит файлы версий, коммит и тег
  forge doctor                    проверить установку и профиль`;

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

function cmdInit(root, args) {
  const write = args.includes('--yes');
  const force = args.includes('--force');
  const { stack, profile, notes } = detectProfile(root);
  const file = profilePath(root);
  if (!write) {
    out(`Стек: ${stack}`);
    out(`Профиль будет записан в ${file}${existsSync(file) ? ' (уже существует — нужен --force)' : ''}:`);
    out(JSON.stringify(profile, null, 2));
    for (const n of notes) out(`• ${n}`);
    out('\nЗаписать: forge init --yes');
    return 0;
  }
  if (existsSync(file) && !force) return fail(`${file} уже существует. Перезаписать: forge init --yes --force`, 1);
  mkdirSync(forgePath(root), { recursive: true });
  copyFileSync(join(pluginRoot(), 'config', 'profile.schema.json'), forgePath(root, 'profile.schema.json'));
  writeJsonAtomic(file, profile);
  out(`Записан ${file} (стек: ${stack}).`);
  if (isGitRepo(root)) {
    const added = addExcludes(root, EXCLUDES);
    out(added.length ? `Добавлено в .git/info/exclude: ${added.join(', ')}` : 'Исключения в .git/info/exclude уже настроены.');
  } else {
    out('Не git-репозиторий: исключения не настраивались.');
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
    out('Состояние сброшено (режим и курсоры сохранены).');
    return 0;
  }
  if (sub === 'set') {
    if (!rest.length || rest.length % 2) return fail('ожидаются пары: forge state set <key> <value> [<key> <value>…]');
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
  return fail(`неизвестная команда state ${sub}`);
}

function cmdMode(root, args) {
  const ctx = routingContext(root);
  const next = args[0];
  if (next) {
    if (!MODES.includes(next)) return fail(`режим должен быть одним из: ${MODES.join(', ')}`);
    updateState(root, (s) => {
      s.mode = next;
    });
    out(`Режим: ${next}`);
  } else {
    out(`Режим: ${ctx.mode}`);
  }
  out(formatTable(ctx.routing, ctx.table, next || ctx.mode));
  for (const w of ctx.warnings) out(`! переопределения routing из профиля проигнорированы: ${w}`);
  return 0;
}

function cmdRoute(root, args) {
  const ctx = routingContext(root);
  for (const w of ctx.warnings) process.stderr.write(`forge: routing из профиля проигнорирован: ${w}\n`);
  if (args.includes('--table')) {
    out(`Режим: ${ctx.mode}`);
    out(formatTable(ctx.routing, ctx.table, ctx.mode));
    return 0;
  }
  const role = args.find((a) => !a.startsWith('--'));
  if (!role) return fail('укажи роль: forge route <role>');
  let r;
  try {
    r = resolveRoute(ctx.routing, ctx.table, ctx.mode, role);
  } catch (err) {
    return fail(err.message);
  }
  out(args.includes('--json') ? JSON.stringify(r) : `role=${r.role} mode=${r.mode} agent=${r.agent} model=${r.model} effort=${r.effort}`);
  return 0;
}

/** Shared by the CLI and the Stop hook: run verify, record the result in state. */
export function verifyAndRecord(root, profile, { fast = false } = {}) {
  const state = loadState(root);
  const offset = state.verify?.edits_offset ?? 0;
  const size = editsSize(root);
  const files = filesSince(root, 0 < offset && offset <= size ? offset : 0);
  const result = runSteps(root, profile, profile.verify.steps, { files, fast });
  const next = updateState(root, (s) => {
    s.verify = {
      at: new Date().toISOString(),
      ok: result.ok,
      summary: summarize(result),
      failed_step: result.failed?.step ?? null,
      edits_offset: size,
      notified: false,
    };
    s.failures = { ...(s.failures || {}), verify_streak: result.ok ? 0 : (s.failures?.verify_streak || 0) + 1 };
  });
  // An absent docs cursor is not a consumer: the Stop hook sets it on first use and drops it when docs.remind is false.
  const docsOffset = Number.isInteger(next.docs?.offset) ? [next.docs.offset] : [];
  if (maybeRotate(root, [next.verify.edits_offset, next.lint_offset, ...docsOffset])) {
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
  if (!exists) return fail('нет профиля — сначала forge init', 1);
  if (!profile.verify.steps.length) return fail('verify.steps пуст — нечего проверять', 1);
  const { result, streak } = verifyAndRecord(root, profile, { fast: args.includes('--fast') });
  if (args.includes('--json')) {
    out(JSON.stringify({ ok: result.ok, summary: summarize(result), failed: result.failed?.step ?? null, streak }));
  } else {
    out(`${result.ok ? 'OK' : 'FAIL'}: ${summarize(result)}`);
    if (!result.ok) out(failureReport(result));
  }
  return result.ok ? 0 : 1;
}

function reportDocs(issues) {
  if (!issues.length) {
    out('✓ Агентские файлы в порядке');
    return;
  }
  for (const i of issues) out(`${i.level === 'error' ? '✗' : '!'} ${i.path}: ${i.message} [${i.code}]`);
}

function cmdDocs(root, args) {
  const unknown = args.filter((a) => a !== '--fix' && a !== '--json');
  if (unknown.length) return fail(`неизвестный аргумент «${unknown[0]}». forge docs [--fix] [--json]`);
  const { profile } = loadProfile(root);
  const json = args.includes('--json');
  let issues = checkDocs(root, profile);
  if (args.includes('--fix')) {
    const { written, skipped } = fixDocs(root, issues);
    for (const p of written) if (!json) out(`создан ${p}`);
    // stderr in --json mode keeps stdout parseable
    for (const s of skipped) (json ? (l) => process.stderr.write(`${l}\n`) : out)(`пропущен ${s.path}: ${s.reason}`);
    issues = checkDocs(root, profile);
  }
  if (json) out(JSON.stringify(issues));
  else reportDocs(issues);
  return issues.some((i) => i.level === 'error') ? 1 : 0;
}

/** Russian plural form: 1 замечание, 2 замечания, 5 замечаний (21 замечание, 11 замечаний). */
function plural(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  if (ones === 1 && tens !== 11) return one;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

// ---- release ------------------------------------------------------------------------------

const RELEASE_LEVELS = ['major', 'minor', 'patch'];
const NOT_CONFIGURED = '✗ раздел release в профиле не настроен — forge init предложит его, если проект выпускается';

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

/** Changelog text and the current version: latest release in the changelog, else the latest tag, else 0.0.0. */
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
    }
  }
  return state;
}

/** Problems of the changelog and version files: [{ code, level, path?, message }]. */
function checkRelease(root, release, state = readReleaseState(root, release)) {
  const issues = [];
  if (state.text === null) {
    issues.push({
      code: 'changelog-missing',
      level: 'error',
      path: release.changelog,
      message: state.readError ? `не удалось прочитать файл (${state.readError})` : 'файл журнала изменений не найден',
    });
  } else {
    for (const i of checkChangelog(state.text)) issues.push({ ...i, path: release.changelog });
  }
  for (const v of readVersions(root, release)) {
    if (v.error) {
      issues.push({ code: 'version-file-unreadable', level: 'error', path: v.path, message: `версия не прочитана: ${v.error}` });
    } else if (state.source && v.version !== state.current) {
      issues.push({ code: 'version-mismatch', level: 'error', path: v.path, message: `версия ${v.version}, а текущая ${state.current}` });
    }
  }
  if (state.latestReleased && isGitRepo(root)) {
    const tag = `${release.tag_prefix}${state.latestReleased}`;
    if (!tagExists(root, tag)) {
      issues.push({ code: 'tag-missing', level: 'warn', message: `версия ${state.latestReleased} выпущена, а тега ${tag} нет` });
    }
  }
  return issues;
}

function cmdReleaseCheck(root, release, json) {
  const issues = checkRelease(root, release);
  if (json) out(JSON.stringify(issues));
  else if (!issues.length) out('✓ Журнал изменений в порядке');
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
      if (value === undefined || !isValidDate(value)) return { error: `--date: нужна дата ГГГГ-ММ-ДД, получено «${value ?? ''}»` };
      opts.date = value;
    } else if (a.startsWith('-')) return { error: `неизвестный аргумент «${a}»` };
    else if (opts.target) return { error: `лишний аргумент «${a}»` };
    else if (RELEASE_LEVELS.includes(a) || parseSemver(a)) opts.target = a;
    else return { error: `уровень должен быть major, minor, patch или версия x.y.z, получено «${a}»` };
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
  const { profile } = loadProfile(root);
  const release = profile.release;
  if (!release) {
    out(NOT_CONFIGURED);
    return 1;
  }
  if (opts.check) {
    if (opts.yes || opts.target || opts.date) return fail('--check не сочетается с --yes, уровнем и --date');
    return cmdReleaseCheck(root, release, opts.json);
  }
  if (opts.yes && !opts.target) return fail('укажи уровень или версию: forge release <major|minor|patch|x.y.z> --yes');

  const refuse = (msg) => {
    out(`✗ ${msg}`);
    return 1;
  };
  const inRepo = isGitRepo(root);
  if (opts.yes) {
    if (!inRepo) return refuse('это не git-репозиторий — выпускать некуда');
    if (!isClean(root)) return refuse('в рабочем дереве есть незакоммиченные изменения — закоммить или отложи их');
  }
  const state = readReleaseState(root, release);
  if (state.text === null) return refuse(`${release.changelog}: ${state.readError ? `не удалось прочитать (${state.readError})` : 'файл журнала изменений не найден'}`);
  if (!state.parsed.unreleased) return refuse(`в ${release.changelog} нет раздела [Unreleased]`);
  if (!unreleasedEntryCount(state.parsed)) return refuse('в [Unreleased] пусто — выпускать нечего');

  let level;
  let reason;
  let next;
  if (opts.target && parseSemver(opts.target)) {
    level = opts.target;
    reason = 'версия задана явно';
    next = opts.target;
  } else if (opts.target) {
    level = opts.target;
    reason = 'уровень задан явно';
    next = bumpVersion(state.current, level);
  } else {
    ({ level, reason } = suggestBump(state.parsed, state.current));
    next = bumpVersion(state.current, level);
  }
  if (compareVersions(next, state.current) <= 0) return refuse(`версия ${next} не больше текущей ${state.current}`);
  const tag = `${release.tag_prefix}${next}`;
  if (inRepo && tagExists(root, tag)) return refuse(`тег ${tag} уже существует`);

  const date = opts.date || localToday();
  const versions = readVersions(root, release);
  const broken = versions.find((v) => v.error);
  if (broken) return refuse(`${broken.path}: версия не прочитана: ${broken.error}`);
  const commit = `chore(release): ${next}`;
  const files = [
    { path: release.changelog, from: '[Unreleased]', to: `[${next}] — ${date}` },
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
    out(`Уровень: ${level} (${reason})`);
    out(`Версия: ${state.current} → ${next}`);
    out(`Дата: ${date}`);
    out('Файлы:');
    for (const f of files) out(`  ${f.path}: ${f.from} → ${f.to}`);
    out(`Тег: ${tag}`);
    out(`Коммит: ${commit}`);
    out('');
    out(`Выпустить: forge release ${level}${opts.date ? ` --date ${opts.date}` : ''} --yes`);
    return 0;
  }

  const branch = currentBranch(root);
  const main = defaultBranch(root);
  if (main && branch !== main) out(`! выпуск не с ветки ${main} (сейчас ${branch ?? 'detached HEAD'})`);

  // Snapshot to restore byte-for-byte if any step fails after files were changed.
  const paths = files.map((f) => f.path);
  const originals = paths.map((p) => readFileSync(join(root, p)));
  let committed = false;
  const rollback = (why) => {
    if (committed) git(root, ['reset', '-q', 'HEAD~1']);
    else git(root, ['reset', '-q', '--', ...paths]);
    paths.forEach((p, i) => writeFileSync(join(root, p), originals[i]));
    out(`✗ ${why}`);
    out('Файлы возвращены в исходное состояние, тег не создан.');
    return 1;
  };
  try {
    writeFileSync(join(root, release.changelog), newChangelog);
    for (const item of release.version_files) writeVersion(root, item, next);
  } catch (err) {
    return rollback(err.message);
  }
  const add = git(root, ['add', '--', ...paths]);
  if (!add.ok) return rollback(`git add не удался: ${add.stderr}`);
  const com = git(root, ['commit', '-q', '-m', commit]);
  if (!com.ok) return rollback(`git commit не удался: ${com.stderr || com.stdout}`);
  committed = true;
  const tagged = git(root, ['tag', '-a', tag, '-m', `release ${next}`]);
  if (!tagged.ok) return rollback(`git tag не удался: ${tagged.stderr}`);

  const sha = headSha(root) || '';
  if (opts.json) {
    out(JSON.stringify({ level, reason, current: state.current, next, tag, files, commit, sha, branch }));
    return 0;
  }
  out(`✓ Выпущена версия ${next}`);
  out(`Коммит: ${sha.slice(0, 7)} ${commit}`);
  out(`Тег: ${tag}`);
  out(`Отправить: git push origin ${branch ?? 'HEAD'} && git push origin ${tag}`);
  return 0;
}

function binaryExists(command) {
  const first = command.trim().split(/\s+/)[0];
  if (!first || first.includes('=')) return true;
  return spawnSync('/bin/sh', ['-c', `command -v ${first}`], { encoding: 'utf8' }).status === 0;
}

function tailLines(file, n) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter((l) => /^\d{4}-/.test(l)).slice(-n);
}

function cmdDoctor(root) {
  const ok = (s) => out(`✓ ${s}`);
  const bad = (s) => out(`✗ ${s}`);
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 20 ? ok : bad)(`Node ${process.versions.node}${major >= 20 ? '' : ' (нужен ≥ 20)'}`);
  ok(`Плагин: ${pluginRoot()}`);
  ok(`Проект: ${root}`);
  const { exists, profile, errors } = loadProfile(root);
  if (!exists) bad('Профиля нет — forge init');
  else if (errors.length) errors.forEach((e) => bad(`профиль: ${e}`));
  else ok('Профиль валиден');
  if (exists) {
    for (const step of profile.verify.steps) {
      const spec = commandSpec(profile.commands[step]);
      if (spec && !binaryExists(spec.run)) bad(`команда «${step}»: не найден исполняемый файл в «${spec.run}»`);
    }
    if (isGitRepo(root)) {
      const lines = excludedLines(root) || [];
      const missing = EXCLUDES.filter((e) => !lines.includes(e));
      if (missing.length) bad(`не исключены из git: ${missing.join(', ')} (forge init --yes --force или добавь в .git/info/exclude)`);
      else ok('Служебные файлы исключены из git');
    }
  }
  const { warnings } = effectiveTable(loadRouting(), profile.routing);
  if (warnings.length) warnings.forEach((w) => bad(`routing: ${w}`));
  else ok('Таблица маршрутизации корректна');
  const docIssues = checkDocs(root, profile);
  if (!docIssues.length) ok('Агентские файлы в порядке');
  else {
    const n = docIssues.length;
    out(`${docIssues.some((i) => i.level === 'error') ? '✗' : '!'} Агентские файлы: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — forge docs`);
  }
  if (profile.release) {
    const issues = checkRelease(root, profile.release);
    if (!issues.length) ok('Журнал изменений в порядке');
    else {
      const n = issues.length;
      out(`${issues.some((i) => i.level === 'error') ? '✗' : '!'} Журнал изменений: ${n} ${plural(n, 'замечание', 'замечания', 'замечаний')} — forge release --check`);
    }
  }
  if (superpowersEnabled(root)) bad('Включён Superpowers — отключи его, он конфликтует с forge');
  const logs = [...new Set([errorLogPath(root), join(tmpdir(), 'forge-errors.log')])];
  const recent = logs.flatMap((f) => tailLines(f, 5));
  if (recent.length) {
    bad('Последние ошибки хуков:');
    recent.forEach((l) => out(`    ${l}`));
  } else {
    ok('Ошибок хуков нет');
  }
  return 0;
}

export function main(argv) {
  const [cmd, ...args] = argv;
  const root = projectRoot(process.cwd());
  switch (cmd) {
    case 'init':
      return cmdInit(root, args);
    case 'state':
      return cmdState(root, args);
    case 'mode':
      return cmdMode(root, args);
    case 'route':
      return cmdRoute(root, args);
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
      out(HELP);
      return 0;
    default:
      return fail(`неизвестная команда «${cmd}». forge help`);
  }
}
