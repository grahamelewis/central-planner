// /api/state contract — the frontend's entire data dependency. If this shape
// drifts, the dashboard renders blank cells with no console error to find.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;

before(async () => {
  sb = await startSandbox({
    seed: ({ projRoots }) => {
      // a pre-existing artifact the chokidar watcher must index on startup
      fs.writeFileSync(path.join(projRoots.alpha, 'report.html'), '<html><body>hi</body></html>');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('snapshot has every key the frontend reads, with the right shapes', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  for (const key of ['projects', 'categories', 'abstracts', 'tasks', 'artifacts', 'pdf', 'ledger', 'sessions', 'runs']) {
    assert.ok(key in body, `snapshot is missing '${key}'`);
  }
  assert.deepEqual(Object.keys(body.projects).sort(), ['alpha', 'beta']);
  for (const p of Object.values(body.projects)) {
    for (const f of ['name', 'root', 'color', 'texWatch', 'status']) assert.ok(f in p, `project missing '${f}'`);
  }
  assert.deepEqual(body.tasks, { alpha: [], beta: [] });
  assert.equal(body.abstracts.alpha, '# Alpha abstract\n');
  assert.equal(body.abstracts.beta, '');
  assert.ok(body.categories.calibration);
  assert.ok(Array.isArray(body.artifacts));
  assert.ok(Array.isArray(body.sessions));
  assert.deepEqual(body.sessions, []);
  assert.deepEqual(body.runs, {});
  assert.deepEqual(body.pdf, {});
});

test('ledger summary starts at zero with the configured target and a Monday start', async () => {
  const { body } = await sb.fetchJson('GET', '/api/state');
  const led = body.ledger;
  assert.equal(led.hourTarget, 35);
  assert.deepEqual(led.totals, { seconds: 0, tokens: 0, costUsd: 0 });
  assert.deepEqual(led.perProject.alpha, { seconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  const since = new Date(led.since);
  assert.ok(!Number.isNaN(since.getTime()), 'ledger.since parses as a date');
  assert.equal(since.getDay(), 1, 'week starts on Monday');
  assert.ok(since.getTime() <= Date.now(), 'week start is not in the future');
});

test('startup artifact indexing finds pre-existing html files', async () => {
  const body = await sb.poll('/api/state', (s) => s.artifacts && s.artifacts.length >= 1);
  const art = body.artifacts.find((a) => a.rel === 'report.html');
  assert.ok(art, 'report.html was indexed');
  assert.equal(art.project, 'alpha');
  assert.equal(art.kind, 'html');
  assert.equal(art.name, 'report.html');
  assert.ok(art.mtime, 'artifact carries an mtime');
});

test('a new artifact written while running gets indexed', async () => {
  fs.writeFileSync(path.join(sb.projRoots.beta, 'figure.html'), '<html>fig</html>');
  const body = await sb.poll('/api/state', (s) => (s.artifacts || []).some((a) => a.rel === 'figure.html'));
  const art = body.artifacts.find((a) => a.rel === 'figure.html');
  assert.equal(art.project, 'beta');
});

test('unknown /api routes 404 with a JSON error', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/definitely-not-a-route');
  assert.equal(status, 404);
  assert.equal(body.error, 'not found');
});
