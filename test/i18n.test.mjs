import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANGS, setLang, getLang, t, defineCatalog, registeredCatalogs, placeholdersOf, detectLang, lastUserText, resolveLang,
  transcriptLang,
} from '../lib/i18n.mjs';
import { defaultProfile, validateProfile, loadProfile } from '../lib/profile.mjs';
import { tempDir, writeProfile } from './helpers.mjs';

// Import every module that defines a catalog here so the parity test covers it.

const fixture = defineCatalog({
  en: {
    hello: 'Hello, {name}!',
    onlyEn: 'English only',
    both: 'Both {a} and {b}',
    fn: ({ n }) => `${n} files`,
  },
  ru: {
    hello: 'Привет, {name}!',
    both: 'И {b}, и {a}',
    fn: ({ n }) => `${n} файлов`,
    onlyEn: 'Только английский',
  },
});

const gappy = { en: { a: 'A', b: 'B' }, ru: { a: 'А' } };

let before;
beforeEach(() => { before = getLang(); });
afterEach(() => { setLang(before); });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-i18n-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---- language state and t() ----

test('LANGS and default language', () => {
  assert.deepEqual(LANGS, ['en', 'ru']);
  setLang('en');
  assert.equal(getLang(), 'en');
});

test('setLang ignores unknown values', () => {
  setLang('ru');
  setLang('de');
  setLang(undefined);
  assert.equal(getLang(), 'ru');
  setLang('en');
  assert.equal(getLang(), 'en');
});

test('t picks the current language and substitutes params', () => {
  setLang('en');
  assert.equal(t(fixture, 'hello', { name: 'Ann' }), 'Hello, Ann!');
  setLang('ru');
  assert.equal(t(fixture, 'hello', { name: 'Аня' }), 'Привет, Аня!');
});

test('t substitutes every occurrence, leaves unknown placeholders, accepts numbers', () => {
  setLang('en');
  assert.equal(t({ en: { k: '{a}-{a}-{zz}' } }, 'k', { a: 0 }), '0-0-{zz}');
  assert.equal(t({ en: { k: 'no params {x}' } }, 'k'), 'no params {x}');
});

test('t calls function messages with params', () => {
  setLang('en');
  assert.equal(t(fixture, 'fn', { n: 3 }), '3 files');
  setLang('ru');
  assert.equal(t(fixture, 'fn', { n: 3 }), '3 файлов');
});

test('t falls back to en when the key is missing in the current language', () => {
  setLang('ru');
  assert.equal(t(gappy, 'b'), 'B');
  assert.equal(t(gappy, 'a'), 'А');
});

test('t throws a clear error when the key is missing in en', () => {
  setLang('en');
  assert.throws(() => t(gappy, 'zzz'), /zzz/);
  setLang('ru');
  assert.throws(() => t(gappy, 'zzz'), /i18n.*zzz|zzz.*en/);
});

// ---- registry parity ----

test('defineCatalog returns the catalog and registers it', () => {
  assert.ok(registeredCatalogs().includes(fixture));
});

test('every registered catalog has identical keys and placeholders in all languages', async () => {
  // Load every lib module so catalogs defined with defineCatalog register themselves.
  const libDir = new URL('../lib/', import.meta.url);
  for (const name of readdirSync(libDir).filter((f) => f.endsWith('.mjs')).sort()) {
    await import(new URL(name, libDir));
  }
  const catalogs = registeredCatalogs();
  assert.ok(catalogs.length >= 1);
  for (const cat of catalogs) {
    for (const lang of LANGS) assert.ok(cat[lang] && typeof cat[lang] === 'object', `catalog lacks ${lang}`);
    const enKeys = Object.keys(cat.en).sort();
    for (const lang of LANGS) {
      assert.deepEqual(Object.keys(cat[lang]).sort(), enKeys, `key mismatch between en and ${lang}`);
    }
    for (const key of enKeys) {
      const enPh = placeholdersOf(cat.en[key]);
      for (const lang of LANGS) {
        assert.equal(typeof cat[lang][key], typeof cat.en[key], `${lang}.${key}: type differs from en`);
        assert.deepEqual(placeholdersOf(cat[lang][key]), enPh, `${lang}.${key}: placeholders differ from en`);
      }
    }
  }
});

