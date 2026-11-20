import { resolveLang, setLang } from './i18n.mjs';
import { loadProfile } from './profile.mjs';
import { loadState } from './state.mjs';

/**
 * Pick the message language for this process and make it current. Every entry point (each hook,
 * the CLI) calls this first. Never throws: a broken profile or state only drops that source.
 * Profile validation errors are rendered in the language current at load time, so callers that
 * show them should load the profile again after this call.
 */
export function initLang(root, input) {
  let profile;
  let state;
  try {
    profile = loadProfile(root).profile;
  } catch {
    // ignore: fall through to the other sources
  }
  try {
    state = loadState(root);
  } catch {
    // ignore
  }
  const lang = resolveLang({ profile, state, input });
  setLang(lang);
  return lang;
}
