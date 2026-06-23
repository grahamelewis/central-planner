// /api/snapshots — change history listing, per-file diff blobs, and the
// revert → revert-the-revert round-trip (history must be invertible).
// Snapshots are normally written by session turns; here we plant a journal
// fixture on disk before the server's first (lazy) load of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;
const ENTRY_ID = 'snp-fixture-0';

before(async () => {
  sb = await startSandbox({
    seed: ({ root, projRoots }) => {
      // the tracked file currently holds its AFTER state
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'beta = 0.99\n');
      const snapDir = path.join(root, 'snapshots', 'alpha');
      fs.mkdirSync(path.join(snapDir, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(snapDir, 'journal.json'), JSON.stringify([{
        id: ENTRY_ID,
        task: 'alp-001',
        ts: new Date().toISOString(),
        files: [{ rel: 'model.jl', status: 'modified' }],
      }], null, 2));
      fs.writeFileSync(path.join(snapDir, 'blobs', `${ENTRY_ID}.0.before`), 'beta = 0.96\n');
      fs.writeFileSync(path.join(snapDir, 'blobs', `${ENTRY_ID}.0.after`), 'beta = 0.99\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

test('listing returns the journal, filterable by task', async () => {
  const all = await sb.fetchJson('GET', '/api/snapshots/alpha');
  assert.equal(all.status, 200);
  assert.equal(all.body.entries.length, 1);
  assert.equal(all.body.entries[0].id, ENTRY_ID);

  const byTask = await sb.fetchJson('GET', '/api/snapshots/alpha?task=alp-001');
  assert.equal(byTask.body.entries.length, 1);
  const byOther = await sb.fetchJson('GET', '/api/snapshots/alpha?task=alp-999');
  assert.equal(byOther.body.entries.length, 0);

  const emptyProject = await sb.fetchJson('GET', '/api/snapshots/beta');
  assert.deepEqual(emptyProject.body.entries, []);
});

test('the per-file diff returns both blob sides', async () => {
  const { status, body } = await sb.fetchJson('GET', `/api/snapshots/alpha/${ENTRY_ID}/file?rel=model.jl`);
  assert.equal(status, 200);
  assert.equal(body.status, 'modified');
  assert.equal(body.before, 'beta = 0.96\n');
  assert.equal(body.after, 'beta = 0.99\n');

  const wrongFile = await sb.fetchJson('GET', `/api/snapshots/alpha/${ENTRY_ID}/file?rel=ghost.jl`);
  assert.equal(wrongFile.status, 404);
  const wrongEntry = await sb.fetchJson('GET', '/api/snapshots/alpha/snp-nope/file?rel=model.jl');
  assert.equal(wrongEntry.status, 404);
});

test('revert restores the before state and records itself; reverting the revert restores after', async () => {
  const abs = path.join(sb.projRoots.alpha, 'model.jl');

  const rev = await sb.fetchJson('POST', `/api/snapshots/alpha/${ENTRY_ID}/revert`, {});
  assert.equal(rev.status, 200);
  assert.equal(rev.body.ok, true);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'beta = 0.96\n', 'file rewound to before-state');
  assert.ok(rev.body.entry, 'the rewind is recorded as its own change-set');
  assert.equal(rev.body.entry.revertOf, ENTRY_ID);

  const list = await sb.fetchJson('GET', '/api/snapshots/alpha');
  assert.equal(list.body.entries.length, 2, 'history grew instead of being rewritten');

  const undo = await sb.fetchJson('POST', `/api/snapshots/alpha/${rev.body.entry.id}/revert`, {});
  assert.equal(undo.status, 200);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'beta = 0.99\n', 'rewind of the rewind restores the after-state');
});

test('reverting an unknown change-set 404s', async () => {
  const { status } = await sb.fetchJson('POST', '/api/snapshots/alpha/snp-nope/revert', {});
  assert.equal(status, 404);
});

test('deleting a task purges its change history', async () => {
  // give the journal a task to purge: create a real task whose id matches the
  // fixture entries' task field, then delete it
  await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'placeholder' }); // becomes alp-001
  const del = await sb.fetchJson('DELETE', '/api/tasks/alpha/alp-001');
  assert.equal(del.status, 200);
  const list = await sb.fetchJson('GET', '/api/snapshots/alpha');
  assert.deepEqual(list.body.entries, [], 'journal entries for the deleted task are gone');
  const blobs = fs.readdirSync(path.join(sb.root, 'snapshots', 'alpha', 'blobs'));
  assert.deepEqual(blobs, [], 'blob files are gone too');
});
