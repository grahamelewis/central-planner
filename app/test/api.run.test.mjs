// /api/run — the ▶ run feature. Uses only trivial bash scripts; asserts the
// full lifecycle (running → done/stopped/error), output capture, the
// one-run-per-project rule, and containment.
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
      fs.writeFileSync(path.join(a, 'hello.sh'), 'echo hello-from-run\n');
      fs.writeFileSync(path.join(a, 'fail.sh'), 'echo about-to-fail >&2\nexit 3\n');
      fs.writeFileSync(path.join(a, 'sleeper.sh'), 'sleep 30\n');
      fs.writeFileSync(path.join(a, 'data.csv'), 'a,b\n1,2\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

const runState = (s) => s.runs && s.runs.alpha;

test('a shell script runs to completion with its output in the tail', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.sh' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.run.state, 'running');
  assert.match(body.run.cmdLine, /bash hello\.sh/);

  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'done');
  const run = runState(state);
  assert.equal(run.exitCode, 0);
  assert.ok(run.tail.includes('hello-from-run'), 'stdout captured in the server-side tail');
  assert.ok(Number.isFinite(run.ms), 'duration recorded');
});

test('a failing script ends in error state with its exit code', async () => {
  await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'fail.sh' });
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'error');
  const run = runState(state);
  assert.equal(run.exitCode, 3);
  assert.ok(run.tail.includes('about-to-fail'), 'stderr captured');
});

test('one run per project: a second start is refused, stop kills the active run', async () => {
  const first = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'sleeper.sh' });
  assert.equal(first.status, 200);

  const second = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'hello.sh' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already active/);

  const stop = await sb.fetchJson('DELETE', '/api/run/alpha');
  assert.equal(stop.status, 200);
  const state = await sb.poll('/api/state', (s) => runState(s) && runState(s).state === 'stopped');
  assert.equal(runState(state).state, 'stopped');
});

test('run refuses unknown files, escapes, and unrunnable extensions', async () => {
  const missing = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'ghost.sh' });
  assert.equal(missing.status, 400);

  const esc = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: '../escape.sh' });
  assert.equal(esc.status, 400);

  const csv = await sb.fetchJson('POST', '/api/run', { project: 'alpha', rel: 'data.csv' });
  assert.equal(csv.status, 400);
  assert.match(csv.body.error, /don't know how to run/);

  const noRel = await sb.fetchJson('POST', '/api/run', { project: 'alpha' });
  assert.equal(noRel.status, 400);
});

test('stopping a project with no active run is a harmless no-op', async () => {
  const { status, body } = await sb.fetchJson('DELETE', '/api/run/beta');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});
