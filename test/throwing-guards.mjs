// Preloaded with `node --import` by hook tests to check that the guard hooks fail closed:
// lib/guards.mjs is replaced with guards that throw, and the lib module named in
// FORGE_TEST_BROKEN_MODULE (e.g. "paths") fails to load at all. Not used by the plugin itself.
import * as nodeModule from 'node:module';

const guards = 'const boom = () => { throw new Error("guard exploded"); };\nexport const checkBash = boom;\nexport const checkPowerShell = boom;\nexport const checkFile = boom;\n';
const broken = 'throw new Error("module failed to load");\n';
const replacement = (url, brokenName) => {
  // module URLs always use "/", but stay agnostic of the separator anyway
  const path = url.replace(/\\/g, '/');
  if (brokenName && path.endsWith(`/lib/${brokenName}.mjs`)) return broken;
  if (path.endsWith('/lib/guards.mjs')) return guards;
  return null;
};

if (nodeModule.registerHooks) {
  nodeModule.registerHooks({
    load: (url, context, next) => {
      const source = replacement(url, process.env.FORGE_TEST_BROKEN_MODULE);
      return source === null ? next(url, context) : { format: 'module', source, shortCircuit: true };
    },
  });
} else {
  // Node < 22.15: asynchronous hooks in a loader module
  const loader = `const replacement = ${replacement.toString()};
const guards = ${JSON.stringify(guards)};
const broken = ${JSON.stringify(broken)};
export async function load(url, context, next) {
  const source = replacement(url, process.env.FORGE_TEST_BROKEN_MODULE);
  return source === null ? next(url, context) : { format: 'module', source, shortCircuit: true };
}`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(loader)}`);
}
