// Owns ROOT/tasks/<project>.json (JSON array of tasks), ROOT/categories.json,
// and read-only access to ROOT/abstracts/<project>.md. Synchronous fs.
import fs from 'fs';
import path from 'path';
import { ROOT, PROJECTS } from './config.js';
import { broadcast } from './events.js';
import { writeFileAtomic } from './paths.js';

const TASKS_DIR = path.join(ROOT, 'tasks');
const ABSTRACTS_DIR = path.join(ROOT, 'abstracts');
const CATEGORIES_FILE = path.join(ROOT, 'categories.json');
const CATEGORIES_EXAMPLE = path.join(ROOT, 'categories.example.json');

function assertProject(project) {
  if (typeof project !== 'string' || !Object.prototype.hasOwnProperty.call(PROJECTS, project)) {
    throw new Error(`unknown project '${project}'`);
  }
}

function taskFile(project) {
  return path.join(TASKS_DIR, `${project}.json`);
}

function readTasksFile(project) {
  const file = taskFile(project);
  if (!fs.existsSync(file)) return []; // genuinely new project — empty is correct
  // A read/parse failure must THROW, not return []: a later write would
  // otherwise replace the whole task file with the empty list.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON array — refusing to touch it`);
  }
  return parsed;
}

function writeTasksFile(project, tasks) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  writeFileAtomic(taskFile(project), JSON.stringify(tasks, null, 2) + '\n');
}

export function listTasks(project) {
  assertProject(project);
  return readTasksFile(project);
}

export function allTasks() {
  // Display path: one corrupt project file shouldn't blank the whole app.
  // (Write paths still go through readTasksFile directly and refuse to write.)
  const out = {};
  for (const key of Object.keys(PROJECTS)) {
    try {
      out[key] = readTasksFile(key);
    } catch (err) {
      console.error(`[core] tasks/${key}.json unreadable:`, err.message);
      out[key] = [];
    }
  }
  return out;
}

export function getTask(project, id) {
  assertProject(project);
  const tasks = readTasksFile(project);
  return tasks.find((t) => t && t.id === id) || null;
}

function nextId(project, tasks) {
  const prefix = project.slice(0, 3);
  let max = 0;
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string') continue;
    const m = t.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export function createTask(project, fields) {
  assertProject(project);
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) fields = {};
  const tasks = readTasksFile(project);

  const defaults = {
    title: '',
    description: '',
    category: null,
    upstream: [],
    priority: 'medium',
    oversight: 'coop',
    status: 'queued',
    question: null,
    model: null, // null → Claude Code's default; else e.g. 'claude-opus-4-8'
    permMode: null, // null → derived from oversight; else 'default'|'acceptEdits'|'auto'|'bypassPermissions'
    context: {
      include_abstract: true,
      include_last_session: true,
      include_sibling_tasks: true,
      include_category_primer: true,
      web_search: { enabled: false, sources: [] },
      files: [],
      notes: '',
    },
    session: null,
    handoff: null,
    due: null,
    log: [],
  };

  const task = { ...defaults, ...fields };
  // Never let caller override the assigned identity fields.
  task.id = nextId(project, tasks);
  task.project = project;
  task.created = new Date().toISOString();
  if (fields.context && typeof fields.context === 'object' && !Array.isArray(fields.context)) {
    task.context = { ...defaults.context, ...fields.context };
    if (fields.context.web_search && typeof fields.context.web_search === 'object') {
      task.context.web_search = { ...defaults.context.web_search, ...fields.context.web_search };
    }
  } else {
    // a null/garbage context in the payload must not shadow the defaults
    task.context = { ...defaults.context };
  }
  if (!Array.isArray(task.upstream)) task.upstream = [];
  if (!Array.isArray(task.log)) task.log = [];

  tasks.push(task);
  writeTasksFile(project, tasks);
  broadcast('task:update', { project, task });
  return task;
}

export function updateTask(project, id, patch) {
  assertProject(project);
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be an object');
  }
  const tasks = readTasksFile(project);
  const idx = tasks.findIndex((t) => t && t.id === id);
  if (idx === -1) throw new Error(`task '${id}' not found in project '${project}'`);

  const { logNote, ...rest } = patch;
  // Protect identity fields from shallow merge.
  delete rest.id;
  delete rest.project;

  const task = { ...tasks[idx], ...rest };
  if (logNote) {
    if (!Array.isArray(task.log)) task.log = [];
    task.log = [...task.log, { ts: new Date().toISOString(), note: String(logNote) }];
  }
  tasks[idx] = task;
  writeTasksFile(project, tasks);
  broadcast('task:update', { project, task });
  return task;
}

export function deleteTask(project, id) {
  assertProject(project);
  const tasks = readTasksFile(project);
  const idx = tasks.findIndex((t) => t && t.id === id);
  if (idx === -1) throw new Error(`task '${id}' not found in project '${project}'`);
  const [removed] = tasks.splice(idx, 1);
  writeTasksFile(project, tasks);
  broadcast('task:delete', { project, id });
  return removed;
}

export function getCategories() {
  // the user's categories.json wins; a fresh clone (no categories.json yet)
  // falls back to the shipped categories.example.json so the Add Task picker
  // isn't empty out of the box. A malformed user file surfaces (not masked).
  for (const file of [CATEGORIES_FILE, CATEGORIES_EXAMPLE]) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // missing — try the next source
      console.error(`[core] failed reading ${path.basename(file)}:`, err.message);
      return {};
    }
  }
  return {};
}

export function getAbstract(project) {
  assertProject(project);
  try {
    const file = path.join(ABSTRACTS_DIR, `${project}.md`);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[core] failed reading abstract for ${project}:`, err.message);
    return '';
  }
}
