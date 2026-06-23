// test/paths.test.mjs — containedPath() is the security boundary: it decides
// which files a session/preview may touch. A thorough allow/deny table plus
// real symlinks on disk to exercise the realpath escape check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp } from './helpers.mjs';
import { PROJECTS } from '../lib/config.js';
import { containedPath } from '../lib/paths.js';

const KEY = '__paths_test__';
let root;       // project root (a temp dir)
let outside;    // a sibling dir OUTSIDE the root

before(() => {
  // realpath the temp base so the project root mirrors production roots, which
  // are NOT under a symlink (macOS tmpdir is /var -> /private/var). containedPath
  // realpaths the root internally; a symlinked root would make `rel` for a
  // *missing* file cross the symlink boundary (cosmetic, not a containment hole).
  const base = fs.realpathSync(mkTmp('cp-paths-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'inside');
  fs.writeFileSync(path.join(root, 'sub', 'deep.txt'), 'deep');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');

  // symlinks (skip silently on platforms that disallow them)
  try {
    // a) link INSIDE root pointing to a file OUTSIDE root  -> must be denied
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape-link'));
    // b) link INSIDE root pointing to a file INSIDE root   -> must be allowed
    fs.symlinkSync(path.join(root, 'file.txt'), path.join(root, 'inside-link'));
    // c) a directory symlink inside root -> outside root
    fs.symlinkSync(outside, path.join(root, 'escape-dir'));
  } catch { /* symlinks unsupported — those cases self-skip below */ }

  PROJECTS[KEY] = { name: 'paths-test', root };
});

after(() => {
  delete PROJECTS[KEY];
  // root and outside share a parent temp dir; remove it
  rmTmp(path.dirname(root));
});

// --- ALLOW cases -----------------------------------------------------------

test('allows a plain file inside the root (relative)', () => {
  const r = containedPath(KEY, 'file.txt');
  assert.ok(r, 'should resolve');
  assert.equal(r.rel, 'file.txt');
  assert.equal(path.basename(r.abs), 'file.txt');
});

test('allows a nested file inside the root', () => {
  const r = containedPath(KEY, 'sub/deep.txt');
  assert.ok(r);
  assert.equal(r.rel, path.join('sub', 'deep.txt'));
});

test('allows an absolute path that lands inside the root', () => {
  const r = containedPath(KEY, path.join(root, 'file.txt'));
  assert.ok(r);
  assert.equal(r.rel, 'file.txt');
});

test('allows the root itself (rel === "")', () => {
  const r = containedPath(KEY, '.', { mustExist: true });
  assert.ok(r, 'root must be allowed');
  assert.equal(r.rel, '');
});

test('allows a missing file with mustExist:false and returns resolved abs', () => {
  const r = containedPath(KEY, 'does/not/exist.txt', { mustExist: false });
  assert.ok(r);
  assert.equal(r.rel, path.join('does', 'not', 'exist.txt'));
});

test('a "." traversal that stays inside is allowed', () => {
  const r = containedPath(KEY, 'sub/../file.txt');
  assert.ok(r);
  assert.equal(r.rel, 'file.txt');
});

// --- DENY cases ------------------------------------------------------------

test('denies lexical traversal escaping the root', () => {
  assert.equal(containedPath(KEY, '../outside/secret.txt'), null);
});

test('denies deep traversal escaping the root', () => {
  assert.equal(containedPath(KEY, 'sub/../../outside/secret.txt'), null);
});

test('denies an absolute path outside the root', () => {
  assert.equal(containedPath(KEY, path.join(outside, 'secret.txt')), null);
});

test('denies a path with a NUL byte', () => {
  assert.equal(containedPath(KEY, 'file.txt\0.png'), null);
});

test('denies a sibling whose name shares the root prefix (root + suffix, no sep)', () => {
  // e.g. root="/tmp/x/root", attacker asks for "/tmp/x/root-evil/f" — the
  // startsWith(root) guard must require a path separator after the root.
  const sibling = root + '-evil';
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'f.txt'), 'evil');
  try {
    assert.equal(containedPath(KEY, path.join(sibling, 'f.txt')), null);
  } finally {
    rmTmp(sibling);
  }
});

test('denies a missing file when mustExist defaults to true', () => {
  assert.equal(containedPath(KEY, 'nope.txt'), null);
});

test('denies an unknown project key', () => {
  assert.equal(containedPath('not-a-real-project', 'file.txt'), null);
});

test('denies a non-string fileish', () => {
  assert.equal(containedPath(KEY, 42), null);
  assert.equal(containedPath(KEY, null), null);
  assert.equal(containedPath(KEY, undefined), null);
});

// --- SYMLINK (realpath) cases ----------------------------------------------

const hasSymlinks = () => fs.existsSync(path.join(root, 'inside-link'));

test('allows a symlink inside root pointing inside root', { skip: !fs.existsSync },
  () => {
    if (!hasSymlinks()) return; // platform without symlinks
    const r = containedPath(KEY, 'inside-link');
    assert.ok(r, 'inside->inside symlink should be allowed');
    // realpath collapses to the real target
    assert.equal(path.basename(r.abs), 'file.txt');
  });

test('DENIES a symlink inside root that points OUTSIDE root (realpath escape)', () => {
  if (!hasSymlinks()) return;
  // This is the attack the realpath check exists to stop.
  assert.equal(containedPath(KEY, 'escape-link'), null);
});

test('DENIES traversal through a directory symlink that points outside root', () => {
  if (!hasSymlinks()) return;
  assert.equal(containedPath(KEY, 'escape-dir/secret.txt'), null);
});

test('trailing slash on an inside dir is allowed and normalized', () => {
  const r = containedPath(KEY, 'sub/');
  assert.ok(r);
  assert.equal(r.rel, 'sub');
});
