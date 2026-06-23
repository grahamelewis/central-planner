// lib/paths.js — shared filesystem discipline.
// One implementation of project-path containment and atomic writes; server.js,
// runner.js, and snapshots.js all build on these instead of rolling their own.
import fs from 'fs';
import path from 'path';
import { PROJECTS } from './config.js';

/**
 * Resolve `fileish` (absolute or project-relative) against a project root with
 * full containment discipline: lexical check first, then realpath so symlinks
 * inside the root cannot point outside it.
 *
 * Returns { root, abs, rel } or null when the path escapes the project (or,
 * with mustExist, when the file is missing). `abs` is the real path when the
 * file exists; for mustExist:false on a missing file it is the resolved path.
 */
export function containedPath(project, fileish, { mustExist = true } = {}) {
  const cfg = PROJECTS[project];
  if (!cfg || typeof fileish !== 'string' || fileish.includes('\0')) return null;
  const root = path.resolve(cfg.root);
  const resolved = path.isAbsolute(fileish) ? path.resolve(fileish) : path.resolve(root, fileish);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
  let real = null;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    if (mustExist) return null;
    // missing leaf (mustExist:false): the leaf can't be realpathed, but its
    // EXISTING ancestors can — without this, a directory symlink pointing
    // outside the root lets a future write land outside the project
    let dir = path.dirname(resolved);
    let realDir = null;
    for (;;) {
      try { realDir = fs.realpathSync(dir); break; } catch { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (realDir !== null && realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return null;
  }
  if (real !== null && real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;

  const abs = real ?? resolved;
  return { root: realRoot, abs, rel: path.relative(realRoot, abs) };
}

/**
 * Atomic write: tmp file + rename, preserving the target's permission bits
 * when it already exists (a plain rewrite would silently drop e.g. the exec
 * bit on .sh files). Cleans up the tmp file on failure.
 */
export function writeFileAtomic(abs, content) {
  let mode = null;
  try {
    mode = fs.statSync(abs).mode & 0o7777;
  } catch { /* new file — default mode */ }
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    if (mode !== null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never existed */ }
    throw err;
  }
}
