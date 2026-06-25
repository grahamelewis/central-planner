// lib/watchers.js — Agent WATCHERS
// Artifact watchers (chokidar v4 — no globs; we filter ourselves) and the
// latexmk -pvc manager. Never throws out of event handlers; never crashes the process.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import { broadcast } from './events.js';
import { PROJECTS, ARTIFACT_GLOBS } from './config.js';
import { containedPath } from './paths.js';

const MAX_ARTIFACTS = 60;

// ---------------------------------------------------------------------------
// Artifact watchers
// ---------------------------------------------------------------------------

// abs path → { project, path, rel, name, mtime, kind }
const artifacts = new Map();
// project → chokidar watcher
const artifactWatchers = new Map();
let artifactWatchersStarted = false;

const ignoreDirSet = new Set(ARTIFACT_GLOBS.ignoreDirs || []);

function kindOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html') return 'html';
  if (ext === '.pdf') return 'pdf';
  return null;
}

// True if any path segment of `abs` relative to `root` is an ignored dir name.
function inIgnoredDir(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) return false;
  const segments = rel.split(path.sep);
  // For files, the last segment is the basename — still fine to check all
  // segments; a *file* named e.g. "data" without extension is not an artifact anyway.
  return segments.some((seg) => ignoreDirSet.has(seg));
}

function makeIgnoredFn(root) {
  // chokidar v4 'ignored' may be called with (path) or (path, stats).
  return (p, stats) => {
    try {
      if (inIgnoredDir(root, p)) return true;
      if (stats && stats.isFile() && !kindOf(p)) return true;
      return false;
    } catch {
      return false;
    }
  };
}

