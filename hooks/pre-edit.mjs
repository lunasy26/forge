// PreToolUse(Edit|Write|MultiEdit|NotebookEdit): protected files.
import { checkFile } from '../lib/guards.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { runHook } from '../lib/util.mjs';

runHook('pre-edit', async (input, root) => {
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (typeof file !== 'string' || !file) return null;
  const { profile } = loadProfile(root);
  const verdict = checkFile(file, { root, protectedFiles: profile.protected_files });
  if (verdict.decision === 'allow') return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
});
