// lib/snapshots.js — per-turn change tracking with rewind.
// A tracker captures a file's content the moment a session's Edit/Write tool
// call appears in the stream (pre-execution), then at turn end compares with
// what's on disk and records a change-set: journal + before/after blobs under
// projectManager/snapshots/<project>/. Reverts write the "before" blob back
// and are themselves recorded, so a rewind can be rewound.
// Limits: only files inside the project root, text files, ≤2MB. Side effects
// of Bash commands are not seen — only direct file-editing tools.
import fs from 'fs';
import path from 'path';
import { broadcast } from './events.js';
import { ROOT } from './config.js';
import { containedPath, writeFileAtomic } from './paths.js';

const SNAP_ROOT = path.join(ROOT, 'snapshots');
const MAX_ENTRIES = 200;               // journal cap per project (oldest pruned)
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const log = (...a) => console.log('[snapshots]', ...a);
const logErr = (...a) => console.error('[snapshots]', ...a);

let idCounter = 0;
const newId = () => `snp-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const journals = new Map(); // project → entries array (newest first)

function dirs(project) {
  const base = path.join(SNAP_ROOT, project);
  return { base, blobs: path.join(base, 'blobs'), journal: path.join(base, 'journal.json') };
}

function loadJournal(project) {
  if (journals.has(project)) return journals.get(project);
  let entries = [];
  const file = dirs(project).journal;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch (err) {
      // Don't silently treat corruption as "empty" — the next save would
      // overwrite the history. Move the corrupt file aside and start fresh.
      const aside = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, aside); } catch { /* read-only? best effort */ }
      logErr(`journal for ${project} unreadable (${err.message}) — moved to ${aside}`);
    }
  }
  journals.set(project, entries);
  return entries;
}

function saveJournal(project) {
  const d = dirs(project);
  fs.mkdirSync(d.base, { recursive: true });
  const tmp = d.journal + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(journals.get(project) || [], null, 2), 'utf8');
  fs.renameSync(tmp, d.journal);
}

function blobPath(project, entryId, idx, side) {
  return path.join(dirs(project).blobs, `${entryId}.${idx}.${side}`);
}

function writeBlob(project, entryId, idx, side, content) {
  const d = dirs(project);
  fs.mkdirSync(d.blobs, { recursive: true });
  // atomic: a truncated 'before' blob would make rewind restore garbage
  writeFileAtomic(blobPath(project, entryId, idx, side), content);
}

function readBlob(project, entryId, idx, side) {
  try {
    return fs.readFileSync(blobPath(project, entryId, idx, side), 'utf8');
  } catch {
    return null;
  }
}

function pruneJournal(project) {
  const entries = journals.get(project) || [];
  while (entries.length > MAX_ENTRIES) {
    const dead = entries.pop(); // newest-first → pop the oldest
    (dead.files || []).forEach((f, i) => {
      for (const side of ['before', 'after']) {
        try { fs.unlinkSync(blobPath(project, dead.id, i, side)); } catch { /* gone */ }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Reading project files safely
// ---------------------------------------------------------------------------

// → string content, null (no file), or undefined (unsnapshotable: binary/huge/dir)
function readSnapshotable(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null; // doesn't exist (yet)
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tracker — one per session turn
// ---------------------------------------------------------------------------

export function createTracker(project, taskId) {
  const noted = new Map(); // rel → { abs, before: string|null } (undefined-skips not stored)

  return {
    // Called when a file-editing tool_use appears in the stream. Captures the
    // pre-state the FIRST time a file shows up in this turn.
    note(fileish) {
      try {
        if (!fileish) return;
        const r = containedPath(project, String(fileish), { mustExist: false });
        if (!r || noted.has(r.rel)) return;
        const before = readSnapshotable(r.abs);
        if (before === undefined) return; // binary/huge — not tracked
        noted.set(r.rel, { abs: r.abs, before });
      } catch (err) {
        logErr('note failed:', err.message);
      }
    },

    // Called once at turn end. Records an entry if anything actually changed.
    finish(meta = {}) {
      try {
        if (!noted.size) return null;
        const files = [];
        const blobs = [];
        for (const [rel, { abs, before }] of noted.entries()) {
          const after = readSnapshotable(abs);
          if (after === undefined) continue;       // became binary/huge — skip
          if (before === after) continue;          // no net change this turn
          const status = before === null ? 'created' : after === null ? 'deleted' : 'modified';
          blobs.push({ before, after });
          files.push({ rel, status });
        }
        if (!files.length) return null;

        const entry = {
          id: newId(),
          task: taskId,
          ts: new Date().toISOString(),
          files,
        };
        if (meta.revertOf) entry.revertOf = meta.revertOf;

        blobs.forEach((b, i) => {
          if (b.before !== null) writeBlob(project, entry.id, i, 'before', b.before);
          if (b.after !== null) writeBlob(project, entry.id, i, 'after', b.after);
        });
        const entries = loadJournal(project);
        entries.unshift(entry);
        pruneJournal(project);
        saveJournal(project);

        try {
          broadcast('snapshot:new', { project, entry });
        } catch (err) {
          logErr('broadcast failed:', err.message);
        }
        log(`${project}/${taskId}: recorded ${files.length} file change(s) (${entry.id})`);
        return entry;
      } catch (err) {
        logErr('finish failed:', err.message);
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Queries + revert
// ---------------------------------------------------------------------------

export function listSnapshots(project, taskId) {
  const entries = loadJournal(project);
  const filtered = taskId ? entries.filter((e) => e.task === taskId) : entries;
  return filtered.map((e) => ({ ...e })); // shallow copies, no blob contents
}

export function getSnapshotFile(project, entryId, rel) {
  const entry = loadJournal(project).find((e) => e.id === entryId);
  if (!entry) return { error: 'unknown change-set' };
  const idx = (entry.files || []).findIndex((f) => f.rel === rel);
  if (idx === -1) return { error: 'file not in this change-set' };
  return {
    rel,
    status: entry.files[idx].status,
    before: readBlob(project, entryId, idx, 'before'),
    after: readBlob(project, entryId, idx, 'after'),
  };
}

/** Remove all change history for a deleted task (journal entries + blobs). */
export function purgeTask(project, taskId) {
  try {
    const entries = loadJournal(project);
    const dead = entries.filter((e) => e.task === taskId);
    if (!dead.length) return;
    for (const e of dead) {
      (e.files || []).forEach((_, i) => {
        for (const side of ['before', 'after']) {
          try { fs.unlinkSync(blobPath(project, e.id, i, side)); } catch { /* gone */ }
        }
      });
    }
    journals.set(project, entries.filter((e) => e.task !== taskId));
    saveJournal(project);
    log(`${project}/${taskId}: purged ${dead.length} change-set(s)`);
  } catch (err) {
    logErr('purgeTask failed:', err.message);
  }
}

// Rewind file(s) in an entry to their BEFORE state. relOnly limits to one
// file; otherwise the whole change-set rewinds. The rewind is recorded as its
// own entry (revertOf), so it shows in history and can itself be rewound.
export function revertSnapshot(project, entryId, relOnly) {
  try {
    const entry = loadJournal(project).find((e) => e.id === entryId);
    if (!entry) return { error: 'unknown change-set' };
    const targets = (entry.files || [])
      .map((f, i) => ({ ...f, idx: i }))
      .filter((f) => !relOnly || f.rel === relOnly);
    if (!targets.length) return { error: 'file not in this change-set' };

    const tracker = createTracker(project, entry.task);
    const failed = [];
    for (const f of targets) {
      try {
        const r = containedPath(project, f.rel, { mustExist: false });
        if (!r) { failed.push(`${f.rel}: path no longer valid`); continue; }
        const before = readBlob(project, entryId, f.idx, 'before');
        // Only a change recorded as 'created' may delete on rewind — a missing
        // blob on a modified file is a read failure, never a license to delete.
        if (before === null && f.status !== 'created') {
          failed.push(`${f.rel}: before-state blob unreadable`);
          continue;
        }
        tracker.note(r.abs); // capture current state so the revert is in history
        if (f.status === 'created') {
          try { fs.unlinkSync(r.abs); } catch { /* already gone */ }
        } else {
          writeFileAtomic(r.abs, before);
        }
      } catch (err) {
        failed.push(`${f.rel}: ${err.message}`);
      }
    }
    // record whatever DID revert, even when some files failed
    const recorded = tracker.finish({ revertOf: entryId });
    if (failed.length === targets.length) {
      return { error: `rewind failed — ${failed.join('; ')}` };
    }
    return { ok: true, entry: recorded, ...(failed.length ? { partial: failed } : {}) };
  } catch (err) {
    logErr('revert failed:', err.message);
    return { error: err.message };
  }
}
