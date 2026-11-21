import { defineCatalog } from './i18n.mjs';

// Catalogs of the hooks that run through runHook (session-start, post-batch, stop). They live in lib/ so the
// catalog parity test, which loads every lib module, covers them. The fail-closed guard hooks keep their
// BROKEN text inline on purpose: it must render when lib/ itself fails to load.

/** SessionStart context lines. */
export const SESSION_START_MSG = defineCatalog({
  en: {
    noProfile: 'forge: no profile in this project: git and secret guards work by default, no auto-checks. Set up: /forge:init.',
    noSteps: 'not set',
    summary: 'forge: mode {mode}, tier T{tier}. Verify: {steps} (on stop: {onStop}). Model and effort for a subagent: forge route <role>.',
    inherited: 'Profile from the main checkout {path}: this worktree has none; state and plans are its own.',
    plan: ', plan {plan}',
    task: 'Active task: {slug}, stage {stage}{plan}.',
    lastFailed: 'Last check failed: {summary}.',
    profileErrors: 'The profile has errors ({count}): forge doctor.',
    routingIgnored: 'Routing overrides from the profile were ignored ({count}): forge doctor.',
    noAgents: 'forge: no AGENTS.md: /forge:docs can create one.',
    noImport: 'forge: CLAUDE.md does not import AGENTS.md: forge docs.',
    superpowers: 'Superpowers is enabled: it conflicts with forge, disable it.',
  },
  ru: {
    noProfile: 'forge: в проекте нет профиля — охрана git и секретов работает по умолчанию, автопроверок нет. Настроить: /forge:init.',
    noSteps: 'не задана',
    summary: 'forge: режим {mode}, уровень T{tier}. Проверка: {steps} (при завершении: {onStop}). Модель и effort для субагента: forge route <role>.',
    inherited: 'Профиль из основного checkout {path}: в этом worktree своего нет, state и планы — свои.',
    plan: ', план {plan}',
    task: 'Активная задача: {slug}, стадия {stage}{plan}.',
    lastFailed: 'Последняя проверка не прошла: {summary}.',
    profileErrors: 'В профиле ошибки ({count}) — forge doctor.',
    routingIgnored: 'Переопределения routing из профиля проигнорированы ({count}) — forge doctor.',
    noAgents: 'forge: нет AGENTS.md — /forge:docs поможет завести.',
    noImport: 'forge: CLAUDE.md не подключает AGENTS.md — forge docs.',
    superpowers: 'Включён Superpowers: он конфликтует с forge — отключи его.',
  },
});

/** PostToolBatch: lint and format failures. */
export const POST_BATCH_MSG = defineCatalog({
  en: { lint: 'forge: after your edits {report}\n\nFix this before the next steps.' },
  ru: { lint: 'forge: после правок {report}\n\nИсправь это до следующих шагов.' },
});

/** Stop: verification before the turn ends. */
export const STOP_MSG = defineCatalog({
  en: {
    lastFailed: 'forge: the last check failed ({summary}).',
    gaveUp: 'forge: the check has failed {streak} times in a row, so auto-verify is letting the session go. Step: {step}. Run forge verify to see the error.',
    escalate: "\n\nThis is failure #{streak} in a row. Don't patch blindly: hand the task to the debugger role (forge route debugger) together with this log.",
    blocked: "forge: the check before finishing failed.\n{report}\n\nFix it and finish again. If it cannot be fixed, tell the user honestly that the check fails.{escalate}",
  },
  ru: {
    lastFailed: 'forge: последняя проверка не прошла ({summary}).',
    gaveUp: 'forge: проверка падает {streak} раз(а) подряд, автопроверка отпустила сессию. Шаг: {step}. Запусти forge verify, чтобы увидеть ошибку.',
    escalate: '\n\nЭто {streak}-е падение подряд. Не латай вслепую: передай задачу роли debugger (forge route debugger) вместе с этим логом.',
    blocked: 'forge: проверка перед завершением не прошла.\n{report}\n\nИсправь и заверши работу снова. Если исправить нельзя — честно сообщи пользователю, что проверка падает.{escalate}',
  },
});
