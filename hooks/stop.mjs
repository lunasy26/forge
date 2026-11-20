// Stop: if code changed since the last verification, verify before letting the turn end;
// then, once per window of edits, remind to re-check the agent files if commands or structure changed
// and to fill [Unreleased] of the changelog if code changed while it is empty — one block for both.
import { verifyAndRecord } from '../lib/cli.mjs';
import { docsReminder } from '../lib/docs.mjs';
import { editsSize, filesSince, maybeRotate } from '../lib/edits.mjs';
import { defineCatalog, detectLang, lastUserText, t } from '../lib/i18n.mjs';
import { initLang } from '../lib/lang.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { releaseMemory, releaseReminder, rememberRelease } from '../lib/release.mjs';
import { loadState, updateState } from '../lib/state.mjs';
import { logError, runHook } from '../lib/util.mjs';
import { failureReport } from '../lib/verify.mjs';

const MSG = defineCatalog({
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
      return { systemMessage: t(MSG, 'lastFailed', { summary: state.verify.summary }) };
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
      systemMessage: t(MSG, 'gaveUp', { streak, step: result.failed.step }),
    };
  }

  const escalate = streak >= 2 ? t(MSG, 'escalate', { streak }) : '';
  return {
    decision: 'block',
    reason: t(MSG, 'blocked', { report: failureReport(result), escalate }),
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The agent-docs part over the shared window: the reason or null; docs memory lives in state.docs.reminded
 * (see docsReminder) and is saved even when nothing is reminded (forgotten entries).
 */
function docsPart(root, profile, files, memory) {
  const { reason, reminded } = docsReminder(root, profile, files, memory);
  const keep = Object.keys(reminded.scripts).length || reminded.dirs.length ? reminded : undefined;
  if (JSON.stringify(keep) !== JSON.stringify(memory)) {
    updateState(root, (s) => {
      if (!isObject(s.docs)) s.docs = {};
      if (keep) s.docs.reminded = keep;
      else delete s.docs.reminded;
    });
  }
  return reason;
}

/** The release part over the shared window: the reason or null; the fired key goes to state.release.reminded. */
function releasePart(root, profile, files, state) {
  const hit = releaseReminder(root, profile, files, state);
  if (!hit) return null;
  updateState(root, (s) => {
    s.release = { ...(isObject(s.release) ? s.release : {}), reminded: rememberRelease(releaseMemory(s), hit.remember) };
  });
  return hit.reason;
}

/**
 * Reminders over one shared window of edits: the edits since state.docs.offset (the one window cursor, kept
 * under its historical key so verifyAndRecord rotates it too). The cursor always moves to the end of the log.
 * No cursor yet (first stop after an update) → only set it. A cursor past the end (log truncated) or negative
 * → read from 0. The agent-docs and release reminders read the same files; each one's error is logged and
 * does not cost the other. Returns the joined reason or null.
 */
function remindersOnStop(root, profile, { docs, release }) {
  const state = loadState(root);
  const size = editsSize(root);
  const prev = isObject(state.docs) ? state.docs : {};
  const offset = prev.offset;
  const files = Number.isInteger(offset) ? filesSince(root, offset < 0 || offset > size ? 0 : offset) : [];
  const next = updateState(root, (s) => {
    s.docs = { ...(isObject(s.docs) ? s.docs : {}), offset: size };
  });
  if (maybeRotate(root, [next.verify?.edits_offset, next.lint_offset, next.docs.offset])) {
    updateState(root, (s) => {
      if (s.verify) s.verify.edits_offset = 0;
      s.lint_offset = 0;
      s.docs.offset = 0;
    });
  }
  if (!files.length) return null;
  const reasons = [];
  if (docs) {
    try {
      reasons.push(docsPart(root, profile, files, prev.reminded));
    } catch (err) {
      logError(root, 'stop:docs', err);
    }
  }
  if (release) {
    try {
      reasons.push(releasePart(root, profile, files, state));
    } catch (err) {
      logError(root, 'stop:release', err);
    }
  }
  return reasons.filter(Boolean).join('\n\n') || null;
}

/** Both reminders are off: drop the window cursor so a stale one never holds the log's rotation. */
function dropWindowCursor(root) {
  const state = loadState(root);
  const next = state.docs === undefined ? state : updateState(root, (s) => {
    delete s.docs;
  });
  if (maybeRotate(root, [next.verify?.edits_offset, next.lint_offset])) {
    updateState(root, (s) => {
      if (s.verify) s.verify.edits_offset = 0;
      s.lint_offset = 0;
    });
  }
}

/** Remember the language of the user's latest message for the CLI (state.lang). Cheap; never throws. */
function rememberLang(root, input) {
  try {
    const detected = detectLang(lastUserText(input.transcript_path));
    if (detected && detected !== loadState(root).lang) {
      updateState(root, (s) => {
        s.lang = detected;
      });
    }
  } catch (err) {
    logError(root, 'stop:lang', err);
  }
}

runHook('stop', async (input, root) => {
  initLang(root, input);
  const { exists, profile } = loadProfile(root);
  if (!exists) return null;
  rememberLang(root, input);

  // Subagents or workflows still running may keep editing: verify when they are done.
  const busy = (input.background_tasks || []).some(
    (task) => ['subagent', 'workflow'].includes(task.type) && !['completed', 'failed', 'killed', 'stopped'].includes(task.status),
  );
  if (busy) return null;

  let verified = null;
  if (profile.verify.on_stop !== 'off' && profile.verify.steps.length) {
    verified = verifyOnStop(input, root, profile);
    if (verified?.decision === 'block') return verified; // a failing check wins; the window cursor stays
    // Giving up must release the session: no reminder block now, the cursor stays for a later passing check.
    if (verified?.gaveUp) return { systemMessage: verified.systemMessage };
  }

  // Reminders must never cost the verify result: an error is logged and the turn ends as verify decided.
  const on = { docs: profile.docs.remind !== false, release: Boolean(profile.release) && profile.release.remind !== false };
  let reason = null;
  try {
    if (on.docs || on.release) reason = remindersOnStop(root, profile, on);
    else dropWindowCursor(root);
  } catch (err) {
    logError(root, 'stop:reminders', err);
  }
  if (!reason) return verified;
  return { ...verified, decision: 'block', reason };
});
