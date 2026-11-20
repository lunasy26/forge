// PreToolUse(Bash): git and rm guards. Silent on allow so normal permissions still apply.
// Unlike the other hooks this one fails closed: if the guard itself breaks (a module that does not
// load, the project root, the check), the user is asked. Only unreadable input passes silently.
// Rendered in the catch below: the i18n module may be the very thing that failed to load.
const BROKEN = {
  en: 'forge: internal error while checking the command (details in the forge error log) — cannot confirm it is safe. Confirm.',
  ru: 'forge: внутренняя ошибка проверки команды (подробности в журнале ошибок forge) — не могу убедиться, что она безопасна. Подтверди.',
};

let input = null;
try {
  const chunks = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  input = text ? JSON.parse(text) : {};
} catch {
  process.exit(0); // no command to guard
}
const command = input?.tool_input?.command;
if (typeof command !== 'string' || !command.trim()) process.exit(0);

let root = null;
let verdict;
try {
  const [{ checkBash }, { loadProfile }, { projectRoot }, { initLang }] = await Promise.all([
    import('../lib/guards.mjs'),
    import('../lib/profile.mjs'),
    import('../lib/paths.mjs'),
    import('../lib/lang.mjs'),
  ]);
  root = projectRoot(input.cwd);
  initLang(root, input);
  const { profile } = loadProfile(root);
  verdict = checkBash(command, { cwd: input.cwd || root, root, protectedBranches: profile.git.protected_branches });
} catch (err) {
  try {
    (await import('../lib/util.mjs')).logError(root, 'pre-bash', err);
  } catch {
    // logging must not turn the ask into a crash
  }
  let reason = BROKEN.en;
  try {
    const { getLang } = await import('../lib/i18n.mjs');
    reason = BROKEN[getLang()] || BROKEN.en;
  } catch {
    // keep English
  }
  verdict = { decision: 'ask', reason };
}
if (verdict.decision !== 'allow') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason },
    }),
  );
}
process.exit(0);
