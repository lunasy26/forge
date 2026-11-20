// PreToolUse(Bash): git and rm guards. Silent on allow so normal permissions still apply.
import { checkBash } from '../lib/guards.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { runHook } from '../lib/util.mjs';

runHook('pre-bash', async (input, root) => {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  const { profile } = loadProfile(root);
  const verdict = checkBash(command, { cwd: input.cwd || root, root, protectedBranches: profile.git.protected_branches });
  if (verdict.decision === 'allow') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
});
