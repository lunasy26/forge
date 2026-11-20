import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { detectProfile } from './detect.mjs';
import { checkDocs, fixDocs } from './docs.mjs';
import { editsSize, filesSince, maybeRotate } from './edits.mjs';
import { addExcludes, excludedLines, isGitRepo } from './git.mjs';
import { forgePath, pluginRoot, projectRoot } from './paths.mjs';
import { MODES, commandSpec, loadProfile, profilePath } from './profile.mjs';
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
