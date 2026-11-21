import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { commandSpec } from './profile.mjs';
import { shellQuote, trimOutput } from './util.mjs';
import { defineCatalog, t } from './i18n.mjs';
import { shellMissingMessage, shellPath } from './sh.mjs';
import { SHELL_MISSING_MSG } from './hook-messages.mjs';
import { loadState, updateState } from './state.mjs';

const MSG = defineCatalog({
  en: {
    noTime: 'ran out of time (verify.timeout_sec)',
    skipped: '{step}: skipped',
    noShell: '{step}: Git Bash not found, skipped',
    ok: '{step}: ok ({sec} s)',
    timeout: '{step}: timeout',
    code: '{step}: code {code}',
    noSteps: 'no steps',
    failedTimeout: 'timeout',
    failedCode: 'code {code}',
    failure: 'Step "{step}" failed ({reason}): `{command}`\n{output}',
  },
  ru: {
    noTime: 'не хватило времени (verify.timeout_sec)',
    skipped: '{step}: пропущен',
    noShell: '{step}: Git Bash не найден, пропущен',
    ok: '{step}: ok ({sec} с)',
    timeout: '{step}: таймаут',
    code: '{step}: код {code}',
    noSteps: 'нет шагов',
    failedTimeout: 'таймаут',
    failedCode: 'код {code}',
    failure: 'Шаг «{step}» упал ({reason}): `{command}`\n{output}',
  },
});

/** Build the shell command for a profile command; null when it needs files and none match. */
export function buildCommand(spec, files) {
  const cmd = commandSpec(spec);
  if (!cmd) return null;
  if (!cmd.run.includes('{files}')) return cmd.run;
  const matching = cmd.ext ? files.filter((f) => cmd.ext.includes(extname(f))) : files;
  if (!matching.length) return null;
  return cmd.run.replaceAll('{files}', matching.map(shellQuote).join(' '));
}

export function runShell(command, { cwd, timeoutMs, shell = shellPath() }) {
  const started = Date.now();
  if (!shell) return { ok: false, shellMissing: true, code: null, timedOut: false, ms: 0, output: shellMissingMessage() };
  const r = spawnSync(shell, ['-c', command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return {
    ok: r.status === 0 && !timedOut,
    code: r.status,
    timedOut,
    ms: Date.now() - started,
    output: `${r.stdout || ''}${r.stderr || ''}${r.error && !timedOut ? String(r.error) : ''}`,
  };
}

/**
 * Run named profile commands in order and stop at the first failure.
 * Steps that need {files} but have no matching files are skipped. When there is no shell to run a command
 * (Windows without Git Bash) that is an environment problem, not a failed step: the step is recorded as skipped
 * with shellMissing, the rest are not run, and the result is { ok: false, shellMissing: true, failed: null }.
 */
export function runSteps(root, profile, steps, { files = [], fast = false, timeoutSec, shell = shellPath() } = {}) {
  const budgetMs = (timeoutSec ?? profile.verify.timeout_sec) * 1000;
  const deadline = Date.now() + budgetMs;
  const results = [];
  for (const step of steps) {
    let spec = profile.commands[step];
    if (fast && step === 'test' && profile.commands.test_fast) {
      const fastCmd = buildCommand(profile.commands.test_fast, files);
      if (fastCmd) spec = profile.commands.test_fast;
    }
    const command = buildCommand(spec, files);
    if (!command) {
      results.push({ step, skipped: true });
      continue;
    }
    if (!shell) {
      results.push({ step, command, skipped: true, shellMissing: true });
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ step, command, ok: false, timedOut: true, code: null, ms: 0, output: t(MSG, 'noTime') });
      break;
    }
    const r = runShell(command, { cwd: root, timeoutMs: remaining, shell });
    results.push({ step, command, ...r });
    if (!r.ok) break;
  }
  const failed = results.find((r) => !r.skipped && !r.ok) || null;
  const shellMissing = results.some((r) => r.shellMissing);
  return { ok: !failed && !shellMissing, shellMissing, results, failed };
}

/**
 * The one-time notice for the user that profile commands were skipped because there is no shell: the text the
 * first time (remembered in state.shell_missing_notified), null afterwards. verifyAndRecord clears the memory
 * once commands run again.
 */
export function shellMissingNotice(root) {
  if (loadState(root).shell_missing_notified) return null;
  updateState(root, (s) => {
    s.shell_missing_notified = true;
  });
  return t(SHELL_MISSING_MSG, 'notice', { message: shellMissingMessage().replace(/^forge: /, '') });
}

export function summarize(result) {
  const parts = result.results.map((r) => {
    if (r.shellMissing) return t(MSG, 'noShell', { step: r.step });
    if (r.skipped) return t(MSG, 'skipped', { step: r.step });
    if (r.ok) return t(MSG, 'ok', { step: r.step, sec: (r.ms / 1000).toFixed(1) });
    return r.timedOut ? t(MSG, 'timeout', { step: r.step }) : t(MSG, 'code', { step: r.step, code: r.code });
  });
  return parts.join(', ') || t(MSG, 'noSteps');
}

export function failureReport(result, maxLines = 60) {
  if (result.shellMissing) return shellMissingMessage();
  const f = result.failed;
  if (!f) return '';
  if (f.shellMissing) return shellMissingMessage();
  const reason = f.timedOut ? t(MSG, 'failedTimeout') : t(MSG, 'failedCode', { code: f.code });
  return t(MSG, 'failure', { step: f.step, reason, command: f.command, output: trimOutput(f.output, maxLines) });
}
