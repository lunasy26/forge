// PostToolUse(Edit|Write|...): append the edited file to .forge/edits.jsonl. Runs nothing else.
import { existsSync } from 'node:fs';
import { recordEdit } from '../lib/edits.mjs';
import { profilePath } from '../lib/profile.mjs';
import { runHook } from '../lib/util.mjs';

// Prints nothing, so it doesn't pick a language: one fewer transcript read per edit.
runHook('post-edit', async (input, root) => {
  if (!existsSync(profilePath(root))) return null; // forge is not set up here: leave no files behind
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (typeof file === 'string' && file) recordEdit(root, file);
  return null;
});
