import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchList } from '../lib/glob.mjs';
import { splitCommands, stripWrappers } from '../lib/shell.mjs';
import { DEFAULT_PROTECTED_FILES } from '../lib/profile.mjs';

const texts = (cmds) => cmds.map((c) => c.map((w) => w.text));

test('glob: unanchored patterns match at any depth', () => {
  assert.ok(matchList('.env', ['.env']));
  assert.ok(matchList('apps/api/.env', ['.env']));
  assert.ok(matchList('certs/server.pem', ['**/*.pem']));
  assert.ok(matchList('a/b.tsx', ['*.{ts,tsx}']));
  assert.equal(matchList('a/b.js', ['*.{ts,tsx}']), null);
});

test('glob: patterns with a slash are anchored, ** crosses directories', () => {
  assert.ok(matchList('src/auth/token.ts', ['src/auth/**']));
  assert.equal(matchList('lib/src/auth/token.ts', ['src/auth/**']), null);
  assert.ok(matchList('db/migrations/001.sql', ['**/migrations/**']));
  assert.ok(matchList('migrations/001.sql', ['**/migrations/**']));
  assert.ok(matchList('.github/workflows/ci.yml', ['.github/workflows/**']));
});

test('glob: directory pattern covers its contents; last match wins with negation', () => {
  assert.ok(matchList('secrets/prod/key.txt', ['secrets']));
  assert.equal(matchList('.env.example', DEFAULT_PROTECTED_FILES), null);
  assert.ok(matchList('.env.local', DEFAULT_PROTECTED_FILES));
  assert.equal(matchList('config/dev.key', [...DEFAULT_PROTECTED_FILES, '!config/dev.key']), null);
});

test('shell: separators split commands, quotes keep words together', () => {
  assert.deepEqual(texts(splitCommands('git add . && git commit -m "fix; push" || echo no')), [
    ['git', 'add', '.'],
    ['git', 'commit', '-m', 'fix; push'],
    ['echo', 'no'],
  ]);
  assert.deepEqual(texts(splitCommands("echo 'a | b' | wc -l; ls")), [['echo', 'a | b'], ['wc', '-l'], ['ls']]);
});

test('shell: redirections and heredoc bodies are not commands or arguments', () => {
  assert.deepEqual(texts(splitCommands('git push origin main 2>&1 | tee out.log')), [
    ['git', 'push', 'origin', 'main'],
    ['tee', 'out.log'],
  ]);
  assert.deepEqual(texts(splitCommands('cat > notes.md <<EOF\ngit push origin main\nEOF\necho ok')), [['cat'], ['echo', 'ok']]);
  assert.deepEqual(texts(splitCommands('cmd &>/dev/null')), [['cmd']]);
});

test('shell: dynamic words are marked, wrappers and env assignments stripped', () => {
  const [[, , dir]] = splitCommands('rm -rf "$DIR"');
  assert.equal(dir.dynamic, true);
  const [[, , sub]] = splitCommands('rm -rf $(pwd)/build');
  assert.equal(sub.dynamic, true);
  const [cmd] = splitCommands('FOO=1 sudo -E git push origin main');
  assert.deepEqual(stripWrappers(cmd).map((w) => w.text), ['git', 'push', 'origin', 'main']);
});