test('hooks define no catalogs of their own: the parity test above only loads lib/', () => {
  const hooksDir = new URL('../hooks/', import.meta.url);
  for (const name of readdirSync(hooksDir).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(new URL(name, hooksDir), 'utf8');
    assert.doesNotMatch(source, /defineCatalog/, `hooks/${name} defines a catalog: move it to lib/hook-messages.mjs`);
  }
});

test('placeholdersOf returns a sorted unique list; functions have none', () => {
  assert.deepEqual(placeholdersOf('{b} {a} {b} text'), ['a', 'b']);
  assert.deepEqual(placeholdersOf('plain'), []);
  assert.deepEqual(placeholdersOf(() => 'x'), []);
});

// ---- detectLang ----

test('detectLang: Russian and English text', () => {
  assert.equal(detectLang('Привет, почини, пожалуйста, тесты'), 'ru');
  assert.equal(detectLang('Please fix the failing tests'), 'en');
});

test('detectLang: Russian text with an English code block stays ru', () => {
  const text = 'Почини функцию ниже:\n```js\nfunction calculateTotalPrice(items) { return items.reduce((a, b) => a + b.price, 0); }\n```';
  assert.equal(detectLang(text), 'ru');
});

test('detectLang: inline code and URLs are ignored', () => {
  assert.equal(detectLang('Открой `calculateTotalPriceForEveryItem` и https://example.com/some/long/path/here'), 'ru');
  assert.equal(detectLang('См. https://example.com/страница/про/что-то `x`'), null);
});

test('detectLang: unclosed fence ignores the rest', () => {
  assert.equal(detectLang('Смотри:\n```\nconst someVeryLongEnglishIdentifier = anotherLongIdentifier;'), 'ru');
});

test('detectLang: fewer than 3 letters is null', () => {
  assert.equal(detectLang(''), null);
  assert.equal(detectLang('ok'), null);
  assert.equal(detectLang('12 34 !!'), null);
  assert.equal(detectLang('да'), null);
  assert.equal(detectLang(undefined), null);
  assert.equal(detectLang('да!'), null);
  assert.equal(detectLang('ага'), 'ru');
});

test('detectLang: threshold at 0.3 Cyrillic share', () => {
  // 3 Cyrillic of 10 letters = 0.3 -> ru
  assert.equal(detectLang('абв' + 'abcdefg'), 'ru');
  // 2 Cyrillic of 10 = 0.2 -> en
  assert.equal(detectLang('аб' + 'abcdefgh'), 'en');
  // 3 of 11 = 0.27 -> en
  assert.equal(detectLang('абв' + 'abcdefgh'), 'en');
});

test('detectLang: pasted content blocks are ignored', () => {
  const paste = `<pasted_content id="1" lines="40">\n${'Error while compiling the module, see the full output below.\n'.repeat(40)}</pasted_content>`;
  assert.equal(detectLang(`Почему это падает?\n${paste}`), 'ru');
  assert.equal(detectLang(`${paste}\nПочему это падает?`), 'ru');
  // an unclosed block runs to the end
  assert.equal(detectLang(`Посмотри лог <pasted_content id="2">${'some english output here '.repeat(50)}`), 'ru');
});

test('detectLang: stack traces and error lines are ignored', () => {
  const js = [
    'Почему падает сборка?',
    'TypeError: Cannot read properties of undefined (reading map)',
    '    at renderList (/app/src/components/List.tsx:42:17)',
    '    at processChild (/app/node_modules/react-dom/cjs/react-dom.development.js:3990:14)',
    '    at Object.renderToString (/app/node_modules/react-dom/server.js:120:5)',
  ].join('\n');
  assert.equal(detectLang(js), 'ru');
  const py = [
    'Вот что выдаёт питон:',
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/site-packages/requests/api.py", line 59, in request',
    '    return session.request(method=method, url=url)',
    'requests.exceptions.ConnectionError: Max retries exceeded with url',
  ].join('\n');
  assert.equal(detectLang(py), 'ru');
  const java = 'Опять ошибка\njava.lang.IllegalStateException: Expected BEGIN_OBJECT but was STRING at line one column two';
  assert.equal(detectLang(java), 'ru');
  // plain English prose that mentions errors still counts
  assert.equal(detectLang('The error happens when the list is empty, please fix it'), 'en');
});

test('detectLang: only the first 16 KB is analysed', () => {
  assert.equal(detectLang('Почини, пожалуйста, тесты' + ' '.repeat(16 * 1024) + 'english words only '.repeat(2000)), 'ru');
  assert.equal(detectLang('1'.repeat(17 * 1024) + ' Привет, почини тесты'), null);
});

