// lib/projectStore.js — runtime mutations of the project registry.
//
// Projects load from config.json once at boot into the shared, mutable PROJECTS
// object (lib/config.js). The Manage Projects tab edits them live: we mutate
// PROJECTS IN PLACE (same object reference — importers and the in-process tests
// rely on it), then persist by rewriting ONLY the `projects` block of
// config.json, leaving user/notifications/port/weeklyHourTarget/artifactGlobs
// untouched. The route layer broadcasts a fresh snapshot so every client live-
// updates. The project KEY is the on-disk identity (tasks/<key>.json, ledger,
// snapshots/<key>/, transcripts/<key>/) and is IMMUTABLE — only the display
// name, color, and status are editable; create mints a fresh key.
import fs from 'fs';
import path from 'path';
import { ROOT, PROJECTS } from './config.js';
import { writeFileAtomic } from './paths.js';

const CONFIG_FILE = path.join(ROOT, 'config.json');
export const STATUSES = ['active', 'trial', 'inactive'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** Designation, with back-compat for the old boolean `trial: true`. */
export function projectStatus(p) {
  if (p && STATUSES.includes(p.status)) return p.status;
  return (p && p.trial) ? 'trial' : 'active';
}

function validColor(c, fallback) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : fallback;
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

// Re-read config.json fresh (never clobber fields we don't own), set projects,
// write atomically. A missing file (env-driven test setups) → write a new one
// with just projects; CP_PROJECTS_JSON still wins on the next boot anyway.
function persist() {
  let cfg = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
  } catch { /* missing or malformed — start fresh, preserving nothing we can't read */ }
  cfg.projects = PROJECTS;
  writeFileAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

/** Create a project. Mints a unique key from the name; validates the root dir. */
export function createProject({ name, root, color, status } = {}) {
  name = String(name || '').trim();
  if (!name) throw httpError(400, 'project name is required');
  root = String(root || '').trim();
  if (!root) throw httpError(400, 'project root path is required');
  if (!path.isAbsolute(root)) throw httpError(400, 'project root must be an absolute path');
  let st;
  try { st = fs.statSync(root); } catch { throw httpError(400, `root path does not exist: ${root}`); }
  if (!st.isDirectory()) throw httpError(400, `root path is not a directory: ${root}`);
  const designation = STATUSES.includes(status) ? status : 'active';

  const base = slugify(name) || 'project';
  // frontend view names — a project keyed 'settings' would shadow that view
  const RESERVED = new Set(['ov', 'cats', 'manage', 'about', 'settings', 'new', 'git']);
  let key = RESERVED.has(base) ? `${base}_2` : base;
  for (let n = 2; Object.prototype.hasOwnProperty.call(PROJECTS, key); n++) key = `${base}_${n}`;

  PROJECTS[key] = {
    name,
    root: path.resolve(root),
    color: validColor(color, '#7ea2f5'),
    texWatch: null,
    status: designation,
  };
  persist();
  return { key, project: PROJECTS[key] };
}

/** Update a project's display name / color / status. The key is immutable. */
export function updateProject(key, { name, color, status } = {}) {
  const p = PROJECTS[key];
  if (!p) throw httpError(404, `unknown project '${key}'`);
  if (name !== undefined) {
    const nm = String(name).trim();
    if (!nm) throw httpError(400, 'name cannot be empty');
    p.name = nm;
  }
  if (color !== undefined) {
    const c = validColor(color, null);
    if (c) p.color = c;
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw httpError(400, `invalid status '${status}' (use ${STATUSES.join('/')})`);
    p.status = status;
    delete p.trial; // converge onto the status model
  }
  persist();
  return { key, project: p };
}