function recordArtifact(project, root, abs, stats, ready) {
  try {
    const kind = kindOf(abs);
    if (!kind) return;
    if (inIgnoredDir(root, abs)) return;
    let mtime = stats && stats.mtime ? stats.mtime : null;
    if (!mtime) {
      try {
        mtime = fs.statSync(abs).mtime;
      } catch {
        return; // vanished between event and stat
      }
    }
    const artifact = {
      project,
      path: abs,
      rel: path.relative(root, abs),
      name: path.basename(abs),
      mtime: new Date(mtime).toISOString(),
      kind,
    };
    artifacts.set(abs, artifact);
    pruneArtifacts();
    if (ready && artifacts.has(abs)) {
      try {
        broadcast('artifact:new', { artifact });
      } catch (err) {
        console.error('[watchers] broadcast artifact:new failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[watchers] recordArtifact error:', err.message);
  }
}

function pruneArtifacts() {
  if (artifacts.size <= MAX_ARTIFACTS) return;
  const sorted = [...artifacts.values()].sort(
    (a, b) => new Date(b.mtime) - new Date(a.mtime)
  );
  for (const stale of sorted.slice(MAX_ARTIFACTS)) {
    artifacts.delete(stale.path);
  }
}

export function startArtifactWatchers() {
  if (artifactWatchersStarted) return;
  artifactWatchersStarted = true;

  for (const [project, cfg] of Object.entries(PROJECTS)) {
    const root = cfg && cfg.root;
    try {
      if (!root || !fs.existsSync(root)) {
        console.error(`[watchers] root missing for ${project}: ${root} — skipping`);
        continue;
      }
      let ready = false;
      const watcher = chokidar.watch(root, {
        ignoreInitial: false,
        ignorePermissionErrors: true,
        usePolling: false,
        // Do NOT follow symlinks. An alias/symlink inside one project's root
        // (e.g. pointing at another project's folder) would otherwise make this
        // watcher walk *through* it and index the other project's files as this
        // project's artifacts — they'd then "follow" the user across projects.
        // Also avoids symlink loops and keeps a watcher within its narrow root.
        followSymlinks: false,
        depth: ARTIFACT_GLOBS.maxDepth,
        alwaysStat: true,
        ignored: makeIgnoredFn(root),
      });
      watcher.on('add', (p, stats) => recordArtifact(project, root, p, stats, ready));
      watcher.on('change', (p, stats) => recordArtifact(project, root, p, stats, ready));
      watcher.on('unlink', (p) => {
        try {
          artifacts.delete(p);
        } catch {
          /* ignore */
        }
      });
      watcher.on('ready', () => {
        ready = true;
        console.log(`[watchers] artifact watcher ready: ${project}`);
      });
      watcher.on('error', (err) => {
        console.error(`[watchers] watcher error (${project}):`, err && err.message);
      });
      artifactWatchers.set(project, watcher);
    } catch (err) {
      // e.g. a cloud-synced/network-mounted root acting up — never break the others.
      console.error(`[watchers] failed to start watcher for ${project}:`, err.message);
    }
  }
}

// One-shot listing of a project's files (relative paths) for the pin-a-file
// picker. Same ignore rules as the artifact watchers; skips dotfiles and
// symlinks; bounded by depth and a hard cap so huge repos can't stall us.
export function listProjectFiles(project) {
  const cfg = PROJECTS[project];
  if (!cfg) return [];
  const root = path.resolve(cfg.root);
  const out = [];
  const MAX = 4000;
  const walk = (dir, depth) => {
    if (depth > ARTIFACT_GLOBS.maxDepth || out.length >= MAX) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (e.name.startsWith('.')) continue;
      if (e.name.includes('\r')) continue; // macOS Finder 'Icon\r' droppings
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirSet.has(e.name)) continue;
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        out.push(path.relative(root, abs));
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

export function getArtifacts() {
  return [...artifacts.values()]
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
    .slice(0, MAX_ARTIFACTS);
}

// ---------------------------------------------------------------------------
// latexmk -pvc manager
// ---------------------------------------------------------------------------

// project → { child, entry: {tex, pdf, state, lastBuildMs, lastBuiltAt, pages},
//             buildStartedAt, killed }
const pdfWatches = new Map();

function broadcastPdf(project) {
  try {
    const w = pdfWatches.get(project);
    if (!w) return;
    broadcast('pdf:status', { project, entry: w.entry });
  } catch (err) {
    console.error('[watchers] broadcast pdf:status failed:', err.message);
  }
}

function parsePagesFromLog(texAbs) {
  try {
    const logPath = texAbs.replace(/\.tex$/i, '.log');
    if (!fs.existsSync(logPath)) return null;
    const txt = fs.readFileSync(logPath, 'utf8');
    const matches = txt.match(/Output written on [^(]*\((\d+) pages?/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1].match(/\((\d+) pages?/);
    return last ? Number(last[1]) : null;
  } catch {
    return null;
  }
}

function handleLatexmkLine(project, line) {
  const w = pdfWatches.get(project);
  if (!w) return;
  try {
    const rebuildStart =
      line.includes('Latexmk: applying rule') ||
      line.includes('file-change detected') ||
      line.includes('Latexmk: Changed files');
    const buildDone =
      line.includes('Latexmk: All targets') || /Output written on/.test(line);
    // Under -pvc a failed compile prints this and waits for the next change —
    // without this transition the state would be stuck at 'building' forever.
    const buildFailed = line.includes('Latexmk: Errors');

    if (buildFailed) {
      w.entry.state = 'error';
      w.buildStartedAt = null;
      broadcastPdf(project);
    } else if (rebuildStart && w.entry.state !== 'building') {
      w.entry.state = 'building';
      w.buildStartedAt = Date.now();
      broadcastPdf(project);
    } else if (buildDone) {
      const now = Date.now();
      w.entry.state = 'built';
      w.entry.lastBuildMs = w.buildStartedAt ? now - w.buildStartedAt : null;
      w.entry.lastBuiltAt = new Date(now).toISOString();
      // Prefer pages from the stdout line itself, else from the .log file.
      const inline = line.match(/Output written on [^(]*\((\d+) pages?/);
      w.entry.pages = inline ? Number(inline[1]) : parsePagesFromLog(w.entry.tex);
      w.buildStartedAt = null;
      broadcastPdf(project);
    }
  } catch (err) {
    console.error('[watchers] latexmk line parse error:', err.message);
  }
}

export function watchTex(project, texPathAbs) {
  try {
    const cfg = PROJECTS[project];
    if (!cfg) return { error: `unknown project: ${project}` };
    if (typeof texPathAbs !== 'string' || !texPathAbs.trim()) {
      return { error: 'tex path required' };
    }

    if (!texPathAbs.toLowerCase().endsWith('.tex')) {
      return { error: 'tex path must end with .tex' };
    }
    // realpath containment (symlink-safe), same discipline as /artifact & runs
    const contained = containedPath(project, texPathAbs);
    if (!contained) return { error: 'tex path must be an existing file inside the project root' };
    const tex = contained.abs;

    // Replace any existing watch for this project.
    if (pdfWatches.has(project)) unwatchTex(project);

    const entry = {
      tex,
      pdf: tex.replace(/\.tex$/i, '.pdf'),
      state: 'building',
      lastBuildMs: null,
      lastBuiltAt: null,
      pages: null,
    };

    const child = spawn(
      'latexmk',
      ['-pdf', '-pvc', '-interaction=nonstopmode', '-halt-on-error', tex],
      { cwd: path.dirname(tex), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const w = { child, entry, buildStartedAt: Date.now(), killed: false };
    pdfWatches.set(project, w);

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      try {
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          handleLatexmkLine(project, line);
        }
      } catch (err) {
        console.error('[watchers] stdout handler error:', err.message);
      }
    });
    child.stderr.on('data', () => {
      /* latexmk is chatty on stderr; state errors are detected via exit code */
    });
    child.on('error', (err) => {
      console.error(`[watchers] latexmk spawn error (${project}):`, err.message);
      const cur = pdfWatches.get(project);
      if (cur && cur.child === child) {
        cur.entry.state = 'error';
        broadcastPdf(project);
      }
    });
    child.on('exit', (code, signal) => {
      const cur = pdfWatches.get(project);
      if (!cur || cur.child !== child) return; // superseded or unwatched
      if (!cur.killed && code !== 0) {
        console.error(
          `[watchers] latexmk exited (${project}) code=${code} signal=${signal}`
        );
        cur.entry.state = 'error';
        broadcastPdf(project);
      }
    });

    console.log(`[watchers] latexmk -pvc started for ${project}: ${tex}`);
    broadcastPdf(project);
    return { ok: true };
  } catch (err) {
    console.error('[watchers] watchTex error:', err.message);
    return { error: err.message };
  }
}

export function unwatchTex(project) {
  try {
    const w = pdfWatches.get(project);
    pdfWatches.delete(project);
    if (w && w.child) {
      w.killed = true;
      try {
        w.child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  } catch (err) {
    console.error('[watchers] unwatchTex error:', err.message);
  }
}

export function getPdfWatches() {
  const out = {};
  for (const [project, w] of pdfWatches.entries()) {
    out[project] = { ...w.entry };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup — kill latexmk children on process exit / signals.
// ---------------------------------------------------------------------------

function killAllChildren(signal = 'SIGTERM') {
  for (const w of pdfWatches.values()) {
    if (w && w.child) {
      w.killed = true;
      try {
        w.child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }
}

process.on('exit', () => killAllChildren('SIGTERM'));
process.on('SIGINT', () => {
  killAllChildren('SIGTERM');
  process.exit(130);
});
process.on('SIGTERM', () => {
  killAllChildren('SIGTERM');
  process.exit(143);
});
