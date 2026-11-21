import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, runCli, runHookScript, tempDir, write, writeProfile } from './helpers.mjs';

// Every entry point must pick the language itself (initLang): with FORGE_LANG removed from the child
// environment nothing else would make it speak Russian. Each Russian case here fails if an entry point
// stops calling initLang.

const CYRILLIC = /\p{Script=Cyrillic}/u;
/** No FORGE_LANG and an English-neutral locale: the language must come from the transcript, state or profile. */
const AUTO = { FORGE_LANG: undefined, LANG: 'C', LC_ALL: undefined, LC_MESSAGES: undefined };

const userEntry = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });

function transcript(...entries) {
  const lines = entries.map((e) => JSON.stringify(typeof e === 'string' ? userEntry(e) : e));
  return write(tempDir(), 'transcript.jsonl', `${lines.join('\n')}\n`);
}

const RU = 'Привет, почини, пожалуйста, тесты';
const EN = 'Please fix the failing tests';
/** What Claude Code itself appends after the human's message: a background task notice and a compaction summary. */
const NOISE = [
  userEntry('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed</summary>\n</task-notification>'),
  userEntry('This session is being continued from a previous conversation that ran out of context. The conversation is summarized below.', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
];

const push = (dir, transcriptPath, env = AUTO) =>
  runHookScript('pre-bash', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push origin main' }, transcript_path: transcriptPath }, { projectDir: dir, env });
const pushReason = (r) => r.json.hookSpecificOutput.permissionDecisionReason;

const editEnv = (dir, transcriptPath) =>
  runHookScript('pre-edit', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, '.env') }, transcript_path: transcriptPath }, { projectDir: dir, env: AUTO });
const editReason = (r) => r.json.hookSpecificOutput.permissionDecisionReason;

function lintProject() {
  const dir = gitRepo('feature/x');
  write(dir, 'lint.mjs', "import { readFileSync } from 'node:fs';\nfor (const f of process.argv.slice(2)) if (readFileSync(f,'utf8').includes('BAD')) { console.error(f + ': BAD found'); process.exit(1); }\n");
  writeProfile(dir, { commands: { lint: 'node lint.mjs {files}' }, verify: { steps: [], on_stop: 'off' } });
  return dir;
}

function lintAfterBadEdit(transcriptPath) {
  const dir = lintProject();
  const file = write(dir, 'bad.ts', 'BAD code');
  runHookScript('post-edit', { cwd: dir, tool_name: 'Write', tool_input: { file_path: file } }, { projectDir: dir, env: AUTO });
  const r = runHookScript('post-batch', { cwd: dir, transcript_path: transcriptPath }, { projectDir: dir, env: AUTO });
  return r.json.hookSpecificOutput.additionalContext;
}

test('pre-bash follows the transcript language', () => {
  const dir = gitRepo('main');
  assert.match(pushReason(push(dir, transcript(RU))), /^forge: push в защищённую ветку/);
  const en = pushReason(push(dir, transcript(EN)));
  assert.match(en, /^forge: pushing to the protected branch/);
  assert.doesNotMatch(en, CYRILLIC);
});

test('pre-edit follows the transcript language', () => {
  const dir = gitRepo('main');
  assert.match(editReason(editEnv(dir, transcript(RU))), /^forge: файл .*\.env.* защищён/);
  const en = editReason(editEnv(dir, transcript(EN)));
  assert.match(en, /^forge: file .*\.env.* is protected/);
  assert.doesNotMatch(en, CYRILLIC);
});

test('post-batch follows the transcript language', () => {
  assert.match(lintAfterBadEdit(transcript(RU)), /^forge: после правок /);
  const en = lintAfterBadEdit(transcript(EN));
  assert.match(en, /^forge: after your edits /);
  assert.doesNotMatch(en, CYRILLIC);
});

