import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { commandSpec } from './profile.mjs';
import { shellQuote, trimOutput } from './util.mjs';

/** Build the shell command for a profile command; null when it needs files and none match. */
export function buildCommand(spec, files) {
  const cmd = commandSpec(spec);
  if (!cmd) return null;
  if (!cmd.run.includes('{files}')) return cmd.run;
  const matching = cmd.ext ? files.filter((f) => cmd.ext.includes(extname(f))) : files;
  if (!matching.length) return null;
  return cmd.run.replaceAll('{files}', matching.map(shellQuote).join(' '));
}

export function runShell(command, { cwd, timeoutMs }) {
  const started = Date.now();
  const r = spawnSync('/bin/sh', ['-c', command], {
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
 * Steps that need {files} but have no matching files are skipped.
 */
export function runSteps(root, profile, steps, { files = [], fast = false, timeoutSec } = {}) {
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
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ step, command, ok: false, timedOut: true, code: null, ms: 0, output: 'не хватило времени (verify.timeout_sec)' });
      break;
    }
    const r = runShell(command, { cwd: root, timeoutMs: remaining });
    results.push({ step, command, ...r });
    if (!r.ok) break;
  }
  const failed = results.find((r) => !r.skipped && !r.ok) || null;
  return { ok: !failed, results, failed };
}

export function summarize(result) {
  const parts = result.results.map((r) => {
    if (r.skipped) return `${r.step}: пропущен`;
    if (r.ok) return `${r.step}: ok (${(r.ms / 1000).toFixed(1)} с)`;
    return `${r.step}: ${r.timedOut ? 'таймаут' : `код ${r.code}`}`;
  });
  return parts.join(', ') || 'нет шагов';
}

export function failureReport(result, maxLines = 60) {
  const f = result.failed;
  if (!f) return '';
  return `Шаг «${f.step}» упал (${f.timedOut ? 'таймаут' : `код ${f.code}`}): \`${f.command}\`\n${trimOutput(f.output, maxLines)}`;
}
