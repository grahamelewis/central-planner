// test/ledger.test.mjs — ledger date/bucketing logic.
// ledger.js binds LEDGER_FILE to ROOT/ledger/ledger.jsonl at import time, with
// no seam to redirect it, and reading the REAL ledger would be non-hermetic.
// So we extract the REAL source of the pure functions and drive them with a
// loadEntries() that reads a temp fixture we control. This tests the actual
// bucketing/parse-tolerance code, not a re-implementation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { mkTmp, rmTmp, extractFunction, APP_DIR } from './helpers.mjs';

const SRC = path.join(APP_DIR, 'lib', 'ledger.js');
const PROJECTS = { alpha: { name: 'alpha' }, beta: { name: 'beta' } };
const WEEKLY_HOUR_TARGET = 35;

let lib;          // { dayKey, weekStart, dailyActivity, weekSummary }
let tmp, ledgerFile;

// loadEntries() the extracted functions will call — reads our temp fixture,
// tolerating corrupt lines exactly as the real one does.
function makeLoadEntries() {
  return function loadEntries() {
    const out = [];
    let raw = '';
    try { raw = fs.readFileSync(ledgerFile, 'utf8'); } catch { /* none */ }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { const e = JSON.parse(t); if (e && typeof e === 'object') out.push(e); } catch { /* skip */ }
    }
    return out;
  };
}

before(() => {
  tmp = mkTmp('cp-ledger-');
  ledgerFile = path.join(tmp, 'ledger.jsonl');
  // bind the extracted functions in one scope with the globals they reference
  const bodies = ['dayKey', 'weekStart', 'dailyActivity', 'weekSummary']
    .map((n) => extractFunction(SRC, n)).join('\n');
  const factory = new Function('loadEntries', 'PROJECTS', 'WEEKLY_HOUR_TARGET',
    `${bodies}\nreturn { dayKey, weekStart, dailyActivity, weekSummary };`);
  lib = factory(makeLoadEntries(), PROJECTS, WEEKLY_HOUR_TARGET);
});

after(() => rmTmp(tmp));

function writeLedger(lines) {
  fs.writeFileSync(ledgerFile, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

// Build an ISO timestamp at LOCAL wall-clock time (so dayKey buckets it on the
// intended calendar day regardless of the test machine's tz).
function localISO(y, mo, d, h = 12, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0).toISOString();
}

describe('dayKey (local-date bucketing)', () => {
  test('buckets a timestamp by local wall-clock day', () => {
    const iso = localISO(2026, 6, 11, 9, 30);
    assert.equal(lib.dayKey(iso), '2026-06-11');
  });

  test('zero-pads month and day', () => {
    assert.equal(lib.dayKey(localISO(2026, 3, 5)), '2026-03-05');
  });

  test('returns null for an unparseable timestamp', () => {
    assert.equal(lib.dayKey('not-a-date'), null);
  });
});

describe('weekStart (Monday 00:00 local)', () => {
  test('always returns a Monday at local midnight', () => {
    const w = lib.weekStart();
    assert.equal(w.getDay(), 1, 'getDay() === 1 (Monday)');
    assert.equal(w.getHours(), 0);
    assert.equal(w.getMinutes(), 0);
    assert.equal(w.getSeconds(), 0);
  });

  test('weekStart is in the past or now (never future)', () => {
    assert.ok(lib.weekStart().getTime() <= Date.now());
  });
});

describe('dailyActivity', () => {
  test('sums seconds and tokens into the correct local-date buckets', () => {
    writeLedger([
      { ts: localISO(2026, 6, 10, 8), type: 'time', project: 'alpha', seconds: 600 },
      { ts: localISO(2026, 6, 10, 9), type: 'time', project: 'beta', seconds: 300 },
      { ts: localISO(2026, 6, 10, 10), type: 'tokens', project: 'alpha', in: 100, out: 50, costUsd: 0.2 },
      { ts: localISO(2026, 6, 11, 8), type: 'time', project: 'alpha', seconds: 120 },
    ]);
    const { days } = lib.dailyActivity();
    assert.equal(days['2026-06-10'].seconds, 900);
    assert.deepEqual(days['2026-06-10'].perProject, { alpha: 600, beta: 300 });
    assert.equal(days['2026-06-10'].tokens, 150);
    assert.ok(Math.abs(days['2026-06-10'].costUsd - 0.2) < 1e-9);
    assert.equal(days['2026-06-11'].seconds, 120);
  });

  test('tolerates corrupt JSONL lines without throwing', () => {
    writeLedger([
      '{ this is not valid json',
      '',
      '   ',
      '42',                              // valid JSON but not an object -> ignored
      { ts: localISO(2026, 6, 11, 8), type: 'time', project: 'alpha', seconds: 60 },
      'null',                            // parses to null -> skipped
    ]);
    const { days } = lib.dailyActivity();
    assert.equal(days['2026-06-11'].seconds, 60);
    assert.equal(Object.keys(days).length, 1);
  });

  test('ignores entries with an unparseable timestamp', () => {
    writeLedger([
      { ts: 'garbage', type: 'time', project: 'alpha', seconds: 999 },
      { ts: localISO(2026, 6, 11), type: 'time', project: 'alpha', seconds: 30 },
    ]);
    const { days } = lib.dailyActivity();
    assert.equal(Object.keys(days).length, 1);
    assert.equal(days['2026-06-11'].seconds, 30);
  });
});

describe('weekSummary (week boundary + per-project totals)', () => {
  test('counts entries from this week and excludes last week', () => {
    const now = lib.weekStart();
    const thisWeek = new Date(now.getTime() + 6 * 3600 * 1000).toISOString(); // Mon 06:00
    const lastWeek = new Date(now.getTime() - 24 * 3600 * 1000).toISOString(); // Sun before
    writeLedger([
      { ts: lastWeek, type: 'time', project: 'alpha', seconds: 5000 }, // excluded
      { ts: thisWeek, type: 'time', project: 'alpha', seconds: 600 },
      { ts: thisWeek, type: 'tokens', project: 'beta', in: 10, out: 20, costUsd: 0.5 },
    ]);
    const s = lib.weekSummary();
    assert.equal(s.perProject.alpha.seconds, 600);
    assert.equal(s.perProject.beta.tokensIn, 10);
    assert.equal(s.perProject.beta.tokensOut, 20);
    assert.equal(s.totals.seconds, 600);
    assert.equal(s.totals.tokens, 30);
    assert.ok(Math.abs(s.totals.costUsd - 0.5) < 1e-9);
    assert.equal(s.hourTarget, WEEKLY_HOUR_TARGET);
  });

  test('initializes every known project with a zeroed bucket', () => {
    writeLedger([]);
    const s = lib.weekSummary();
    for (const k of Object.keys(PROJECTS)) {
      assert.deepEqual(s.perProject[k], { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    }
    assert.deepEqual(s.totals, { seconds: 0, tokens: 0, costUsd: 0 });
  });

  test('creates a dynamic bucket for an unknown/retired project key', () => {
    const thisWeek = new Date(lib.weekStart().getTime() + 3600 * 1000).toISOString();
    writeLedger([{ ts: thisWeek, type: 'time', project: 'retired_key', seconds: 100 }]);
    const s = lib.weekSummary();
    assert.equal(s.perProject.retired_key.seconds, 100);
    assert.equal(s.totals.seconds, 100, 'still counted in totals');
  });

  test('since is the ISO of weekStart', () => {
    writeLedger([]);
    assert.equal(lib.weekSummary().since, lib.weekStart().toISOString());
  });
});
