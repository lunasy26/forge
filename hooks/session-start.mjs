// SessionStart: at most a few lines of context. No manifesto.
import { isGitRepo } from '../lib/git.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { superpowersEnabled } from '../lib/settings.mjs';
import { loadState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';

export const MAX_CONTEXT = 600;

runHook('session-start', async (_input, root) => {
  const { exists, profile, errors } = loadProfile(root);
  const lines = [];
  if (!exists) {
    if (!isGitRepo(root)) return null; // not a project: stay silent
    lines.push('forge: в проекте нет профиля — охрана git и секретов работает по умолчанию, автопроверок нет. Настроить: /forge:init.');
  } else {
    const state = loadState(root);
    const mode = state.mode || profile.mode;
    const steps = profile.verify.steps.join(' → ') || 'не задана';
    lines.push(
      `forge: режим ${mode}, уровень T${state.tier}. Проверка: ${steps} (при завершении: ${profile.verify.on_stop}). ` +
        'Модель и effort для субагента: forge route <role>.',
    );
    if (state.task?.slug) {
      const plan = state.artifacts?.plan ? `, план ${state.artifacts.plan}` : '';
      lines.push(`Активная задача: ${state.task.slug}, стадия ${state.stage || '—'}${plan}.`);
    }
    if (state.verify && state.verify.ok === false) lines.push(`Последняя проверка не прошла: ${state.verify.summary}.`);
    if (errors.length) lines.push(`В профиле ошибки (${errors.length}) — forge doctor.`);
  }
  if (superpowersEnabled(root)) lines.push('Включён Superpowers: он конфликтует с forge — отключи его.');
  let text = lines.join('\n');
  if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT - 1) + '…';
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
});
