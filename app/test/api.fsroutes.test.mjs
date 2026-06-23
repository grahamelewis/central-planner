// Sidebar/file routes (/api/ls, /api/files, /api/pincard, /api/datahead) and
// the heartbeat → ledger → activity pipeline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      const a = projRoots.alpha;
      fs.writeFileSync(path.join(a, 'notes.txt'), 'hello\n');
      fs.writeFileSync(path.join(a, 'script.py'), 'print("hi")\n');
      fs.writeFileSync(path.join(a, 'data.csv'),
        'id,name,score\n1,ann,3.5\n2,"bo, jr",4.2\n3,cy,1.1\n');
      fs.mkdirSync(path.join(a, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(a, 'sub', 'inner.txt'), 'inner\n');
      fs.writeFileSync(path.join(a, '.hidden'), 'dot\n');
      fs.mkdirSync(path.join(a, 'node_modules', 'junk'), { recursive: true });
      fs.writeFileSync(path.join(a, 'node_modules', 'junk', 'x.js'), '1\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('/api/ls lists a directory, dirs first, skipping dotfiles and ignored dirs', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/ls/alpha');
  assert.equal(status, 200);
  const names = body.entries.map((e) => e.name);
  assert.ok(names.includes('sub'));
  assert.ok(names.includes('notes.txt'));
  assert.ok(!names.includes('.hidden'), 'dotfiles hidden');
  assert.ok(!names.includes('node_modules'), 'ignored dirs hidden');
  assert.equal(body.entries[0].dir, true, 'directories sort first');
  const notes = body.entries.find((e) => e.name === 'notes.txt');
  assert.equal(notes.dir, false);
  assert.ok(notes.size > 0, 'files carry a size');
});

test('/api/ls handles subdirs, traversal, and non-directories', async () => {
  const sub = await sb.fetchJson('GET', '/api/ls/alpha?rel=sub');
  assert.deepEqual(sub.body.entries.map((e) => e.name), ['inner.txt']);

  const out = await sb.fetchJson('GET', `/api/ls/alpha?rel=${encodeURIComponent('../')}`);
  assert.equal(out.status, 404, 'escaping rel is refused');

  const file = await sb.fetchJson('GET', '/api/ls/alpha?rel=notes.txt');
  assert.equal(file.status, 400, 'a file is not a directory');

  const missing = await sb.fetchJson('GET', '/api/ls/alpha?rel=ghost');
  assert.equal(missing.status, 404);
});

test('/api/files returns the sorted recursive file list for pin search', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/files/alpha');
  assert.equal(status, 200);
  assert.ok(body.files.includes('notes.txt'));
  assert.ok(body.files.includes('sub/inner.txt'));
  assert.ok(!body.files.some((f) => f.startsWith('node_modules')), 'ignored dirs excluded');
  assert.ok(!body.files.includes('.hidden'));
  assert.deepEqual(body.files, [...body.files].sort(), 'list is sorted');
});

test('/api/pincard builds a data card for a CSV (schema, not contents)', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/pincard/alpha?rel=data.csv');
  assert.equal(status, 200);
  assert.ok(body.card, 'card text present');
  for (const col of ['id', 'name', 'score']) {
    assert.ok(body.card.includes(col), `card mentions column '${col}'`);
  }
});

test('/api/pincard builds a folder card for a trailing-slash rel', async () => {
  const { status, body } = await sb.fetchJson('GET', `/api/pincard/alpha?rel=${encodeURIComponent('sub/')}`);
  assert.equal(status, 200);
  assert.ok(body.card.includes('inner.txt'), 'tree map names the file');
});

test('/api/pincard refuses code pins, missing files, and escapes', async () => {
  const code = await sb.fetchJson('GET', '/api/pincard/alpha?rel=script.py');
  assert.equal(code.status, 400, 'code pins have no card');
  const missing = await sb.fetchJson('GET', '/api/pincard/alpha?rel=ghost.csv');
  assert.equal(missing.status, 400);
  const esc = await sb.fetchJson('GET', `/api/pincard/alpha?rel=${encodeURIComponent('../outside.csv')}`);
  assert.equal(esc.status, 400);
});

test('/api/datahead previews a CSV as json and as a standalone html page', async () => {
  const json = await sb.fetchJson('GET', '/api/datahead/alpha?rel=data.csv&format=json');
  assert.equal(json.status, 200);
  const flat = JSON.stringify(json.body);
  assert.ok(flat.includes('ann'), 'json preview contains a cell value');
  assert.ok(flat.includes('bo, jr'), 'quoted comma cell parsed correctly');

  const html = await fetch(`${sb.base}/api/datahead/alpha?rel=data.csv`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const page = await html.text();
  assert.ok(page.includes('ann'), 'html preview contains a cell value');
  assert.ok(!page.includes('<script'), 'preview page ships no scripts');
});

test('/api/datahead refuses escapes and missing files', async () => {
  const esc = await sb.fetchJson('GET', `/api/datahead/alpha?rel=${encodeURIComponent('../x.csv')}&format=json`);
  assert.equal(esc.status, 400);
  const missing = await sb.fetchJson('GET', '/api/datahead/alpha?rel=ghost.csv&format=json');
  assert.equal(missing.status, 400);
});

// ---- heartbeat → ledger → activity (order matters: these share global state)

test('heartbeat clamps claimed seconds to 120 and writes one ledger line', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/heartbeat', { project: 'alpha', seconds: 999 });
  assert.equal(status, 200);
  assert.notEqual(body.deduped, true, 'first beat is logged, not deduped');

  const lines = fs.readFileSync(path.join(sb.root, 'ledger', 'ledger.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'time');
  assert.equal(lines[0].project, 'alpha');
  assert.equal(lines[0].seconds, 120, '999 claimed seconds clamped to 120');
});

test('a second heartbeat inside the window is deduped globally', async () => {
  const { body } = await sb.fetchJson('POST', '/api/heartbeat', { project: 'beta', seconds: 30 });
  assert.equal(body.deduped, true, 'concurrent dashboards cannot double-count time');
  const lines = fs.readFileSync(path.join(sb.root, 'ledger', 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'no second ledger line');
});

test('heartbeat validates the project key', async () => {
  const { status } = await sb.fetchJson('POST', '/api/heartbeat', { project: 'nope', seconds: 30 });
  assert.equal(status, 404);
});

test('the logged time shows up in the week summary and daily activity', async () => {
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.equal(state.ledger.perProject.alpha.seconds, 120);
  assert.equal(state.ledger.totals.seconds, 120);

  const { body: act } = await sb.fetchJson('GET', '/api/activity');
  const days = Object.keys(act.days);
  assert.equal(days.length, 1);
  const today = act.days[days[0]];
  assert.equal(today.seconds, 120);
  assert.deepEqual(today.perProject, { alpha: 120 });
});
