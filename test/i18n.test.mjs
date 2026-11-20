import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANGS, setLang, getLang, t, defineCatalog, registeredCatalogs, placeholdersOf, detectLang, lastUserText, resolveLang,
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

test('lastUserText: big file with the user message early (beyond 256 KB, within 2 MB)', () => {
  const filler = assistant('x'.repeat(4000));
  const lines = [user('Давно написанное сообщение')];
  for (let i = 0; i < 100; i++) lines.push(filler); // ~400 KB
  const file = transcript(jsonl(...lines));
  assert.equal(lastUserText(file), 'Давно написанное сообщение');
});

test('lastUserText: a message beyond 2 MB from the end is not found', () => {
  const filler = assistant('x'.repeat(4000));
  const lines = [user('too far')];
  for (let i = 0; i < 600; i++) lines.push(filler); // ~2.4 MB
  const file = transcript(jsonl(...lines));
  assert.equal(lastUserText(file), null);
});

test('lastUserText: a partial first line in the window does not break parsing', () => {
  const big = user('y'.repeat(300 * 1024));
  const file = transcript(jsonl(big, user('Привет')));
  assert.equal(lastUserText(file), 'Привет');
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
  assert.match(validateProfile({ language: 'de' }).join('\n'), /language: одно из auto, en, ru/);
  const root = tempDir();
  writeProfile(root, { language: 'de' });
  const { profile, errors } = loadProfile(root);
  assert.equal(profile.language, 'auto');
  assert.equal(errors.length, 1);
});
