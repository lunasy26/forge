// Portable test runner: `npm test` must work on POSIX shells and Windows cmd.exe alike.
// Replaces `FORGE_LANG=ru node --test test/*.test.mjs` (env prefix and shell glob are POSIX-only,
// and Node 20 has no glob support in `--test`).
//
// Usage: node test/run.mjs [node --test options] [files...]
//   - arguments ending in .mjs are test files; with none, every test/*.test.mjs is run
//   - everything else (e.g. --test-name-pattern "force") is passed to `node --test` before the files
//   - FORGE_LANG is always ru (an exported value is ignored); the *-en tests pin the language themselves
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const files = args.filter((a) => a.endsWith('.mjs'));
const options = args.filter((a) => !a.endsWith('.mjs'));

if (files.length === 0) {
  files.push(
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.test.mjs'))
      .sort()
      .map((f) => join(dir, f)),
  );
}

const env = { ...process.env };
env.FORGE_LANG = 'ru'; // always: an exported FORGE_LANG=en must not turn the Russian message tests red

const res = spawnSync(process.execPath, ['--test', ...options, ...files], { stdio: 'inherit', env });
process.exit(res.status ?? 1);
