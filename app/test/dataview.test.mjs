// test/dataview.test.mjs — the two PURE, pandas-free parts of the data viewer:
//  1. csvFallback(): the naive node csv/tsv parser used when python is absent.
//  2. esc()/renderHtml(): XSS escaping + JSON->HTML shape for the iframe page.
// Both are private; we extract their REAL source text and run them with the
// free variables they reference injected (no module import, no child spawn).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp, loadPrivateFns, APP_DIR } from './helpers.mjs';

const SRC = path.join(APP_DIR, 'lib', 'dataview.js');

// constants copied from dataview.js (load-bearing for the extracted fns)
const CELL_MAX = 200;
const COL_MAX = 80;
const PAGE_CSS = ''; // body is irrelevant to escaping assertions

let csv, view;
let tmp;

before(() => {
  tmp = mkTmp('cp-dataview-');
  // truncCell first (csvFallback closes over it)
  const fns = loadPrivateFns(SRC,
    ['truncCell', 'csvFallback', 'esc', 'page', 'renderHtml'],
    { fs, path, CELL_MAX, COL_MAX, PAGE_CSS });
  csv = (rel, ext, rows, why = 'test') => fns.csvFallback(path.join(tmp, rel), ext, rows, why);
  view = fns;
});

after(() => rmTmp(tmp));

function writeFixture(name, content) {
  fs.writeFileSync(path.join(tmp, name), content);
  return name;
}

describe('csvFallback (node csv/tsv parser)', () => {
  test('parses a simple csv with header + rows', () => {
    writeFixture('simple.csv', 'a,b,c\n1,2,3\n4,5,6\n');
    const r = csv('simple.csv', 'csv', 50);
    assert.deepEqual(r.columns.map((c) => c.name), ['a', 'b', 'c']);
    assert.deepEqual(r.columns.map((c) => c.dtype), ['text', 'text', 'text']);
    assert.deepEqual(r.rows, [['1', '2', '3'], ['4', '5', '6']]);
    assert.equal(r.nrows_shown, 2);
    assert.equal(r.total_rows, 2, 'whole file scanned -> exact count');
    assert.match(r.note, /naive node parser/);
  });

  test('handles a missing trailing newline (last row not dropped)', () => {
    writeFixture('notrail.csv', 'a,b\n1,2\n3,4'); // no final \n
    const r = csv('notrail.csv', 'csv', 50);
    assert.deepEqual(r.rows, [['1', '2'], ['3', '4']]);
    assert.equal(r.total_rows, 2);
  });

  test('respects quoted fields with embedded delimiters and newlines', () => {
    writeFixture('quoted.csv', 'a,b\n"x,y","line1\nline2"\n"plain",z\n');
    const r = csv('quoted.csv', 'csv', 50);
    assert.deepEqual(r.rows[0], ['x,y', 'line1\nline2']);
    assert.deepEqual(r.rows[1], ['plain', 'z']);
  });

  test('handles escaped doubled quotes inside a quoted field', () => {
    writeFixture('escq.csv', 'a\n"say ""hi"""\n');
    const r = csv('escq.csv', 'csv', 50);
    assert.deepEqual(r.rows[0], ['say "hi"']);
  });

  test('parses tsv with tab delimiter', () => {
    writeFixture('t.tsv', 'a\tb\n1\t2\n');
    const r = csv('t.tsv', 'tsv', 50);
    assert.deepEqual(r.columns.map((c) => c.name), ['a', 'b']);
    assert.deepEqual(r.rows, [['1', '2']]);
  });

  test('strips a UTF-8 BOM from the first header cell', () => {
    writeFixture('bom.csv', '﻿a,b\n1,2\n');
    const r = csv('bom.csv', 'csv', 50);
    assert.equal(r.columns[0].name, 'a', 'BOM should be stripped');
  });

  test('names empty header cells (col N)', () => {
    writeFixture('emptyhdr.csv', 'a,,c\n1,2,3\n');
    const r = csv('emptyhdr.csv', 'csv', 50);
    assert.deepEqual(r.columns.map((c) => c.name), ['a', '(col 2)', 'c']);
  });

  test('truncates a cell longer than CELL_MAX with an ellipsis', () => {
    const big = 'x'.repeat(CELL_MAX + 50);
    writeFixture('big.csv', `a\n${big}\n`);
    const r = csv('big.csv', 'csv', 50);
    assert.equal(r.rows[0][0].length, CELL_MAX + 1); // CELL_MAX chars + '…'
    assert.ok(r.rows[0][0].endsWith('…'));
  });

  test('honours the rows cap (does not over-read)', () => {
    writeFixture('many.csv', 'a\n' + Array.from({ length: 20 }, (_, i) => i).join('\n') + '\n');
    const r = csv('many.csv', 'csv', 5);
    assert.equal(r.nrows_shown, 5);
    assert.equal(r.total_rows, null, 'partial scan -> count is not exact');
  });

  test('pads short rows with null for missing trailing columns', () => {
    writeFixture('ragged.csv', 'a,b,c\n1,2\n');
    const r = csv('ragged.csv', 'csv', 50);
    assert.deepEqual(r.rows[0], ['1', '2', null]);
  });
});