test('detectLang: URL stripping is linear', () => {
  for (const text of ['a.'.repeat(1e5), 'a'.repeat(2e5), 'a:/'.repeat(7e4), '-a'.repeat(1e5)]) {
    const started = performance.now();
    detectLang(text);
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${text.slice(0, 6)}… took ${ms.toFixed(1)} ms`);
  }
});

// ---- lastUserText ----

function jsonl(...entries) {
  return entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
}
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = () => user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);

function transcript(text) {
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, text);
  return file;
}

test('lastUserText: string content, latest message wins', () => {
  const file = transcript(jsonl(user('first'), assistant('reply'), user('Привет, мир')));
  assert.equal(lastUserText(file), 'Привет, мир');
});

test('lastUserText: array of text blocks', () => {
  const file = transcript(jsonl(user([{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }])));
  assert.equal(lastUserText(file), 'one\ntwo');
});

test('lastUserText: trailing tool_result entries and assistant lines are skipped', () => {
  const file = transcript(jsonl(user('Сделай это'), assistant('ok'), toolResult(), assistant('done'), toolResult()));
  assert.equal(lastUserText(file), 'Сделай это');
});

test('lastUserText: command wrappers, system reminders and meta messages are skipped', () => {
  const file = transcript(jsonl(
    user('real message'),
    user('<command-name>/forge:plan</command-name>'),
    user('<local-command-stdout>output</local-command-stdout>'),
    user('<system-reminder>reminder</system-reminder>'),
    user('meta text', { isMeta: true }),
    user([{ type: 'text', text: '<command-message>x</command-message>' }]),
  ));
  assert.equal(lastUserText(file), 'real message');
});

test('lastUserText: ignores non-user types, other roles, broken lines', () => {
  const file = transcript(jsonl(
    user('good'),
    { type: 'summary', message: { role: 'user', content: 'nope' } },
    { type: 'user', message: { role: 'assistant', content: 'nope' } },
    'not json at all',
    '{"type":"user"',
  ));
  assert.equal(lastUserText(file), 'good');
});

test('lastUserText: missing file, empty file, bad arguments give null', () => {
  assert.equal(lastUserText(join(dir, 'nope.jsonl')), null);
  assert.equal(lastUserText(transcript('')), null);
  assert.equal(lastUserText(undefined), null);
  assert.equal(lastUserText(null), null);
  assert.equal(lastUserText(dir), null);
  assert.equal(lastUserText(transcript(jsonl(assistant('only assistant')))), null);
});

test('lastUserText: big file with the user message early (beyond 2 MB, within 8 MB)', () => {
  const filler = assistant('x'.repeat(4000));
  const lines = [user('Давно написанное сообщение')];
  for (let i = 0; i < 1000; i++) lines.push(filler); // ~4 MB
  const file = transcript(jsonl(...lines));
  assert.equal(lastUserText(file), 'Давно написанное сообщение');
});

test('lastUserText: a message beyond 8 MB from the end is not found', () => {
  const filler = assistant('x'.repeat(4000));
  const lines = [user('too far')];
  for (let i = 0; i < 2100; i++) lines.push(filler); // ~8.4 MB
  const file = transcript(jsonl(...lines));
  assert.equal(lastUserText(file), null);
});

test('lastUserText: a partial first line in the window does not break parsing', () => {
  const big = user('y'.repeat(300 * 1024));
  const file = transcript(jsonl(big, user('Привет')));
  assert.equal(lastUserText(file), 'Привет');
});

test('lastUserText: entries Claude Code writes on its own behalf are skipped', () => {
  const file = transcript(jsonl(
    user('Привет, почини тесты'),
    user('This session is being continued from a previous conversation that ran out of context. Summary: ...', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('Summary of the earlier part of the conversation', { isVisibleInTranscriptOnly: true }),
    user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>'),
    user('Background agent finished its work and reported back', { origin: { kind: 'task-notification' } }),
    user('A scheduled reminder fired for the session', { promptSource: 'system' }),
    user('<bash-input>ls -la</bash-input>'),
    user('<bash-stdout>total 0\ndrwxr-xr-x  2 user  staff  64 Jan  1 00:00 .</bash-stdout><bash-stderr></bash-stderr>'),
    user('<bash-stderr>command not found</bash-stderr>'),
    user('<user-prompt-submit-hook>Hook output in English</user-prompt-submit-hook>'),
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
    user('  This session is being continued from a previous conversation.'),
  ));
  assert.equal(lastUserText(file), 'Привет, почини тесты');
});

test('lastUserText: a human origin and a non-system prompt source still count', () => {
  const file = transcript(jsonl(user('first'), user('Сообщение человека', { origin: { kind: 'human' }, promptSource: 'user' })));
  assert.equal(lastUserText(file), 'Сообщение человека');
});

test('lastUserText: IDE context blocks are dropped, the user text next to them counts', () => {
  const opened = '<ide_opened_file>The user opened the file /repo/src/app.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>';
  const selection = '<ide_selection>The user selected the lines 1 to 3 from /repo/src/app.ts:\nconst a = 1;\n</ide_selection>';
  assert.equal(lastUserText(transcript(jsonl(user([{ type: 'text', text: opened }, { type: 'text', text: 'Почини это' }])))), 'Почини это');
  assert.equal(lastUserText(transcript(jsonl(user(`${selection}Объясни этот код`)))), 'Объясни этот код');
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), user([{ type: 'text', text: opened }, { type: 'text', text: selection }])))), 'earlier');
});

test('lastUserText: slash commands give their arguments', () => {
  const cmd = (args) => `<command-message>forge:plan</command-message>\n<command-name>/forge:plan</command-name>\n<command-args>${args}</command-args>`;
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), user(cmd('добавь поддержку русского языка'))))), 'добавь поддержку русского языка');
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), user(cmd(''))))), 'earlier');
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), user(cmd('   '))))), 'earlier');
  const nameFirst = '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>check the parser</command-args>';
  assert.equal(lastUserText(transcript(jsonl(user('раньше'), user(nameFirst)))), 'check the parser');
});

test('transcriptLang: the latest detectable human message decides', () => {
  assert.equal(transcriptLang(transcript(jsonl(user('Please fix the tests'), user('Привет, почини тесты')))), 'ru');
  assert.equal(transcriptLang(transcript(jsonl(user('Привет, почини тесты'), assistant('Готово?'), user('да')))), 'ru');
  assert.equal(transcriptLang(transcript(jsonl(user('Please fix the tests'), user('ок'), user('<task-notification>done</task-notification>')))), 'en');
  assert.equal(transcriptLang(transcript(jsonl(user('ok'), user('да')))), null);
  assert.equal(transcriptLang(join(dir, 'missing.jsonl')), null);
  assert.equal(transcriptLang(undefined), null);
});

test('transcriptLang: an English compaction or notification after a Russian message keeps Russian', () => {
  const file = transcript(jsonl(
    user('Сделай, пожалуйста, рефакторинг модуля'),
    assistant('Working on it'),
    user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
    user('<task-notification>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>'),
  ));
  assert.equal(transcriptLang(file), 'ru');
});

test('lastUserText: text next to a tool_result still counts, tool output alone does not', () => {
  const mixed = user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'Привет' }]);
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), mixed))), 'Привет');
  const nested = user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'tool output text' }] }]);
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), nested))), 'earlier');
});

test('lastUserText: lines that span read chunks are read whole', () => {
  const huge = 'Привет ' + 'я'.repeat(400 * 1024); // ~800 KB, several chunks
  assert.equal(lastUserText(transcript(jsonl(user('earlier'), user(huge), assistant('x'.repeat(300 * 1024))))), huge);
  // many lines of odd lengths: chunk borders fall inside lines and right before marks
  const lines = [user('Привет, почини, пожалуйста, тесты')];
  for (let i = 0; i < 3000; i++) lines.push(i % 7 ? assistant('w'.repeat(37 + (i % 101))) : user('ok'));
  for (let i = 0; i < 3000; i++) lines.push(i % 5 ? toolResult() : user(`да ${'!'.repeat(i % 13)}`));
  const file = transcript(jsonl(...lines));
  assert.equal(lastUserText(file), 'да !!!!!!!!!!!'.slice(0, 'да '.length + (2995 % 13)));
  assert.equal(transcriptLang(file), 'ru');
});

// ---- resolveLang ----

const ruTranscript = () => transcript(jsonl(user('Привет, почини тесты')));
const enTranscript = () => transcript(jsonl(user('Please fix the tests')));

test('resolveLang: FORGE_LANG beats everything', () => {
  const input = { transcript_path: ruTranscript() };
  assert.equal(resolveLang({ env: { FORGE_LANG: 'en', LANG: 'ru_RU.UTF-8' }, profile: { language: 'ru' }, state: { lang: 'ru' }, input }), 'en');
  assert.equal(resolveLang({ env: { FORGE_LANG: 'ru' }, profile: { language: 'en' }, input: { transcript_path: enTranscript() } }), 'ru');
});

test('resolveLang: invalid FORGE_LANG is ignored', () => {
  assert.equal(resolveLang({ env: { FORGE_LANG: 'de' }, profile: { language: 'ru' } }), 'ru');
});

test('resolveLang: profile language beats transcript, state and locale', () => {
  const input = { transcript_path: ruTranscript() };
  assert.equal(resolveLang({ env: {}, profile: { language: 'en' }, state: { lang: 'ru' }, input }), 'en');
  assert.equal(resolveLang({ env: { LANG: 'en_US.UTF-8' }, profile: { language: 'ru' }, input: { transcript_path: enTranscript() } }), 'ru');
});

test('resolveLang: profile auto falls through to the transcript', () => {
  assert.equal(resolveLang({ env: {}, profile: { language: 'auto' }, state: { lang: 'en' }, input: { transcript_path: ruTranscript() } }), 'ru');
  assert.equal(resolveLang({ env: { LANG: 'ru_RU.UTF-8' }, profile: { language: 'auto' }, input: { transcript_path: enTranscript() } }), 'en');
});

test('resolveLang: transcript beats state and locale', () => {
  assert.equal(resolveLang({ env: { LANG: 'ru_RU.UTF-8' }, state: { lang: 'ru' }, input: { transcript_path: enTranscript() } }), 'en');
});

test('resolveLang: undetectable transcript falls through to state', () => {
  const short = transcript(jsonl(user('ok')));
  assert.equal(resolveLang({ env: {}, state: { lang: 'ru' }, input: { transcript_path: short } }), 'ru');
  assert.equal(resolveLang({ env: { LANG: 'ru_RU.UTF-8' }, state: { lang: 'en' }, input: { transcript_path: join(dir, 'missing.jsonl') } }), 'en');
});

test('resolveLang: invalid state.lang falls through to locale', () => {
  assert.equal(resolveLang({ env: { LANG: 'ru_RU.UTF-8' }, state: { lang: 'de' } }), 'ru');
});

test('resolveLang: locale order LC_ALL, LC_MESSAGES, LANG; only ru-prefixed counts', () => {
  assert.equal(resolveLang({ env: { LANG: 'ru_RU.UTF-8' } }), 'ru');
  assert.equal(resolveLang({ env: { LC_MESSAGES: 'ru_UA.UTF-8' } }), 'ru');
  assert.equal(resolveLang({ env: { LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' } }), 'ru');
  assert.equal(resolveLang({ env: { LC_ALL: 'en_US.UTF-8', LANG: 'ru_RU.UTF-8' } }), 'en');
  assert.equal(resolveLang({ env: { LANG: 'de_DE.UTF-8' } }), 'en');
});

test('resolveLang: defaults to en with nothing to go on', () => {
  assert.equal(resolveLang({ env: {} }), 'en');
  assert.equal(resolveLang({ env: {}, profile: null, state: null, input: null }), 'en');
});

// ---- profile.language ----

test('profile: language defaults to auto', () => {
  assert.equal(defaultProfile().language, 'auto');
  const { profile, errors } = loadProfile(tempDir());
  assert.equal(profile.language, 'auto');
  assert.deepEqual(errors, []);
});

test('profile: language accepts auto, en, ru', () => {
  for (const language of ['auto', 'en', 'ru']) {
    const root = tempDir();
    writeProfile(root, { language });
    const { profile, errors } = loadProfile(root);
    assert.equal(profile.language, language);
    assert.deepEqual(errors, []);
  }
});

test('profile: invalid language gives a Russian error and the default', () => {
  setLang('ru'); // afterEach restores the language
  assert.match(validateProfile({ language: 'de' }).join('\n'), /language: одно из auto, en, ru/);
  const root = tempDir();
  writeProfile(root, { language: 'de' });
  const { profile, errors } = loadProfile(root);
  assert.equal(profile.language, 'auto');
  assert.equal(errors.length, 1);
});
