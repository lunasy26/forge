const cache = new Map();

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/**
 * gitignore-like glob → RegExp, matched against a path relative to the project root.
 * - no slash in pattern (other than trailing): matches at any depth ("*.pem", ".env")
 * - slash in pattern: anchored to the root ("src/auth/x"), unless it starts with a double-star segment
 * - "**" crosses directories, "*" and "?" don't, "{a,b}" alternation
 * - a pattern that matches a directory also matches everything below it
 */
export function globToRegExp(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let p = pattern.trim();
  if (p.endsWith('/')) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || (p.includes('/') && !p.startsWith('**/'));
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atSegmentStart = i === 0 || p[i - 1] === '/';
        if (atSegmentStart && p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        re += `(?:${p.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else if (c === '}') {
      re += '\\}';
    } else {
      re += escapeRe(c);
    }
  }
  const rx = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
  cache.set(pattern, rx);
  return rx;
}

/**
 * Match a path against a list of patterns, last match wins (like .gitignore).
 * A leading "!" negates. Returns the matching (positive) pattern or null.
 */
export function matchList(path, patterns = []) {
  let hit = null;
  for (const raw of patterns) {
    if (!raw) continue;
    const negated = raw.startsWith('!');
    const pat = negated ? raw.slice(1) : raw;
    if (globToRegExp(pat).test(path)) hit = negated ? null : raw;
  }
  return hit;
}
