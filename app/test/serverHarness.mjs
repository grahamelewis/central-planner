// test/serverHarness.mjs — boot a fully sandboxed Central Planner server.
// A throwaway data ROOT + two throwaway project roots in os.tmpdir(), a free
// port, and CP_* env overrides (see lib/config.js) so the child process never
// reads or writes the real projectManager folder, never collides with the
// live server on 4242, and never sends ntfy pushes.
//
// SAFE ROUTES ONLY: tests must never POST /api/tasks/:p/:id/launch, /message,
// or /api/profile/generate — those spawn real billed Claude sessions.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Boot a sandboxed server. `seed({ root, projRoots })` runs after the dirs
 * exist but before the server starts — drop fixture files there.
 * Returns { base, root, projRoots, fetchJson, rawRequest, poll, logs, stop }.
 */
export async function startSandbox({ seed, trial = [] } = {}) {
  // realpath: os.tmpdir() is a symlink on macOS (/var → /private/var), and a
  // symlinked project root makes containedPath's lexical check reject real
  // paths handed back from its own realpath step (production roots are real)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sandbox-')));
  const projRoots = {};
  for (const key of ['alpha', 'beta']) {
    projRoots[key] = path.join(root, `proj-${key}`);
    fs.mkdirSync(projRoots[key], { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'abstracts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'categories.json'), JSON.stringify({
    calibration: { name: 'calibration', primer: 'Calibration primer text.' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'abstracts', 'alpha.md'), '# Alpha abstract\n');
  if (seed) await seed({ root, projRoots });

  const projects = {};
  for (const [key, proot] of Object.entries(projRoots)) {
    projects[key] = { name: key, root: proot, color: '#aabbcc', texWatch: null, trial: trial.includes(key) };
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      CP_ROOT: root,
      CP_PORT: String(port),
      CP_PROJECTS_JSON: JSON.stringify(projects),
      CP_NTFY_TOPIC: '', // never push from tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  // wait until /api/state answers
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`sandbox server exited before becoming ready:\n${logs}`);
    }
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw new Error(`sandbox server never became ready:\n${logs}`);
    }
    await new Promise((res) => setTimeout(res, 100));
  }

  /** fetch a JSON API route → { status, body, headers }. */
  async function fetchJson(method, route, body) {
    const r = await fetch(base + route, {
      method,
      ...(body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  }

  /**
   * Raw HTTP request with the path sent byte-for-byte (fetch/URL normalize
   * dot segments — including %2e%2e — which defeats traversal tests).
   */
  function rawRequest(method, rawPath, body) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.connect(port, '127.0.0.1', () => {
        const payload = body !== undefined ? JSON.stringify(body) : '';
        socket.write(
          `${method} ${rawPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: close\r\n' +
          (payload
            ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n`
            : '') +
          '\r\n' + payload);
      });
      socket.on('data', (d) => chunks.push(d));
      socket.on('error', reject);
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = Number((text.match(/^HTTP\/1\.1 (\d+)/) || [])[1]) || 0;
        resolve({ status, text });
      });
    });
  }

  /** Re-fetch `route` until `pred(body)` is truthy (default timeout 10s). */
  async function poll(route, pred, { timeoutMs = 10000, everyMs = 100 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await fetchJson('GET', route);
      if (pred(body)) return body;
      if (Date.now() > end) {
        throw new Error(`poll timed out on ${route}; last body: ${JSON.stringify(body).slice(0, 500)}`);
      }
      await new Promise((res) => setTimeout(res, everyMs));
    }
  }

  return {
    base,
    root,
    projRoots,
    fetchJson,
    rawRequest,
    poll,
    logs: () => logs,
    async stop() {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 3000);
        child.on('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
      });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
