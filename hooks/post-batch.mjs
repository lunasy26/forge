// PostToolBatch: once per batch of tool calls, format + lint the files edited since the last run.
import { editsSize, filesSince } from '../lib/edits.mjs';
import { loadProfile } from '../lib/profile.mjs';
import { loadState, updateState } from '../lib/state.mjs';
import { runHook } from '../lib/util.mjs';
import { failureReport, runSteps } from '../lib/verify.mjs';

runHook('post-batch', async (_input, root) => {
  const { exists, profile } = loadProfile(root);
  if (!exists) return null;
  const steps = ['format', 'lint'].filter((s) => s in profile.commands);
  if (!steps.length) return null;
  const state = loadState(root);
  const size = editsSize(root);
  const from = state.lint_offset > size ? 0 : state.lint_offset || 0;
  if (size <= from) return null;
  const files = filesSince(root, from);
  updateState(root, (s) => {
    s.lint_offset = size;
  });
  if (!files.length) return null;
  const result = runSteps(root, profile, steps, { files, timeoutSec: 150 });
  if (result.ok) return null;
  // decision:'block' on PostToolBatch stops the loop before the next model call and shows the reason as a
  // warning, so lint errors would not be acted on in this turn; additionalContext reaches the model now.
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolBatch',
      additionalContext: `forge: после правок ${failureReport(result, 40)}\n\nИсправь это до следующих шагов.`,
    },
  };
});
