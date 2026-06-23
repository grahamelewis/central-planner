// test/pins.test.mjs — pinKind() string classification, and pinCard()'s
// stat-derived kind (a folder pin stored without its trailing slash must still
// be recognized as a folder via st.isDirectory(), not misread as code).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp } from './helpers.mjs';
import { PROJECTS } from '../lib/config.js';
import { pinKind, pinCard, DATA_EXTS } from '../lib/pins.js';

describe('pinKind (string classification)', () => {
  test('trailing slash => folder', () => {
    assert.equal(pinKind('some/dir/'), 'folder');
    assert.equal(pinKind('a/b/c.csv/'), 'folder', 'trailing slash wins over ext');
  });

  test('data extensions => data', () => {
    for (const ext of DATA_EXTS) assert.equal(pinKind(`f.${ext}`), 'data', ext);
    assert.equal(pinKind('DATA.CSV'), 'data', 'case-insensitive');
  });

  test('code/text extensions => code', () => {
    for (const f of ['main.py', 'a.R', 'notes.md', 'x.tex', 'noext', 'script.sh']) {
      assert.equal(pinKind(f), 'code', f);
    }
  });

  test('handles empty / non-string input', () => {
    assert.equal(pinKind(''), 'code');
    assert.equal(pinKind(null), 'code');
    assert.equal(pinKind(undefined), 'code');
  });
});

describe('pinCard (stat-derived kind)', () => {
  const KEY = '__pins_test__';
  let root;

  before(() => {
    root = fs.realpathSync(mkTmp('cp-pins-'));
    fs.mkdirSync(path.join(root, 'mydir'));
    fs.writeFileSync(path.join(root, 'mydir', 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'mydir', 'b.txt'), 'b');
    fs.writeFileSync(path.join(root, 'data.csv'), 'x,y\n1,2\n3,4\n');
    fs.writeFileSync(path.join(root, 'script.py'), 'print(1)\n');
    PROJECTS[KEY] = { name: 'pins-test', root };
  });

  after(() => { delete PROJECTS[KEY]; rmTmp(root); });

  test('a directory pin WITH trailing slash yields a folder card', async () => {
    const r = await pinCard(KEY, 'mydir/');
    assert.equal(r.kind, 'folder');
    assert.match(r.card, /folder map of mydir/);
    assert.match(r.card, /a\.txt/);
  });

  test('a directory pin WITHOUT trailing slash is still a folder (stat wins)', async () => {
    // Regression guard: the dashboard strips trailing slashes; a suffix-only
    // check would misread this as 'code' and refuse the card.
    const r = await pinCard(KEY, 'mydir');
    assert.equal(r.kind, 'folder');
    assert.match(r.card, /folder map of mydir/);
  });

  test('a csv file yields a data card with schema + sample', async () => {
    const r = await pinCard(KEY, 'data.csv');
    assert.equal(r.kind, 'data');
    assert.match(r.card, /format: csv/);
    assert.match(r.card, /columns/);
    assert.match(r.card, /\bx\b/);
  });

  test('a code file has no card (the session reads it directly)', async () => {
    const r = await pinCard(KEY, 'script.py');
    assert.ok(r.error, 'should be an error result');
    assert.match(r.error, /code pins have no card/);
  });

  test('a missing / out-of-root path returns an error, never throws', async () => {
    const r = await pinCard(KEY, '../escape.csv');
    assert.ok(r.error);
    assert.match(r.error, /not found or outside the project/);
  });

  test('an unknown project returns an error', async () => {
    const r = await pinCard('no-such-project', 'data.csv');
    assert.ok(r.error);
  });
});
