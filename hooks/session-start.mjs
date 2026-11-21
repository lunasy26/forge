// SessionStart: at most a few lines of context. No manifesto.
import { isGitRepo } from '../lib/git.mjs';
import { SESSION_START_MSG as MSG } from '../lib/hook-messages.mjs';
import { t } from '../lib/i18n.mjs';
import { initLang } from '../lib/lang.mjs';
import { effectiveTable, loadRouting } from '../lib/route.mjs';
import { rootDocStatus } from '../lib/docs.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { superpowersEnabled } from '../lib/settings.mjs';
import { loadState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';

export const MAX_CONTEXT = 600;

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
