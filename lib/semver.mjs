// SemVer 2.0.0: parsing, precedence and bumping. The one implementation shared by the changelog,
// the version files and git tags. Numeric parts have no leading zeros, so CalVer such as 2024.01.15
// is not a version.

const NUM = '(?:0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const BUILD_ID = '[0-9A-Za-z-]+';

/** Source of a regexp matching one version: 1 major, 2 minor, 3 patch, 4 pre-release (optional). */
export const SEMVER_SOURCE = `(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?`;
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);

/** Parse "1.2.3", "1.2.3-rc.1" or "1.2.3+build" into { major, minor, patch, pre: string[] }, or null. */
export function parseSemver(text) {
  const m = SEMVER.exec(String(text ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** SemVer precedence of two versions (strings or parsed): negative, 0 or positive. Build metadata is ignored. */
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // release > pre-release
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Like compareSemver, but throws a Russian Error for a string that is not a version. */
export function compareVersions(a, b) {
  if (!parseSemver(a) || !parseSemver(b)) throw new Error(`Не версия semver: ${!parseSemver(a) ? a : b}`);
  return compareSemver(a, b);
}

/**
 * Next version for a bump level, like `npm version`. From a release it is the usual +1; from a pre-release
 * the suffix is dropped and the level only advances when the pre-release did not already reach it:
 * 1.2.3-rc.1 + patch -> 1.2.3; 1.2.0-rc.1 + minor -> 1.2.0 (1.2.3-rc.1 -> 1.3.0); 2.0.0-rc.1 + major -> 2.0.0
 * (2.1.0-rc.1 -> 3.0.0).
 */
export function bumpVersion(version, level) {
  const v = parseSemver(version);
  if (!v) throw new Error(`Не версия semver: ${version}`);
  const pre = v.pre.length > 0;
  if (level === 'major') {
    return pre && v.minor === 0 && v.patch === 0 ? `${v.major}.0.0` : `${v.major + 1}.0.0`;
  }
  if (level === 'minor') {
    return pre && v.patch === 0 ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`;
  }
  if (level === 'patch') {
    return pre ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`;
  }
  throw new Error(`Неизвестный уровень повышения версии: ${level}`);
}
