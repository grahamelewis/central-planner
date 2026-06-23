// test/helpers.mjs — shared, hermetic test utilities.
// No network, no real-data writes: temp dirs live under os.tmpdir() and are
// removed by the caller's after() hook.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Make a fresh temp dir under os.tmpdir(). Caller removes it in after(). */
export function mkTmp(prefix = 'cp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmTmp(dir) {
  if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

/**
 * Extract a top-level `function NAME(...) { ... }` body verbatim from a source
 * file and return its source text, via brace matching. Used to unit-test
 * private helpers (sessions.parseHandoff, ledger date logic) WITHOUT importing
 * the whole module — which would pull the Agent SDK and read real data dirs.
 * This tests the REAL source text of the function, not a re-implementation.
 */
export function extractFunction(absFile, name) {
  const src = fs.readFileSync(absFile, 'utf8');
  // form 1: `function NAME(...) { ... }`  -> brace-match the body
  const fnSig = new RegExp(`function\\s+${name}\\s*\\(`);
  const fm = fnSig.exec(src);
  if (fm) {
    const open = src.indexOf('{', fm.index);
    if (open < 0) throw new Error(`extractFunction: no body for ${name}`);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(fm.index, j + 1); }
    }
    throw new Error(`extractFunction: unbalanced braces for ${name}`);
  }
  // form 2: `const NAME = (...) => ...;`  -> take the single statement line(s)
  const constSig = new RegExp(`((?:const|let|var)\\s+${name}\\s*=[\\s\\S]*?);\\n`);
  const cm = constSig.exec(src);
  if (cm) return cm[1] + ';';
  throw new Error(`extractFunction: ${name} not found in ${absFile}`);
}

/**
 * Build callable copies of one or more private functions from a source file,
 * sharing one scope so they can call each other. `globals` injects any free
 * variables the functions reference (e.g. constants from the module).
 */
export function loadPrivateFns(absFile, names, globals = {}) {
  const bodies = names.map((n) => extractFunction(absFile, n)).join('\n');
  const gNames = Object.keys(globals);
  const factory = new Function(...gNames, `${bodies}\nreturn { ${names.join(', ')} };`);
  return factory(...gNames.map((k) => globals[k]));
}