test('a task notification or compaction after a Russian message keeps Russian', () => {
  const ruThenNoise = transcript(RU, ...NOISE);
  const dir = gitRepo('main');
  assert.match(pushReason(push(dir, ruThenNoise)), /^forge: push в защищённую ветку/);
  assert.match(editReason(editEnv(dir, ruThenNoise)), /^forge: файл /);
  assert.match(lintAfterBadEdit(ruThenNoise), /^forge: после правок /);

  // Stop stores the language for the CLI: the notice must not flip it to English.
  const project = lintProject();
  const r = runHookScript('stop', { cwd: project, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: ruThenNoise }, { projectDir: project, env: AUTO });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(readFileSync(join(project, '.forge', 'state.json'), 'utf8')).lang, 'ru');
});

test('a short reply ("да") falls back to the earlier human message', () => {
  const dir = gitRepo('main');
  assert.match(pushReason(push(dir, transcript(RU, 'да'))), /^forge: push в защищённую ветку/);
  assert.match(pushReason(push(dir, transcript(EN, 'да'))), /^forge: pushing to the protected branch/);

  const project = lintProject();
  write(project, '.forge/state.json', { version: 1, lang: 'en' });
  runHookScript('stop', { cwd: project, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript(RU, 'да') }, { projectDir: project, env: AUTO });
  assert.equal(JSON.parse(readFileSync(join(project, '.forge', 'state.json'), 'utf8')).lang, 'ru', 'Stop stores the language of the earlier message');
});

test('stop and session-start follow the transcript language', () => {
  const stopReason = (transcriptPath) => {
    const dir = gitRepo('feature/x');
    write(dir, 'check.mjs', 'process.exit(1);\n');
    writeProfile(dir, { commands: { test: 'node check.mjs' }, verify: { steps: ['test'], on_stop: 'full' } });
    const file = write(dir, 'a.ts', '1');
    runHookScript('post-edit', { cwd: dir, tool_name: 'Write', tool_input: { file_path: file } }, { projectDir: dir, env: AUTO });
    return runHookScript('stop', { cwd: dir, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcriptPath }, { projectDir: dir, env: AUTO }).json.reason;
  };
  assert.match(stopReason(transcript(RU, ...NOISE)), /^forge: проверка перед завершением не прошла/);
  assert.match(stopReason(transcript(EN)), /^forge: the check before finishing failed/);

  const start = (transcriptPath) => {
    const dir = gitRepo();
    return runHookScript('session-start', { cwd: dir, source: 'resume', transcript_path: transcriptPath }, { projectDir: dir, env: AUTO }).json.hookSpecificOutput.additionalContext;
  };
  assert.match(start(transcript(RU, ...NOISE)), /^forge: в проекте нет профиля/);
  assert.match(start(transcript(EN)), /^forge: no profile in this project/);
});

test('CLI: state.lang picks the language', () => {
  const dir = gitRepo();
  write(dir, '.forge/state.json', { version: 1, lang: 'ru' });
  const r = runCli(['help'], { cwd: dir, env: AUTO });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^forge — CLI плагина forge/);

  write(dir, '.forge/state.json', { version: 1, lang: 'en' });
  const en = runCli(['help'], { cwd: dir, env: AUTO });
  assert.match(en.stdout, /^forge — forge plugin CLI/);
  assert.doesNotMatch(en.stdout, CYRILLIC);
});

test('CLI: profile.language beats state.lang', () => {
  const dir = gitRepo();
  writeProfile(dir, { language: 'en' });
  write(dir, '.forge/state.json', { version: 1, lang: 'ru' });
  const r = runCli(['help'], { cwd: dir, env: AUTO });
  assert.match(r.stdout, /^forge — forge plugin CLI/);
  assert.doesNotMatch(r.stdout, CYRILLIC);

  // and the other way round
  writeProfile(dir, { language: 'ru' });
  write(dir, '.forge/state.json', { version: 1, lang: 'en' });
  assert.match(runCli(['help'], { cwd: dir, env: AUTO }).stdout, /^forge — CLI плагина forge/);
});

test('CLI: no state and a Russian locale give Russian', () => {
  const dir = gitRepo();
  assert.match(runCli(['help'], { cwd: dir, env: { ...AUTO, LANG: 'ru_RU.UTF-8' } }).stdout, /^forge — CLI плагина forge/);
  const en = runCli(['help'], { cwd: dir, env: AUTO });
  assert.match(en.stdout, /^forge — forge plugin CLI/);
});
