// Task CRUD over REST — id assignment, default/context merging, identity
// protection, log notes, 404/400 paths, and the id-reuse-after-delete quirk.
// Never launches or messages a task (those spawn billed Claude sessions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

test('create with minimal fields applies the documented defaults', async () => {
  const { status, body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'First task',
  });
  assert.equal(status, 201);
  assert.equal(task.id, 'alp-001');
  assert.equal(task.project, 'alpha');
  assert.equal(task.title, 'First task');
  assert.equal(task.status, 'queued');
  assert.equal(task.oversight, 'coop');
  assert.equal(task.priority, 'medium');
  assert.equal(task.session, null);
  assert.equal(task.handoff, null);
  assert.deepEqual(task.upstream, []);
  assert.deepEqual(task.log, []);
  assert.ok(!Number.isNaN(Date.parse(task.created)), 'created is an ISO date');
  assert.deepEqual(task.context, {
    include_abstract: true,
    include_last_session: true,
    include_sibling_tasks: true,
    include_category_primer: true,
    web_search: { enabled: false, sources: [] },
    files: [],
    notes: '',
  });
});

test('ids are sequential and zero-padded', async () => {
  const { body: t2 } = await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Second' });
  assert.equal(t2.id, 'alp-002');
});

test('caller cannot override identity fields on create', async () => {
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Sneaky', id: 'alp-999', created: '1999-01-01T00:00:00Z',
  });
  assert.equal(task.id, 'alp-003');
  assert.notEqual(task.created, '1999-01-01T00:00:00Z');
});

test('partial context merges over defaults instead of replacing them', async () => {
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha',
    title: 'With context',
    context: { notes: 'check the appendix', web_search: { enabled: true } },
  });
  assert.equal(task.context.notes, 'check the appendix');
  assert.equal(task.context.include_abstract, true, 'unset flags keep their defaults');
  assert.deepEqual(task.context.web_search, { enabled: true, sources: [] },
    'web_search merges, keeping default sources');
  assert.deepEqual(task.context.files, []);
});

test('garbage context falls back to full defaults', async () => {
  const { body: task } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Bad ctx', context: 'not-an-object',
  });
  assert.equal(task.context.include_abstract, true);
  assert.deepEqual(task.context.files, []);
});

test('create on an unknown project 404s', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/tasks', { project: 'nope', title: 'x' });
  assert.equal(status, 404);
  assert.match(body.error, /unknown project/i);
});

test('PATCH shallow-merges, appends logNote, and protects identity fields', async () => {
  const { body: t1 } = await sb.fetchJson('PATCH', '/api/tasks/alpha/alp-001', {
    title: 'Renamed', logNote: 'renamed it',
  });
  assert.equal(t1.title, 'Renamed');
  assert.equal(t1.log.length, 1);
  assert.equal(t1.log[0].note, 'renamed it');
  assert.ok(t1.log[0].ts);

  const { body: t2 } = await sb.fetchJson('PATCH', '/api/tasks/alpha/alp-001', {
    id: 'alp-777', project: 'beta', priority: 'high',
  });
  assert.equal(t2.id, 'alp-001', 'id survives a hostile patch');
  assert.equal(t2.project, 'alpha', 'project survives a hostile patch');
  assert.equal(t2.priority, 'high');
  assert.equal(t2.log.length, 1, 'earlier log entries survive');
});

test('PATCH error paths: unknown task, unknown project, non-object patch, bad JSON', async () => {
  const unknownTask = await sb.fetchJson('PATCH', '/api/tasks/alpha/alp-404', { title: 'x' });
  assert.equal(unknownTask.status, 404);

  const unknownProject = await sb.fetchJson('PATCH', '/api/tasks/nope/alp-001', { title: 'x' });
  assert.equal(unknownProject.status, 404);

  const arrayPatch = await sb.fetchJson('PATCH', '/api/tasks/alpha/alp-001', ['not', 'an', 'object']);
  assert.equal(arrayPatch.status, 400);

  const badJson = await sb.rawRequest('PATCH', '/api/tasks/alpha/alp-001');
  // raw request with Content-Type json but empty body → body-parser treats {} —
  // send actually-broken JSON instead
  const r = await fetch(`${sb.base}/api/tasks/alpha/alp-001`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{"title": broken',
  });
  assert.equal(r.status, 400);
  assert.ok(badJson.status >= 200, 'raw empty-body request did not hang');
});

test('closing an idle task via PATCH status done succeeds', async () => {
  const { body: t } = await sb.fetchJson('PATCH', '/api/tasks/alpha/alp-002', { status: 'done' });
  assert.equal(t.status, 'done');
});

test('DELETE removes the task; a second delete 404s', async () => {
  const del = await sb.fetchJson('DELETE', '/api/tasks/alpha/alp-003');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { ok: true });

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok(!state.tasks.alpha.some((t) => t.id === 'alp-003'));

  const again = await sb.fetchJson('DELETE', '/api/tasks/alpha/alp-003');
  assert.equal(again.status, 404);
});

test('deleting the highest-numbered task reuses its id on the next create', async () => {
  // documents current nextId() behavior — the transcript "created" stamp guard
  // in sessions.js exists because of exactly this
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const maxId = state.tasks.alpha.map((t) => t.id).sort().at(-1);
  await sb.fetchJson('DELETE', `/api/tasks/alpha/${maxId}`);
  const { body: fresh } = await sb.fetchJson('POST', '/api/tasks', { project: 'alpha', title: 'Reuser' });
  assert.equal(fresh.id, maxId, `id ${maxId} is reused after deleting its task`);
});

test('transcript of a never-launched task is an empty array', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/transcript/alpha/alp-001');
  assert.equal(status, 200);
  assert.deepEqual(body, { transcript: [] });
});

test('transcript of an unknown task 404s', async () => {
  const { status } = await sb.fetchJson('GET', '/api/transcript/alpha/alp-404');
  assert.equal(status, 404);
});

test('bodies over the 5mb JSON limit are rejected, not crashed on', async () => {
  const r = await fetch(`${sb.base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'alpha', title: 'big', description: 'x'.repeat(6 * 1024 * 1024) }),
  });
  assert.equal(r.status, 413);
  // server is still alive afterwards
  const { status } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
});

test('tasks persist to disk as the editable JSON files', async () => {
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const onDisk = JSON.parse(fs.readFileSync(path.join(sb.root, 'tasks', 'alpha.json'), 'utf8'));
  assert.deepEqual(onDisk, state.tasks.alpha, 'tasks/<project>.json matches the API view');
});
