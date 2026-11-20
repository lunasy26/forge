// Stop: if code changed since the last verification, verify before letting the turn end;
// then, once per window of edits, remind to re-check the agent files if commands or structure changed.
import { verifyAndRecord } from '../lib/cli.mjs';
import { docsReminder } from '../lib/docs.mjs';
import { editsSize, filesSince, maybeRotate } from '../lib/edits.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { loadState, updateState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';
import { failureReport } from '../lib/verify.mjs';

/** After this many consecutive failures the hook stops blocking and tells the user instead. */
export const GIVE_UP_AFTER = 3;

/**
 * Verification on Stop: null, { systemMessage }, { decision: 'block', reason } or, when it gives up after
 * GIVE_UP_AFTER failures, { systemMessage, gaveUp: true } (the marker is internal and never printed).
 */
function verifyOnStop(input, root, profile) {
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
      gaveUp: true,
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
}

/**
 * Agent-docs reminder over the edits since state.docs.offset; the cursor always moves to the end of the log.
 * No cursor yet (first stop after an update) → only set it. A cursor past the end (log truncated) → read from 0.
 */
function docsOnStop(root, profile) {
  const state = loadState(root);
  const size = editsSize(root);
  const offset = state.docs?.offset;
  const files = Number.isInteger(offset) ? filesSince(root, offset > size ? 0 : offset) : [];
  const next = updateState(root, (s) => {
    s.docs = { ...(s.docs && typeof s.docs === 'object' && !Array.isArray(s.docs) ? s.docs : {}), offset: size };
  });
  if (maybeRotate(root, [next.verify?.edits_offset, next.lint_offset, next.docs.offset])) {
    updateState(root, (s) => {
      if (s.verify) s.verify.edits_offset = 0;
      s.lint_offset = 0;
      s.docs.offset = 0;
    });
  }
  return docsReminder(root, profile, files);
}

runHook('stop', async (input, root) => {
  const { exists, profile } = loadProfile(root);
  if (!exists) return null;

  // Subagents or workflows still running may keep editing: verify when they are done.
  const busy = (input.background_tasks || []).some(
    (t) => ['subagent', 'workflow'].includes(t.type) && !['completed', 'failed', 'killed', 'stopped'].includes(t.status),
  );
  if (busy) return null;

  let verified = null;
  if (profile.verify.on_stop !== 'off' && profile.verify.steps.length) {
    verified = verifyOnStop(input, root, profile);
    if (verified?.decision === 'block') return verified; // a failing check wins; the docs cursor stays
    // Giving up must release the session: no docs block now, the cursor stays for a later passing check.
    if (verified?.gaveUp) return { systemMessage: verified.systemMessage };
  }

  const reason = profile.docs.remind !== false ? docsOnStop(root, profile) : null;
  if (!reason) return verified;
  return { ...verified, decision: 'block', reason };
});