describe('esc / renderHtml (XSS + JSON shape)', () => {
  test('esc escapes all five HTML-significant characters', () => {
    assert.equal(view.esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  test('renderHtml escapes a malicious column name', () => {
    const html = view.renderHtml('f.csv', {
      columns: [{ name: '<script>alert(1)</script>', dtype: 'text' }],
      rows: [['ok']], nrows_shown: 1, total_rows: 1,
    });
    assert.ok(!html.includes('<script>'), 'raw <script> must not appear');
    assert.ok(html.includes('&lt;script&gt;'), 'should be escaped');
  });

  test('renderHtml escapes a malicious cell value', () => {
    const html = view.renderHtml('f.csv', {
      columns: [{ name: 'c', dtype: 'text' }],
      rows: [['<img src=x onerror=alert(1)>']], nrows_shown: 1, total_rows: 1,
    });
    assert.ok(!html.includes('<img'), 'raw <img must not appear');
    assert.ok(html.includes('&lt;img'));
  });

  test('renderHtml escapes the rel/filename in the header', () => {
    const html = view.renderHtml('<evil>.csv', {
      columns: [{ name: 'c', dtype: 'text' }], rows: [], nrows_shown: 0, total_rows: 0,
    });
    assert.ok(!html.includes('<evil>'));
    assert.ok(html.includes('&lt;evil&gt;'));
  });

  test('renderHtml marks null cells with the null class, not text', () => {
    const html = view.renderHtml('f.csv', {
      columns: [{ name: 'c', dtype: 'text' }],
      rows: [[null]], nrows_shown: 1, total_rows: 1,
    });
    assert.match(html, /<td class="null">/);
  });

  test('renderHtml right-aligns numeric cells', () => {
    const html = view.renderHtml('f.csv', {
      columns: [{ name: 'c', dtype: 'int' }],
      rows: [[42]], nrows_shown: 1, total_rows: 1,
    });
    assert.match(html, /<td class="num">42<\/td>/);
  });

  test('renderHtml renders an error page (no table) on result.error', () => {
    const html = view.renderHtml('f.csv', { error: 'boom <x>' });
    assert.match(html, /preview failed/);
    assert.ok(html.includes('&lt;x&gt;'), 'error text is escaped too');
    assert.ok(!html.includes('<table'));
  });

  test('renderHtml output is a complete standalone HTML document', () => {
    const html = view.renderHtml('f.csv', {
      columns: [{ name: 'c', dtype: 'text' }], rows: [['v']], nrows_shown: 1, total_rows: 1,
    });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<\/html>$/);
    assert.ok(!html.includes('<script'), 'page must contain no scripts');
  });
});
