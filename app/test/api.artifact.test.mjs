// /artifact/:project/* — file serving and the editor save path.
// Security: traversal, symlink escape, null bytes. Semantics: the
// X-Mtime-Ms baseline, the 409 conflict guard, atomic writes that keep
// permission bits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox } from './serverHarness.mjs';

let sb;
let alpha;

before(async () => {
  sb = await startSandbox({
    seed: ({ root, projRoots }) => {
      const a = projRoots.alpha;
      fs.writeFileSync(path.join(a, 'notes.txt'), 'hello world\n');
      fs.mkdirSync(path.join(a, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(a, 'sub', 'inner.txt'), 'inner\n');
      fs.writeFileSync(path.join(a, 'script.sh'), '#!/bin/bash\necho run\n');
      fs.chmodSync(path.join(a, 'script.sh'), 0o755);
      fs.mkdirSync(path.join(a, 'docs'), { recursive: true });
      // a secret OUTSIDE the project root, plus a symlink to it from inside
      fs.writeFileSync(path.join(root, 'outside-secret.txt'), 'SECRET\n');
      fs.symlinkSync(path.join(root, 'outside-secret.txt'), path.join(a, 'link-out.txt'));
    },
  });
  alpha = sb.projRoots.alpha;
});
after(async () => { if (sb) await sb.stop(); });

test('GET serves a contained file with a precise X-Mtime-Ms baseline', async () => {
  const r = await fetch(`${sb.base}/artifact/alpha/notes.txt`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello world\n');
  const mtime = Number(r.headers.get('x-mtime-ms'));
  assert.ok(Number.isFinite(mtime) && mtime > 0, 'X-Mtime-Ms header is a real timestamp');
});

test('GET serves nested files', async () => {
  const r = await fetch(`${sb.base}/artifact/alpha/sub/inner.txt`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'inner\n');
});

test('encoded dot-segment traversal is refused (raw request, no URL normalization)', async () => {
  // fetch/URL fold %2e%2e into '..' client-side, so go through a raw socket
  const a = await sb.rawRequest('GET', '/artifact/alpha/%2e%2e/outside-secret.txt');
  assert.equal(a.status, 403);
  assert.ok(!a.text.includes('SECRET'), 'secret content must not leak');
  const b = await sb.rawRequest('GET', '/artifact/alpha/..%2foutside-secret.txt');
  assert.ok([400, 403, 404].includes(b.status), `..%2f form is refused (got ${b.status})`);
  assert.ok(!b.text.includes('SECRET'));
});

test('a symlink pointing outside the project is refused', async () => {
  const r = await fetch(`${sb.base}/artifact/alpha/link-out.txt`);
  assert.equal(r.status, 403);
});

test('null bytes in the path are refused', async () => {
  const r = await sb.rawRequest('GET', '/artifact/alpha/notes%00.txt');
  assert.ok([400, 403].includes(r.status), `got ${r.status}`);
});

test('missing files 404, directories are not served', async () => {
  const missing = await fetch(`${sb.base}/artifact/alpha/nope.txt`);
  assert.equal(missing.status, 404);
  const dir = await fetch(`${sb.base}/artifact/alpha/docs`);
  assert.ok([403, 404].includes(dir.status), `directory GET refused (got ${dir.status})`);
  const badProject = await fetch(`${sb.base}/artifact/nope/notes.txt`);
  assert.equal(badProject.status, 404);
});

test('PUT saves content and returns the new mtime baseline', async () => {
  const get = await fetch(`${sb.base}/artifact/alpha/notes.txt`);
  const base = Number(get.headers.get('x-mtime-ms'));
  const { status, body } = await sb.fetchJson('PUT', '/artifact/alpha/notes.txt', {
    content: 'edited in the dashboard\n', baseMtimeMs: base,
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.mtimeMs));
  assert.equal(fs.readFileSync(path.join(alpha, 'notes.txt'), 'utf8'), 'edited in the dashboard\n');
});

test('PUT with a stale baseline 409s instead of clobbering a disk change', async () => {
  const { body: first } = await sb.fetchJson('PUT', '/artifact/alpha/notes.txt', {
    content: 'my open buffer\n',
  });
  const staleBase = first.mtimeMs;
  // someone else (e.g. a running Claude session) edits the file on disk
  const abs = path.join(alpha, 'notes.txt');
  fs.writeFileSync(abs, 'changed behind your back\n');
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(abs, future, future);

  const { status, body } = await sb.fetchJson('PUT', '/artifact/alpha/notes.txt', {
    content: 'my stale save\n', baseMtimeMs: staleBase,
  });
  assert.equal(status, 409);
  assert.match(body.error, /changed on disk/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'changed behind your back\n', 'disk content was not clobbered');
});

test('PUT preserves the exec bit on shell scripts', async () => {
  const { status } = await sb.fetchJson('PUT', '/artifact/alpha/script.sh', {
    content: '#!/bin/bash\necho edited\n',
  });
  assert.equal(status, 200);
  const mode = fs.statSync(path.join(alpha, 'script.sh')).mode & 0o777;
  assert.equal(mode, 0o755, 'exec bit survives the dashboard save');
});

test('PUT validation: missing content, new files, directories, traversal', async () => {
  const noContent = await sb.fetchJson('PUT', '/artifact/alpha/notes.txt', { baseMtimeMs: 1 });
  assert.equal(noContent.status, 400);

  const newFile = await sb.fetchJson('PUT', '/artifact/alpha/brand-new.txt', { content: 'x' });
  assert.equal(newFile.status, 404, 'PUT only saves existing files');

  const dir = await sb.fetchJson('PUT', '/artifact/alpha/docs', { content: 'x' });
  assert.ok([400, 404].includes(dir.status), `got ${dir.status}`);

  const esc = await sb.rawRequest('PUT', '/artifact/alpha/%2e%2e/outside-secret.txt', { content: 'pwn' });
  assert.equal(esc.status, 403);
  assert.equal(fs.readFileSync(path.join(sb.root, 'outside-secret.txt'), 'utf8'), 'SECRET\n',
    'outside file untouched');
});
