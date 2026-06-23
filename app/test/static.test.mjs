// test/static.test.mjs — cheap, broad safety net: every shipped JS file must
// parse cleanly under `node --check`. Catches syntax errors / typos in files
// the runtime loads lazily (e.g. public/app.js, public/m/m.js) that a
// server-side test suite would otherwise never touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import path from 'path';
import { APP_DIR } from './helpers.mjs';

const pexec = promisify(execFile);

const FILES = [
  ...fs.readdirSync(path.join(APP_DIR, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('lib', f)),
  'server.js',
  'public/app.js',
  'public/hl.js',
  'public/m/m.js',
];

for (const rel of FILES) {
  test(`node --check passes on ${rel}`, async () => {
    const abs = path.join(APP_DIR, rel);
    assert.ok(fs.existsSync(abs), `${rel} should exist`);
    // resolves on exit 0; rejects (throwing the test) with stderr on a parse error
    await pexec(process.execPath, ['--check', abs]);
  });
}
