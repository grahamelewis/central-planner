// Project registry over REST — the Manage Projects tab's create/rename/status
// designation feature (lib/projectStore.js + POST /api/projects + PATCH
// /api/projects/:key). Covers the status field & its defaults, create success /
// path-validation / key-slug-uniqueness, name & status patches with an immutable
// key, and config.json persistence that preserves sibling blocks
// (user/notifications/port/etc.). Never launches or messages (no billed calls).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;
// Seed config.json with sibling blocks BEFORE boot so we can prove persist()
// rewrites only `projects` and leaves user/notifications/port/etc. untouched.
// (CP_PROJECTS_JSON still drives the live PROJECTS, so the stale on-disk
// `projects` here is expected to be overwritten, not merged.)
const PRESERVE = {
  port: 9999,
  weeklyHourTarget: 12,
  user: { name: 'Test Person' },
  notifications: { ntfyTopic: 'keep-me-secret', ntfyDetail: true },
  projects: { staleFromDisk: { name: 'should be replaced by live PROJECTS' } },
};
before(async () => {
  sb = await startSandbox({
    seed: async ({ root }) => {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(PRESERVE, null, 2) + '\n');
    },
  });
});
after(async () => { if (sb) await sb.stop(); });

const readConfig = () => JSON.parse(fs.readFileSync(path.join(sb.root, 'config.json'), 'utf8'));

test('GET /api/state exposes a status field (default active) and no trial field', async () => {
  const { status, body } = await sb.fetchJson('GET', '/api/state');
  assert.equal(status, 200);
  for (const key of ['alpha', 'beta']) {
    const p = body.projects[key];
    assert.ok(p, `${key} present in state`);
    assert.equal(p.status, 'active', `${key} defaults to active`);
    assert.ok(!('trial' in p), `${key} no longer emits a trial field`);
  }
});

test('POST /api/projects creates a project, returns 201 + {key, project}, slug key', async () => {
  const root = os.tmpdir(); // a definitely-existing directory
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'New Proj', root, color: '#abcdef', status: 'active',
  });
  assert.equal(status, 201);
  assert.equal(body.key, 'new_proj', 'key is a slug of the name');
  assert.equal(body.project.name, 'New Proj');
  assert.equal(body.project.color, '#abcdef');
  assert.equal(body.project.status, 'active');
  assert.equal(body.project.root, path.resolve(root));

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok('new_proj' in state.projects, 'new project shows up in /api/state');
  assert.equal(state.projects.new_proj.status, 'active');
});

test('POST /api/projects with a nonexistent root path is rejected 400', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Ghost', root: '/no/such/path/anywhere',
  });
  assert.equal(status, 400);
  assert.match(body.error, /path does not exist/i);
});

test('POST /api/projects defaults status to active and color to a sensible fallback', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Defaulty', root: os.tmpdir(),
  });
  assert.equal(status, 201);
  assert.equal(body.project.status, 'active', 'status defaults to active');
  assert.match(body.project.color, /^#[0-9a-fA-F]{3,8}$/, 'a default color is applied');
});

test('a duplicate name mints a distinct, suffixed key (no clobber)', async () => {
  const { body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'New Proj', root: os.tmpdir(),
  });
  assert.notEqual(body.key, 'new_proj', 'second "New Proj" gets a unique key');
  assert.match(body.key, /^new_proj_\d+$/, 'suffix disambiguates the slug');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.ok('new_proj' in state.projects, 'original survives');
  assert.ok(body.key in state.projects, 'duplicate survives under its own key');
});

test('frontend view names are reserved — "Settings" never mints the key `settings`', async () => {
  // 'ov'/'cats'/'manage'/'about'/'settings' are view keys in the frontend
  // router; a project minted under one of them would shadow that view
  const { status, body } = await sb.fetchJson('POST', '/api/projects', {
    name: 'Settings', root: os.tmpdir(),
  });
  assert.equal(status, 201);
  assert.match(body.key, /^settings_\d+$/, 'reserved slug gets a suffix');
});

test('POST /api/projects with no name is rejected 400', async () => {
  const { status, body } = await sb.fetchJson('POST', '/api/projects', { root: os.tmpdir() });
  assert.equal(status, 400);
  assert.match(body.error, /name is required/i);
});

test('PATCH renames the display name while the key stays immutable', async () => {
  const { status, body } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { name: 'Renamed' });
  assert.equal(status, 200);
  assert.equal(body.key, 'new_proj', 'returned key is unchanged');
  assert.equal(body.project.name, 'Renamed');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.equal(state.projects.new_proj.name, 'Renamed');
  assert.ok('new_proj' in state.projects, 'key survived the rename');
});

test('PATCH updates status to a valid designation', async () => {
  const { status, body } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'inactive' });
  assert.equal(status, 200);
  assert.equal(body.project.status, 'inactive');

  const { body: state } = await sb.fetchJson('GET', '/api/state');
  assert.equal(state.projects.new_proj.status, 'inactive');

  // and back to trial — the nav trial tag is driven by this exact value
  const { body: trialed } = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'trial' });
  assert.equal(trialed.project.status, 'trial');
});

test('PATCH error paths: invalid status 400, unknown key 404, empty name 400', async () => {
  const badStatus = await sb.fetchJson('PATCH', '/api/projects/new_proj', { status: 'bogus' });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.body.error, /invalid status/i);

  const unknown = await sb.fetchJson('PATCH', '/api/projects/does_not_exist', { name: 'x' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /unknown project/i);

  const emptyName = await sb.fetchJson('PATCH', '/api/projects/new_proj', { name: '   ' });
  assert.equal(emptyName.status, 400);
  assert.match(emptyName.body.error, /name cannot be empty/i);
});

test('config.json persists the new project AND preserves sibling top-level blocks', async () => {
  const cfg = readConfig();
  // sibling blocks the writer must never touch
  assert.equal(cfg.port, PRESERVE.port, 'port preserved');
  assert.equal(cfg.weeklyHourTarget, PRESERVE.weeklyHourTarget, 'weeklyHourTarget preserved');
  assert.deepEqual(cfg.user, PRESERVE.user, 'user block preserved');
  assert.deepEqual(cfg.notifications, PRESERVE.notifications, 'notifications block preserved');

  // the projects block reflects the live registry (seeded + created)
  assert.ok('new_proj' in cfg.projects, 'created project written to disk');
  assert.equal(cfg.projects.new_proj.status, 'trial', 'last patched status is on disk');
  assert.ok('alpha' in cfg.projects && 'beta' in cfg.projects, 'seeded projects written too');
  // the stale on-disk `projects` block is replaced by the live PROJECTS object
  assert.ok(!('staleFromDisk' in cfg.projects), 'stale disk-only project was overwritten');
});
