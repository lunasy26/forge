// SessionStart: at most a few lines of context. No manifesto.
import { isGitRepo } from '../lib/git.mjs';
import { defineCatalog, t } from '../lib/i18n.mjs';
import { initLang } from '../lib/lang.mjs';
import { effectiveTable, loadRouting } from '../lib/route.mjs';
import { rootDocStatus } from '../lib/docs.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { superpowersEnabled } from '../lib/settings.mjs';
import { loadState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';

export const MAX_CONTEXT = 600;

const MSG = defineCatalog({
  en: {
    noProfile: 'forge: no profile in this project: git and secret guards work by default, no auto-checks. Set up: /forge:init.',
    noSteps: 'not set',
    summary: 'forge: mode {mode}, tier T{tier}. Verify: {steps} (on stop: {onStop}). Model and effort for a subagent: forge route <role>.',
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

runHook('session-start', async (input, root) => {
  initLang(root, input);
  const { exists, profile, errors } = loadProfile(root);
  const lines = [];
  if (!exists) {
    if (!isGitRepo(root)) return null; // not a project: stay silent
    lines.push(t(MSG, 'noProfile'));
  } else {
    const state = loadState(root);
    const mode = state.mode || profile.mode;
    const steps = profile.verify.steps.join(' → ') || t(MSG, 'noSteps');
    lines.push(t(MSG, 'summary', { mode, tier: state.tier, steps, onStop: profile.verify.on_stop }));
    if (state.task?.slug) {
      const plan = state.artifacts?.plan ? t(MSG, 'plan', { plan: state.artifacts.plan }) : '';
      lines.push(t(MSG, 'task', { slug: state.task.slug, stage: state.stage || '—', plan }));
    }
    if (state.verify && state.verify.ok === false) lines.push(t(MSG, 'lastFailed', { summary: state.verify.summary }));
    if (errors.length) lines.push(t(MSG, 'profileErrors', { count: errors.length }));
    const { warnings } = effectiveTable(loadRouting(), profile.routing);
    if (warnings.length) lines.push(t(MSG, 'routingIgnored', { count: warnings.length }));
    const docs = rootDocStatus(root);
    if (docs === 'missing') lines.push(t(MSG, 'noAgents'));
    else if (docs === 'no-import') lines.push(t(MSG, 'noImport'));
  }
  if (superpowersEnabled(root)) lines.push(t(MSG, 'superpowers'));
  let text = lines.join('\n');
  if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT - 1) + '…';
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
});
