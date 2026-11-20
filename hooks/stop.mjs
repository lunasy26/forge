// Stop: if code changed since the last verification, verify before letting the turn end.
import { verifyAndRecord } from '../lib/cli.mjs';
import { editsSize } from '../lib/edits.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { loadState, updateState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';
import { failureReport } from '../lib/verify.mjs';

/** After this many consecutive failures the hook stops blocking and tells the user instead. */
export const GIVE_UP_AFTER = 3;

runHook('stop', async (input, root) => {
  const { exists, profile } = loadProfile(root);
  if (!exists || profile.verify.on_stop === 'off' || !profile.verify.steps.length) return null;

  // Subagents or workflows still running may keep editing: verify when they are done.
  const busy = (input.background_tasks || []).some(
    (t) => ['subagent', 'workflow'].includes(t.type) && !['completed', 'failed', 'killed', 'stopped'].includes(t.status),
  );
  if (busy) return null;

  const state = loadState(root);
  const size = editsSize(root);
  const offset = state.verify?.edits_offset ?? 0;
  const hasNewEdits = size > offset || (offset > size && size > 0);

  if (!hasNewEdits) {
    // Nothing new to check. If the last check failed and the user hasn't been told, tell them once.
    if (state.verify && state.verify.ok === false && !state.verify.notified) {
      updateState(root, (s) => {
        s.verify.notified = true;
      });
      return { systemMessage: `forge: последняя проверка не прошла (${state.verify.summary}).` };
    }
    return null;
  }

  const { result, streak } = verifyAndRecord(root, profile, { fast: profile.verify.on_stop === 'fast' });
  if (result.ok) return null;

  if (input.stop_hook_active && streak >= GIVE_UP_AFTER) {
    updateState(root, (s) => {
      s.verify.notified = true;
    });
    return {
      systemMessage: `forge: проверка падает ${streak} раз(а) подряд, автопроверка отпустила сессию. Шаг: ${result.failed.step}. Запусти forge verify, чтобы увидеть ошибку.`,
    };
  }

  const escalate =
    streak >= 2
      ? `\n\nЭто ${streak}-е падение подряд. Не латай вслепую: передай задачу роли debugger (forge route debugger) вместе с этим логом.`
      : '';
  return {
    decision: 'block',
    reason: `forge: проверка перед завершением не прошла.\n${failureReport(result)}\n\nИсправь и заверши работу снова. Если исправить нельзя — честно сообщи пользователю, что проверка падает.${escalate}`,
  };
});
