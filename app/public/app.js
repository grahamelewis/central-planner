// app.js — live frontend for projectManager.
// Renders all views from a single `state` object fed by GET /api/state + the /ws event stream.
// No build step; plain ES module. All user/task text injected into HTML goes through esc().

'use strict';

import { hlFor, hlText, paintHL } from './hl.js';

const enc = encodeURIComponent;
const hlStores = {}; // fkey → highlighter cache ({lang, text, lines, states})

/* ───────────────────────── state ───────────────────────── */

const state = {
  projects: {},   // key → {name, root, color, texWatch}
  categories: {},
  abstracts: {},
  tasks: {},      // key → Task[]
  artifacts: [],
  pdf: {},        // key → {tex, pdf, state, lastBuildMs, lastBuiltAt, pages}
  ledger: null,   // weekSummary()
  sessions: [],
  runs: {},       // key → {rel, cmdLine, state, exitCode, startedAt, ms}
};

const ui = {
  view: 'ov',     // 'ov' | 'cats' | 'manage' | projectKey
  per: {},        // projectKey → { taskId, fileTab (index|'tail'|null), viewerKey }
  manageOpen: new Set(), // expanded `${project}::${category}` rows on the manage page
};

const tailBufs = {};      // `${project}/${id}` → accumulated session:stream text
const transcripts = {};   // `${project}/${id}` → { entries:[{role,text,ts}], fetched }
const fileCache = {};     // `${project}::${rel}` → { text, mtimeMs } | { error } | { loading }
const drafts = {};        // `${project}::${rel}` → unsaved editor text (survives re-renders)
const draftBase = {};     // `${project}::${rel}` → disk mtimeMs the draft started from —
                          // frozen at first keystroke so cache refreshes can't re-baseline
                          // a stale draft over someone else's newer write
const runBufs = {};       // project → accumulated run output (plain text)
const runSegs = {};       // project → [{fd, text}] — same content, stderr-tagged
                          // (absent after a reload: the server tail is colorless)
const runOff = {};        // project → highest run:stream byte offset applied —
                          // drops chunks replayed across a ws reconnect
const fileLists = {};     // project → { files:[rel,…] } | { loading } — for the pin picker
const closedCache = {};   // `${project}/${taskId}` → Set of closed-tab file strings
const htmlEdits = {};     // project → { rel, doctype, baseMtimeMs, dirty } — live WYSIWYG edit
const snapsCache = {};    // `${project}/${taskId}` → { entries:[…], fetched } — change history
const pendingPerms = {};  // `${project}/${taskId}` → [{requestId, tool, input}, …] awaiting approval
const composerDrafts = {}; // `${project}/${taskId}` → unsent composer text (survives re-renders)
const dirCache = {};      // `${project}::${rel}` → { entries, sig, loaded, loading } — sidebar folder browser

let form = null;          // add-task modal form state

/* ───────────────────────── theme ───────────────────────── */
/* 'system' | 'dark' | 'light' in localStorage; the <head> bootstrap applied it
   before first paint, this keeps it live (Settings clicks + macOS switching) */

const sysLight = matchMedia('(prefers-color-scheme: light)');

function themePref() {
  try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; }
}

function applyTheme() {
  const t = themePref();
  const light = t === 'light' || (t === 'system' && sysLight.matches);
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

function setTheme(t) {
  try { localStorage.setItem('theme', t); } catch { /* private mode — session-only */ }
  applyTheme();
  if (ui.view === 'settings') renderSettings();
}

sysLight.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });

/* ───────────────────────── helpers ───────────────────────── */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const OVS_LABEL = { auto: 'AUTO', propose: 'PROP', coop: 'COOP', manual: 'MAN' };

function statusDot(s) {
  return { running: 'run', waiting: 'ask', queued: 'q', manual: 'man', done: 'done' }[s] || 'q';
}

// projKeys() is the VISIBLE set (nav, overview, shortcuts, add-task) — it hides
// 'inactive' projects. allProjKeys() is the full set for lookups (resolveId,
// lineage) and the Manage tab, which must still see inactive ones to reactivate.
function projKeys() { return Object.keys(state.projects).filter(k => state.projects[k]?.status !== 'inactive'); }
function allProjKeys() { return Object.keys(state.projects); }
function tasksOf(k) { return Array.isArray(state.tasks[k]) ? state.tasks[k] : []; }
function findTask(k, id) { return tasksOf(k).find(t => t && t.id === id) || null; }

function resolveId(id) {
  for (const k of allProjKeys()) {
    const t = findTask(k, id);
    if (t) return { k, t };
  }
  return null;
}

function perOf(k) { return ui.per[k] ?? (ui.per[k] = {}); }

function curTask(k) {
  const per = perOf(k);
  let t = per.taskId ? findTask(k, per.taskId) : null;
  if (!t) {
    // fallback never auto-selects an archived task
    const ts = tasksOf(k).filter(x => !x.archived);
    t = ts.find(x => x.status === 'running' || x.status === 'waiting') || ts[0] || null;
    per.taskId = t ? t.id : null;
  }
  return t;
}

// Feature flag: show the personal "hours logged" counter on the dashboard.
// Disabled for now — the heartbeat/ledger infrastructure still records hours;
// this only hides the display (ring, ledger column, wk chip, This-week stats).
// Flip back to true to restore it.
const SHOW_HOURS = false;

function hrs(sec) { return ((sec || 0) / 3600).toFixed(1); }
function fmtTok(n) {
  n = n || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
}
function usd(x) { return '$' + (x || 0).toFixed(2); }
function extOf(f) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(f || ''));
  return m ? m[1].toUpperCase() : '?';
}
function fmtWhen(mtime) {
  try {
    const d = new Date(mtime);
    if (isNaN(d)) return '';
    const today = new Date();
    if (d.toDateString() === today.toDateString())
      return d.toTimeString().slice(0, 5);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}
function isoWeek(d) {
  try {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = x.getUTCDay() || 7;
    x.setUTCDate(x.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
    return Math.ceil((((x - y0) / 86400000) + 1) / 7);
  } catch { return ''; }
}

/* map context.files entry → path relative to project root, or null if outside */
function relOf(project, file) {
  const root = state.projects[project]?.root || '';
  let f = String(file || '').trim();
  if (!f) return null;
  if (f.startsWith('/')) {
    const r = root.endsWith('/') ? root : root + '/';
    if (root && (f === root || f.startsWith(r))) return f.slice(r.length).replace(/^\/+/, '');
    return null;
  }
  return f.replace(/^\.\//, '');
}

const isPdfFile = (f) => String(f || '').toLowerCase().endsWith('.pdf');

/* pin kinds: code (read on demand) · data (schema card) · folder (tree map) · pdf (viewer) */
const DATA_EXTS_C = ['csv', 'tsv', 'parquet', 'dta', 'rds', 'rdata', 'feather', 'xlsx', 'xls'];
const isDataFile = (f) => DATA_EXTS_C.includes(String(f || '').split('.').pop().toLowerCase());
/* server-rendered head-of-table page (pandas) — iframed in the show panel */
const dataviewUrl = (key, rel) => `/api/datahead/${enc(key)}?rel=${enc(rel)}`;
function pinKindOf(f) {
  const s = String(f || '');
  if (s.endsWith('/')) return 'folder';
  if (isPdfFile(s)) return 'pdf';
  return DATA_EXTS_C.includes(s.split('.').pop().toLowerCase()) ? 'data' : 'code';
}
const pinLabelOf = (f) => {
  const s = String(f || '');
  return s.endsWith('/') ? s.replace(/\/+$/, '').split('/').pop() + '/' : s.split('/').pop();
};
const PIN_ICON = { code: '▮', data: '▦', folder: '🗀', pdf: '◫' };

function artifactUrl(project, rel) {
  return `/artifact/${enc(project)}/` + String(rel).split('/').map(enc).join('/');
}

function pdfSrc(key) {
  const e = state.pdf?.[key];
  if (!e || !e.pdf) return null;
  const rel = relOf(key, e.pdf);
  return rel ? artifactUrl(key, rel) : null;
}

/* ───────────────────────── toast + fetch ───────────────────────── */

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(msg);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* in-app confirm dialog — native confirm() can be silenced by the browser,
   and a styled danger button reads clearer. msg is HTML (esc() the parts). */
function confirmBox(msg, goLabel = 'Delete') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.id = 'confirmBack';
    back.innerHTML = `<div id="confirmBox">
      <div class="cbMsg">${msg}</div>
      <div class="cbBtns">
        <button class="cbCancel">Cancel</button>
        <button class="cbGo">${esc(goLabel)}</button>
      </div></div>`;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
    };
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    back.querySelector('.cbCancel').addEventListener('click', () => done(false));
    back.querySelector('.cbGo').addEventListener('click', () => done(true));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    back.querySelector('.cbCancel').focus(); // Enter defaults to the safe side
  });
}

async function api(method, url, body, opts = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      if (!opts.quiet) toast(`${method} ${url} → ${data.error || res.status}`);
      return null;
    }
    return data;
  } catch (err) {
    if (!opts.quiet) toast(`${method} ${url} failed: ${err.message || err}`);
    return null;
  }
}
const apiQuiet = (m, u, b) => api(m, u, b, { quiet: true });

/* ───────────────────────── transcripts & files ───────────────────────── */

async function refreshTranscript(project, id) {
  const k = `${project}/${id}`;
  const data = await apiQuiet('GET', `/api/transcript/${enc(project)}/${enc(id)}`);
  const prev = transcripts[k];
  transcripts[k] = {
    entries: (data && Array.isArray(data.transcript)) ? data.transcript : (prev?.entries || []),
    fetched: true,
  };
  if (ui.view === project && curTask(project)?.id === id) renderWB(project);
}

function ensureTranscript(project, id) {
  const k = `${project}/${id}`;
  if (transcripts[k]) return;
  transcripts[k] = { entries: [], fetched: false };
  refreshTranscript(project, id);
}

async function ensureFile(project, rel) {
  const k = `${project}::${rel}`;
  if (fileCache[k]) return;
  fileCache[k] = { loading: true };
  try {
    const res = await fetch(artifactUrl(project, rel));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    // precise server header first; Last-Modified (second-floor) as fallback
    const lm = Number(res.headers.get('x-mtime-ms'))
      || Date.parse(res.headers.get('last-modified') || '') || null;
    const truncated = text.length > 200000;
    const binary = text.includes('\u0000') || /\ufffd{2}/.test(text.slice(0, 8000));
    fileCache[k] = {
      text: binary ? `// binary file (${text.length.toLocaleString()} bytes) — not editable here` :
        truncated ? text.slice(0, 200000) + '\n… (truncated)' : text,
      mtimeMs: lm,
      truncated: truncated || binary, // binary rides the read-only path
      binary,
    };
  } catch (err) {
    fileCache[k] = { error: String(err.message || err) };
  }
  if (ui.view === project) renderWB(project);
}

async function saveFile(key, rel) {
  const k = `${key}::${rel}`;
  if (drafts[k] == null) return; // nothing unsaved
  const base = draftBase[k] ?? fileCache[k]?.mtimeMs;
  if (!Number.isFinite(base)) {
    // no trustworthy baseline (cache mid-load/error) — saving now could
    // overwrite a newer on-disk version with the conflict guard disarmed
    toast('cannot save yet — file state unknown, reopen the tab first');
    return;
  }
  const text = drafts[k];
  let res;
  try {
    res = await fetch(artifactUrl(key, rel), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, baseMtimeMs: base }),
    });
  } catch (err) { toast('save failed: ' + (err.message || err)); return; }
  if (res.status === 409) {
    // real recovery path: offer to load the new disk version (draft → clipboard)
    if (confirm('This file changed on disk (a session or another machine edited it).\n\n' +
      'Load the NEW version? Your unsaved text is copied to the clipboard first.\n' +
      'Cancel keeps your draft (saving will keep failing until you reload).')) {
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard denied */ }
      delete drafts[k];
      delete draftBase[k];
      delete fileCache[k];
      renderWB(key);
      toast('reloaded from disk — your draft is on the clipboard');
    }
    return;
  }
  if (!res.ok) {
    let msg = `save failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* */ }
    toast(msg);
    return;
  }
  const r = await res.json();
  fileCache[k] = { text, mtimeMs: r.mtimeMs };
  if (drafts[k] === text) {
    delete drafts[k]; // clean — nothing typed while the save was in flight
    delete draftBase[k];
  } else {
    draftBase[k] = r.mtimeMs; // newer keystrokes survive; rebase them on our own write
  }
  toast('saved ' + rel);
  editorChrome(key);
}

/* closed tabs — UI-only state (localStorage), so closing a tab never touches
   the task record: the file stays pinned and in the context packet */
function getClosed(key, task) {
  const ck = `${key}/${task.id}`;
  if (!closedCache[ck]) {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(`closedTabs:${ck}`) || '[]'); } catch { /* corrupt */ }
    closedCache[ck] = new Set(Array.isArray(arr) ? arr.map(String) : []);
  }
  return closedCache[ck];
}

function persistClosed(key, task) {
  const ck = `${key}/${task.id}`;
  if (closedCache[ck]) localStorage.setItem(`closedTabs:${ck}`, JSON.stringify([...closedCache[ck]]));
}

function closeTab(key, task, i, files) {
  const closed = getClosed(key, task);
  closed.add(String(files[i]));
  persistClosed(key, task);
  const per = perOf(key);
  if (per.fileTab === i) {
    // hand focus to the nearest tab that's still open (pdfs have no tabs)
    const open = files.map((_, j) => j)
      .filter(j => !closed.has(String(files[j])) && !isPdfFile(files[j]) && pinKindOf(files[j]) !== 'folder');
    per.fileTab = open.find(j => j > i) ?? (open.length ? open[open.length - 1]
      : per.openExtra?.length ? 'x:' + per.openExtra[0] : 'tail');
  }
  renderWB(key);
}

/* ephemeral code tabs — files opened from a folder-pin browser. UI-only and
   per project (per.openExtra), NOT part of the task's context packet; the
   fileTab value for extras is the string 'x:<rel>' so it can never collide
   with numeric pin indexes or 'tail'/'run'/'snaps' */
const extraRel = (fi) => (typeof fi === 'string' && fi.startsWith('x:')) ? fi.slice(2) : null;

function openExtraTab(key, rel) {
  const per = perOf(key);
  const task = curTask(key);
  const pins = task && Array.isArray(task.context?.files) ? task.context.files : [];
  const pinIdx = pins.findIndex(f => relOf(key, String(f).replace(/\/+$/, '')) === rel);
  if (pinIdx >= 0 && pinIdx < 12 && pinKindOf(pins[pinIdx]) === 'code') {
    // already pinned as code — select its tab (reopening it if × closed);
    // data/folder pins render cards, so those still get an ephemeral tab
    per.fileTab = pinIdx;
    if (task) {
      const closed = getClosed(key, task);
      if (closed.delete(String(pins[pinIdx]))) persistClosed(key, task);
    }
    if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
  } else {
    // note: pdf/html/data files never reach here — the folder-browser click
    // routes them to the show panel; this path is code/text files only
    per.openExtra = per.openExtra || [];
    if (!per.openExtra.includes(rel)) per.openExtra.push(rel);
    per.fileTab = 'x:' + rel;
    // refetch on open (unless a draft is in progress) — same staleness rule as pins
    if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
  }
  renderWB(key);
}

async function ensureDir(key, rel) {
  const ck = `${key}::${rel}`;
  const cur = dirCache[ck];
  if (cur && cur.loading) return; // fetch already in flight
  // refetch even on a cache hit — stale entries stay visible while loading,
  // so re-expanding a folder (or the heartbeat sweep) picks up new files
  dirCache[ck] = cur ? { ...cur, loading: true } : { entries: [], loading: true };
  const d = await apiQuiet('GET', `/api/ls/${enc(key)}?rel=${enc(rel)}`);
  const entries = (d && d.entries) || [];
  // re-render only when names change: sizes churn while logs are written
  const sig = entries.map(e => (e.dir ? 'd' : 'f') + e.name).join('\n');
  const changed = !cur || sig !== cur.sig;
  dirCache[ck] = { entries, sig, loaded: true };
  if (changed && ui.view === key) renderWB(key);
}

/* expanded folder contents under a 🗀 pin — pdfs/htmls open in the show panel */
function dirKidsHtml(key, rel, depth) {
  const dc = dirCache[`${key}::${rel}`];
  const pad = 16 + depth * 13;
  if (!dc || (dc.loading && !dc.loaded)) return `<div class="scKid note" style="padding-left:${pad}px">loading…</div>`;
  if (!dc.entries.length) return `<div class="scKid note" style="padding-left:${pad}px">empty</div>`;
  return dc.entries.map(e => {
    const crel = `${rel}/${e.name}`;
    if (e.dir) {
      const open = perOf(key).openDirs?.has(crel);
      return `<div class="scKid dirk" data-dk="${esc(crel)}" style="padding-left:${pad}px">${open ? '▾' : '▸'} 🗀 ${esc(e.name)}</div>`
        + (open ? dirKidsHtml(key, crel, depth + 1) : '');
    }
    const ext = e.name.split('.').pop().toLowerCase();
    const dataf = isDataFile(e.name);
    const viewable = ['pdf', 'html', 'htm'].includes(ext) || dataf;
    const icon = ext === 'pdf' ? '◫' : (ext === 'html' || ext === 'htm') ? '⌗' : dataf ? '▦' : '·';
    return `<div class="scKid filek ${viewable ? 'viewable' : ''}" data-fk="${esc(crel)}"
      style="padding-left:${pad}px" title="${dataf ? 'preview head rows in the show panel'
    : viewable ? 'open in the show panel' : 'open in the code pane'}">${icon} ${esc(e.name)}</div>`;
  }).join('');
}

async function ensureCard(key, rel) {
  const ck = `${key}::card::${rel}`;
  if (fileCache[ck]) return;
  fileCache[ck] = { loading: true };
  const d = await apiQuiet('GET', `/api/pincard/${enc(key)}?rel=${enc(rel)}`);
  fileCache[ck] = (d && d.card) ? { text: d.card } : { error: (d && d.error) || 'card unavailable' };
  if (ui.view === key) renderWB(key);
}

async function ensureFileList(key) {
  if (fileLists[key]) return;
  fileLists[key] = { loading: true };
  const d = await apiQuiet('GET', `/api/files/${enc(key)}`);
  fileLists[key] = { files: (d && Array.isArray(d.files)) ? d.files : [] };
  if (ui.view === key) renderWB(key);
}

/* the ＋ menu's actions: native dialogs locally; remote falls back to the
   in-app search (files) or a path prompt (folders). Dialog errors just toast —
   never silently swap UIs (that was the old "search bar appears" bug). */
async function pickPin(key, task, kindWanted) {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  if (local) {
    const r = await api('POST', '/api/pickfile', kindWanted === 'folder'
      ? { project: key, kind: 'folder', prompt: 'Pin a folder to {name} — the map is injected, not the contents' }
      : { project: key, prompt: 'Pin a file to {name}' });
    if (r && r.rel) pinFile(key, task, r.rel);
    // canceled → nothing; errors already toasted by api()
  } else if (kindWanted === 'folder') {
    const rel = prompt(`Folder path in ${state.projects[key]?.name || key} (relative to project root):`, '');
    if (rel && rel.trim()) pinFile(key, task, rel.trim().replace(/\/?$/, '/'));
  } else {
    const per = perOf(key);
    per.pinOpen = true;
    per.pinQ = '';
    delete fileLists[key];
    ensureFileList(key);
    renderWB(key);
    document.querySelector(`#v-${key} #pinSearch`)?.focus();
  }
}

async function pinFile(key, task, rel) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  const cur = Array.isArray(local.context?.files) ? local.context.files : [];
  if (cur.some(f => relOf(key, f) === rel)) return; // already pinned
  const order = [...cur, rel];
  // optimistic: show the new tab immediately, then persist (broadcast confirms)
  local.context = { ...(local.context || {}), files: order };
  const closed = getClosed(key, task); // re-pinning something once closed reopens it
  if (closed.delete(rel)) persistClosed(key, task);
  const per = perOf(key);
  per.openExtra = (per.openExtra || []).filter(r => r !== rel); // pin tab supersedes an ephemeral one
  if (isPdfFile(rel)) selectViewer(key, rel); // pdfs open in the show panel
  else if (pinKindOf(rel) === 'folder') {
    // folders have no center tab — open their sidebar browser instead
    const frel = relOf(key, String(rel).replace(/\/+$/, ''));
    if (frel != null) {
      per.openDirs = per.openDirs || new Set();
      per.openDirs.add(frel);
      ensureDir(key, frel);
    }
  } else if (order.length <= 12) per.fileTab = order.length - 1;
  else toast('pinned — beyond the 12 visible tabs, see the sidebar'); // don't focus a different file
  per.pinOpen = false;
  per.pinQ = '';
  renderWB(key);
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`,
    { context: { ...local.context, files: order } });
}

function pinResultsHtml(key, task) {
  const fl = fileLists[key];
  if (!fl || fl.loading) return '<div class="sideNote">scanning project…</div>';
  const terms = (perOf(key).pinQ || '').toLowerCase().split(/\s+/).filter(Boolean);
  const pinned = new Set((task.context?.files || []).map(f => relOf(key, f)).filter(Boolean));
  const hits = fl.files.filter(f =>
    !pinned.has(f) && terms.every(t => f.toLowerCase().includes(t)));
  if (!hits.length) return '<div class="sideNote">no matches</div>';
  return hits.slice(0, 30).map(f =>
    `<div class="pinRow" data-rel="${esc(f)}" title="${esc(f)}">＋ ${esc(f)}</div>`).join('')
    + (hits.length > 30 ? `<div class="sideNote">… ${hits.length - 30} more — keep typing</div>` : '');
}

async function runFile(key, rel) {
  if (state.runs[key]?.state === 'running') {
    toast('a run is already active in this project — ⊘ stop it first');
    perOf(key).sessTab = 'run';
    renderWB(key);
    return;
  }
  const k = `${key}::${rel}`;
  if (drafts[k] != null) {
    const c = fileCache[k];
    if (!c || c.loading || c.error || c.truncated) {
      // a leftover draft with no visible editor — saving it would overwrite
      // newer on-disk content (e.g. a file that grew past the display cap)
      toast('stale unsaved draft on a read-only file — reopen the tab before running');
      return;
    }
    await saveFile(key, rel);
    if (drafts[k] != null) return; // save failed — don't run the stale on-disk version
  }
  runBufs[key] = '';
  delete runSegs[key];
  const r = await api('POST', '/api/run', { project: key, rel });
  if (r && r.ok) {
    if (r.run) state.runs[key] = r.run;
    perOf(key).sessTab = 'run'; // jump to the ▶ output tab (session pane)
    renderWB(key);
  }
}

async function stopRunReq(key) {
  await api('DELETE', `/api/run/${enc(key)}`);
}

/* ── change history (snapshots) ── */

async function ensureSnaps(key, taskId) {
  const ck = `${key}/${taskId}`;
  if (snapsCache[ck]) return;
  snapsCache[ck] = { entries: [], fetched: false };
  const d = await apiQuiet('GET', `/api/snapshots/${enc(key)}?task=${enc(taskId)}`);
  snapsCache[ck] = { entries: (d && Array.isArray(d.entries)) ? d.entries : [], fetched: true };
  if (ui.view === key && curTask(key)?.id === taskId) renderWB(key);
}

/* line diff: trim common prefix/suffix, LCS-align the middle (bounded) */
function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length, eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = a.slice(0, pre).map(l => ['=', l]);
  const mA = a.slice(pre, ea), mB = b.slice(pre, eb);
  if (mA.length * mB.length > 4000000) {
    // too big to align precisely — show as wholesale replace
    mA.forEach(l => ops.push(['-', l]));
    mB.forEach(l => ops.push(['+', l]));
  } else if (mA.length || mB.length) {
    const n = mA.length, m = mB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = mA[i] === mB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (mA[i] === mB[j]) { ops.push(['=', mA[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', mA[i]]); i++; }
      else { ops.push(['+', mB[j]]); j++; }
    }
    while (i < n) ops.push(['-', mA[i++]]);
    while (j < m) ops.push(['+', mB[j++]]);
  }
  a.slice(ea).forEach(l => ops.push(['=', l]));
  return ops;
}

function diffHtml(before, after) {
  const ops = diffLines(before, after);
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] === '=') {
      let j = i;
      while (j < ops.length && ops[j][0] === '=') j++;
      const run = j - i;
      if (run > 8) { // collapse long unchanged stretches to 3 lines of context
        for (let k2 = i; k2 < i + 3; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
        out.push(`<div class="dl skip">··· ${run - 6} unchanged lines ···</div>`);
        for (let k2 = j - 3; k2 < j; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
      } else {
        for (let k2 = i; k2 < j; k2++) out.push(`<div class="dl ctx">${esc(ops[k2][1])}</div>`);
      }
      i = j - 1;
    } else if (ops[i][0] === '-') {
      out.push(`<div class="dl del">${esc(ops[i][1])}</div>`);
    } else {
      out.push(`<div class="dl add">${esc(ops[i][1])}</div>`);
    }
  }
  return `<div class="diffBox">${out.join('')}</div>`;
}

/* ── WYSIWYG html editing — designMode on the viewer iframe ──
   The page renders with its own CSS but scripts paused, so MathJax/plot code
   stays as source ($...$ etc.) and the saved file remains faithful. While an
   edit is live, renderWB skips this project so WS events can't reload the
   iframe and eat the edits. */

async function startHtmlEdit(key, rel) {
  // grab the raw source once for the doctype + the conflict-guard mtime
  let doctype = '<!DOCTYPE html>';
  let mtimeMs = null;
  try {
    const res = await fetch(artifactUrl(key, rel));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const m = text.match(/^﻿?\s*<!doctype[^>]*>/i);
    if (m) doctype = m[0].trim();
    // precise header first — Last-Modified is second-truncated and trips the
    // 250ms conflict window with spurious 409s
    mtimeMs = Number(res.headers.get('x-mtime-ms'))
      || Date.parse(res.headers.get('last-modified') || '') || null;
  } catch (err) {
    toast('cannot edit ' + rel + ' — ' + (err.message || err));
    return;
  }
  htmlEdits[key] = { rel, doctype, baseMtimeMs: mtimeMs, dirty: false };
  const per = perOf(key);
  per.htmlEdit = rel;
  per.viewerKey = rel;
  renderWB(key);
}

async function saveHtmlEdit(key) {
  const st = htmlEdits[key];
  const frame = document.querySelector(`#v-${key} #htmlEditFrame`);
  const doc = frame && frame.contentDocument;
  if (!st || !doc) return;
  const gen = st.gen || 0; // edits made while the PUT is in flight bump gen
  const html = st.doctype + '\n' + doc.documentElement.outerHTML + '\n';
  const r = await api('PUT', artifactUrl(key, st.rel), { content: html, baseMtimeMs: st.baseMtimeMs });
  if (!r || !r.ok) return; // api() toasted the reason (409 = changed on disk)
  st.baseMtimeMs = r.mtimeMs;
  if ((st.gen || 0) === gen) st.dirty = false; // else newer keystrokes stay unsaved
  // disk changed under the code pane — refresh its copy (an unsaved raw draft,
  // if one exists, is kept; its own conflict guard will catch the divergence)
  delete fileCache[`${key}::${st.rel}`];
  toast('saved ' + st.rel);
  htmlEditChrome(key);
}

function endHtmlEdit(key) {
  const st = htmlEdits[key];
  if (st?.dirty && !confirm('Discard unsaved visual edits to ' + st.rel + '?')) return;
  delete htmlEdits[key];
  perOf(key).htmlEdit = null;
  renderWB(key); // back to the normal scripted view
}

function htmlEditChrome(key) {
  const el = document.querySelector(`#v-${key} #htmlDirty`);
  if (el) el.textContent = htmlEdits[key]?.dirty ? '● unsaved — ⌘S' : '';
}

/* refresh the footer save-state and tab dirty-dot in place — no re-render,
   so this is safe to call on every keystroke */
function editorChrome(key) {
  const root = document.getElementById('v-' + key);
  const ed = root && root.querySelector('#codeEditor');
  if (!ed) return;
  const dirty = drafts[ed.dataset.fkey] != null;
  const ss = root.querySelector('#saveState');
  if (ss) {
    ss.classList.toggle('dirty', dirty);
    ss.innerHTML = dirty
      ? '● unsaved — ⌘S or <button id="saveFileBtn" class="saveBtn">save</button>'
      : 'editable — ⌘S saves';
    const btn = ss.querySelector('#saveFileBtn');
    if (btn) btn.addEventListener('click', () => saveFile(key, ed.dataset.rel));
  }
  const tab = root.querySelector('.ctab.cd.on');
  if (tab) {
    const dot = tab.querySelector('.dirtyDot');
    if (dirty && !dot) tab.insertAdjacentHTML('beforeend', '<span class="dirtyDot">●</span>');
    else if (!dirty && dot) dot.remove();
  }
}

/* ───────────────────────── websocket ───────────────────────── */

let wsFirst = true;
function connectWS() {
  let ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'; // https when proxied (tailscale serve)
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { setTimeout(connectWS, 3000); return; }
  ws.onopen = async () => {
    if (!wsFirst) { await loadState(); renderAll(); }
    wsFirst = false;
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { handleEvent(msg.type, msg.payload); }
    catch (err) { console.warn('[ui] event handler error', msg.type, err); }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function handleEvent(type, p) {
  switch (type) {
    case 'state': {
      applyState(p);
      renderAll();
      break;
    }
    case 'task:update': {
      if (!p || !p.task) break;
      const arr = state.tasks[p.project] || (state.tasks[p.project] = []);
      const i = arr.findIndex(t => t && t.id === p.task.id);
      if (i >= 0) arr[i] = p.task; else arr.push(p.task);
      renderNav();
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === 'manage') renderManage();
      else if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'session:stream': {
      if (!p) break;
      const k = `${p.project}/${p.id}`;
      const chunk = String(p.chunk ?? '');
      {
        let b = (tailBufs[k] || '') + chunk;
        if (b.length > 200000) {
          b = b.slice(-200000);
          const nl = b.indexOf('\n'); // cut at a line boundary, not mid-marker
          if (nl > 0) b = b.slice(nl + 1);
        }
        tailBufs[k] = b;
      }
      if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(p.project, k));
      break;
    }
    case 'session:status': {
      if (!p) break;
      if (perOf(p.project).interrupting === p.id) perOf(p.project).interrupting = null;
      const t = findTask(p.project, p.id);
      if (t && p.status) t.status = p.status;
      if (p.error) toast(`[${p.project} · ${p.id}] ${p.error}`);
      if (p.status && p.status !== 'running') {
        refreshTranscript(p.project, p.id); // sync server-side transcript after the turn
      }
      renderNav();
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'artifact:new': {
      const a = p && p.artifact;
      if (!a) break;
      const i = state.artifacts.findIndex(x => x.project === a.project && x.rel === a.rel);
      if (i >= 0) state.artifacts.splice(i, 1);
      state.artifacts.unshift(a);
      state.artifacts = state.artifacts.slice(0, 60);
      delete fileCache[`${a.project}::${a.rel}`]; // content changed on disk
      // the kept viewer stack never recreates its iframes on re-render, so a
      // frame showing this file is reloaded in place (hidden ones included)
      document.querySelectorAll(`#v-${a.project} iframe.artFrame[data-vk]`).forEach(f => {
        if (f.dataset.vk !== a.rel) return;
        f.src = a.kind === 'pdf'
          ? artifactUrl(a.project, a.rel) + '?t=' + Date.now() + '#navpanes=0&view=FitH'
          : artifactUrl(a.project, a.rel); // re-setting src forces a reload
      });
      if (ui.view === 'ov') renderOverview();
      else if (ui.view === a.project) renderWB(a.project);
      break;
    }
    case 'run:stream': {
      if (!p || !p.project) break;
      const chunk = String(p.chunk ?? '');
      if (typeof p.off === 'number') {
        // replay protection: state adoption sets runOff to the server's byte
        // count, so a chunk re-delivered across a reconnect is dropped
        if (p.off <= (runOff[p.project] || 0)) break;
        runOff[p.project] = p.off;
      }
      runBufs[p.project] = ((runBufs[p.project] || '') + chunk).slice(-200000);
      {
        // mirror into fd-tagged segments so stderr stays red across re-renders
        const segs = (runSegs[p.project] = runSegs[p.project] || []);
        const lastSeg = segs[segs.length - 1];
        if (lastSeg && lastSeg.fd === p.fd) lastSeg.text += chunk;
        else segs.push({ fd: p.fd, text: chunk });
        let total = segs.reduce((n, s) => n + s.text.length, 0);
        while (total > 200000 && segs.length > 1) total -= segs.shift().text.length;
      }
      const pre = document.querySelector(`#v-${p.project} #runPre`);
      if (pre && pre.dataset.key === p.project) {
        pre.querySelector(':scope > span.cm')?.remove(); // the "output appears here" placeholder
        // stick to the bottom only if the user hasn't scrolled up to read
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre._chars = (pre._chars ?? pre.textContent.length) + chunk.length;
        if (p.fd === 2) {
          // stderr — render in red so tracebacks stand out in noisy output
          const s = document.createElement('span');
          s.className = 'errOut';
          s.textContent = chunk;
          pre.appendChild(s);
        } else {
          pre.appendChild(document.createTextNode(chunk));
        }
        // keep the live DOM in lockstep with the buffers' 200k cap
        while (pre._chars > 200000 && pre.firstChild) {
          const n = pre.firstChild;
          const len = n.textContent.length;
          if (pre._chars - len >= 200000) { pre._chars -= len; n.remove(); }
          else {
            n.textContent = n.textContent.slice(pre._chars - 200000);
            pre._chars = 200000;
          }
        }
        if (stick) pre.scrollTop = pre.scrollHeight;
      }
      break;
    }
    case 'run:status': {
      if (!p || !p.project) break;
      if (p.run && p.run.state === 'running' && p.run.startedAt
        && state.runs[p.project]?.startedAt !== p.run.startedAt) {
        // a NEW run — possibly started from another client, where runFile's
        // local reset never ran: drop the previous run's output
        runBufs[p.project] = '';
        delete runSegs[p.project];
        runOff[p.project] = 0;
        const pre0 = document.querySelector(`#v-${p.project} #runPre`);
        if (pre0) { pre0.textContent = ''; pre0._chars = 0; }
      }
      state.runs[p.project] = p.run;
      if (p.run && p.run.state !== 'running') {
        const what = p.run.state === 'done' ? 'finished ✓'
          : p.run.state === 'error' ? `failed ✗ (exit ${p.run.exitCode ?? '?'})` : p.run.state;
        toast(`run ${what} — ${p.run.rel}` +
          (p.run.ms != null ? ` (${(p.run.ms / 1000).toFixed(1)}s)` : ''));
      }
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'task:delete': {
      if (!p || !p.project) break;
      const arr = state.tasks[p.project];
      if (arr) {
        const i = arr.findIndex(t => t && t.id === p.id);
        if (i >= 0) arr.splice(i, 1);
      }
      if (perOf(p.project).taskId === p.id) {
        perOf(p.project).taskId = null;
        perOf(p.project).fileTab = null;
      }
      renderAll();
      break;
    }
    case 'session:permission': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      (pendingPerms[pk] = pendingPerms[pk] || []).push({ requestId: p.requestId, tool: p.tool, input: p.input });
      toast(`⏳ approval needed — ${p.tool} (${state.projects[p.project]?.name || p.project})`);
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'session:permission:resolved': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      if (pendingPerms[pk]) {
        pendingPerms[pk] = pendingPerms[pk].filter(x => x.requestId !== p.requestId);
        if (!pendingPerms[pk].length) delete pendingPerms[pk];
      }
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'snapshot:new': {
      if (!p || !p.project || !p.entry) break;
      const ck = `${p.project}/${p.entry.task}`;
      const sc = snapsCache[ck];
      if (sc && sc.fetched && !sc.entries.some(e => e.id === p.entry.id)) sc.entries.unshift(p.entry);
      // files changed on disk — drop stale copies so the code pane reloads
      (p.entry.files || []).forEach(f => delete fileCache[`${p.project}::${f.rel}`]);
      if (ui.view === p.project) renderWB(p.project);
      break;
    }
    case 'pdf:status': {
      if (!p || !p.project) break;
      state.pdf[p.project] = p.entry;
      if (p.entry && p.entry.state === 'built') {
        if (ui.view === p.project) renderWB(p.project); // rebuilds iframe with fresh cache-bust src
        else if (ui.view === 'ov') renderOverview();
      } else {
        const t = document.querySelector(`#v-${p.project} #pdfStateTxt`);
        if (t && ui.view === p.project) {
          t.textContent = p.entry?.state === 'error' ? '✗ build error' : '⟳ building…';
        }
        if (ui.view === 'ov') renderOverview();
      }
      break;
    }
    case 'ledger:update': {
      state.ledger = p || state.ledger;
      renderNav();
      if (ui.view === 'about') { aboutCache.activity = null; ensureAboutData(); }
      if (ui.view === 'ov') renderOverview();
      // NEVER renderWB here: a full innerHTML rebuild every 30s heartbeat
      // would reload the viewer iframes (live pdf loses scroll/zoom) and wipe
      // the composer. Patch the few ledger-driven text nodes in place instead.
      else if (state.projects[ui.view]) updateLedgerInline(ui.view);
      break;
    }
    default: break;
  }
}

/* ───────────────────────── state load ───────────────────────── */

function applyState(p) {
  if (!p || typeof p !== 'object') return;
  state.user = p.user || {};
  state.projects = p.projects || {};
  // if the project we're viewing just went inactive (or was removed) — e.g. a
  // Manage edit here or on another client — fall back to overview so we don't
  // strand the user on a tab-less workbench (go()'s guard isn't on this path)
  if (!['ov', 'cats', 'manage', 'about'].includes(ui.view)
    && (!state.projects[ui.view] || state.projects[ui.view].status === 'inactive')) {
    ui.view = 'ov';
  }
  state.categories = p.categories || {};
  state.abstracts = p.abstracts || {};
  state.tasks = p.tasks || {};
  state.artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
  state.pdf = p.pdf || {};
  state.ledger = p.ledger || null;
  state.sessions = Array.isArray(p.sessions) ? p.sessions : [];
  state.runs = {};
  for (const [k, run] of Object.entries(p.runs || {})) {
    const { tail, ...rest } = run;
    state.runs[k] = rest;
    // the server tail is authoritative: after a reload OR a ws reconnect the
    // local buffer may have a gap from missed chunks (stderr tags can't be
    // reconstructed, so the recovered text renders uncolored)
    if (tail && tail !== runBufs[k]) {
      runBufs[k] = tail;
      delete runSegs[k];
    }
    if (typeof rest.bytes === 'number') runOff[k] = rest.bytes; // replay guard baseline
  }
}

async function loadState() {
  const data = await apiQuiet('GET', '/api/state');
  if (data) applyState(data);
  else toast('could not reach server — retrying…');
}

/* ───────────────────────── top-level render ───────────────────────── */

function ensureViews() {
  const host = document.getElementById('projectViews');
  if (!host) return;
  projKeys().forEach(k => {
    if (!document.getElementById('v-' + k)) {
      const d = document.createElement('div');
      d.className = 'view';
      d.id = 'v-' + k;
      host.appendChild(d);
    }
  });
}

function renderAll() {
  ensureViews();
  renderNav();
  if (ui.view === 'ov') renderOverview();
  else if (ui.view === 'cats') renderCats();
  else if (ui.view === 'manage') renderManage();
  else if (ui.view === 'about') renderAbout();
  else if (ui.view === 'settings') renderSettings();
  else if (state.projects[ui.view]) renderWB(ui.view);
  document.querySelectorAll('#v-ov, #v-cats, #v-manage, #v-about, #v-settings, #projectViews > .view')
    .forEach(x => x.classList.toggle('show', x.id === 'v-' + ui.view));
}

function go(v) {
  // before leaving, save the current project's console scroll WHILE its view is
  // still visible — renderAll only re-renders the entered view, so the outgoing
  // project's renderWB never fires to capture it (cross-project scroll memory)
  if (state.projects[ui.view]) {
    const prev = document.getElementById('v-' + ui.view)?.querySelector('#consoleBox');
    if (prev && prev.clientHeight) consoleView[prev.dataset.key] = {
      scrollTop: prev.scrollTop,
      follow: prev._follow !== false,
    };
  }
  // an inactive project has no nav tab / workbench view — fall back to overview
  const isProj = state.projects[v] && state.projects[v].status !== 'inactive';
  ui.view = (v === 'ov' || v === 'cats' || v === 'manage' || v === 'about' || v === 'settings' || isProj) ? v : 'ov';
  renderAll();
  window.scrollTo(0, 0);
}

/* ───────────────────────── nav ───────────────────────── */

function renderNav() {
  // top-left brand = the configured user name (neutral placeholder until setup)
  const brand = document.getElementById('brandName');
  if (brand) brand.textContent = state.user?.name || 'Central Planner';
  const host = document.getElementById('navProjects');
  if (!host) return;
  host.innerHTML = projKeys().map(k => {
    const ts = tasksOf(k);
    const running = ts.some(t => t.status === 'running');
    const waiting = ts.filter(t => t.status === 'waiting').length;
    const dot = running ? 'run' : waiting ? 'wait' : 'off';
    return `<div class="tab ${ui.view === k ? 'on' : ''}" data-v="${esc(k)}">
      <span class="dot ${dot}"></span>${esc(state.projects[k]?.name || k)}${state.projects[k]?.status === 'trial' ? '<span class="trialTag">trial</span>' : ''}
      ${waiting ? `<span class="badge">${waiting}</span>` : ''}</div>`;
  }).join('');
  host.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => go(el.dataset.v)));
  // descendant selector: project tabs live inside #navProjects, cats inside .right
  document.querySelectorAll('#nav .tab[data-v]').forEach(t => t.classList.toggle('on', t.dataset.v === ui.view));
  const chip = document.getElementById('navWeek');
  if (chip && state.ledger?.totals) {
    chip.innerHTML = SHOW_HOURS
      ? `wk <b>${hrs(state.ledger.totals.seconds)}h</b> · <b class="y">${fmtTok(state.ledger.totals.tokens)} tok</b>`
      : `wk <b class="y">${fmtTok(state.ledger.totals.tokens)} tok</b>`;
  }
}

/* ───────────────────────── overview ───────────────────────── */

function renderOverview() {
  const bento = document.getElementById('bento');
  if (!bento) return;
  const lw = state.ledger;

  // sessions cell — running/waiting tasks across projects
  const live = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => {
    if (!t.archived && (t.status === 'running' || t.status === 'waiting')) live.push({ k, t });
  }));
  const avCls = ['g', 'b', 'p', 'y'];
  const sessionsHtml = live.length ? live.map(({ k, t }, i) => {
    const wait = t.status === 'waiting';
    const per = lw?.perProject?.[k];
    const tok = per ? fmtTok((per.tokensIn || 0) + (per.tokensOut || 0)) : '0';
    const sub = wait
      ? esc(t.question ? 'asked: ' + t.question : 'turn finished — waiting for you')
      : `<span class="claudeVerb">${claudeVerb()}…</span> · turn ${t.session?.turns ?? 1}`;
    return `<div class="agentCard" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <div class="av ${wait ? 'y' : avCls[i % 4]}">${wait ? '?' : '⚙'}</div>
      <div><div class="nm">${esc(state.projects[k]?.name || k)} · ${esc(t.title)}</div>
      <div class="st">${sub}</div></div>
      <div class="tm ${wait ? 'y' : ''}">${wait ? '⏸ needs you' : '● running'}<small>${tok} tok this wk</small></div>
    </div>`;
  }).join('') : `<div class="sideNote" style="padding:16px 4px;">no active sessions — open a project and launch a queued task</div>`;

  // up next — queued + waiting + manual, waiting pinned
  const order = { waiting: 0, queued: 1, manual: 2 };
  const prio = { high: 0, medium: 1, low: 2 };
  const next = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => { if (!t.archived && t.status in order) next.push({ k, t }); }));
  next.sort((a, b) =>
    (order[a.t.status] - order[b.t.status]) ||
    ((prio[a.t.priority] ?? 1) - (prio[b.t.priority] ?? 1)));
  const nextHtml = next.slice(0, 9).map(({ k, t }) => {
    const wait = t.status === 'waiting';
    const pr = wait ? 'ask' : t.priority === 'high' ? 'hi' : t.priority === 'low' ? 'lo' : 'md';
    return `<div class="taskRow ${wait ? 'ask' : ''}" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <span class="pr ${pr}"></span>
      <span class="lbl">${wait ? '<b>Answer:</b> ' : ''}${esc(t.title)}</span>
      <span class="ovs ${esc(t.oversight)}">${OVS_LABEL[t.oversight] || ''}</span>
      <span class="proj">${esc(state.projects[k]?.name || k)}</span></div>`;
  }).join('') || `<div class="sideNote" style="padding:14px 4px;">queue is empty — ＋ ADD TASK to create one</div>`;

  // week ring: outer = hours logged vs target, inner = how much of the week
  // has elapsed (the pace to compare against)
  const secs = lw?.totals?.seconds || 0;
  const tokens = lw?.totals?.tokens || 0;
  const hourTarget = lw?.hourTarget || 35;
  const weekFrac = lw?.since
    ? Math.min(1, (Date.now() - Date.parse(lw.since)) / (7 * 86400000)) : 0;
  const C1 = 2 * Math.PI * 42, C2 = 2 * Math.PI * 30;
  const o1 = C1 * (1 - Math.min(1, secs / 3600 / hourTarget));
  const o2 = C2 * (1 - weekFrac);
  const pct = Math.round(100 * Math.min(1, secs / 3600 / hourTarget));
  const wkPct = Math.round(weekFrac * 100);
  // with hours off, the ring shows week-elapsed and the figure shows Claude tokens
  const ringMainOffset = SHOW_HOURS ? o1 : C1 * (1 - weekFrac);
  const ringInner = SHOW_HOURS
    ? `<circle class="bg" cx="50" cy="50" r="30" style="stroke-width:7"/>
       <circle class="fg2" cx="50" cy="50" r="30" style="stroke-width:7;stroke-dasharray:${C2.toFixed(1)};stroke-dashoffset:${o2.toFixed(1)}"/>`
    : '';
  const ringNumHtml = SHOW_HOURS
    ? `${hrs(secs)}h<small>of ${hourTarget}h · ${pct}%</small>`
    : `${fmtTok(tokens)}<small>claude tok · wk ${wkPct}%</small>`;
  const ringSplitHtml = SHOW_HOURS
    ? `<i style="background:var(--green)"></i>you — ${hrs(secs)}h logged<br>
       <i style="background:var(--purple)"></i>week — ${wkPct}% elapsed<br>
       <span style="color:var(--dim)">claude — ${fmtTok(tokens)} tok</span>`
    : `<i style="background:var(--green)"></i>week — ${wkPct}% elapsed<br>
       <span style="color:var(--dim)">claude — ${fmtTok(tokens)} tok</span>`;

  // weekly ledger table (the Σ you hours column is gated behind SHOW_HOURS)
  const lgRows = projKeys().map(k => {
    const e = lw?.perProject?.[k];
    if (!e) return '';
    const col = state.projects[k]?.color || '#888';
    return `<tr data-go="${esc(k)}" style="cursor:pointer;">
      <td class="pn"><i style="background:${esc(col)}"></i>${esc(state.projects[k]?.name || k)}</td>
      ${SHOW_HOURS ? `<td class="sumh">${hrs(e.seconds)}h</td>` : ''}
      <td class="sumt">${fmtTok((e.tokensIn || 0) + (e.tokensOut || 0))}</td></tr>`;
  }).join('');
  const ledgerHtml = lgRows
    ? `<table class="ledger">
        <tr><th>project</th>${SHOW_HOURS ? '<th>Σ you</th>' : ''}<th>Σ claude tok</th></tr>
        ${lgRows}
        <tr class="tot"><td class="pn">Σ week</td>
          ${SHOW_HOURS ? `<td class="sumh">${hrs(secs)}h</td>` : ''}
          <td class="sumt">${fmtTok(tokens)}</td></tr>
      </table>
      <div class="lgNote">${SHOW_HOURS
        ? `Hours <b>${hrs(secs)}h of ${hourTarget}h</b> weekly target · claude <b>${fmtTok(tokens)} tok</b> alongside.`
        : `Claude <b>${fmtTok(tokens)} tok</b> this week.`}</div>`
    : `<div class="sideNote" style="padding:14px 4px;">${SHOW_HOURS
        ? 'nothing logged this week yet — hours accrue while a project workbench is focused'
        : 'no Claude activity logged this week yet'}</div>`;

  // live deck (first pdf watch)
  const pdfKey = Object.keys(state.pdf || {}).find(k => state.pdf[k]);
  const pe = pdfKey ? state.pdf[pdfKey] : null;
  const deckHtml = pe
    ? `<div class="pdfGlass" data-go="${esc(pdfKey)}" data-viewer="pdf">
        <div class="live"><i></i>${pe.state === 'building' ? 'BUILDING' : 'LIVE'}</div>
        <div style="font-size:17px;font-weight:600;">${esc(state.projects[pdfKey]?.name || pdfKey)}</div>
        <div>${esc(pe.tex || '')}</div>
        ${pe.pages ? `<div style="font-size:10px;color:#888;margin-top:6px;">— ${esc(pe.pages)} pages —</div>` : ''}
      </div>
      <div class="pdfFoot"><span>${esc(pe.tex || '')}</span>
        <span>${pe.state === 'building' ? '⟳ building…' : pe.state === 'error' ? '✗ build error' : `built${pe.lastBuildMs ? ' in ' + (pe.lastBuildMs / 1000).toFixed(1) + 's' : ''} ✓`}</span></div>`
    : `<div class="pdfGlass" style="cursor:default;color:#888;">
        <div style="font-size:13px;">no live deck</div>
        <div style="font-size:10.5px;margin-top:4px;">watch a .tex from a project's show panel →</div>
      </div><div class="pdfFoot"><span>latexmk -pvc</span><span>idle</span></div>`;

  // recent tasks strip — every status, closed/archived included, newest activity first
  const recent = [];
  projKeys().forEach(k => tasksOf(k).forEach(t => {
    recent.push({ k, t, ts: Date.parse(t.session?.lastTurnAt || t.created || '') || 0 });
  }));
  recent.sort((a, b) => b.ts - a.ts);
  const TSTAT = { running: ['●', 'run'], waiting: ['⏸', 'wait'], queued: ['◌', 'q'], manual: ['✎', 'man'], done: ['✓', 'done'] };
  const stripHtml = recent.slice(0, 16).map(({ k, t, ts }) => {
    const [ic, cls] = t.archived ? ['▣', 'arch'] : (TSTAT[t.status] || ['·', 'man']);
    return `<div class="thumb taskThumb" data-go="${esc(k)}" data-tid="${esc(t.id)}">
      <b>${esc(t.title)}</b>
      <span class="pj">${esc(state.projects[k]?.name || k)}${ts ? ' · ' + esc(fmtWhen(ts)) : ''}</span>
      <span class="tstat ${cls}">${ic} ${t.archived ? 'archived' : esc(t.status)}</span>
    </div>`;
  }).join('')
    || `<div class="sideNote" style="padding:10px 4px;">no tasks yet — ＋ ADD TASK to create one</div>`;

  bento.innerHTML = `
    <div class="cell c-sessions">
      <div class="ch">Claude sessions <span class="anno">click → workbench</span></div>
      <div class="cellScroll">${sessionsHtml}</div>
    </div>
    <div class="cell c-next">
      <div class="ch">Up next <span class="anno">needs-you pinned</span></div>
      ${nextHtml}
      <div class="taskFoot">tasks persist in <code>projectManager/tasks/&lt;project&gt;.json</code></div>
    </div>
    <div class="cell c-ring">
      <div class="ch">Week ${isoWeek(new Date())}</div>
      <div class="ringWrap">
        <svg class="ring" viewBox="0 0 100 100">
          <circle class="bg" cx="50" cy="50" r="42"/>
          <circle class="fg" cx="50" cy="50" r="42" style="stroke-dasharray:${C1.toFixed(1)};stroke-dashoffset:${ringMainOffset.toFixed(1)}"/>
          ${ringInner}
        </svg>
        <div class="ringNum">${ringNumHtml}</div>
      </div>
      <div class="ringSplit">${ringSplitHtml}</div>
    </div>
    <div class="cell c-ledger">
      <div class="ch">Weekly ledger <span class="anno">${SHOW_HOURS ? 'your hours + claude tokens' : 'claude tokens'}</span></div>
      ${ledgerHtml}
    </div>
    <div class="cell c-pdf">
      <div class="ch">Live deck <span class="anno">recompiles on .tex save</span></div>
      ${deckHtml}
    </div>
    <div class="cell c-gallery">
      <div class="ch">Recent tasks <span class="anno">closed + archived included, newest first · click → task</span></div>
      <div class="thumbStrip">${stripHtml}</div>
    </div>`;

  bento.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
    const k = el.dataset.go;
    if (el.dataset.tid) {
      perOf(k).taskId = el.dataset.tid;
      perOf(k).fileTab = null; // a stale numeric index would open an arbitrary file of the new task
    }
    if (el.dataset.viewer) perOf(k).viewerKey = el.dataset.viewer;
    go(k);
  }));
}

/* closed show-panel tabs — UI-only, persisted per project like closed file tabs */
function getClosedViewers(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(`closedViewers:${key}`) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
function persistClosedViewers(key, set) {
  localStorage.setItem(`closedViewers:${key}`, JSON.stringify([...set]));
}
/* explicitly opening a viewer brings it back from closed */
function selectViewer(key, vk) {
  perOf(key).viewerKey = vk;
  const closed = getClosedViewers(key);
  if (closed.delete(String(vk))) persistClosedViewers(key, closed);
}

/* displays added by hand via the ＋ tab — persisted per project, so they stay
   in the strip even when they fall out of the recent-artifacts window */
function getAddedViewers(key) {
  try {
    const arr = JSON.parse(localStorage.getItem(`addedViewers:${key}`) || '[]');
    return Array.isArray(arr) ? arr.filter(v => v && v.rel) : [];
  } catch { return []; }
}
function persistAddedViewers(key, arr) {
  localStorage.setItem(`addedViewers:${key}`, JSON.stringify(arr));
}

/* ＋ tab: pick a display for the show panel. .tex → live latexmk watch;
   .html/.pdf → display tab. Both then refresh themselves: the artifact
   watcher broadcasts on save and the panel re-renders. */
async function addDisplay(key) {
  let rel = null;
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    const r = await api('POST', '/api/pickfile', {
      project: key,
      types: ['tex', 'pdf', 'html', 'htm'],
      prompt: 'Show in {name} — .tex live-compiles, .html/.pdf display',
    });
    if (!r || r.canceled) return;
    rel = r.rel;
  } else {
    // remote: the native dialog would open on the server's screen
    rel = prompt(`Path to a .tex / .html / .pdf in ${state.projects[key]?.name || key} (relative to project root):`, '');
    if (!rel || !rel.trim()) return;
    rel = rel.trim();
  }
  const ext = rel.split('.').pop().toLowerCase();
  if (ext === 'tex') {
    const r = await api('POST', '/api/pdf/watch', { project: key, tex: rel });
    if (r && !r.error) {
      if (!state.pdf[key]) state.pdf[key] = { tex: rel, pdf: null, state: 'building' };
      selectViewer(key, 'pdf');
      toast(`watching ${rel} — recompiles and refreshes on every save`);
      renderWB(key);
    } else if (r && r.error) toast(r.error);
  } else if (ext === 'pdf' || ext === 'html' || ext === 'htm') {
    const arr = getAddedViewers(key);
    if (!arr.some(v => v.rel === rel)) {
      arr.push({ rel, kind: ext === 'pdf' ? 'pdfart' : 'html' });
      persistAddedViewers(key, arr);
    }
    selectViewer(key, rel);
    renderWB(key);
  } else {
    toast(`the show panel displays .html and .pdf (or .tex to live-compile) — got .${ext}`);
  }
}

/* ───────────────────────── workbench ───────────────────────── */

function sideChainHtml(key, task) {
  const ups = Array.isArray(task.upstream) ? task.upstream : [];
  // the FULL chain: transitive ancestors above, descendants below. CSS caps the
  // box at ~2 nodes — scroll up for history, down for follow-ups. Levels walk
  // the upstream DAG breadth-first; the seen-set collapses cycles and diamonds.
  const seen = new Set([task.id]);
  const upLevels = [];
  let frontier = ups.filter(id => !seen.has(id));
  while (frontier.length) {
    frontier.forEach(id => seen.add(id));
    upLevels.unshift(frontier);
    frontier = frontier
      .flatMap(id => { const r = resolveId(id); return r && Array.isArray(r.t.upstream) ? r.t.upstream : []; })
      .filter((id, i, a) => !seen.has(id) && a.indexOf(id) === i);
  }
  const downLevels = [];
  let wave = [task.id];
  while (wave.length) {
    const kids = [];
    allProjKeys().forEach(k2 => tasksOf(k2).forEach(t => {
      if (!seen.has(t.id) && Array.isArray(t.upstream) && t.upstream.some(u => wave.includes(u))) {
        seen.add(t.id);
        kids.push(t.id);
      }
    }));
    if (!kids.length) break;
    downLevels.push(kids);
    wave = kids;
  }
  if (!upLevels.length && !downLevels.length) {
    return `<div class="sideNote">no lineage — ＋ links an upstream task whose handoff feeds this one</div>`;
  }
  const node = (id) => {
    const r = resolveId(id);
    const dot = r ? statusDot(r.t.status) : 'man';
    const title = r ? r.t.title : id;
    // ✕ on direct parents (this task's own links) and direct children (the
    // link lives on the child's upstream — the handler patches that task)
    const isChild = r && Array.isArray(r.t.upstream) && r.t.upstream.includes(task.id);
    const x = ups.includes(id) ? `<span class="schX" data-ux="${esc(id)}" title="unlink this parent task">✕</span>`
      : isChild ? `<span class="schX" data-dx="${esc(id)}" title="unlink this child task">✕</span>` : '';
    return `<div class="schNode" ${r ? `data-lk="${esc(r.k)}" data-lid="${esc(r.t.id)}"` : ''}>
      <span class="tdot ${dot}"></span>${esc(title)}${r && r.t.status === 'done' ? ' ✓' : ''}${x}</div>`;
  };
  const parts = [
    ...upLevels.map(ids => ids.map(node).join('')),
    `<div class="schNode cur"><span class="tdot ${statusDot(task.status)}"></span>${esc(task.title)}</div>`,
    ...downLevels.map(ids => ids.map(node).join('')),
  ];
  return `<div class="sideChain" data-tid="${esc(task.id)}">${parts.join('<div class="schArr">↓ handoff</div>')}</div>`;
}

const RUNNABLE_EXTS = ['jl', 'py', 'r', 'sh', 'tex'];

/* claude-code-style activity verbs while a turn runs */
const CLAUDE_VERBS = ['Pondering', 'Forging', 'Brewing', 'Scheming', 'Conjuring', 'Deriving',
  'Sleuthing', 'Wrangling', 'Distilling', 'Percolating', 'Crunching', 'Untangling', 'Marinating',
  'Hatching', 'Simmering', 'Cogitating', 'Noodling', 'Riffing', 'Whirring', 'Musing'];
const claudeVerb = () => CLAUDE_VERBS[Math.floor(Math.random() * CLAUDE_VERBS.length)];
setInterval(() => {
  const els = document.querySelectorAll('.claudeVerb');
  if (!els.length) return;
  const v = claudeVerb() + '…';
  els.forEach(el => { el.textContent = v; });
}, 3500);

/* session model choices — null id = Claude Code's configured default */
const MODELS = [
  { id: null, label: 'default' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

/* ── console rendering: markdown + LaTeX, web-claude style ──
   The stream buffer is parsed into typed segments (you / thinking / answer /
   tool / result / meta). Earlier segments are immutable, so updates only
   re-render the LAST segment — that's what makes streaming text smooth. */

function md(text) {
  // protect math from the markdown parser ($x_t$ underscores etc.), then
  // parse, sanitize, and restore the math for KaTeX to typeset
  const stash = [];
  // private-use-area sentinels — effectively impossible in real prose, unlike
  // a literal '@@MATH0@@' which Claude could legitimately write
  const SL = '', SR = '';
  const protectedText = String(text).replace(
    /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^\n$]+\$)/g,
    (m) => { stash.push(m); return `${SL}${stash.length - 1}${SR}`; });
  let html = null;
  try {
    if (window.marked && window.DOMPurify) {
      html = DOMPurify.sanitize(marked.parse(protectedText, { breaks: true, mangle: false, headerIds: false }));
    }
  } catch { /* fall back to plain */ }
  if (html == null) html = esc(protectedText).replace(/\n/g, '<br>');
  return html.replace(new RegExp(`${SL}(\\d+)${SR}`, 'g'), (_, i) => esc(stash[+i] ?? ''));
}

function katexEl(el) {
  try {
    if (window.renderMathInElement) {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        ignoredTags: ['pre', 'code', 'script', 'style', 'textarea'],
      });
    }
  } catch { /* partial math mid-stream — renders once complete */ }
}

function parseConsole(buf) {
  const segs = [];
  let cur = null;
  let inFence = false; // marker-lookalikes inside ``` blocks are CONTENT
  const start = (type) => { cur = { type, text: '' }; segs.push(cur); };
  const solo = (type, text) => { segs.push({ type, text }); cur = null; };
  const content = (line) => {
    if (!cur) { if (!line.trim() && !inFence) return; start('ans'); }
    cur.text += (cur.text ? '\n' : '') + line;
  };
  for (const line of String(buf).split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; content(line); continue; }
    if (inFence) { content(line); continue; }
    if (/^▸ you ─+$/.test(line)) { start('you'); continue; }
    if (/^▸ claude ─+$/.test(line)) { start('ans'); continue; }
    if (line === '∴ thinking…') { start('think'); continue; }
    if (line === '— answer —') { start('ans'); continue; }
    if (line.startsWith('⟐ ')) { solo('meta', line.slice(2)); continue; }
    if (/^↳? ?\[tool: /.test(line)) { solo('tool', line); continue; }
    if (/^↳? ?\[(result|✗ error)\] /.test(line)) { solo(line.includes('[✗ error]') ? 'err' : 'res', line.replace(/^↳? ?\[(result|✗ error)\] /, '')); continue; }
    if (line.startsWith('⏳ approval')) { solo('appr', line); continue; }
    if (/^— turn /.test(line)) { solo('turn', line.replace(/^— /, '').replace(/ —$/, '')); continue; }
    content(line);
  }
  return segs.filter(s => s.text.trim() !== '' || s.type === 'turn');
}

function consoleSegHtml(s) {
  switch (s.type) {
    case 'you': return `<div class="csTag csYou">you</div><div class="csMd">${md(s.text)}</div>`;
    case 'think': return `<div class="csTag">∴ thinking</div><div class="csMd csThink">${md(s.text)}</div>`;
    case 'ans': return `<div class="csMd">${md(s.text)}</div>`;
    case 'tool': return esc(s.text);
    case 'res': return `<span class="csResTag">↩</span> ${esc(s.text)}`;
    case 'err': return `<span class="csErrTag">✗</span> ${esc(s.text)}`;
    case 'appr': return esc(s.text);
    case 'meta': return `⟐ ${esc(s.text)}`;
    case 'turn': return esc(s.text);
    default: return esc(s.text);
  }
}

/* the actively-streaming segment, rendered as PLAIN escaped text — no markdown,
   no KaTeX. pre-wrap CSS (.csRaw) preserves newlines, so growth is append-only
   and nothing above it reflows or re-typesets. It settles into consoleSegHtml()
   the instant it's no longer the tail (a new segment starts) or the turn ends. */
function consoleSegRaw(s) {
  const tag = s.type === 'think' ? '<div class="csTag">∴ thinking</div>' : '';
  const cls = s.type === 'think' ? 'csMd csThink csRaw' : 'csMd csRaw';
  return `${tag}<div class="${cls}">${esc(s.text)}</div>`;
}

function updateConsole(box, k, upto, final = true) {
  // follow-the-stream is an explicit intent bit (box._follow), maintained by
  // the user-scroll listener in wireWB. Height-based "near the bottom" guesses
  // fail when the scrollback is shorter than the threshold: every position —
  // including the top — measures as near-bottom, and streaming drags a reader
  // who scrolled up to re-read.
  const stick = box._follow !== false;
  const full = tailBufs[k] || '';
  if (upto == null) upto = full.length;
  let wrap = box.querySelector(':scope > .csegWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'csegWrap';
    box.appendChild(wrap);
  }
  const segs = parseConsole(full.slice(0, upto));
  // the tail renders raw only while the turn is live; once it stops running the
  // last segment settles into formatted markdown + KaTeX (one paint). Opening a
  // finished task's console has running=false, so it's fully formatted at once.
  const [project, taskId] = k.split('/');
  const t = (state.tasks[project] || []).find(x => x && x.id === taskId);
  const running = !!(t && t.status === 'running');
  if (!segs.length) {
    wrap.innerHTML = '<div class="csEmpty">— the conversation streams here: thinking, tools, results, answers —</div>';
    wrap._n = 0;
  } else {
    if (wrap._n === 0 && wrap.firstChild) wrap.innerHTML = ''; // the empty-state note
    // Streaming legitimately re-segments the tail (a fence opener swallows
    // later lines; a growing last line turns into a marker): find the first
    // segment that differs from the DOM and refresh from there — never wipe
    // the whole console, which flashes, drops scroll anchoring, and forces a
    // full re-typeset
    const lastIdx = segs.length - 1;
    const isStream = (type) => type === 'think' || type === 'ans';
    // raw = plain text (no markdown/KaTeX): only the live tail of a running turn
    const rawAt = (j) => running && j === lastIdx && isStream(segs[j].type);
    const kids = wrap.children;
    const fresh = (el, j) => el
      && el._txt === segs[j].text
      && el.className === `cseg cs-${segs[j].type}`
      && el._raw === rawAt(j);
    let first = 0;
    while (first < Math.min(kids.length, segs.length) && fresh(kids[first], first)) first++;
    while (wrap.children.length > segs.length) wrap.lastElementChild.remove();
    for (let j = first; j < segs.length; j++) {
      let el = wrap.children[j];
      if (el && fresh(el, j)) continue;
      if (!el) { el = document.createElement('div'); wrap.appendChild(el); }
      const seg = segs[j];
      const raw = rawAt(j);
      const cls = `cseg cs-${seg.type}`;
      if (raw) {
        // already streaming raw → grow the text node only (true append, no
        // wrapper rebuild); otherwise lay out the raw shell once
        const body = el._raw && el.className === cls ? el.querySelector(':scope > .csRaw') : null;
        if (body) body.textContent = seg.text;
        else { el.className = cls; el.innerHTML = consoleSegRaw(seg); }
        el._kx = false;
      } else {
        el.className = cls;
        el.innerHTML = consoleSegHtml(seg);
        el._kx = false;
        if (['you', 'think', 'ans'].includes(seg.type)) { katexEl(el); el._kx = true; }
      }
      el._txt = seg.text;
      el._raw = raw;
    }
    wrap._n = segs.length;
  }

  // live approval card rides at the end of the stream — part of the console,
  // not the buffer
  const perm = (pendingPerms[k] || [])[0];
  let card = box.querySelector(':scope > .permCard');
  if (perm) {
    if (!card || card._reqId !== perm.requestId) {
      if (card) card.remove();
      card = document.createElement('div');
      card.className = 'permCard csPerm';
      card._reqId = perm.requestId;
      card.innerHTML = permCardInner(perm);
      box.appendChild(card);
      wirePermCard(card, project, taskId, perm);
    }
  } else if (card) {
    card.remove();
  }

  // live activity verb at the stream's end — only while a turn truly runs
  const interrupting = running && perOf(project).interrupting === taskId;
  let verbEl = box.querySelector(':scope > .csVerb');
  if (running) {
    if (!verbEl) {
      verbEl = document.createElement('div');
      verbEl.className = 'csVerb';
      box.appendChild(verbEl);
    } else if (verbEl !== box.lastElementChild) {
      box.appendChild(verbEl); // keep it below new segments
    }
    const want = interrupting ? 'int' : 'run';
    if (verbEl._st !== want) {
      verbEl._st = want;
      verbEl.innerHTML = interrupting
        ? '<span class="live" style="background:var(--yellow)"></span> interrupting…'
        : `<span class="live"></span> <span class="claudeVerb">${claudeVerb()}…</span>`;
    }
  } else if (verbEl) {
    verbEl.remove();
  }
  // first paint lands at the bottom; afterwards follow the stream unless the
  // user scrolled away — scrolling back mustn't be fought
  if (stick) {
    const before = box.scrollTop;
    box.scrollTop = box.scrollHeight; // setter clamps to the real maximum
    // our own write fires one scroll event — flag it so the wireWB listener
    // doesn't mistake it for the user scrolling
    if (box.scrollTop !== before) box._prog = (box._prog || 0) + 1;
  }
}

/* smooth sequential reveal: incoming chunks land in tailBufs instantly, but
   the console advances a cursor toward the target each animation frame, so
   text flows in steadily instead of appearing in blocks */
const shownLen = {};   // k → characters revealed so far
const pumps = {};      // k → pending rAF id
const consoleView = {}; // `${project}/${id}` → { scrollTop, follow } — console scroll kept across task switches
function pumpConsole(project, k) {
  pumps[k] = 0;
  const target = (tailBufs[k] || '').length;
  const box = document.querySelector(`#v-${project} #consoleBox`);
  if (!box || box.dataset.key !== k) { shownLen[k] = target; return; } // console not open — no replay later
  if (shownLen[k] == null || shownLen[k] > target) shownLen[k] = target;
  if (shownLen[k] < target) {
    const gap = target - shownLen[k];
    shownLen[k] = Math.min(target, shownLen[k] + Math.max(3, Math.ceil(gap / 16)));
    updateConsole(box, k, shownLen[k], shownLen[k] === target);
    pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
  } else {
    updateConsole(box, k, target, true);
  }
}

/* ── permission approvals — diff + rendered preview before approving ── */

async function fetchCurrent(key, fileish) {
  const rel = relOf(key, String(fileish || ''));
  if (!rel) return null; // outside the project root — can't read it
  try {
    const r = await fetch(artifactUrl(key, rel));
    if (r.status === 404) return ''; // new file — proposal creates it
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/* apply the proposed Write/Edit/MultiEdit to `current` without executing it */
function proposedContent(perm, current) {
  const inp = perm.input || {};
  if (perm.tool === 'Write') return String(inp.content ?? '');
  if (current == null) return null;
  if (perm.tool === 'Edit') {
    const old = String(inp.old_string ?? ''), nw = String(inp.new_string ?? '');
    return inp.replace_all ? current.split(old).join(nw) : current.replace(old, nw);
  }
  if (perm.tool === 'MultiEdit' && Array.isArray(inp.edits)) {
    let txt = current;
    for (const e of inp.edits) {
      const old = String(e.old_string ?? ''), nw = String(e.new_string ?? '');
      txt = e.replace_all ? txt.split(old).join(nw) : txt.replace(old, nw);
    }
    return txt;
  }
  return null;
}

/* proposal previews render INSIDE the show panel as a closable tab —
   never a full-screen takeover */
const proposalPreview = {}; // project → { html, title }

function showProposalInPanel(key, html, title) {
  proposalPreview[key] = { html, title };
  perOf(key).viewerKey = '__proposal';
  renderWB(key);
}

function closeProposal(key) {
  delete proposalPreview[key];
  if (perOf(key).viewerKey === '__proposal') perOf(key).viewerKey = null;
  renderWB(key);
}

const PERM_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function permCardInner(perm) {
  const inp = perm.input || {};
  const fileish = inp.file_path || inp.notebook_path || inp.path || null;
  const isEdit = PERM_EDIT_TOOLS.includes(perm.tool);
  const isHtml = fileish && /\.html?$/i.test(String(fileish));
  const detail = perm.tool === 'Bash'
    ? `<pre class="permCmd">${esc(String(inp.command || ''))}</pre>`
    : fileish ? `<div class="permFile">${esc(String(fileish))}</div>` : '';
  return `
    <div class="ph">⏳ approval needed — <b>${esc(perm.tool)}</b>${inp.description ? ' · ' + esc(String(inp.description).slice(0, 120)) : ''}</div>
    ${detail}
    <div class="permBtns">
      ${isEdit ? `<button class="pbtn permDiff">± diff</button>` : ''}
      ${isEdit && isHtml ? `<button class="pbtn permPrev">⌗ rendered preview</button>` : ''}
      <span style="flex:1"></span>
      <button class="pbtn deny permDeny">✗ deny</button>
      <button class="pbtn allow permAllow">✓ approve</button>
    </div>
    <div class="permDiffBox"></div>`;
}

function wirePermCard(card, project, taskId, perm) {
  const resolveIt = (allow) => {
    // one decision per request — double-clicks were 404ing the second resolve
    card.querySelectorAll('.permAllow, .permDeny').forEach(b => { b.disabled = true; });
    return api('POST', `/api/tasks/${enc(project)}/${enc(taskId)}/permission`, { requestId: perm.requestId, allow });
  };
  card.querySelector('.permAllow')?.addEventListener('click', () => resolveIt(true));
  card.querySelector('.permDeny')?.addEventListener('click', () => resolveIt(false));
  card.querySelector('.permDiff')?.addEventListener('click', async () => {
    const box = card.querySelector('.permDiffBox');
    if (!box) return;
    if (box.innerHTML) { box.innerHTML = ''; return; } // toggle off
    box.innerHTML = '<div class="sideNote">computing diff…</div>';
    const inp = perm.input || {};
    if (perm.tool === 'Edit') {
      box.innerHTML = diffHtml(String(inp.old_string ?? ''), String(inp.new_string ?? ''));
      return;
    }
    const current = await fetchCurrent(project, inp.file_path || inp.notebook_path || '');
    const proposed = proposedContent(perm, current);
    box.innerHTML = (current == null || proposed == null)
      ? '<div class="sideNote">cannot diff — file outside the project root or unsupported tool input</div>'
      : diffHtml(current, proposed);
  });
  card.querySelector('.permPrev')?.addEventListener('click', async () => {
    const inp = perm.input || {};
    const fileish = String(inp.file_path || '');
    const current = await fetchCurrent(project, fileish);
    const proposed = proposedContent(perm, current);
    if (proposed == null) { toast('cannot preview this proposal'); return; }
    showProposalInPanel(project, proposed, 'proposed · ' + (fileish.split('/').pop() || perm.tool));
  });
}

function modelSelHtml(task) {
  const cur = task.model || '';
  return `<select class="mdlSel" title="model for this task's session — applies from the next turn">
    ${MODELS.map(m => `<option value="${esc(m.id ?? '')}"${cur === (m.id ?? '') ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
  </select>`;
}

/* permission prompting, decoupled from oversight: the oversight appendix
   (e.g. cooperative back-and-forth) is injected every turn regardless */
const PERM_MODES = [
  { id: null, label: '🛡 by oversight' },
  { id: 'default', label: '🛡 ask first' },
  { id: 'acceptEdits', label: '🛡 auto-edits' },
  { id: 'auto', label: '🛡 auto (classifier)' },
  { id: 'bypassPermissions', label: '🛡 full auto' },
];

function permSelHtml(task) {
  const cur = task.permMode || '';
  if (task.oversight === 'propose') {
    // plan mode is what makes propose propose — no override offered
    return `<select class="mdlSel permSel" disabled title="propose tasks always run in plan mode — the permission override is disabled so plans can't silently execute">
      <option selected>🛡 plan (locked)</option></select>`;
  }
  return `<select class="mdlSel permSel" title="permission prompting — oversight behavior (coop/auto) is unaffected; applies from the next turn">
    ${PERM_MODES.map(m => `<option value="${esc(m.id ?? '')}"${cur === (m.id ?? '') ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
  </select>`;
}

async function setTaskPerm(key, task, permMode) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  local.permMode = permMode;
  renderWB(key);
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { permMode });
  toast(permMode === 'bypassPermissions' ? 'next turn runs fully unattended — rewind is your safety net'
    : permMode === 'auto' ? 'next turn: a classifier approves routine calls, only dangerous ones ask'
    : permMode === 'acceptEdits' ? 'next turn auto-accepts file edits (bash still asks)'
    : permMode === 'default' ? 'next turn asks before tool use'
    : 'next turn uses the oversight default');
}

async function setTaskModel(key, task, modelId) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  local.model = modelId; // optimistic; task:update broadcast confirms
  renderWB(key);
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { model: modelId });
  toast(modelId ? `next turn runs on ${MODELS.find(m => m.id === modelId)?.label || modelId}` : 'next turn uses the default model');
}

async function setTaskWebSearch(key, task, next) {
  const local = tasksOf(key).find(t => t.id === task.id) || task;
  const cur = local.context?.web_search || { enabled: false, sources: [] };
  const ws = { enabled: next, sources: cur.sources || [] }; // preserve sources — toggle is on/off only
  local.context = { ...(local.context || {}), web_search: ws }; // optimistic; task:update broadcast confirms
  renderWB(key);
  // ★ send the FULL merged context — updateTask shallow-merges, so a partial
  // { web_search } would wipe pinned files / notes / include flags
  await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { context: { ...local.context, web_search: ws } });
  toast('web search ' + (next ? 'on' : 'off') + ' — applies to the next message');
}

const SNAP_ICON = { modified: '±', created: '+', deleted: '−' };

function snapsHtml(key, task) {
  const sc = snapsCache[`${key}/${task.id}`];
  if (!sc || !sc.fetched) return `<pre><span class="cm">— loading change history… —</span></pre>`;
  if (!sc.entries.length) {
    return `<pre><span class="cm">— no recorded changes yet —
every session turn that edits files records a change-set here,
with highlighted diffs and one-click rewind —</span></pre>`;
  }
  const rows = sc.entries.map(e => {
    const when = new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const files = (e.files || []).map(f => `
      <div class="snapFile">
        <span class="snapSt ${esc(f.status)}">${SNAP_ICON[f.status] || '±'}</span>
        <span class="snapRel" title="${esc(f.rel)}">${esc(f.rel)}</span>
        <button class="snapBtn snapDiffBtn" data-eid="${esc(e.id)}" data-rel="${esc(f.rel)}">diff</button>
        <button class="snapBtn snapRevertBtn" data-eid="${esc(e.id)}" data-rel="${esc(f.rel)}" title="restore this file to before this change">⟲ rewind</button>
      </div>`).join('');
    return `<div class="snapEntry">
      <div class="snapHead">
        <span class="snapKind ${e.revertOf ? 'rew' : ''}">${e.revertOf ? '⟲ rewind' : 'Δ session edit'}</span>
        <span class="snapTime">${esc(when)}</span>
        <span class="snapCount">${e.files.length} file${e.files.length === 1 ? '' : 's'}</span>
        ${e.files.length > 1 ? `<button class="snapBtn snapRevertAll" data-eid="${esc(e.id)}" title="restore every file in this change-set">⟲ rewind all</button>` : ''}
      </div>${files}</div>`;
  }).join('');
  return `<div class="snapList">${rows}</div>`;
}

function runStatTxt(run) {
  if (!run) return '';
  if (run.state === 'running') return '⟳ running…';
  const secs = run.ms != null ? ` · ${(run.ms / 1000).toFixed(1)}s` : '';
  if (run.state === 'done') return `✓ exit 0${secs}`;
  if (run.state === 'stopped') return `⊘ stopped${secs}`;
  return `✗ exit ${run.exitCode ?? '?'}${secs}`;
}

function workSurface(key, task, files, fi) {
  const run = state.runs[key]; // run output itself lives in the session pane now
  const snapCount = snapsCache[`${key}/${task.id}`]?.entries?.length || 0;
  const closed = getClosed(key, task);
  const tabs = files.map((f, i) => {
    // closed → sidebar; pdfs → show panel; folders live in the sidebar browser
    if (closed.has(String(f)) || isPdfFile(f) || pinKindOf(f) === 'folder') return '';
    const kind = pinKindOf(f);
    const rel0 = relOf(key, f);
    const dirty = kind === 'code' && rel0 && drafts[`${key}::${rel0}`] != null;
    const icon = kind !== 'code' ? PIN_ICON[kind] + ' ' : '';
    return `<div class="ctab cd ${fi === i ? 'on' : ''}" data-fi="${i}" draggable="true" title="${esc(String(f))} — drag to reorder">${icon}${esc(pinLabelOf(f))}${dirty ? '<span class="dirtyDot">●</span>' : ''}<span class="tabX" data-xi="${i}" title="close tab — reopen from the sidebar">×</span></div>`;
  }).join('')
    + (perOf(key).openExtra || []).map((rel) => {
      const xid = 'x:' + rel;
      const dirty = drafts[`${key}::${rel}`] != null;
      return `<div class="ctab cd xtab ${fi === xid ? 'on' : ''}" data-fi="${esc(xid)}" title="${esc(rel)} — opened from the folder browser; not in the context packet">◇ ${esc(rel.split('/').pop())}${dirty ? '<span class="dirtyDot">●</span>' : ''}<span class="tabX" data-xi="${esc(xid)}" title="close tab">×</span></div>`;
    }).join('')
    + (snapCount ? `<div class="ctab cd ${fi === 'snaps' ? 'on' : ''}" data-fi="snaps" title="files this task's sessions changed — diffs + rewind">Δ ${snapCount}</div>` : '')
    + `<div class="ctab cd console ${fi === 'tail' ? 'on' : ''}" data-fi="tail" title="the session conversation — thinking, tools, results, answers">≋ console${(pendingPerms[`${key}/${task.id}`] || []).length ? ' <span class="permDot">⏳</span>' : ''}</div>`;
  let body, foot;
  if (fi === 'snaps') {
    body = snapsHtml(key, task);
    foot = `<div class="cfoot"><span>change history — what sessions edited, rewindable</span><span>${esc(task.id)}</span></div>`;
  } else if (fi === 'tail') {
    const tk = `${key}/${task.id}`;
    let buf = tailBufs[tk] || '';
    if (!buf) {
      // after a reload the live buffer is gone — seed from the saved
      // transcript so the console still shows the conversation so far
      const tr = transcripts[tk];
      if (tr?.entries?.length) {
        buf = tr.entries.map(e =>
          (e.role === 'user' ? '\n▸ you ─────────\n' : '\n▸ claude ──────\n') + e.text + '\n').join('');
        tailBufs[tk] = buf; // live chunks append after it coherently
      }
    }
    body = `<div class="consoleBox" id="consoleBox" data-key="${esc(tk)}"></div>`;
    foot = `<div class="cfoot"><span>≋ console — full session stream</span><span>${esc(task.id)}</span></div>`;
  } else {
    const xrel = extraRel(fi);
    const f = xrel ?? files[fi];
    // extras always take the plain file path (binary/data files come back as a
    // read-only notice from ensureFile's binary sniff)
    const pkKind = xrel != null ? 'code' : pinKindOf(f);
    if (pkKind === 'data' || pkKind === 'folder') {
      // cards, not contents — the same thing the session sees at launch
      const crel = relOf(key, String(f).replace(/\/+$/, ''));
      const cc = crel != null ? fileCache[`${key}::card::${crel}`] : { error: 'outside the project root' };
      const content = !cc || cc.loading
        ? `// generating ${pkKind === 'data' ? 'data card (schema · sample · scale)' : 'folder map'}…`
        : cc.error ? `// ${cc.error}` : cc.text;
      body = `<pre>${esc(content)}</pre>`;
      foot = `<div class="cfoot"><span>${esc(String(f))}</span><span>${pkKind === 'data'
        ? '▦ data card — injected at launch; content stays on disk'
        : '🗀 folder map — injected at launch'}</span></div>`;
      return `<div class="codeHalf codeFull"><div class="ctabs">${tabs}</div>${body}${foot}</div>`;
    }
    const rel = relOf(key, f);
    const fkey = rel ? `${key}::${rel}` : null;
    const c = fkey ? fileCache[fkey] : null;
    const ext = rel ? String(rel).split('.').pop().toLowerCase() : '';
    const runBit = rel && RUNNABLE_EXTS.includes(ext)
      ? (run?.state === 'running'
        ? `<button id="runFileBtn" class="stopBtn" data-rel="${esc(rel)}" data-running="1">⊘ stop run</button>`
        : `<button id="runFileBtn" class="runBtn" data-rel="${esc(rel)}">▶ run</button>`)
      : '';
    if (rel && c && !c.loading && !c.error && !c.truncated) {
      // editable: drafts hold unsaved text so re-renders never lose keystrokes
      const dirty = drafts[fkey] != null;
      const hlOn = !!hlFor(ext);
      const ta = `<textarea id="codeEditor" class="codeEdit${hlOn ? ' codeSrc' : ''}" data-fkey="${esc(fkey)}" data-rel="${esc(rel)}" data-ext="${esc(ext)}"
        spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off">${esc(dirty ? drafts[fkey] : c.text)}</textarea>`;
      // known language → syntax-color overlay: the textarea's text turns
      // transparent and an identically-metriced <pre> behind it carries the
      // colors (wired in wireWB); unknown ext → today's plain textarea
      body = hlOn
        ? `<div class="edWrap"><pre class="codeEdit codeHL" aria-hidden="true"><code id="codeHL"></code></pre>${ta}</div>`
        : ta;
      foot = `<div class="cfoot"><span>${esc(String(f))}</span>${runBit}
        <span id="saveState" class="${dirty ? 'dirty' : ''}">${dirty
          ? '● unsaved — ⌘S or <button id="saveFileBtn" class="saveBtn">save</button>'
          : 'editable — ⌘S saves'}</span></div>`;
    } else {
      let content;
      if (!rel) {
        content = `<span class="cm">// ${esc(String(f))}\n// outside the project root — cannot preview here</span>`;
      } else if (!c || c.loading) content = `<span class="cm">// loading ${esc(rel)}…</span>`;
      else if (c.error) content = `<span class="cm">// could not load ${esc(rel)} — ${esc(c.error)}</span>`;
      else content = (!c.binary && hlFor(ext) && hlText(c.text, ext)) || esc(c.text);
      body = `<pre>${content}</pre>`;
      foot = `<div class="cfoot"><span>${esc(String(f))}</span>${runBit}<span>${c?.truncated ? 'too large to edit here — read-only'
        : xrel != null ? '◇ unpinned — not in the launch context' : 'pinned context file'}</span></div>`;
    }
  }
  return `<div class="codeHalf codeFull"><div class="ctabs">${tabs}</div>${body}${foot}</div>`;
}

function handoffCard(t, proposed) {
  const h = t.handoff || {};
  const arts = Array.isArray(h.artifacts) ? h.artifacts : [];
  const nums = Array.isArray(h.numbers) ? h.numbers : [];
  const decs = Array.isArray(h.decisions) ? h.decisions : [];
  return `<div class="handoff">
    <div class="hh">${proposed
    ? '📋 proposed handoff — awaiting your accept'
    : '✓ complete — handoff record'} <span>stored in the task json · injected downstream</span></div>
    <div class="hsum">${esc(h.summary || '')}</div>
    ${arts.length ? `<div class="hsec">Files that matter</div>` + arts.map(a => {
      const [f, n] = Array.isArray(a) ? a : [a, ''];
      return `<div class="hfile"><code>${esc(f)}</code><span>${esc(n || '')}</span></div>`;
    }).join('') : ''}
    ${nums.length ? `<div class="hsec">Key numbers</div><div class="hnums">` + nums.map(p => {
      const [k2, v] = Array.isArray(p) ? p : [p, ''];
      return `<span class="qchip on">${esc(k2)}: <b>${esc(v)}</b></span>`;
    }).join('') + `</div>` : ''}
    ${decs.length ? `<div class="hsec">Decisions that matter later</div>` + decs.map(d => `<div class="hdec">· ${esc(d)}</div>`).join('') : ''}
    ${h.next ? `<div class="hsec">Note to downstream tasks</div><div class="hnext">${esc(h.next)}</div>` : ''}
  </div>`;
}

function launchCard(key, task) {
  const ctx = task.context || {};
  const chips = [];
  if (ctx.include_abstract) chips.push('✓ living abstract');
  if (ctx.include_last_session) chips.push('✓ last session');
  if (ctx.include_sibling_tasks) chips.push('✓ sibling tasks');
  if (ctx.include_category_primer) chips.push('✓ category primer');
  (Array.isArray(task.upstream) ? task.upstream : []).forEach(id => chips.push('⛓ handoff: ' + id));
  (Array.isArray(ctx.files) ? ctx.files : []).forEach(f => chips.push(String(f)));
  return `<div class="taskHero"><div class="queueCard">
    <div class="qt">${esc(task.title)}</div>
    <div class="qdesc">${esc(task.description || '')}</div>
    <div class="qmeta"><span class="ovs ${esc(task.oversight)}">${OVS_LABEL[task.oversight] || ''}</span>
      <span class="qchip" style="font-size:9.5px;padding:2px 9px;">${esc(task.category || '')}</span>
      queued — session not yet started</div>
    <div class="qsec">Context packet — assembled at launch</div>
    <div class="qchips">
      <span class="qchip ${ctx.web_search?.enabled ? 'on' : ''}" data-webtoggle style="cursor:pointer;" title="click to turn web search on/off — applies to the next message">🌐 web search${ctx.web_search?.enabled ? (ctx.web_search.sources?.length ? ' — ' + esc(ctx.web_search.sources.join(' · ')) : '') : ' off'}</span>
      ${chips.map(c =>
      `<span class="qchip ${/^[✓⛓]/u.test(c) ? 'on' : ''}">${esc(c)}</span>`).join('')}</div>
    ${ctx.notes ? `<div class="qsec">Your notes to Claude</div><div class="qnotes">${esc(ctx.notes)}</div>` : ''}
    <div class="qlaunch">
      <button id="launchBtn">▶ Launch session</button>
      <span class="alt">${modelSelHtml(task)} ${permSelHtml(task)} · oversight ${OVS_LABEL[task.oversight] || '?'}</span>
    </div>
  </div></div>`;
}

function manualCard(key, task) {
  return `<div class="taskHero"><div class="queueCard">
    <div class="qt">${esc(task.title)}</div>
    <div class="qdesc">${esc(task.description || '')}</div>
    <div class="qmeta"><span class="ovs manual">MAN</span> manual — no agent attached${task.due ? ` · due ${esc(task.due)}` : ''}</div>
    ${task.context?.notes ? `<div class="qnotes" style="margin-top:14px;">${esc(task.context.notes)}</div>` : ''}
    <div class="qlaunch">
      <button id="markDoneBtn" style="background:var(--glass);color:var(--ink);border:1px solid var(--ov2a);">✓ Mark done</button>
    </div>
  </div></div>`;
}

/* ▶ output — a tab of the session pane (bottom right) */
function runPaneHtml(key, run) {
  const buf = runBufs[key] || '';
  const segs = runSegs[key];
  const bufHtml = segs?.length
    ? segs.map(s => s.fd === 2 ? `<span class="errOut">${esc(s.text)}</span>` : esc(s.text)).join('')
    : esc(buf);
  return `<div class="runPane">
    <pre id="runPre" data-key="${esc(key)}">${buf ? bufHtml : '<span class="cm">— run output appears here —</span>'}</pre>
    <div class="runFoot"><span>${esc(run?.cmdLine || 'run output')}</span>
      ${run?.state === 'running' ? '<button id="stopRunBtn" class="stopBtn">⊘ stop</button>' : ''}
      <span class="runStat ${esc(run?.state || '')}">${runStatTxt(run)}</span></div>
  </div>`;
}

function sessionBody(key, task) {
  const st = task.status;
  if (st === 'queued') return launchCard(key, task);
  if (st === 'manual') return manualCard(key, task);

  // the entry pane: things that need YOU (questions, approvals, handoffs) plus
  // the composer — the conversation itself streams into the ≋ console tab
  const k = `${key}/${task.id}`;
  const parts = [];
  if (st === 'waiting' && task.handoff) {
    // Claude proposed completion — the user decides: accept, or push back below
    parts.push(`<div class="runHint" style="color:var(--green);border-color:rgb(from var(--green) r g b / 18%);background:rgb(from var(--green) r g b / 5%);align-items:center;">
      <span class="live"></span>Claude considers this task complete — review the handoff, then
      <button id="acceptDoneBtn" style="background:var(--green);color:var(--on-accent);border:none;border-radius:8px;
        padding:5px 14px;font-weight:800;font-size:11px;cursor:pointer;margin-left:6px;">✓ accept &amp; close</button>
      <span style="color:var(--dim);font-size:10.5px;">or reply below to keep working</span></div>`);
    parts.push(handoffCard(task, true));
  }
  if (st === 'done' && task.handoff) {
    parts.push(handoffCard(task));
  }
  if (st === 'running') {
    parts.push(perOf(key).interrupting === task.id
      ? `<div class="runHint" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);"><span class="live" style="background:var(--yellow)"></span>interrupting — finishing the current step…</div>`
      : `<div class="runHint"><span class="live"></span>Claude is working — follow along in the <b>≋ console</b> tab</div>`);
  }
  if (st === 'waiting' && task.question) {
    parts.push(`<div class="msg" style="max-width:100%;"><div class="who"><span class="live" style="background:var(--pink)"></span>claude · needs you</div>
      <div class="askBlock"><div class="q">${esc(task.question)}</div></div></div>`);
  }
  const perms = pendingPerms[k];
  if (perms && perms.length) {
    parts.push(`<div class="runHint" style="color:var(--yellow);border-color:rgb(from var(--yellow) r g b / 18%);background:rgb(from var(--yellow) r g b / 5%);">
      <span class="live" style="background:var(--yellow)"></span>
      ${perms.length} approval${perms.length > 1 ? 's' : ''} pending — review in the <b>≋ console</b> tab</div>`);
  }
  if (!parts.length) {
    parts.push(`<div class="sideNote">compose below — the conversation lives in the <b>≋ console</b> tab of the center pane</div>`);
  }
  const s = task.session;
  // web-search toggle only where another turn can run — not done/archived
  const webOn = task.context?.web_search?.enabled;
  const webChip = (st === 'done' || task.archived) ? ''
    : `<span class="webtog ${webOn ? 'on' : ''}" data-webtoggle title="click to turn web search on/off — applies to the next message">web ${webOn ? 'on' : 'off'}</span>`;
  const sessbar = `<div class="sessbar">
    <span>${modelSelHtml(task)}</span>
    <span>${permSelHtml(task)}</span>
    ${webChip}
    ${s
    ? `<span><b>${fmtTok((s.tokensIn || 0) + (s.tokensOut || 0))} tok</b> · ${s.turns || 0} turn${s.turns === 1 ? '' : 's'}</span>`
    : '<span>no session yet</span>'}
    <span>oversight <b>${OVS_LABEL[task.oversight] || ''}</b></span>
    <span>category <b>${esc(task.category || '')}</b></span></div>`;
  const foot = st === 'done'
    ? `<div class="closedbar">task complete · handoff recorded ✓</div>`
    : `<div class="composer">
        <textarea id="composerInput" rows="1"
          placeholder="Message Claude · ${esc(task.title)} — Enter sends, ⇧Enter for a new line">${esc(composerDrafts[k] || '')}</textarea>
        <span class="ctl" id="interruptBtn" title="interrupt active turn">⏹</span>
        <button class="send" id="sendBtn">Send</button>
      </div>${sessbar}`;
  return `<div class="chat"><div class="log" id="chatLog">${parts.join('')}</div>${foot}</div>`;
}

function viewerHtml(key, vsel, pdfEntry) {
  if (!vsel) {
    return `<div class="viewerTop"><div class="noCode inViewer"><div class="big">⌗</div>
      <div>no artifacts yet in <b>${esc(state.projects[key]?.name || key)}</b><br>
      html + pdf files appear here as sessions create them<br>
      <span style="font-size:11px;">or ⊕ watch a .tex for a live-compiled deck</span></div></div></div>`;
  }
  if (vsel.kind === 'pdf') {
    const src = pdfSrc(key);
    const e = pdfEntry || {};
    const stateTxt = e.state === 'building' ? '⟳ building…'
      : e.state === 'error' ? '✗ build error'
      : `built${e.lastBuildMs ? ' in ' + (e.lastBuildMs / 1000).toFixed(1) + 's' : ''} ✓`;
    return `<div class="viewerTop">
      ${src
        ? `<iframe id="pdfFrame" data-project="${esc(key)}" class="artFrame" src="${esc(src)}#navpanes=0&view=FitH&t=${enc(e.lastBuiltAt || '0')}" title="live pdf"></iframe>`
        : `<div class="pdfPage"><div class="t1">waiting for first build…</div><div class="t2">${esc(e.tex || '')}</div></div>`}
      <div class="viewerBar" id="pdfStatusBar">
        <span class="rec"><i></i>watching ${esc(e.tex || '')}</span>
        ${e.pages ? `<span>${esc(e.pages)} pages</span>` : ''}
        <span id="pdfStateTxt" style="margin-left:auto;">${esc(stateTxt)}</span>
        <span id="unwatchTex" style="cursor:pointer;color:var(--dim);" title="stop watching">✕ unwatch</span>
      </div></div>`;
  }
  if (vsel.kind === 'proposal') {
    const pp = proposalPreview[key] || { html: '', title: '' };
    return `<div class="viewerTop">
      <iframe class="artFrame" sandbox="allow-scripts" srcdoc="${esc(pp.html)}" title="proposal preview"></iframe>
      <div class="viewerBar"><span style="color:var(--yellow)">⌗ ${esc(pp.title)} — read-only preview of the proposed change</span>
      <span id="closeProposal" style="margin-left:auto;cursor:pointer;color:var(--dim);">✕ close</span></div></div>`;
  }
  const url = artifactUrl(key, vsel.key);
  if (vsel.kind === 'pdfart') {
    // navpanes=0 keeps Chrome's thumbnail sidebar closed; FitH fills the width
    return `<div class="viewerTop">
      <iframe class="artFrame" data-vk="${esc(vsel.key)}" src="${esc(url)}#navpanes=0&view=FitH" title="${esc(vsel.label)}"></iframe>
      <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
  }
  if (vsel.kind === 'datav') {
    // fully sandboxed: the page is static html+css from our own server
    return `<div class="viewerTop">
      <iframe class="artFrame" data-vk="${esc(vsel.key)}" sandbox="" src="${esc(dataviewUrl(key, vsel.key))}&t=${Date.now()}" title="${esc(vsel.label)}"></iframe>
      <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
  }
  // html artifact — either the live WYSIWYG editor or the normal scripted view
  if (htmlEdits[key] && htmlEdits[key].rel === vsel.key) {
    return `<div class="viewerTop">
      <div class="editBar" id="editBar">
        <button data-cmd="bold" title="bold (⌘B)"><b>B</b></button>
        <button data-cmd="italic" title="italic (⌘I)"><i>I</i></button>
        <button data-cmd="underline" title="underline (⌘U)"><u>U</u></button>
        <span class="ebSep"></span>
        <button data-cmd="formatBlock" data-arg="h1" title="heading 1">H1</button>
        <button data-cmd="formatBlock" data-arg="h2" title="heading 2">H2</button>
        <button data-cmd="formatBlock" data-arg="h3" title="heading 3">H3</button>
        <button data-cmd="formatBlock" data-arg="p" title="normal paragraph">¶</button>
        <span class="ebSep"></span>
        <button data-cmd="insertUnorderedList" title="bullet list">•≡</button>
        <button data-cmd="insertOrderedList" title="numbered list">1≡</button>
        <button data-cmd="link" title="make selection a link">⛓</button>
        <button data-cmd="removeFormat" title="strip formatting from selection">✕fmt</button>
        <span class="ebSep"></span>
        <button data-cmd="undo" title="undo">↶</button>
        <button data-cmd="redo" title="redo">↷</button>
        <span id="htmlDirty" class="ebDirty"></span>
        <button id="htmlSaveBtn" class="ebSave" title="write to disk (⌘S)">save</button>
        <button id="htmlDoneBtn" class="ebDone" title="finish editing">✓ done</button>
      </div>
      <iframe id="htmlEditFrame" class="artFrame" sandbox="allow-same-origin" src="${esc(url)}" title="editing ${esc(vsel.key)}"></iframe>
      <div class="viewerBar"><span style="color:var(--yellow)">✎ editing ${esc(vsel.key)} — click into the page and type. Scripts are paused, so math/plots show as source.</span></div>
    </div>`;
  }
  return `<div class="viewerTop">
    <iframe class="artFrame" data-vk="${esc(vsel.key)}" sandbox="allow-scripts" src="${esc(url)}" title="${esc(vsel.label)}"></iframe>
    <div class="viewerBar">${artBarHtml(key, vsel)}</div></div>`;
}

/* bar under a plain artifact iframe (html or pdf file) — shared by the full
   render and the in-place tab switch */
function artBarHtml(key, vsel) {
  const url = artifactUrl(key, vsel.key);
  if (vsel.kind === 'pdfart') {
    return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span style="margin-left:auto;"><a href="${esc(url)}" target="_blank">open in browser ↗</a></span>`;
  }
  if (vsel.kind === 'datav') {
    return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span>▦ data preview — head rows via pandas</span>
    <span style="margin-left:auto;"><a href="${esc(dataviewUrl(key, vsel.key))}" target="_blank">open in browser ↗</a></span>`;
  }
  return `<span style="color:var(--dim)">${esc(vsel.key)}</span>
    <span id="htmlEditBtn" data-rel="${esc(vsel.key)}" style="margin-left:auto;cursor:pointer;color:var(--green);" title="edit this page in place">✎ edit</span>
    <span style="margin-left:14px;"><a href="${esc(url)}" target="_blank">open in browser ↗</a></span>`;
}

/* the kept viewer stack: every plain artifact iframe (html / pdf file) stays
   mounted once shown — detaching an iframe makes the browser reload it, so
   hidden tabs are display:none'd, never removed. This surfaces vsel's frame,
   creating it on first visit, and rebuilds the bar fresh (wireWB rewires it). */
function syncViewerStack(top, key, vsel) {
  const bar = top.querySelector(':scope > .viewerBar');
  let frame = top.querySelector(`:scope > iframe.artFrame[data-vk="${CSS.escape(vsel.key)}"]`);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'artFrame';
    frame.dataset.vk = vsel.key;
    frame.title = vsel.label || vsel.key;
    const url = artifactUrl(key, vsel.key);
    if (vsel.kind === 'pdfart') frame.src = url + '#navpanes=0&view=FitH';
    else if (vsel.kind === 'datav') {
      frame.setAttribute('sandbox', '');
      frame.src = `${dataviewUrl(key, vsel.key)}&t=${Date.now()}`;
    } else { frame.setAttribute('sandbox', 'allow-scripts'); frame.src = url; }
    top.insertBefore(frame, bar);
  }
  top.querySelectorAll(':scope > iframe.artFrame[data-vk]').forEach(f =>
    f.classList.toggle('vhid', f.dataset.vk !== vsel.key));
  bar.innerHTML = artBarHtml(key, vsel);
}

/* patch ledger-driven text in the open workbench without a full re-render */
function updateLedgerInline(key) {
  const root = document.getElementById('v-' + key);
  if (!root) return;
  const lg = state.ledger?.perProject?.[key] || null;
  const stats = root.querySelector('.side .stats');
  if (stats) {
    const ts = tasksOf(key);
    stats.innerHTML = `${SHOW_HOURS ? `you <b class="g">${lg ? hrs(lg.seconds) + 'h' : '0h'}</b><br>` : ''}claude <b class="p">${lg ? fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0)) + ' tok' : '—'}</b><br>
      open <b>${ts.filter(t => t.status !== 'done').length} tasks</b>`;
  }
  const bar = root.querySelector('.statusbar');
  if (bar) {
    bar.innerHTML = `${statusbarHtml(key, tasksOf(key), lg)}<span style="margin-left:auto;">⌘1–5 projects · ⌘0 overview</span>`;
  }
}

function statusbarHtml(key, ts, lg) {
  const running = ts.filter(t => t.status === 'running').length;
  const waiting = ts.filter(t => t.status === 'waiting').length;
  const queued = ts.filter(t => t.status === 'queued').length;
  const segs = [];
  if (running) segs.push(`<span class="g">● ${running} running</span>`);
  if (waiting) segs.push(`<span class="y">⏸ ${waiting} waiting on you</span>`);
  if (queued) segs.push(`<span>${queued} queued</span>`);
  if (!segs.length) segs.push(`<span style="color:var(--dim)">○ idle</span>`);
  if (lg) segs.push(SHOW_HOURS
    ? `<span>wk <b>${hrs(lg.seconds)}h</b> · <b class="p">${fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0))} tok</b></span>`
    : `<span>wk <b class="p">${fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0))} tok</b></span>`);
  return segs.join('');
}

function renderWB(key) {
  const root = document.getElementById('v-' + key);
  if (!root || !state.projects[key]) return;
  const per = perOf(key);
  // a live WYSIWYG edit is modal for this project: re-rendering would reload
  // the iframe and destroy the edits, so hold the frame until ✓ done
  if (per.htmlEdit && htmlEdits[key] && root.querySelector('#htmlEditFrame')) return;
  const ts = tasksOf(key);
  const task = curTask(key);
  const lg = state.ledger?.perProject?.[key] || null;

  // show-panel viewer list: pdf watch + project's html artifacts (+ a clicked pdf artifact)
  const viewers = [];
  const pdfEntry = state.pdf?.[key];
  if (pdfEntry) viewers.push({ kind: 'pdf', key: 'pdf', label: '◫ ' + (pdfEntry.pdf ? String(pdfEntry.pdf).split('/').pop() : 'live pdf') });
  state.artifacts.filter(a => a.project === key && a.kind === 'html').slice(0, 8)
    .forEach(a => viewers.push({ kind: 'html', key: a.rel, label: '⌗ ' + a.name }));
  // pinned .pdf files belong to the show panel, not the code pane
  const watchRel = pdfEntry?.pdf ? relOf(key, pdfEntry.pdf) : null;
  (task && Array.isArray(task.context?.files) ? task.context.files : [])
    .filter(isPdfFile)
    .forEach(f => {
      const rel = relOf(key, f);
      if (!rel || rel === watchRel || viewers.some(v => v.key === rel)) return;
      viewers.push({ kind: 'pdfart', key: rel, label: '◫ ' + String(f).split('/').pop() });
    });
  if (per.viewerKey && per.viewerKey !== 'pdf' && per.viewerKey !== '__proposal' && !viewers.some(v => v.key === per.viewerKey)) {
    const a = state.artifacts.find(x => x.project === key && x.rel === per.viewerKey);
    if (a) {
      viewers.push({ kind: a.kind === 'pdf' ? 'pdfart' : 'html', key: a.rel, label: (a.kind === 'pdf' ? '◫ ' : '⌗ ') + a.name });
    } else if (/\.(pdf|html?)$/i.test(per.viewerKey)) {
      // any viewable file (e.g. a paper opened from a folder pin) gets an
      // ephemeral tab — it lives while selected, no pinning required
      const isPdf = /\.pdf$/i.test(per.viewerKey);
      viewers.push({ kind: isPdf ? 'pdfart' : 'html', key: per.viewerKey, label: (isPdf ? '◫ ' : '⌗ ') + per.viewerKey.split('/').pop() });
    } else if (isDataFile(per.viewerKey)) {
      // data files get a server-rendered head-of-table preview (pandas)
      viewers.push({ kind: 'datav', key: per.viewerKey, label: '▦ ' + per.viewerKey.split('/').pop() });
    }
  }
  // user-arranged tab order (drag a tab onto another; persisted per project);
  // tabs not in the saved order keep their natural recency order, after it
  let vOrder = [];
  try { vOrder = JSON.parse(localStorage.getItem(`viewerOrder:${key}`) || '[]'); } catch { /* corrupt */ }
  if (Array.isArray(vOrder) && vOrder.length) {
    const pos = new Map(vOrder.map((k2, i) => [k2, i]));
    const nat = new Map(viewers.map((v, i) => [v.key, i]));
    viewers.sort((a, b) =>
      (pos.has(a.key) ? pos.get(a.key) : 1e9 + nat.get(a.key)) -
      (pos.has(b.key) ? pos.get(b.key) : 1e9 + nat.get(b.key)));
  }

  // a pending proposal preview gets a tab of its own
  if (proposalPreview[key]) {
    viewers.unshift({ kind: 'proposal', key: '__proposal', label: '⌗ ' + proposalPreview[key].title });
  }

  // displays added by hand via ＋ (dedup against artifacts/pinned pdfs)
  getAddedViewers(key).forEach(v => {
    if (viewers.some(x => x.key === v.rel)) return;
    viewers.push({ kind: v.kind, key: v.rel, label: (v.kind === 'pdfart' ? '◫ ' : '⌗ ') + String(v.rel).split('/').pop() });
  });

  // drop tabs the user closed with × (the live 'pdf' watch tab is never
  // hidden — its × unwatches instead; explicit selection reopens a closed tab)
  const closedV = getClosedViewers(key);
  if (closedV.size) {
    for (let i = viewers.length - 1; i >= 0; i--) {
      if (viewers[i].key !== 'pdf' && closedV.has(viewers[i].key)) viewers.splice(i, 1);
    }
  }

  const vsel = viewers.find(v => v.key === per.viewerKey) || viewers[0] || null;
  if (vsel) per.viewerKey = vsel.key;

  // pinned context files for the current task
  const files = task ? (Array.isArray(task.context?.files) ? task.context.files : []).slice(0, 12) : [];
  const closedSet = task ? getClosed(key, task) : new Set();
  // a visible code-pin tab supersedes an ephemeral tab for the same file
  // (covers pins added from another client — pinFile only dedupes locally)
  if (per.openExtra?.length) {
    per.openExtra = per.openExtra.filter(r =>
      !files.some(f => pinKindOf(f) === 'code' && relOf(key, f) === r));
  }
  let fi = per.fileTab;
  if (fi === 'run') fi = null; // legacy — run output lives in the session pane now
  if (fi === 'snaps' && !(task && snapsCache[`${key}/${task.id}`]?.entries?.length)) fi = null;
  if (extraRel(fi) != null && !(per.openExtra || []).includes(extraRel(fi))) fi = null;
  if (typeof fi === 'number' && (fi >= files.length || closedSet.has(String(files[fi]))
    || isPdfFile(files[fi]) || pinKindOf(files[fi]) === 'folder')) fi = null;
  if (fi == null) {
    const firstOpen = files.findIndex(f =>
      !closedSet.has(String(f)) && !isPdfFile(f) && pinKindOf(f) !== 'folder');
    fi = firstOpen >= 0 ? firstOpen : 'tail';
  }
  per.fileTab = fi;

  // the innerHTML swap below destroys the code editor — carry its viewport
  // and cursor across the render (drafts already preserve the text itself)
  const prevEd = root.querySelector('#codeEditor');
  const edState = prevEd ? {
    fkey: prevEd.dataset.fkey,
    scrollTop: prevEd.scrollTop,
    scrollLeft: prevEd.scrollLeft, // wrap="off" → horizontal scroll matters too
    selStart: prevEd.selectionStart,
    selEnd: prevEd.selectionEnd,
    focused: document.activeElement === prevEd,
  } : null;
  const prevPin = root.querySelector('#pinSearch');
  const pinFocused = !!prevPin && document.activeElement === prevPin;
  const prevComp = root.querySelector('#composerInput');
  const compState = prevComp && document.activeElement === prevComp
    ? { selStart: prevComp.selectionStart, selEnd: prevComp.selectionEnd } : null;
  // carry the live console DOM across the render: rebuilding it re-parses and
  // re-typesets the whole transcript (visible flash) and loses scroll position.
  // Capture at-bottom-ness too: content height changes between renders (verb
  // line, final typeset), so "stay at the bottom" must be restored as intent,
  // not as a stale pixel offset
  const prevConsole = root.querySelector('#consoleBox');
  const consoleKeep = prevConsole ? {
    el: prevConsole,
    scrollTop: prevConsole.scrollTop,
    stick: prevConsole.scrollTop + prevConsole.clientHeight >= prevConsole.scrollHeight - 30,
    key: prevConsole.dataset.key,
  } : null;
  // persist the outgoing console's scroll/follow per task — on a task switch the
  // live node is discarded (its key no longer matches, so consoleKeep can't
  // carry it), and without this the returning task would snap back to the bottom.
  // Guard on clientHeight: a renderWB on a HIDDEN project view (returning to a
  // project — renderWB runs before .show) reads scrollTop 0, which would clobber
  // the real value saved on leave; only harvest a console that has layout.
  if (prevConsole && prevConsole.clientHeight) consoleView[prevConsole.dataset.key] = {
    scrollTop: prevConsole.scrollTop,
    follow: prevConsole._follow !== false,
  };
  // ▶ output scroll: stick to the bottom unless the user scrolled up to read
  const prevRun = root.querySelector('#runPre');
  const runKeep = prevRun ? {
    scrollTop: prevRun.scrollTop,
    stick: prevRun.scrollTop + prevRun.clientHeight >= prevRun.scrollHeight - 30,
  } : null;
  // session-pane chat: same treatment — a render (e.g. switching a show-panel
  // tab) must not slam a scrolled-up chat back to the bottom
  const prevChat = root.querySelector('#chatLog');
  const chatKeep = prevChat ? {
    scrollTop: prevChat.scrollTop,
    stick: prevChat.scrollTop + prevChat.clientHeight >= prevChat.scrollHeight - 30,
  } : null;
  // sidebar lineage chain: hold the scroll across renders; a task switch
  // instead defaults to the current node at the bottom (parent visible above)
  const prevSch = root.querySelector('.sideChain');
  const schKeep = prevSch ? { tid: prevSch.dataset.tid, scrollTop: prevSch.scrollTop } : null;

  // persistent skeleton: each render refills the slots below, never the root —
  // so the viewer slot can keep its loaded artifact iframes mounted across
  // renders (detaching an iframe from the DOM forces the browser to reload it)
  let wb = root.querySelector(':scope > .wb');
  if (!wb) {
    root.innerHTML = `<div class="wb">
      <div class="side"></div>
      <div class="sdivider" title="drag to resize"></div>
      <div class="pane"></div>
      <div class="vdivider" title="drag to resize"></div>
      <div class="pane">
        <div class="ptabs vtabs"></div>
        <div class="pbody rpb">
          <div class="vslot"></div>
          <div class="hdivider" title="drag to resize"></div>
          <div class="sessHalf"></div>
        </div>
      </div>
    </div>
    <div class="statusbar"></div>`;
    wb = root.querySelector(':scope > .wb');
    wireDividers(root); // the divider nodes persist — wire them exactly once
  }
  // editHold greys + disables the workbench (incl. the composer's .sessHalf)
  // while a WYSIWYG edit is live — but ONLY when the edited file is the shown
  // viewer. Without the viewerKey check, switching the viewer away (or to
  // another project and back) strands editHold, dead-locking the composer with
  // no visible edit. (renderWB bails above while the edit frame is mounted, so
  // this line only runs when the frame is NOT the active viewer.)
  wb.classList.toggle('editHold', !!htmlEdits[key] && per.viewerKey === htmlEdits[key].rel);

  wb.querySelector(':scope > .side').innerHTML = `
      <div class="sh">Task goal</div>
      <div class="abstract">${task ? esc(task.description || task.title || '') : 'no task selected'}</div>
      ${task ? `<div class="taskActs">
        ${task.archived
        ? '<span class="tact" id="unarchTask" title="restore to the tab strip and overview">▣ unarchive</span>'
        : '<span class="tact" id="archTask" title="hide from tabs & overview — keeps transcript, handoff, history">▣ archive</span>'}
        <span class="tact danger" id="delTask" title="permanently delete the task, its transcript and change history — files it created stay on disk">✕ delete</span>
      </div>` : ''}
      <div class="sh">⛓ Lineage <span class="anno" style="margin-left:6px">this task</span>
        ${task ? '<span id="linAddBtn" class="pinAdd" title="link an upstream task — its handoff feeds this task">＋</span>' : ''}</div>
      ${task ? sideChainHtml(key, task) : '<div class="sideNote">no tasks yet</div>'}
      <div class="sh">▮ Pinned files <span class="anno" style="margin-left:6px">context</span>
        ${task ? '<span id="pinAddBtn" class="pinAdd" title="pin a file or folder to this task">＋</span>' : ''}</div>
      ${task && per.pinOpen ? `<div class="pinPick">
        <input id="pinSearch" placeholder="search project files…" value="${esc(per.pinQ || '')}"
          autocomplete="off" spellcheck="false">
        <div id="pinResults">${pinResultsHtml(key, task)}</div></div>` : ''}
      ${files.length ? files.map((f, i) => {
        const kind = pinKindOf(f);
        if (kind === 'pdf') {
          const rel = relOf(key, f);
          return `<div class="scRow ${rel && per.viewerKey === rel ? 'sel' : ''}" data-fi="${i}" draggable="true"
            title="pdf — opens in the show panel"><span class="nm">◫ ${esc(pinLabelOf(f))}</span><span class="lang">pdf</span></div>`;
        }
        const isClosed = kind !== 'folder' && closedSet.has(String(f)); // folders have no tab to close
        const icon = isClosed ? '○' : PIN_ICON[kind];
        const chip = kind === 'data' ? 'data' : kind === 'folder' ? 'dir' : esc(extOf(f));
        const frel = kind === 'folder' ? relOf(key, String(f).replace(/\/+$/, '')) : null;
        const dirOpen = frel != null && per.openDirs?.has(frel);
        const selCls = kind === 'folder' ? (dirOpen ? 'sel' : '') : (fi === i ? 'sel' : '');
        let row = `<div class="scRow ${selCls} ${isClosed ? 'closed' : ''}" data-fi="${i}" draggable="true"
          title="${isClosed ? 'closed — click to reopen' : kind === 'data' ? 'data pin — schema card, not contents' : kind === 'folder' ? 'click to browse the folder' : 'drag to reorder'}"><span class="nm">${icon} ${esc(pinLabelOf(f))}</span><span class="lang">${chip}</span></div>`;
        if (dirOpen) row += dirKidsHtml(key, frel, 1);
        return row;
      }).join('')
        : '<div class="sideNote">no pinned context files on this task</div>'}
      ${ts.some(t => t.archived) ? `
      <div class="sh">▣ Archived <span class="anno" style="margin-left:6px">${ts.filter(t => t.archived).length}</span></div>
      ${ts.filter(t => t.archived).map(t =>
        `<div class="scRow arch ${task && t.id === task.id ? 'sel' : ''}" data-aid="${esc(t.id)}" title="click to view — unarchive from the sidebar"><span class="nm">▣ ${esc(t.title)}</span><span class="lang">${esc(t.status)}</span></div>`).join('')}` : ''}
      <div class="sh">This week</div>
      <div class="stats">
        ${SHOW_HOURS ? `you <b class="g">${lg ? hrs(lg.seconds) + 'h' : '0h'}</b><br>` : ''}claude <b class="p">${lg ? fmtTok((lg.tokensIn || 0) + (lg.tokensOut || 0)) + ' tok' : '—'}</b><br>
        open <b>${ts.filter(t => t.status !== 'done').length} tasks</b>
      </div>`;

  wb.querySelector(':scope > .pane').innerHTML = `
      <div class="ptabs">
        ${ts.filter(t => !t.archived || (task && t.id === task.id)).map(t => `<div class="ptab tk ${task && t.id === task.id ? 'on' : ''}" data-id="${esc(t.id)}">
          <span class="tdot ${statusDot(t.status)}"></span>${t.archived ? '▣ ' : ''}${esc(t.title)}
          <span class="ovs ${esc(t.oversight)}" style="font-size:7.5px;">${OVS_LABEL[t.oversight] || ''}</span>${t.status === 'done' && !t.archived
            ? `<span class="tabX" data-ax="${esc(t.id)}" title="clear the tab — the task moves to ▣ Archived in the sidebar">×</span>` : ''}</div>`).join('')}
        <div class="ptab plus" id="newTaskTab" title="new task in ${esc(key)}">＋</div>
      </div>
      <div class="pbody">${task
        ? workSurface(key, task, files, fi)
        : `<div class="noCode"><div class="big">▮</div><div>no tasks in <b>${esc(state.projects[key]?.name || key)}</b> — hit <b>＋</b></div></div>`}</div>`;

  wb.querySelector('.vtabs').innerHTML = `
        ${viewers.map(v => `<div class="ptab vw ${vsel && v.key === vsel.key ? 'on' : ''}" data-vk="${esc(v.key)}" draggable="true" title="${esc(v.key)} — drag to rearrange">${esc(v.label)}${v.kind === 'pdf' ? ' <span style="color:var(--green);font-size:10px;">●</span>' : ''}<span class="tabX" data-vx="${esc(v.key)}" title="${v.kind === 'pdf' ? 'stop watching this .tex' : 'close — reopen from the sidebar or a folder pin'}">×</span></div>`).join('')}
        <div class="ptab plus" id="addViewBtn" title="add a display — .html/.pdf to show, or a .tex to live-compile">＋</div>`;

  // the viewer slot: keep the live iframe stack whenever the selection is a
  // plain artifact and the slot already holds a stack; rebuild it otherwise
  // (live pdf watch, proposal preview, WYSIWYG edit, empty state)
  const vslot = wb.querySelector('.vslot');
  const liveTop = vslot.querySelector(':scope > .viewerTop');
  const keepStack = !!(liveTop && !htmlEdits[key]
    && vsel && (vsel.kind === 'html' || vsel.kind === 'pdfart' || vsel.kind === 'datav')
    && liveTop.querySelector(':scope > iframe.artFrame[data-vk]')
    && liveTop.querySelector(':scope > .viewerBar'));
  if (keepStack) {
    const live = new Set(viewers.map(v => v.key));
    liveTop.querySelectorAll(':scope > iframe.artFrame[data-vk]').forEach(f => {
      if (!live.has(f.dataset.vk)) f.remove(); // its tab was closed
    });
    syncViewerStack(liveTop, key, vsel);
  } else {
    vslot.innerHTML = viewerHtml(key, vsel, pdfEntry);
  }

  // session pane (bottom right): tabbed — ⌘ session + ▶ output when a run exists
  {
    const run = state.runs[key];
    const hasRun = !!(run || runBufs[key]);
    let st = per.sessTab;
    if (st === 'run' && !hasRun) st = null;
    st = st || 'sess';
    per.sessTab = st;
    const sessTabs = `<div class="sessTabs">
      <div class="stab ${st === 'sess' ? 'on' : ''}" data-st="sess">${task
        ? `<span class="tdot ${statusDot(task.status)}"></span><span class="stitle">⌘ session · ${esc(task.title)}</span>
           <span class="ovs ${esc(task.oversight)}">${OVS_LABEL[task.oversight] || ''}</span>`
        : '⌘ session'}</div>
      ${hasRun ? `<div class="stab runT ${st === 'run' ? 'on' : ''}" data-st="run">▶ output${run?.state === 'running' ? '<span class="runSpin">⟳</span>' : ''}</div>` : ''}
    </div>`;
    const sessBody = st === 'run'
      ? runPaneHtml(key, run)
      : task ? sessionBody(key, task)
        : `<div class="taskHero"><div class="sideNote">no task selected</div></div>`;
    wb.querySelector('.sessHalf').innerHTML = sessTabs + sessBody;
  }

  root.querySelector(':scope > .statusbar').innerHTML =
    `${statusbarHtml(key, ts, lg)}<span style="margin-left:auto;">⌘1–5 projects · ⌘0 overview</span>`;

  {
    const freshRun = root.querySelector('#runPre');
    if (freshRun) {
      freshRun.scrollTop = runKeep && !runKeep.stick ? runKeep.scrollTop : freshRun.scrollHeight;
    }
    const freshChat = root.querySelector('#chatLog');
    if (freshChat) {
      freshChat.scrollTop = chatKeep && !chatKeep.stick ? chatKeep.scrollTop : freshChat.scrollHeight;
    }
    const freshSch = root.querySelector('.sideChain');
    if (freshSch) {
      if (schKeep && schKeep.tid === freshSch.dataset.tid) freshSch.scrollTop = schKeep.scrollTop;
      else {
        // center the current task (parent peeking above, child below). During
        // go() the view is still display:none and all sizes read 0 — place on
        // the next frame, after renderAll's show toggle
        const place = () => {
          const cur = freshSch.querySelector('.schNode.cur');
          if (cur) freshSch.scrollTop = cur.offsetTop - (freshSch.clientHeight - cur.offsetHeight) / 2;
        };
        if (freshSch.clientHeight) place();
        else requestAnimationFrame(place);
      }
    }
  }

  // swap the freshly-rendered empty console for the preserved live one BEFORE
  // wiring, so updateConsole appends to it instead of rebuilding
  if (consoleKeep) {
    const fresh = root.querySelector('#consoleBox');
    if (fresh && fresh.dataset.key === consoleKeep.key) {
      fresh.replaceWith(consoleKeep.el);
      consoleKeep.el.scrollTop = consoleKeep.stick
        ? consoleKeep.el.scrollHeight : consoleKeep.scrollTop;
    }
  }

  wireWB(root, key, task, files);

  if (edState) {
    const ed = root.querySelector('#codeEditor');
    if (ed && ed.dataset.fkey === edState.fkey) {
      ed.scrollTop = edState.scrollTop;
      ed.scrollLeft = edState.scrollLeft;
      if (edState.focused) {
        ed.focus();
        try { ed.setSelectionRange(edState.selStart, edState.selEnd); } catch { /* ranges can go stale */ }
      }
    }
  }
  if (pinFocused) {
    const pin = root.querySelector('#pinSearch');
    if (pin) {
      pin.focus();
      pin.setSelectionRange(pin.value.length, pin.value.length);
    }
  }
  if (compState) {
    const comp = root.querySelector('#composerInput');
    if (comp) {
      comp.focus();
      try { comp.setSelectionRange(compState.selStart, compState.selEnd); } catch { /* stale range */ }
    }
  }

  if (task) {
    ensureTranscript(key, task.id);
    ensureSnaps(key, task.id);
    const xrel = extraRel(fi);
    if (xrel != null) ensureFile(key, xrel);
    else if (typeof fi === 'number' && files[fi] != null) {
      const kind = pinKindOf(files[fi]);
      const rel = relOf(key, String(files[fi]).replace(/\/+$/, ''));
      if (rel != null) {
        if (kind === 'data') ensureCard(key, rel); // folders have no center tab
        else if (kind === 'code') ensureFile(key, rel);
      }
    }
  }
}

function dragTrack(onMove) {
  // shared drag plumbing: disables iframe pointer-events so the drag
  // doesn't die the moment the cursor crosses an embedded artifact.
  return (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
    const move = (ev) => onMove(ev);
    const up = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function wireDividers(root) {
  const wb = root.querySelector('.wb');
  const rpb = root.querySelector('.rpb');

  // restore persisted sizes
  const savedSide = localStorage.getItem('wbSidePx');
  if (wb && savedSide) wb.style.setProperty('--wb-side', savedSide + 'px');
  const savedCol = localStorage.getItem('wbCenterPx');
  if (wb && savedCol) wb.style.setProperty('--wb-center', savedCol + 'px');
  const savedSplit = localStorage.getItem('wbVSplit');
  if (rpb && savedSplit) rpb.style.setProperty('--vsplit', savedSplit + '%');

  const sdiv = root.querySelector('.sdivider');
  if (sdiv && wb) sdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = wb.getBoundingClientRect();
    // half this divider; clamp so the sidebar stays usable and the panes keep their minimums
    const px = Math.min(Math.max(ev.clientX - rect.left - 3, 180), Math.min(460, rect.width - 14 - 280 - 300));
    wb.style.setProperty('--wb-side', px + 'px');
    localStorage.setItem('wbSidePx', String(Math.round(px)));
  }));

  const vdiv = root.querySelector('.vdivider');
  if (vdiv && wb) vdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = wb.getBoundingClientRect();
    // live sidebar width + its divider + half this divider; clamp so neither pane collapses
    const side = wb.querySelector(':scope > .side').getBoundingClientRect().width;
    const px = Math.min(Math.max(ev.clientX - rect.left - side - 7 - 3, 280), rect.width - side - 14 - 300);
    wb.style.setProperty('--wb-center', px + 'px');
    localStorage.setItem('wbCenterPx', String(Math.round(px)));
  }));

  const hdiv = root.querySelector('.hdivider');
  if (hdiv && rpb) hdiv.addEventListener('mousedown', dragTrack((ev) => {
    const rect = rpb.getBoundingClientRect();
    const pct = Math.min(82, Math.max(15, ((ev.clientY - rect.top) / rect.height) * 100));
    rpb.style.setProperty('--vsplit', pct.toFixed(1) + '%');
    localStorage.setItem('wbVSplit', pct.toFixed(1));
  }));
}

function wireFileReorder(root, key, task, files) {
  // Drag a file tab (center) or pinned-file row (sidebar) onto another to
  // reorder. The new order is persisted to task.context.files via PATCH,
  // so future session launches read the files in your order.
  const per = perOf(key);
  let fromIdx = null;

  const commit = async (from, to) => {
    if (from === to || from == null || to == null) return;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return; // pins only — extras aren't draggable
    // `files` is the DISPLAYED slice (first 12); reorder within it but always
    // persist the FULL pinned list, or extras beyond the slice get deleted
    const local = tasksOf(key).find(t => t.id === task.id) || task;
    const full = Array.isArray(local.context?.files) ? local.context.files.slice() : files.slice();
    const order = files.slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const newFull = [...order, ...full.slice(files.length)];
    // keep the selection glued to the file the user had open
    const sel = per.fileTab;
    if (sel !== 'tail' && typeof sel === 'number') {
      per.fileTab = order.indexOf(files[sel]);
    }
    // optimistic local update, then persist (task:update broadcast confirms);
    // PATCH from the fresh local context, not the render-time closure
    local.context = { ...(local.context || {}), files: newFull };
    renderWB(key);
    await api('PATCH', `/api/tasks/${encodeURIComponent(key)}/${encodeURIComponent(task.id)}`,
      { context: { ...local.context, files: newFull } });
  };

  root.querySelectorAll('[data-fi][draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      fromIdx = +el.dataset.fi;
      el.classList.add('dragSrc');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(fromIdx)); } catch { /* required by FF */ }
    });
    el.addEventListener('dragend', () => {
      fromIdx = null;
      root.querySelectorAll('.dragSrc, .dragOver').forEach(x => x.classList.remove('dragSrc', 'dragOver'));
    });
    el.addEventListener('dragover', (e) => {
      if (fromIdx == null || el.dataset.fi === 'tail') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dragOver');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragOver'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragOver');
      commit(fromIdx, +el.dataset.fi);
      fromIdx = null;
    });
  });
}

function wireViewerReorder(root, key) {
  // drag a show-panel tab onto another to rearrange; order persists per project
  const tabs = [...root.querySelectorAll('.ptab.vw')];
  if (tabs.length < 2) return;
  let fromK = null;
  tabs.forEach(el => {
    el.addEventListener('dragstart', (e) => {
      fromK = el.dataset.vk;
      el.classList.add('dragSrc');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', fromK); } catch { /* required by FF */ }
    });
    el.addEventListener('dragend', () => {
      fromK = null;
      root.querySelectorAll('.dragSrc, .dragOver').forEach(x => x.classList.remove('dragSrc', 'dragOver'));
    });
    el.addEventListener('dragover', (e) => {
      if (fromK == null || el.dataset.vk === fromK) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dragOver');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragOver'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragOver');
      if (fromK == null || fromK === el.dataset.vk) return;
      const keys = tabs.map(t => t.dataset.vk);
      const [moved] = keys.splice(keys.indexOf(fromK), 1);
      keys.splice(keys.indexOf(el.dataset.vk) + (e.offsetX > el.offsetWidth / 2 ? 1 : 0), 0, moved);
      localStorage.setItem(`viewerOrder:${key}`, JSON.stringify(keys));
      fromK = null;
      renderWB(key);
    });
  });
}

function wireWB(root, key, task, files) {
  const per = perOf(key);
  wireViewerReorder(root, key);
  if (task && files.length > 1) wireFileReorder(root, key, task, files);

  root.querySelectorAll('.ptab.tk').forEach(el => el.addEventListener('click', () => {
    if (per.taskId === el.dataset.id) return; // already selected — don't reset tabs
    per.taskId = el.dataset.id; per.fileTab = null; per.sessTab = 'sess'; renderWB(key);
  }));
  // × on a done task's tab — archives it (same as ▣ archive in the sidebar)
  root.querySelectorAll('.ptab.tk .tabX[data-ax]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't select the tab being dismissed
    const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(el.dataset.ax)}`, { archived: true });
    if (r) {
      const arr = state.tasks[key] || [];
      const i = arr.findIndex(t => t && t.id === r.id);
      if (i >= 0) arr[i] = r; // apply now — don't wait for the broadcast
      toast('archived — it lives under ▣ Archived in the sidebar');
      if (per.taskId === el.dataset.ax) per.taskId = null; // fall to the next task
      renderWB(key);
    }
  }));
  root.querySelectorAll('.scRow.arch').forEach(el => el.addEventListener('click', () => {
    per.taskId = el.dataset.aid; per.fileTab = null; per.sessTab = 'sess'; renderWB(key);
  }));
  root.querySelectorAll('.scKid.dirk').forEach(el => el.addEventListener('click', () => {
    per.openDirs = per.openDirs || new Set();
    const r = el.dataset.dk;
    if (per.openDirs.has(r)) per.openDirs.delete(r);
    else { per.openDirs.add(r); ensureDir(key, r); }
    renderWB(key);
  }));
  root.querySelectorAll('.scKid.filek').forEach(el => el.addEventListener('click', () => {
    const r = el.dataset.fk;
    const ext = r.split('.').pop().toLowerCase();
    if (['pdf', 'html', 'htm'].includes(ext) || isDataFile(r)) {
      selectViewer(key, r); // pdf/html render; data files get a head-rows preview
      renderWB(key);
    } else {
      openExtraTab(key, r); // anything else opens as an ephemeral code tab
    }
  }));
  if (task) {
    root.querySelector('#archTask')?.addEventListener('click', async () => {
      if (task.status === 'running') { toast('interrupt the running turn before archiving'); return; }
      const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { archived: true });
      if (r) { toast('archived — it lives under ▣ Archived in the sidebar'); per.taskId = null; renderWB(key); }
    });
    root.querySelector('#unarchTask')?.addEventListener('click', async () => {
      const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { archived: false });
      if (r) toast('restored to the tab strip');
    });
    root.querySelector('#delTask')?.addEventListener('click', async () => {
      const refs = tasksOf(key).filter(t => Array.isArray(t.upstream) && t.upstream.includes(task.id));
      const ok = await confirmBox(
        `Are you sure you want to delete <b>“${esc(task.title)}”</b>?<br><br>`
        + 'This removes the task, its transcript and its change history. '
        + 'Files the task created in the project <b>stay on disk</b>.'
        + (task.handoff ? '<br>⚠ Its handoff record will be lost.' : '')
        + (refs.length ? `<br>⚠ ${refs.length} task(s) list it as upstream — their lineage link will dangle.` : '')
        + '<br><br>This cannot be undone.');
      if (!ok) return;
      const r = await api('DELETE', `/api/tasks/${enc(key)}/${enc(task.id)}`);
      if (r) toast('task deleted');
      // task:delete broadcast clears state + selection
    });
  }
  const plus = root.querySelector('#newTaskTab');
  if (plus) plus.addEventListener('click', () => openModal(key));

  root.querySelectorAll('.ptab.vw').forEach(el => el.addEventListener('click', () => {
    per.viewerKey = el.dataset.vk; renderWB(key);
  }));
  root.querySelectorAll('.sessTabs .stab').forEach(el => el.addEventListener('click', () => {
    per.sessTab = el.dataset.st; renderWB(key);
  }));
  // run-pane controls are project-scoped — wire them even with no task selected
  const srb = root.querySelector('#stopRunBtn');
  if (srb) srb.addEventListener('click', () => stopRunReq(key));
  root.querySelectorAll('[data-vx]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't let the tab's select-click fire
    const vk = el.dataset.vx;
    if (vk === '__proposal') { closeProposal(key); return; }
    if (vk === 'pdf') {
      // the live watch tab: × stops the latexmk -pvc watch entirely
      await api('DELETE', `/api/pdf/watch/${enc(key)}`);
      delete state.pdf[key];
      if (per.viewerKey === 'pdf') per.viewerKey = null;
    } else {
      const closed = getClosedViewers(key);
      closed.add(String(vk));
      persistClosedViewers(key, closed);
      // a hand-added display is fully removed, not just hidden
      const added = getAddedViewers(key);
      if (added.some(v => v.rel === vk)) {
        persistAddedViewers(key, added.filter(v => v.rel !== vk));
      }
      if (per.viewerKey === vk) per.viewerKey = null; // fall to the next tab
    }
    renderWB(key);
  }));
  root.querySelectorAll('[data-fi]').forEach(el => el.addEventListener('click', () => {
    const v = el.dataset.fi;
    if (extraRel(v) != null) {
      per.fileTab = v;
      const rel = extraRel(v);
      if (drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`]; // refetch on open
      renderWB(key);
      return;
    }
    if (v === 'tail' || v === 'snaps') {
      per.fileTab = v;
    } else if (isPdfFile(files[+v])) {
      const rel = relOf(key, files[+v]);
      if (!rel) { toast('pdf is outside the project root — cannot display'); return; }
      selectViewer(key, rel); // pdfs open in the show panel (reopens if × closed)
    } else if (pinKindOf(files[+v]) === 'folder') {
      // folders have no center tab — the sidebar row just toggles its browser
      const rel = relOf(key, String(files[+v]).replace(/\/+$/, ''));
      if (rel != null) {
        per.openDirs = per.openDirs || new Set();
        if (per.openDirs.has(rel)) per.openDirs.delete(rel);
        else { per.openDirs.add(rel); ensureDir(key, rel); }
      }
      if (task) { // clear a legacy closed-tab entry from when folders had tabs
        const closed = getClosed(key, task);
        if (closed.delete(String(files[+v]))) persistClosed(key, task);
      }
    } else {
      per.fileTab = +v;
      if (task) { // selecting a closed sidebar row reopens its tab
        const closed = getClosed(key, task);
        if (closed.delete(String(files[+v]))) persistClosed(key, task);
      }
      // refetch on open (unless a draft is in progress): code files have no
      // watcher, so this is what catches external edits going stale
      const kind = pinKindOf(files[+v]);
      const rel = relOf(key, String(files[+v]).replace(/\/+$/, ''));
      if (rel != null && kind === 'code' && drafts[`${key}::${rel}`] == null) delete fileCache[`${key}::${rel}`];
      if (rel != null && kind === 'data') delete fileCache[`${key}::card::${rel}`];
    }
    renderWB(key);
  }));
  root.querySelectorAll('.tabX').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the tab's select-click fire
    if (el.dataset.xi == null) return; // viewer-tab ×s ([data-vx]) have their own handler
    const xrel = extraRel(el.dataset.xi);
    if (xrel != null) {
      // ephemeral tab: × removes it outright (drafts survive in memory and
      // come back if the file is reopened)
      per.openExtra = (per.openExtra || []).filter(r => r !== xrel);
      if (per.fileTab === el.dataset.xi) per.fileTab = null; // fall to the next tab
      renderWB(key);
      return;
    }
    closeTab(key, task, +el.dataset.xi, files);
  }));
  root.querySelectorAll('[data-lid]').forEach(el => el.addEventListener('click', () => {
    const k2 = el.dataset.lk || key;
    perOf(k2).taskId = el.dataset.lid;
    perOf(k2).fileTab = null;
    perOf(k2).sessTab = 'sess';
    if (k2 !== key) go(k2); else renderWB(key);
  }));
  root.querySelectorAll('.schX[data-ux]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation(); // the lineage node click navigates to that task
    const next = (Array.isArray(task.upstream) ? task.upstream : []).filter(u => u !== el.dataset.ux);
    task.upstream = next; // optimistic — the PATCH broadcast confirms
    renderWB(key);
    await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { upstream: next });
  }));
  root.querySelectorAll('.schX[data-dx]').forEach(el => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const child = resolveId(el.dataset.dx); // the link lives on the child's upstream
    if (!child) return;
    const next = (Array.isArray(child.t.upstream) ? child.t.upstream : []).filter(u => u !== task.id);
    child.t.upstream = next; // optimistic — the PATCH broadcast confirms
    renderWB(key);
    await api('PATCH', `/api/tasks/${enc(child.k)}/${enc(child.t.id)}`, { upstream: next });
  }));

  // WYSIWYG html editing
  const heb = root.querySelector('#htmlEditBtn');
  if (heb) heb.addEventListener('click', () => startHtmlEdit(key, heb.dataset.rel));
  const ef = root.querySelector('#htmlEditFrame');
  if (ef) {
    const hook = () => {
      try {
        const doc = ef.contentDocument;
        if (!doc || !htmlEdits[key]) return;
        doc.designMode = 'on';
        doc.addEventListener('input', () => {
          const st = htmlEdits[key];
          if (!st) return;
          st.gen = (st.gen || 0) + 1;
          if (!st.dirty) { st.dirty = true; htmlEditChrome(key); }
        });
        doc.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveHtmlEdit(key);
          }
        });
      } catch (err) {
        toast('cannot enter edit mode: ' + (err.message || err));
      }
    };
    ef.addEventListener('load', hook);
    if (ef.contentDocument && ef.contentDocument.readyState === 'complete') hook();
  }
  root.querySelectorAll('#editBar button[data-cmd]').forEach(b => {
    // keep the iframe's selection alive — a normal click would steal focus
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const doc = root.querySelector('#htmlEditFrame')?.contentDocument;
      const st = htmlEdits[key];
      if (!doc || !st) return;
      const cmd = b.dataset.cmd;
      try {
        if (cmd === 'link') {
          const u = prompt('Link URL:', 'https://');
          if (u && u.trim()) doc.execCommand('createLink', false, u.trim());
        } else if (b.dataset.arg) {
          doc.execCommand(cmd, false, b.dataset.arg);
        } else {
          doc.execCommand(cmd);
        }
        st.gen = (st.gen || 0) + 1;
        if (!st.dirty) { st.dirty = true; htmlEditChrome(key); }
      } catch { /* command not applicable to selection */ }
    });
  });
  const hsb = root.querySelector('#htmlSaveBtn');
  if (hsb) hsb.addEventListener('click', () => saveHtmlEdit(key));
  const hdb = root.querySelector('#htmlDoneBtn');
  if (hdb) hdb.addEventListener('click', () => endHtmlEdit(key));

  const cp = root.querySelector('#closeProposal');
  if (cp) cp.addEventListener('click', () => closeProposal(key));
  const av = root.querySelector('#addViewBtn');
  if (av) av.addEventListener('click', () => addDisplay(key));
  const un = root.querySelector('#unwatchTex');
  if (un) un.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api('DELETE', `/api/pdf/watch/${enc(key)}`);
    delete state.pdf[key];
    per.viewerKey = null;
    renderWB(key);
  });

  if (!task) return;

  const ed = root.querySelector('#codeEditor');
  if (ed) {
    const k = ed.dataset.fkey;
    // syntax-color overlay (only present for known languages)
    const hlCode = root.querySelector('#codeHL');
    const hlPre = hlCode ? hlCode.parentElement : null;
    const hlSync = () => {
      if (!hlPre) return;
      hlPre.scrollTop = ed.scrollTop;
      hlPre.scrollLeft = ed.scrollLeft;
    };
    let hlQueued = false;
    const hlPaint = () => {
      if (!hlCode) return;
      if (!hlStores[k]) {
        hlStores[k] = {};
        const ks = Object.keys(hlStores); // cap the cache — oldest entry out
        if (ks.length > 30) delete hlStores[ks[0] === k ? ks[1] : ks[0]];
      }
      paintHL(hlCode, ed.value, ed.dataset.ext, hlStores[k]);
      hlSync();
    };
    const hlSchedule = () => { // coalesce to one repaint per frame
      if (!hlCode || hlQueued) return;
      hlQueued = true;
      requestAnimationFrame(() => { hlQueued = false; hlPaint(); });
    };
    if (hlCode) {
      ed.addEventListener('scroll', hlSync);
      // IME composition draws provisional text in the textarea itself — make
      // it opaque and hide the overlay until composition ends
      ed.addEventListener('compositionstart', () => ed.closest('.edWrap')?.classList.add('ime'));
      ed.addEventListener('compositionend', () => {
        ed.closest('.edWrap')?.classList.remove('ime');
        hlSchedule();
      });
      hlPaint();
    }
    ed.addEventListener('input', () => {
      if (ed.value === fileCache[k]?.text) {
        delete drafts[k];
        delete draftBase[k];
      } else {
        if (drafts[k] == null) draftBase[k] = fileCache[k]?.mtimeMs; // baseline at first divergence
        drafts[k] = ed.value;
      }
      editorChrome(key);
      hlSchedule();
    });
    ed.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveFile(key, ed.dataset.rel);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault(); // save + run
        runFile(key, ed.dataset.rel);
      } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); // keep Tab as indentation, not focus-leave
        // Julia files get REPL-style \beta⇥ → β (unicode is idiomatic there);
        // other languages — especially .tex, full of intentional \alpha —
        // keep Tab purely as indentation. A missed \name falls through too.
        if (ed.dataset.ext === 'jl' && texComplete(ed) === true) return;
        const s = ed.selectionStart, en = ed.selectionEnd;
        const sel = ed.value.slice(s, en);
        if (sel.includes('\n')) {
          // multi-line selection: indent every line instead of deleting the block
          const ls = ed.value.lastIndexOf('\n', s - 1) + 1;
          const block = ed.value.slice(ls, en).replace(/^/gm, '  ');
          ed.setRangeText(block, ls, en, 'select');
        } else {
          ed.setRangeText('  ', s, en, 'end');
        }
        ed.dispatchEvent(new Event('input'));
      }
    });
    const sb = root.querySelector('#saveFileBtn');
    if (sb) sb.addEventListener('click', () => saveFile(key, ed.dataset.rel));
  }

  const pa = root.querySelector('#pinAddBtn');
  if (pa) pa.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = root.querySelector('#pinMenu');
    if (existing) { existing.remove(); return; }
    if (per.pinOpen) { per.pinOpen = false; per.pinQ = ''; renderWB(key); return; }
    const menu = document.createElement('div');
    menu.id = 'pinMenu';
    menu.innerHTML = `
      <div class="pmItem" data-pk="file">▮ pin a file…</div>
      <div class="pmItem" data-pk="folder">🗀 pin a folder…</div>`;
    pa.closest('.sh').appendChild(menu);
    menu.querySelectorAll('.pmItem').forEach(it => it.addEventListener('click', async () => {
      // no stopPropagation: let the document once-listener fire and clean up
      menu.remove();
      await pickPin(key, task, it.dataset.pk);
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });

  const la = root.querySelector('#linAddBtn');
  if (la) la.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = root.querySelector('#linMenu');
    if (existing) { existing.remove(); return; }
    const ups = Array.isArray(task.upstream) ? task.upstream : [];
    // same rules as Add Task → Lineage: chains live within a category GROUP
    // (e.g. any Empirics task can feed any other); archived tasks stay linkable
    // (their handoffs are the point), sorted last, marked ▣; exclude self,
    // already-linked, and tasks already downstream of this one
    const kin = tasksOf(key).filter(t => t.id !== task.id
      && catGroup(t.category) === catGroup(task.category)
      && !ups.includes(t.id) && !(Array.isArray(t.upstream) && t.upstream.includes(task.id)))
      .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
    const item = (t, attr) => `<div class="pmItem" ${attr}="${esc(t.id)}">⛓ ${t.archived ? '▣ ' : ''}${esc(t.title)}<span class="anno">${esc(state.categories?.[t.category]?.name || t.category)} · ${t.archived ? 'archived' : esc(t.status)}</span></div>`;
    const menu = document.createElement('div');
    menu.id = 'linMenu';
    menu.innerHTML = kin.length
      ? `<div class="pmHead">↑ add a parent — its handoff feeds this task</div>`
        + kin.map(t => item(t, 'data-lu')).join('')
        + `<div class="pmHead">↓ add a child — receives this task's handoff</div>`
        + kin.map(t => item(t, 'data-lc')).join('')
      : '<div class="sideNote" style="padding:7px 12px;">no linkable tasks — lineage chains live within a category group</div>';
    la.closest('.sh').appendChild(menu);
    menu.querySelectorAll('.pmItem[data-lu]').forEach(it => it.addEventListener('click', async () => {
      // no stopPropagation: the document once-listener below cleans the menu up
      const next = [...ups, it.dataset.lu];
      task.upstream = next; // optimistic — the PATCH broadcast confirms
      renderWB(key);
      await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { upstream: next });
    }));
    menu.querySelectorAll('.pmItem[data-lc]').forEach(it => it.addEventListener('click', async () => {
      // child links live on the CHILD's upstream array
      const child = tasksOf(key).find(t => t.id === it.dataset.lc);
      const next = [...(Array.isArray(child?.upstream) ? child.upstream : []), task.id];
      if (child) child.upstream = next; // optimistic — the PATCH broadcast confirms
      renderWB(key);
      await api('PATCH', `/api/tasks/${enc(key)}/${enc(it.dataset.lc)}`, { upstream: next });
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });

  const wirePinRows = () => root.querySelectorAll('.pinRow').forEach(el =>
    el.addEventListener('click', () => pinFile(key, task, el.dataset.rel)));
  const ps = root.querySelector('#pinSearch');
  if (ps) {
    ps.addEventListener('input', () => {
      per.pinQ = ps.value;
      const out = root.querySelector('#pinResults');
      if (out) { out.innerHTML = pinResultsHtml(key, task); wirePinRows(); }
    });
    ps.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { per.pinOpen = false; per.pinQ = ''; renderWB(key); }
      else if (e.key === 'Enter') {
        const first = root.querySelector('.pinRow');
        if (first) pinFile(key, task, first.dataset.rel);
      }
    });
    wirePinRows();
  }

  const rb = root.querySelector('#runFileBtn');
  if (rb) rb.addEventListener('click', () => {
    if (rb.dataset.running) stopRunReq(key);
    else runFile(key, rb.dataset.rel);
  });

  // change history: expand diffs inline, rewind files
  root.querySelectorAll('.snapDiffBtn').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('.snapFile');
    const open = row.nextElementSibling;
    if (open && open.classList.contains('snapDiffWrap')) { open.remove(); return; } // toggle off
    const d = await api('GET',
      `/api/snapshots/${enc(key)}/${enc(b.dataset.eid)}/file?rel=${enc(b.dataset.rel)}`);
    if (!d || d.error) return;
    const wrap = document.createElement('div');
    wrap.className = 'snapDiffWrap';
    wrap.innerHTML = diffHtml(d.before ?? '', d.after ?? '');
    row.after(wrap);
  }));
  const doRevert = async (eid, rel) => {
    const what = rel || 'every file in this change-set';
    if (!confirm(`Rewind ${what} to before this change?\n(The rewind is recorded too, so it can be undone.)`)) return;
    const r = await api('POST', `/api/snapshots/${enc(key)}/${enc(eid)}/revert`, rel ? { rel } : {});
    if (r && r.ok) toast('rewound — files restored');
    // the snapshot:new broadcast refreshes history + invalidates file caches
  };
  root.querySelectorAll('.snapRevertBtn').forEach(b =>
    b.addEventListener('click', () => doRevert(b.dataset.eid, b.dataset.rel)));
  root.querySelectorAll('.snapRevertAll').forEach(b =>
    b.addEventListener('click', () => doRevert(b.dataset.eid, null)));

  const send = root.querySelector('#sendBtn');
  const input = root.querySelector('#composerInput');
  if (send && input) {
    const ck = `${key}/${task.id}`;
    // grow with the text: 1 line → 2 → 3 …, scrollable past ~7 lines
    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 170) + 'px';
    };
    // size to content, but defer if the view has no layout yet: on a project
    // switch renderWB runs while the view is still display:none, so scrollHeight
    // reads 0 and would pin the textarea to height:0 — a present-but-unclickable
    // composer. Mirror the console-scroll restore: size now if visible, else
    // on the next frame (after renderAll's .show toggle gives it layout).
    if (input.clientHeight) autosize(); // restored drafts may already be multi-line
    else requestAnimationFrame(autosize);
    input.addEventListener('input', () => { composerDrafts[ck] = input.value; autosize(); });
    const doSend = () => {
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      delete composerDrafts[ck];
      per.fileTab = 'tail';        // jump to the console to watch the turn —
      sendMsg(key, task.id, text); // set BEFORE sendMsg so its render lands
    };                             // on the console directly (one render, no flash)
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
  }
  const cbox = root.querySelector('#consoleBox');
  if (cbox) {
    // user-scroll intent: scrolling away from the bottom stops the stream
    // from following; scrolling back near it resumes. Our own programmatic
    // writes are excluded via the _prog counter (see updateConsole). The
    // listener rides the kept element across renders — wire it once.
    if (!cbox._wired) {
      cbox._wired = true;
      cbox.addEventListener('scroll', () => {
        if (cbox._prog > 0) { cbox._prog--; return; }
        cbox._follow = cbox.scrollHeight - cbox.scrollTop - cbox.clientHeight < 40;
      });
    }
    const ck2 = cbox.dataset.key;
    const target = (tailBufs[ck2] || '').length;
    // restore this task's saved scroll/follow before painting: seed _follow so
    // updateConsole's stick logic doesn't snap a returning task to the bottom
    const view = consoleView[ck2];
    if (view) cbox._follow = view.follow;
    // FIRST open shows history instantly; a console that's already revealing
    // mid-stream keeps its smooth pump — jumping the cursor on every render
    // dumped a tall block at once and knocked the view off the stream
    if (shownLen[ck2] == null || !pumps[ck2]) shownLen[ck2] = target;
    updateConsole(cbox, ck2, shownLen[ck2], shownLen[ck2] === target);
    // position scroll once the view has LAYOUT. On a project switch, renderAll
    // renders this view while it's still display:none (the .show toggle runs
    // after), so geometry reads 0 and a scroll write is a no-op — defer to the
    // next frame when visible, mirroring the lineage-chain restore. _prog flags
    // our own write so the scroll listener doesn't read it as a user scroll.
    const applyScroll = () => {
      const before = cbox.scrollTop;
      if (view && view.follow === false) cbox.scrollTop = view.scrollTop; // reader's saved offset
      else if (cbox._follow !== false) cbox.scrollTop = cbox.scrollHeight; // following/default → bottom
      if (cbox.scrollTop !== before) cbox._prog = (cbox._prog || 0) + 1;
    };
    if (cbox.clientHeight) applyScroll();
    else requestAnimationFrame(applyScroll);
  }
  root.querySelectorAll('.mdlSel:not(.permSel)').forEach(el => el.addEventListener('change', () => {
    setTaskModel(key, task, el.value || null);
  }));
  root.querySelectorAll('.permSel').forEach(el => el.addEventListener('change', () => {
    setTaskPerm(key, task, el.value || null);
  }));
  // web-search on/off toggle — same chip on the launch card (queued) and the
  // session bar (running/waiting); flips take effect on the next turn
  root.querySelectorAll('[data-webtoggle]').forEach(el => el.addEventListener('click', () => {
    const live = tasksOf(key).find(t => t.id === task.id) || task; // read fresh state, not the render-time closure
    setTaskWebSearch(key, task, !(live.context?.web_search?.enabled));
  }));

  const intr = root.querySelector('#interruptBtn');
  if (intr) intr.addEventListener('click', async () => {
    per.interrupting = task.id; // acknowledge instantly; cleared on session:status
    renderWB(key);
    const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/interrupt`);
    if (r) toast('interrupt sent — the turn stops at the next safe point');
    else { per.interrupting = null; renderWB(key); } // request failed — don't lie
  });
  const lb = root.querySelector('#launchBtn');
  if (lb) lb.addEventListener('click', async () => {
    lb.disabled = true; lb.textContent = '⟳ launching…';
    const r = await api('POST', `/api/tasks/${enc(key)}/${enc(task.id)}/launch`);
    if (!r) { lb.disabled = false; lb.textContent = '▶ Launch session'; return; }
    per.fileTab = 'tail'; // watch the first turn in the console
    renderWB(key);
  });
  const md = root.querySelector('#markDoneBtn');
  if (md) md.addEventListener('click', () =>
    api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`, { status: 'done', logNote: 'marked done manually' }));
  const ad = root.querySelector('#acceptDoneBtn');
  if (ad) ad.addEventListener('click', async () => {
    const r = await api('PATCH', `/api/tasks/${enc(key)}/${enc(task.id)}`,
      { status: 'done', logNote: 'handoff accepted by user' });
    if (r) toast('task closed — handoff recorded ✓');
  });

  // (#chatLog scroll is restored by renderWB's chatKeep — pinning it to the
  // bottom here fought users who had scrolled up to re-read)
}

async function sendMsg(project, id, text) {
  const k = `${project}/${id}`;
  (transcripts[k] ?? (transcripts[k] = { entries: [], fetched: true }))
    .entries.push({ role: 'user', text, ts: new Date().toISOString() });
  // a live console buffer gets the message inline (same marker format the
  // transcript seed uses) — without this, a mid-conversation console never
  // shows what you just sent, and the next turn's output appears unprompted
  if (tailBufs[k]) {
    tailBufs[k] += `\n▸ you ─────────\n${text}\n`;
    if (!pumps[k]) pumps[k] = requestAnimationFrame(() => pumpConsole(project, k));
  }
  if (ui.view === project) renderWB(project);
  await api('POST', `/api/tasks/${enc(project)}/${enc(id)}/message`, { text });
}

/* ───────────────────────── categories ───────────────────────── */

/* the group ("partition") a category belongs to — lineage chains live within it */
function catGroup(k) {
  const c = (state.categories || {})[k];
  return (c && typeof c === 'object' && c.group) || 'Other';
}

/* group categories by their `group` field, preserving categories.json order */
function catGroups() {
  const order = [];
  const byGroup = new Map();
  for (const [k, raw] of Object.entries(state.categories || {})) {
    const c = (typeof raw === 'string') ? { primer: raw } : (raw || {});
    const g = c.group || 'Other';
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push([k, c]);
  }
  return order.map(g => [g, byGroup.get(g)]);
}

/* designation accent colors: [text, chip background] */
const GROUP_COLOR = {
  'Structural': ['var(--purple)', 'var(--des-structural)'],
  'Empirics': ['var(--blue)', 'var(--blue-d)'],
  'Literature': ['var(--yellow)', 'var(--des-literature)'],
  'Final Goods': ['var(--green)', 'var(--des-final)'],
};
const groupColor = (g) => GROUP_COLOR[g] || ['var(--blue)', 'var(--blue-d)'];

/* ───────────────────────── settings (profile menu) ───────────────────────── */

function renderSettings() {
  const host = document.getElementById('settingsFrame');
  if (!host) return;
  const cur = themePref();
  const opts = [
    ['system', '◐ System', 'follows the macOS appearance'],
    ['dark', '● Dark', 'the classic night dashboard'],
    ['light', '○ Light', 'paper mode for bright rooms'],
  ];
  host.innerHTML = `
    <h1>Settings</h1>
    <div class="setSec">
      <h3>Appearance</h3>
      <div class="setRow">
        <div class="setLbl">Theme<small>${esc(opts.find(o => o[0] === cur)?.[2] || '')}</small></div>
        <div class="segCtl" id="themeSeg">
          ${opts.map(([v, label]) =>
    `<div class="segOpt ${cur === v ? 'on' : ''}" data-th="${esc(v)}">${esc(label)}</div>`).join('')}
        </div>
      </div>
    </div>`;
  host.querySelectorAll('[data-th]').forEach(el =>
    el.addEventListener('click', () => setTheme(el.dataset.th)));
}

/* ───────────────────────── about you (profile menu) ───────────────────────── */

const aboutCache = { profile: null, activity: null, commits: null, loading: false, generating: false };
const COMMITS_PREVIEW = 8; // shown initially; "show more" reveals in steps
let commitsShown = COMMITS_PREVIEW;

async function ensureAboutData(force) {
  if (aboutCache.loading) return;
  if (!force && aboutCache.profile && aboutCache.activity && aboutCache.commits) return;
  aboutCache.loading = true;
  try {
    const [profile, activity, commits] = await Promise.all([
      apiQuiet('GET', '/api/profile'),
      apiQuiet('GET', '/api/activity'),
      apiQuiet('GET', '/api/commits'),
    ]);
    if (profile) aboutCache.profile = profile;
    if (activity) aboutCache.activity = activity;
    if (commits) aboutCache.commits = commits.commits || [];
  } finally {
    aboutCache.loading = false;
  }
  if (ui.view === 'about') renderAbout();
}

const dayKeyOf = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* GitHub-style activity heatmap: 53 Monday-start week columns ending today.
   Green ramp = your logged hours; purple = days only Claude worked. */
function heatmapHtml(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // this week's Monday
  start.setDate(start.getDate() - 52 * 7);                     // 52 weeks earlier

  const level = (d) => {
    if (!d || (!d.seconds && !d.tokens)) return 'l0';
    if (!d.seconds) return 'lC'; // Claude worked, you didn't log time
    const h = d.seconds / 3600;
    return h < 1 ? 'l1' : h < 2.5 ? 'l2' : h < 5 ? 'l3' : 'l4';
  };
  const tip = (date, d) => {
    const base = `${DOWS[(date.getDay() + 6) % 7]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    if (!d || (!d.seconds && !d.tokens)) return `${base} — no activity`;
    const bits = [];
    if (d.seconds) bits.push(`${(d.seconds / 3600).toFixed(1)}h you`);
    if (d.tokens) bits.push(`${fmtTok(d.tokens)} tok`);
    if (d.costUsd) bits.push(`$${d.costUsd.toFixed(2)}`);
    const per = Object.entries(d.perProject || {}).sort((a, b) => b[1] - a[1])
      .map(([k, s]) => `${state.projects[k]?.name || k} ${(s / 3600).toFixed(1)}h`).join(', ');
    return `${base} — ${bits.join(' · ')}${per ? ` (${per})` : ''}`;
  };

  let monthCells = '';
  let gridCells = '';
  const stats = { seconds: 0, tokens: 0, costUsd: 0, active: 0, streak: 0, bestStreak: 0 };
  for (let w = 0; w < 53; w++) {
    const weekStartD = new Date(start);
    weekStartD.setDate(start.getDate() + w * 7);
    // label the column when the month changes within its first week
    monthCells += `<span class="hmMonth">${weekStartD.getDate() <= 7 ? MONTHS[weekStartD.getMonth()] : ''}</span>`;
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(weekStartD);
      date.setDate(weekStartD.getDate() + dow);
      if (date > today) { gridCells += '<span class="hmCell future"></span>'; continue; }
      const d = days[dayKeyOf(date)];
      gridCells += `<span class="hmCell ${level(d)}" title="${esc(tip(date, d))}"></span>`;
      if (d) {
        stats.seconds += d.seconds || 0;
        stats.tokens += d.tokens || 0;
        stats.costUsd += d.costUsd || 0;
        if (d.seconds || d.tokens) {
          stats.active++;
          stats.streak++;
          stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
        } else stats.streak = 0;
      } else stats.streak = 0;
    }
  }
  return `
    <div class="hmWrap">
      <div class="hmMonths">${monthCells}</div>
      <div class="hmBody">
        <div class="hmDows"><span>Mon</span><span>Wed</span><span>Fri</span></div>
        <div class="hmGrid">${gridCells}</div>
      </div>
      <div class="hmFoot">
        <span class="hmStat"><b>${hrs(stats.seconds)}h</b> logged</span>
        <span class="hmStat"><b>${stats.active}</b> active day${stats.active === 1 ? '' : 's'}</span>
        <span class="hmStat"><b>${stats.bestStreak}</b> day best streak</span>
        <span class="hmStat"><b class="p">${fmtTok(stats.tokens)}</b> tok · <b class="p">$${stats.costUsd.toFixed(0)}</b></span>
        <span class="hmLegend">less <span class="hmCell l0"></span><span class="hmCell l1"></span><span class="hmCell l2"></span><span class="hmCell l3"></span><span class="hmCell l4"></span> more · <span class="hmCell lC"></span> Claude only</span>
      </div>
    </div>`;
}

function commitsHtml(commits) {
  if (!commits) return '<div class="sideNote">loading commits…</div>';
  if (!commits.length) return '<div class="sideNote">no commits found in the project repos</div>';
  const hidden = commits.length - commitsShown;
  const shown = hidden > 0 ? commits.slice(0, commitsShown) : commits;
  const byDay = new Map();
  shown.forEach(c => {
    const d = new Date(c.ts);
    const k = dayKeyOf(d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(c);
  });
  return [...byDay.entries()].map(([k, list]) => {
    const d = new Date(list[0].ts);
    return `<div class="cmDay">${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}</div>`
      + list.map(c => `<div class="cmRow" title="${esc(c.author || '')} · ${esc(c.hash || '')}">
          <span class="pdot" style="background:${esc(state.projects[c.project]?.color || '#888')}"></span>
          <span class="cmProj">${esc(state.projects[c.project]?.name || c.project)}</span>
          <span class="cmMsg">${esc(c.subject || '')}</span>
          <span class="cmHash">${esc(c.short || '')}</span>
        </div>`).join('');
  }).join('')
    + (hidden > 0 ? `<div class="cmMore" id="cmMore">▾ show ${Math.min(hidden, 20)} more <span>(${hidden} hidden)</span></div>` : '')
    + (hidden <= 0 && commits.length > COMMITS_PREVIEW ? `<div class="cmMore" id="cmLess">▴ collapse</div>` : '');
}

function renderAbout() {
  const host = document.getElementById('aboutFrame');
  if (!host) return;
  ensureAboutData();
  const p = aboutCache.profile;
  const act = aboutCache.activity;
  const bio = p?.bio;
  const interests = p?.interests || [];
  host.innerHTML = `
    <div class="aboutHead">
      <div class="avatar">g</div>
      <div class="aboutId">
        <h1>${esc(p?.name || state.user?.name || 'Researcher')}</h1>
        ${bio
      ? `<div class="aboutBio">${esc(bio)}</div>`
      : `<div class="aboutBio dim">${aboutCache.generating
        ? 'Claude is reading your projects and writing your profile…'
        : p ? 'No profile yet — Claude writes this from your abstracts, tasks and activity.' : 'loading…'}</div>`}
        ${interests.length ? `<div class="aboutInts">${interests.map(i => `<span class="intChip">${esc(i)}</span>`).join('')}</div>` : ''}
        <div class="aboutMeta">
          ${p?.generatedAt ? `<span>written by Claude · ${esc(new Date(p.generatedAt).toLocaleDateString())}</span>` : ''}
          <span id="profileGen" class="${aboutCache.generating ? 'busy' : ''}">${aboutCache.generating ? '⟳ writing…' : '↻ let Claude rewrite it'}</span>
        </div>
      </div>
    </div>
    <div class="aboutSec"><h3>▦ Activity <span class="anno">past 12 months — green is your time, purple is Claude working solo</span></h3>
      ${act ? heatmapHtml(act.days || {}) : '<div class="sideNote">loading activity…</div>'}
    </div>
    <div class="aboutSec"><h3>⎇ Recent commits <span class="anno">across all project repos</span></h3>
      <div class="cmFeed">${commitsHtml(aboutCache.commits)}</div>
    </div>`;

  host.querySelector('#cmMore')?.addEventListener('click', () => {
    commitsShown += 20;
    renderAbout();
  });
  host.querySelector('#cmLess')?.addEventListener('click', () => {
    commitsShown = COMMITS_PREVIEW;
    renderAbout();
  });
  host.querySelector('#profileGen')?.addEventListener('click', async () => {
    if (aboutCache.generating) return;
    aboutCache.generating = true;
    renderAbout();
    const r = await api('POST', '/api/profile/generate');
    aboutCache.generating = false;
    if (r && !r.error) {
      aboutCache.profile = r;
      toast('profile rewritten by Claude ✓');
    }
    renderAbout();
  });
}

/* ───────────────────────── manage projects (profile menu) ───────────────────────── */

/* undirected components over upstream links — a task's "chain" is everything
   reachable through lineage; size 1 = unchained */
function chainSizes(ts) {
  const present = new Set(ts.map(t => t.id));
  const parent = new Map(ts.map(t => [t.id, t.id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  ts.forEach(t => (Array.isArray(t.upstream) ? t.upstream : []).forEach(u => {
    if (!present.has(u)) return; // dangling lineage link
    const ra = find(t.id), rb = find(u);
    if (ra !== rb) parent.set(ra, rb);
  }));
  const size = new Map();
  ts.forEach(t => { const r = find(t.id); size.set(r, (size.get(r) || 0) + 1); });
  return { sizeOf: (id) => size.get(find(id)) || 1, rootOf: (id) => find(id) };
}

function renderManage() {
  const host = document.getElementById('manageFrame');
  if (!host) return;
  const catOrder = Object.keys(state.categories || {});
  const sections = allProjKeys().map(k => {  // Manage shows inactive projects too
    const proj = state.projects[k] || {};
    const ts = tasksOf(k); // full history — archived included, marked ▣
    const chains = chainSizes(ts);
    const byCat = new Map();
    ts.forEach(t => {
      const c = t.category || 'uncategorized';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(t);
    });
    const cats = [...byCat.keys()].sort((a, b) => {
      const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      return ((ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib)) || a.localeCompare(b);
    });
    const catRows = cats.map(c => {
      const list = byCat.get(c);
      const done = list.filter(t => t.status === 'done').length;
      const ck = `${k}::${c}`;
      const open = ui.manageOpen.has(ck);
      // chains first (longest chain up top, members grouped), then unchained;
      // ties fall back to creation order
      const sorted = list.slice().sort((a, b) => {
        const sa = chains.sizeOf(a.id), sb = chains.sizeOf(b.id);
        const ga = sa > 1 ? 0 : 1, gb = sb > 1 ? 0 : 1;
        if (ga !== gb) return ga - gb;
        if (ga === 0) {
          if (sb !== sa) return sb - sa;
          const ra = chains.rootOf(a.id), rb = chains.rootOf(b.id);
          if (ra !== rb) return ra < rb ? -1 : 1;
        }
        return String(a.created || '').localeCompare(String(b.created || ''));
      });
      const rows = open ? sorted.map(t => {
        const sz = chains.sizeOf(t.id);
        const isDone = t.status === 'done';
        return `<div class="mpTask ${isDone ? 'done' : ''}" data-mt="${esc(k)}::${esc(t.id)}" title="open in the workbench">
          <span class="tdot ${statusDot(t.status)}"></span>
          ${sz > 1 ? `<span class="mpChain" title="part of a ${sz}-task chain">⛓${sz}</span>` : '<span class="mpChain solo">·</span>'}
          <span class="mpTitle">${t.archived ? '▣ ' : ''}${esc(t.title)}</span>
          <span class="mpId">${esc(t.id)}</span>
          <span class="mpSt ${esc(t.status)}">${isDone ? '✓ done' : esc(t.status)}</span>
        </div>`;
      }).join('') : '';
      return `<div class="mpCat ${open ? 'open' : ''}" data-mpc="${esc(ck)}">
          <span class="caret">${open ? '▾' : '▸'}</span> ${esc(c)}
          <span class="mpCount">${list.length} task${list.length === 1 ? '' : 's'} · ${done} done</span>
        </div>
        ${open ? `<div class="mpList">${rows}</div>` : ''}`;
    }).join('');
    const doneAll = ts.filter(t => t.status === 'done').length;
    const status = ['active', 'trial', 'inactive'].includes(proj.status) ? proj.status : 'active';
    const pills = ['active', 'trial', 'inactive'].map(s =>
      `<span class="mpStPill ${status === s ? 'on' : ''}" data-pkst="${esc(k)}::${s}">${s}</span>`).join('');
    return `<div class="mpProj ${status === 'inactive' ? 'mpInactive' : ''}">
      <div class="mpHead">
        <input type="color" class="mpColor" data-pk="${esc(k)}" value="${esc(proj.color || '#888888')}" title="project color">
        <input class="mpName" data-pk="${esc(k)}" value="${esc(proj.name || k)}" spellcheck="false" title="display name — Enter or click away to save">
        <span class="mpKey" title="permanent id — tasks, ledger and snapshots are stored under it, so it can't be changed">${esc(k)}</span>
        <span class="mpStatus">${pills}</span>
        ${status !== 'inactive' ? `<span class="mpOpen" data-mpgo="${esc(k)}" title="open the workbench">open ›</span>` : ''}
        <span class="mpCount">${ts.length} task${ts.length === 1 ? '' : 's'} · ${doneAll} done</span>
      </div>
      ${catRows || '<div class="sideNote" style="padding:4px 12px;">no tasks yet</div>'}
    </div>`;
  }).join('');
  host.innerHTML = `
    <div class="catHead">
      <h1>🗂 Manage projects</h1>
      <span class="sub">rename, recolor, or set a designation — active (default) · trial (tag in the nav) · inactive (hidden from nav &amp; overview). Changes save to config.json.</span>
    </div>
    <div class="mpNew">
      <input type="color" id="npColor" value="#7ea2f5" title="color">
      <input id="npName" placeholder="New project name" spellcheck="false">
      <input id="npRoot" placeholder="/absolute/path/to/the/project/folder" spellcheck="false">
      <button type="button" id="npBrowse" class="pickBtn" title="choose the folder with your computer's file picker">⌖ browse…</button>
      <button id="npCreate" class="mpAdd">＋ Create project</button>
    </div>
    ${sections}`;
  host.querySelectorAll('.mpCat').forEach(el => el.addEventListener('click', () => {
    const ck = el.dataset.mpc;
    if (ui.manageOpen.has(ck)) ui.manageOpen.delete(ck); else ui.manageOpen.add(ck);
    renderManage();
  }));
  host.querySelectorAll('.mpTask').forEach(el => el.addEventListener('click', () => {
    const p = el.dataset.mt.split('::')[0];
    const tid = el.dataset.mt.slice(p.length + 2);
    perOf(p).taskId = tid;
    perOf(p).fileTab = null;
    perOf(p).sessTab = 'sess';
    go(p);
  }));
  host.querySelectorAll('[data-mpgo]').forEach(el => el.addEventListener('click', () => go(el.dataset.mpgo)));
  // rename — commit on Enter / blur; skip if unchanged. The state broadcast re-renders.
  host.querySelectorAll('.mpName').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('change', () => {
      const name = el.value.trim();
      if (!name || name === (state.projects[el.dataset.pk]?.name || '')) return;
      api('PATCH', `/api/projects/${enc(el.dataset.pk)}`, { name });
    });
  });
  host.querySelectorAll('.mpColor').forEach(el => el.addEventListener('change', () =>
    api('PATCH', `/api/projects/${enc(el.dataset.pk)}`, { color: el.value })));
  host.querySelectorAll('.mpStPill').forEach(el => el.addEventListener('click', () => {
    const [k, s] = el.dataset.pkst.split('::');
    if ((state.projects[k]?.status || 'active') === s) return; // already that designation
    api('PATCH', `/api/projects/${enc(k)}`, { status: s });
  }));
  const nbrowse = host.querySelector('#npBrowse');
  if (nbrowse) nbrowse.addEventListener('click', async () => {
    // native folder picker — same as the pinned-files ＋; the dialog opens on
    // the SERVER's screen, so it only works when browsing locally
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
      toast('the folder dialog opens on the server machine — type the path here instead');
      return;
    }
    nbrowse.textContent = '…';
    const r = await api('POST', '/api/pickfolder', { prompt: 'Choose the project folder' });
    nbrowse.textContent = '⌖ browse…';
    if (r && r.path) host.querySelector('#npRoot').value = r.path;
  });
  const npc = host.querySelector('#npCreate');
  if (npc) npc.addEventListener('click', async () => {
    const name = host.querySelector('#npName').value.trim();
    const root = host.querySelector('#npRoot').value.trim();
    const color = host.querySelector('#npColor').value;
    if (!name) { toast('enter a project name'); return; }
    if (!root) { toast('enter the project folder path'); return; }
    const r = await api('POST', '/api/projects', { name, root, color, status: 'active' });
    if (r) toast(`created "${name}" (key: ${r.key})`);
  });
}

function renderCats() {
  const host = document.getElementById('catsFrame');
  if (!host) return;
  const groups = catGroups();
  host.innerHTML = `
    <div class="catHead">
      <h1>⊞ Task categories</h1>
      <span class="sub">each category is a primer injected at the top of every session of that kind</span>
    </div>
    ${groups.map(([g, entries]) => {
      const [fg, bg] = groupColor(g);
      return `
      <div class="catGroupHead" style="--gfg:${fg};--gbg:${bg};">
        <span class="cgChip">${esc(g)}</span>
        <span class="cgLine"></span>
        <span class="cgCount">${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}</span>
      </div>
      <div class="catGrid">${entries.map(([k, c]) => {
        const name = c.name || k;
        const icon = c.icon || name.slice(0, 1);
        const metas = Object.entries(c)
          .filter(([mk]) => !['name', 'primer', 'icon', 'group'].includes(mk))
          .map(([mk, mv]) => `<span>${esc(mk)} <b>${esc(typeof mv === 'object' ? JSON.stringify(mv) : mv)}</b></span>`)
          .join('');
        return `<div class="catCard">
          <div class="cn"><span class="ic" style="background:${bg};color:${fg}">${esc(icon)}</span> ${esc(name)}
            ${name !== k ? `<span class="ckey">${esc(k)}</span>` : ''}</div>
          <div class="primer">${c.primer ? esc(c.primer) : '<i>no primer set</i>'}</div>
          ${metas ? `<div class="meta">${metas}</div>` : ''}
        </div>`;
      }).join('')}</div>`;
    }).join('') || '<div class="sideNote">no categories found in categories.json</div>'}
    <div class="catFoot">categories live in <b>projectManager/categories.json</b> · injection order at launch:
      <b>category primer</b> → living abstract → upstream handoffs → sibling tasks → pinned files → your notes.
      Read-only in v1.</div>`;
}

/* ───────────────────────── add-task modal ───────────────────────── */

function openModal(presetProject) {
  if (!projKeys().length) { toast('no projects loaded yet'); return; }
  form = {
    title: '', description: '',
    category: Object.keys(state.categories || {})[0] || '',
    project: (presetProject && state.projects[presetProject]) ? presetProject
      : (state.projects[ui.view] ? ui.view : projKeys()[0]),
    upstream: [],
    downstream: [],
    priority: 'medium',
    oversight: 'coop', // safe default: interactive, not unattended autopilot

    include_abstract: true, include_last_session: true,
    include_sibling_tasks: true, include_category_primer: true,
    web_enabled: true, web_sources: '',
    files: '', notes: '',
  };
  renderModal();
  document.getElementById('modalBack').classList.add('show');
  const t = document.getElementById('mTitle');
  if (t) t.focus();
}

function closeModal() {
  document.getElementById('modalBack')?.classList.remove('show');
  form = null;
}

function buildTaskFields() {
  const f = form;
  return {
    project: f.project,
    title: f.title,
    description: f.description,
    category: f.category,
    upstream: f.upstream.slice(),
    priority: f.priority,
    oversight: f.oversight,
    status: f.oversight === 'manual' ? 'manual' : 'queued',
    context: {
      include_abstract: f.include_abstract,
      include_last_session: f.include_last_session,
      include_sibling_tasks: f.include_sibling_tasks,
      include_category_primer: f.include_category_primer,
      web_search: {
        enabled: f.web_enabled,
        sources: f.web_sources.split(',').map(s => s.trim()).filter(Boolean),
      },
      files: f.files.split(',').map(s => s.trim()).filter(Boolean),
      notes: f.notes,
    },
  };
}

function jsonPreviewHtml(obj) {
  const j = JSON.stringify(obj, null, 2) || '';
  let out = '', last = 0, m;
  const re = /"(?:[^"\\]|\\.)*"(\s*:)?/g;
  while ((m = re.exec(j))) {
    out += esc(j.slice(last, m.index));
    if (m[1]) {
      const keyPart = m[0].slice(0, m[0].length - m[1].length);
      out += `<span class="k">${esc(keyPart)}</span>${esc(m[1])}`;
    } else {
      out += `<span class="s">${esc(m[0])}</span>`;
    }
    last = m.index + m[0].length;
  }
  out += esc(j.slice(last));
  return out;
}

function updateJson() {
  if (!form) return;
  const el = document.getElementById('mJson');
  if (el) el.innerHTML = jsonPreviewHtml(buildTaskFields());
  const jf = document.getElementById('jhFile');
  if (jf) jf.textContent = `tasks/${form.project}.json`;
}

function renderModal() {
  const f = form;
  if (!f) return;
  const host = document.getElementById('modalForm');
  // lineage lives WITHIN a category GROUP: any task in the partition can chain
  // (e.g. a cleaning task after a collection one — both Empirics).
  // Archived tasks stay linkable — their handoffs are exactly what a follow-up
  // task wants injected — they just sort after the active ones, marked ▣
  const kin = tasksOf(f.project).filter(t => catGroup(t.category) === catGroup(f.category))
    .sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  const groupName = catGroup(f.category);
  const lineageChips = (list, sel, dataAttr) => list.map(t =>
    `<span class="qchip ${sel.includes(t.id) ? 'on' : ''}" ${dataAttr}="${esc(t.id)}">⛓ ${t.archived ? '▣ ' : ''}${esc(state.categories?.[t.category]?.icon || '')} ${esc(t.title)} (${esc(t.id)} · ${t.archived ? 'archived' : esc(t.status)})</span>`).join('');

  host.innerHTML = `
    <h2>New task <span class="anno">becomes a launchable session</span></h2>

    <div class="fld"><div class="flbl">Title</div>
      <input type="text" id="mTitle" placeholder="e.g. Rebuild permutation placebo with new clusters" value="${esc(f.title)}"></div>

    <div class="fld"><div class="flbl">Description — what does done look like?</div>
      <textarea rows="4" id="mDesc" placeholder="Done = …">${esc(f.description)}</textarea></div>

    <div class="fld"><div class="flbl">Category <span class="anno" style="margin-left:8px">primes the session</span></div>
      <div id="mCat">${catGroups().map(([g, entries]) => {
        const [fg] = groupColor(g);
        return `<div class="catPickRow">
          <span class="cgLbl" style="color:${fg}">${esc(g)}</span>
          <div class="pillRow">${entries.map(([k, c]) =>
            `<span class="pillOpt ${f.category === k ? 'on' : ''}" data-c="${esc(k)}">${esc(c.icon || '')} ${esc(c.name || k)}</span>`).join('')}</div>
        </div>`;
      }).join('') || '<span class="sideNote" style="padding:0;">no categories defined</span>'}</div></div>

    <div class="fld"><div class="flbl">Project</div>
      <div class="pillRow" id="mProj">${projKeys().map(k =>
        `<span class="pillOpt ${f.project === k ? 'on' : ''}" data-p="${esc(k)}">${esc(state.projects[k]?.name || k)}</span>`).join('')}</div></div>

    <div class="fld"><div class="flbl">Lineage — within ${esc(groupName)} <span class="anno" style="margin-left:8px">handoffs flow downstream</span></div>
      ${kin.length ? `
        <div class="linRow"><span class="linLbl">↑ parents</span>
          <div class="qchips" id="mUp">${lineageChips(kin, f.upstream, 'data-u')}</div></div>
        <div class="linRow"><span class="linLbl">↓ children</span>
          <div class="qchips" id="mDown">${lineageChips(kin, f.downstream, 'data-d')}</div></div>
        <div class="linHint">parents ran first — their handoffs feed this task; children run later and receive this task's handoff.</div>`
      : `<span class="sideNote" style="padding:0;">no other ${esc(groupName)} tasks in this project yet — lineage chains live within a category group</span>`}</div>

    <div class="fld"><div class="flbl">Priority</div>
      <div class="pillRow" id="mPri">${['high', 'medium', 'low'].map(p =>
        `<span class="pillOpt ${f.priority === p ? 'on' : ''}" data-pr="${p}">${p}</span>`).join('')}</div></div>

    <div class="fld"><div class="flbl">Oversight — how much rope does Claude get?</div>
      <div class="ovsGrid" id="mOvs">
        ${[['auto', 'AUTO', 'Autopilot', 'Runs to completion unattended. Pings you when done or stuck.'],
           ['propose', 'PROP', 'Propose first', 'Reads context, drafts a plan, then waits. Nothing executes until you sign off.'],
           ['coop', 'COOP', 'Cooperative', 'You and Claude at the whiteboard — short turns, live back-and-forth.'],
           ['manual', 'MAN', 'Manual', 'No agent — a tracked todo. Coauthor emails stay yours.']]
          .map(([o, b, t2, d]) => `<div class="ovsCard ${f.oversight === o ? 'on' : ''}" data-o="${o}">
            <div class="ot"><span class="ovs ${o}">${b}</span> ${t2}</div><div class="od">${d}</div></div>`).join('')}
      </div></div>

    <div class="fld"><div class="flbl">Context packet <span class="anno" style="margin-left:8px">assembled &amp; injected at launch</span></div>
      <div class="ctxBox">
        <div class="qchips">
          ${[['include_abstract', '✓ living abstract'],
             ['include_last_session', '✓ last session summary'],
             ['include_sibling_tasks', '✓ sibling tasks'],
             ['include_category_primer', '✓ category primer']]
            .map(([kk, lb]) => `<span class="qchip ${f[kk] ? 'on' : ''}" data-t="${kk}">${lb}</span>`).join('')}
          <span class="qchip ${f.web_enabled ? 'on' : ''}" data-t="web_enabled">🌐 web search</span>
        </div>
        <input type="text" id="mSources" style="margin-top:8px;${f.web_enabled ? '' : 'display:none;'}"
          placeholder="web sources, comma-separated (arxiv, nber, ssrn…)" value="${esc(f.web_sources)}">
        <div style="display:flex;gap:8px;margin-top:8px;align-items:stretch;">
          <input type="text" id="mFiles" style="flex:1;"
            placeholder="pinned files, comma-separated (relative to project root)" value="${esc(f.files)}">
          <button type="button" id="mFilesPick" class="pickBtn" title="choose a file from the ${esc(state.projects[f.project]?.name || f.project)} folder">⌖ browse…</button>
        </div>
        <textarea rows="3" style="margin-top:10px;" id="mNotes" placeholder="Background notes for Claude…">${esc(f.notes)}</textarea>
      </div></div>

    <div class="foot">
      <button class="save" id="mSave">Save task</button>
      <span class="cancel" id="mCancel">cancel</span>
      <span class="where" id="mWhere">→ tasks/${esc(f.project)}.json</span>
    </div>`;

  host.querySelector('#mTitle').addEventListener('input', e => { f.title = e.target.value; updateJson(); });
  host.querySelector('#mDesc').addEventListener('input', e => { f.description = e.target.value; updateJson(); });
  host.querySelector('#mFiles').addEventListener('input', e => { f.files = e.target.value; updateJson(); });
  const fp = host.querySelector('#mFilesPick');
  if (fp) fp.addEventListener('click', async () => {
    // same native macOS chooser as the workbench ＋ — only when browsing at
    // the server machine (remotely the dialog would open on its screen)
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
      toast('the file dialog opens on the server machine — type the path here instead');
      return;
    }
    fp.textContent = '…';
    const r = await api('POST', '/api/pickfile', { project: f.project });
    fp.textContent = '⌖ browse…';
    if (r && r.rel) {
      const cur = f.files.split(',').map(s => s.trim()).filter(Boolean);
      if (!cur.includes(r.rel)) cur.push(r.rel);
      f.files = cur.join(', ');
      renderModal(); // re-renders the field and the JSON preview
    }
  });
  host.querySelector('#mNotes').addEventListener('input', e => { f.notes = e.target.value; updateJson(); });
  const ms = host.querySelector('#mSources');
  if (ms) ms.addEventListener('input', e => { f.web_sources = e.target.value; updateJson(); });

  host.querySelectorAll('#mCat .pillOpt').forEach(el => el.addEventListener('click', () => {
    if (f.category !== el.dataset.c) {
      // lineage candidates only change when the GROUP does — switching between
      // sibling categories (e.g. collection → cleaning) keeps the links
      if (catGroup(el.dataset.c) !== catGroup(f.category)) { f.upstream = []; f.downstream = []; }
      f.category = el.dataset.c;
    }
    renderModal();
  }));
  host.querySelectorAll('#mProj .pillOpt').forEach(el => el.addEventListener('click', () => {
    if (f.project !== el.dataset.p) { f.project = el.dataset.p; f.upstream = []; f.downstream = []; }
    renderModal();
  }));
  const toggleLineage = (id, list, other) => {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    else {
      list.push(id);
      const j = other.indexOf(id); // a task can't be both before and after
      if (j >= 0) other.splice(j, 1);
    }
    renderModal();
  };
  host.querySelectorAll('#mUp .qchip[data-u]').forEach(el => el.addEventListener('click', () =>
    toggleLineage(el.dataset.u, f.upstream, f.downstream)));
  host.querySelectorAll('#mDown .qchip[data-d]').forEach(el => el.addEventListener('click', () =>
    toggleLineage(el.dataset.d, f.downstream, f.upstream)));
  host.querySelectorAll('#mPri .pillOpt').forEach(el => el.addEventListener('click', () => {
    f.priority = el.dataset.pr; renderModal();
  }));
  host.querySelectorAll('#mOvs .ovsCard').forEach(el => el.addEventListener('click', () => {
    f.oversight = el.dataset.o; renderModal();
  }));
  host.querySelectorAll('.ctxBox .qchip[data-t]').forEach(el => el.addEventListener('click', () => {
    f[el.dataset.t] = !f[el.dataset.t]; renderModal();
  }));
  host.querySelector('#mSave').addEventListener('click', saveTask);
  host.querySelector('#mCancel').addEventListener('click', closeModal);

  updateJson();
}

async function saveTask() {
  if (!form) return;
  if (!form.title.trim()) { toast('Title required'); return; }
  const fields = buildTaskFields();
  const downstream = form.downstream.slice(); // survive closeModal()
  const task = await api('POST', '/api/tasks', fields);
  if (!task) return;
  closeModal();
  toast(`saved ${task.id || ''} → tasks/${fields.project}.json`);
  // "comes after" links live on the downstream tasks: add us to their upstream
  if (task.id) {
    for (const did of downstream) {
      const dt = tasksOf(fields.project).find(t => t.id === did);
      const ups = Array.isArray(dt?.upstream) ? dt.upstream.slice() : [];
      if (!ups.includes(task.id)) {
        ups.push(task.id);
        await api('PATCH', `/api/tasks/${enc(fields.project)}/${enc(did)}`, { upstream: ups });
      }
    }
  }
  if (task.id) perOf(fields.project).taskId = task.id;
  go(fields.project);
}

/* ───────────────────────── git panel ───────────────────────── */

const gitState = { open: false, key: null, info: null, busy: false, log: '' };

function openGitPanel() {
  gitState.open = true;
  gitState.key = state.projects[ui.view] ? ui.view : projKeys()[0];
  gitState.info = null;
  gitState.log = '';
  document.getElementById('gitBack').classList.add('show');
  renderGitPanel();
  refreshGitInfo();
}

function closeGitPanel() {
  gitState.open = false;
  document.getElementById('gitBack').classList.remove('show');
}

async function refreshGitInfo() {
  const k = gitState.key;
  const info = await api('GET', `/api/git/${enc(k)}`);
  if (gitState.key !== k || !gitState.open) return; // switched away meanwhile
  gitState.info = info;
  renderGitPanel();
}

function gitDiffColor(text) {
  return String(text).split('\n').map(l => {
    const e = esc(l);
    if (l.startsWith('+++') || l.startsWith('---')) return `<span class="gdh">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="gdm">${e}</span>`;
    if (l.startsWith('+')) return `<span class="gda">${e}</span>`;
    if (l.startsWith('-')) return `<span class="gdd">${e}</span>`;
    return e;
  }).join('\n');
}

function renderGitPanel() {
  const host = document.getElementById('gitPanel');
  if (!host || !gitState.open) return;
  const k = gitState.key;
  const info = gitState.info;
  const name = state.projects[k]?.name || k;

  const pills = projKeys().map(p =>
    `<span class="pill gp ${p === gitState.key ? 'on' : ''}" data-gp="${esc(p)}">${esc(state.projects[p]?.name || p)}</span>`).join('');

  let body;
  if (!info) {
    body = `<div class="sideNote">reading repository state…</div>`;
  } else if (!info.repo) {
    body = `<div class="sideNote" style="padding:18px 4px;">
      <b>${esc(name)}</b> is not a git repository.<br><br>
      To put it under version control: <code>cd ${esc(state.projects[k]?.root || '')} && git init</code>,
      add a .gitignore (exclude <code>data/raw</code>, build artifacts), then create a GitHub repo
      with <code>gh repo create</code>. After that this panel lights up.</div>`;
  } else {
    const dirty = info.dirty || [];
    const upBit = info.upstream
      ? `→ ${esc(info.upstream)} <span class="gAhead">${info.ahead ? `↑${info.ahead}` : ''} ${info.behind ? `↓${info.behind}` : ''}</span>${!info.ahead && !info.behind ? '<span class="gOk">✓ in sync</span>' : ''}`
      : '<span class="gWarn">no upstream — first push will set one</span>';
    body = `
      <div class="gHead">
        <span class="gBranch">⎇ ${esc(info.branch || '?')}</span> ${upBit}
        ${info.conflicted ? '<span class="gErr">⚠ merge conflicts present</span>' : ''}
      </div>
      ${info.lastCommit ? `<div class="gLast">last: <b>${esc(info.lastCommit.hash)}</b> ${esc(info.lastCommit.msg)} <span>· ${esc(fmtWhen(info.lastCommit.when))}</span></div>` : ''}
      <div class="gFiles">
        <div class="gfHead">${dirty.length ? `${dirty.length} changed file${dirty.length === 1 ? '' : 's'}` : 'working tree clean'}</div>
        ${dirty.slice(0, 60).map(d => `
          <div class="gFile" data-grel="${esc(d.path)}">
            <span class="gs ${/\?\?/.test(d.s) ? 'new' : /D/.test(d.s) ? 'del' : 'mod'}">${esc(d.s)}</span>
            <span class="gp2">${esc(d.path)}</span><span class="gdiffLink">diff</span>
          </div>`).join('')}
        ${dirty.length > 60 ? `<div class="sideNote">… ${dirty.length - 60} more</div>` : ''}
      </div>
      <div class="gDiffBox" id="gDiffBox"></div>
      <input type="text" id="gMsg" placeholder="commit message (empty → checkpoint timestamp)" autocomplete="off">
      <div class="gBtns">
        <button class="gbtn" id="gPull" ${gitState.busy ? 'disabled' : ''}>⇣ pull</button>
        <button class="gbtn go" id="gSync" ${gitState.busy ? 'disabled' : ''}>⇡ commit &amp; push</button>
        <button class="gbtn ai" id="gSteward" ${gitState.busy ? 'disabled' : ''}
          title="launch a session that groups changes into logical commits, writes messages, and pushes">🤖 delegate cleanup</button>
        <span style="flex:1"></span>
        <button class="gbtn" id="gRefresh">↻</button>
      </div>
      ${gitState.log ? `<pre class="gLog">${gitDiffColor(gitState.log)}</pre>` : ''}`;
  }

  const GH = `<svg class="ghIcon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
  host.innerHTML = `
    <div class="gTop"><span class="gTitle">${GH} GitHub</span>
      <div class="pills" style="display:inline-flex;gap:6px;margin-left:14px;">${pills}</div>
      <span id="gitClose" style="margin-left:auto;cursor:pointer;color:var(--dim);">✕</span></div>
    ${body}`;

  host.querySelector('#gitClose').addEventListener('click', closeGitPanel);
  host.querySelectorAll('[data-gp]').forEach(el => el.addEventListener('click', () => {
    if (gitState.busy) { toast('an action is running — hold on'); return; }
    gitState.key = el.dataset.gp; gitState.info = null; gitState.log = '';
    renderGitPanel(); refreshGitInfo();
  }));
  host.querySelector('#gRefresh')?.addEventListener('click', refreshGitInfo);
  host.querySelectorAll('.gFile').forEach(el => el.addEventListener('click', async () => {
    const box = host.querySelector('#gDiffBox');
    if (box._rel === el.dataset.grel && box.innerHTML) { box.innerHTML = ''; box._rel = null; return; }
    box._rel = el.dataset.grel;
    box.innerHTML = '<div class="sideNote">loading diff…</div>';
    const d = await api('GET', `/api/git/${enc(k)}/diff?rel=${enc(el.dataset.grel)}`);
    if (box._rel !== el.dataset.grel) return;
    box.innerHTML = d && d.diff ? `<pre class="gLog">${gitDiffColor(d.diff)}</pre>` : '<div class="sideNote">no diff (binary or unchanged)</div>';
  }));
  const act = async (label, fn) => {
    gitState.busy = true; gitState.log = `${label}…`; renderGitPanel();
    const r = await fn();
    gitState.busy = false;
    if (r && r.steps) {
      gitState.log = r.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.step}\n${s.output || ''}`.trim()).join('\n');
    } else {
      gitState.log = r ? (r.output || (r.ok ? 'done ✓' : r.error || 'failed')) : 'request failed';
    }
    await refreshGitInfo();
  };
  host.querySelector('#gPull')?.addEventListener('click', () =>
    act('pulling', () => api('POST', `/api/git/${enc(k)}/pull`)));
  host.querySelector('#gSync')?.addEventListener('click', () =>
    act('committing & pushing', () => api('POST', `/api/git/${enc(k)}/sync`,
      { message: host.querySelector('#gMsg')?.value || '' })));
  host.querySelector('#gSteward')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/git/${enc(k)}/steward`);
    if (r && r.ok) {
      toast(`repo steward launched (${r.id}) — watch its console`);
      closeGitPanel();
      perOf(k).taskId = r.id;
      perOf(k).fileTab = 'tail';
      go(k);
    }
  });
}

/* ───────────────────────── heartbeat / keyboard / boot ───────────────────────── */

window.addEventListener('beforeunload', (e) => {
  const dirtyHtml = Object.values(htmlEdits).some(s => s && s.dirty);
  if (Object.keys(drafts).length || dirtyHtml) { e.preventDefault(); e.returnValue = ''; }
});

const IDLE_LIMIT_MS = 5 * 60 * 1000; // focused-but-away windows stop logging time
let lastActivity = Date.now();
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
  window.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));

function startHeartbeat() {
  setInterval(() => {
    try {
      // week rollover: ledger displays would otherwise show last week's totals
      // until the next ledger event after Monday 00:00
      if (state.ledger?.since && (Date.now() - Date.parse(state.ledger.since)) > 7 * 86400000) {
        loadState().then(renderAll);
      }
      if (!document.hasFocus()) return;
      if (Date.now() - lastActivity > IDLE_LIMIT_MS) return; // present but idle
      const k = ui.view;
      if (!state.projects[k]) return; // only while a project view is open
      apiQuiet('POST', '/api/heartbeat', { project: k, seconds: 30 });
      // sweep expanded folder pins so files created on disk appear without a reload
      for (const rel of perOf(k).openDirs || []) ensureDir(k, rel);
    } catch (err) { console.warn('[ui] heartbeat', err); }
  }, 30000);
}

/* ── Julia-style LaTeX completion: type \beta then Tab → β ──────────────────
   Works in every prose input (composer, Add Task fields, searches) via the
   delegated handler in wireGlobal; the code editor opts in for .jl files only
   (its Tab is indentation, and .tex files are full of intentional \alpha). */
const TEX_SYMS = {
  // greek (Julia/LaTeX names: \epsilon ϵ vs \varepsilon ε, \phi ϕ vs \varphi φ)
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // operators & relations
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  cdots: '⋯', ldots: '…', dots: '…', prime: '′', infty: '∞', partial: '∂', nabla: '∇',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', sqrt: '√', propto: '∝',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', equiv: '≡', neq: '≠', ne: '≠',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', prec: '≺', succ: '≻',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', lor: '∨',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙',
  perp: '⊥', parallel: '∥', angle: '∠', therefore: '∴', because: '∵',
  vdash: '⊢', dashv: '⊣', models: '⊨', top: '⊤', bot: '⊥',
  // arrows
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', hookrightarrow: '↪',
  longrightarrow: '⟶', implies: '⟹', iff: '⟺',
  // letterlike & sets (Julia's \bb…/\scr… names)
  hbar: 'ℏ', ell: 'ℓ', wp: '℘', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  bbN: 'ℕ', bbZ: 'ℤ', bbQ: 'ℚ', bbR: 'ℝ', bbC: 'ℂ', bbE: '𝔼', bbP: 'ℙ', bbone: '𝟙',
  scrF: 'ℱ', scrG: '𝒢', scrH: 'ℋ', scrL: 'ℒ', scrO: '𝒪',
  // misc
  degree: '°', checkmark: '✓', dagger: '†', ddagger: '‡', S: '§', P: '¶',
  copyright: '©', euro: '€', pounds: '£', yen: '¥', cent: '¢',
  // super/subscripts: \^2 → ², \_t → ₜ
  '^0': '⁰', '^1': '¹', '^2': '²', '^3': '³', '^4': '⁴', '^5': '⁵', '^6': '⁶', '^7': '⁷',
  '^8': '⁸', '^9': '⁹', '^+': '⁺', '^-': '⁻', '^=': '⁼', '^(': '⁽', '^)': '⁾', '^n': 'ⁿ', '^i': 'ⁱ',
  '_0': '₀', '_1': '₁', '_2': '₂', '_3': '₃', '_4': '₄', '_5': '₅', '_6': '₆', '_7': '₇',
  '_8': '₈', '_9': '₉', '_+': '₊', '_-': '₋', '_=': '₌', '_(': '₍', '_)': '₎',
  '_a': 'ₐ', '_e': 'ₑ', '_i': 'ᵢ', '_j': 'ⱼ', '_k': 'ₖ', '_m': 'ₘ', '_n': 'ₙ', '_t': 'ₜ', '_x': 'ₓ',
};

/* Replace a trailing \name (or \^2 / \_t) before the caret with its symbol.
   → true (converted) | 'miss' (a \name attempt, unknown) | false (nothing). */
function texComplete(el) {
  const pos = el.selectionStart;
  if (pos == null || pos !== el.selectionEnd) return false;
  const before = el.value.slice(Math.max(0, pos - 24), pos);
  const m = before.match(/\\([A-Za-z]+|[\^_][0-9A-Za-z+\-=()])$/);
  if (!m) return false;
  const sym = TEX_SYMS[m[1]];
  if (!sym) return 'miss';
  const start = pos - m[0].length;
  el.setSelectionRange(start, pos);
  // execCommand keeps native undo (⌘Z restores the \name); fall back if gone
  if (!document.execCommand || !document.execCommand('insertText', false, sym)) {
    el.setRangeText(sym, start, pos, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

function wireGlobal() {
  // Julia-style \symbol completion in every prose input — delegated, so it
  // survives the constant re-renders. The code editor handles its own Tab
  // (indentation + .jl completion) and preventDefaults before this runs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    const el = e.target;
    if (!el || el.id === 'codeEditor') return;
    const isText = el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type || ''));
    if (!isText) return;
    // converted → eat the Tab; attempted-but-unknown → still eat it, a failed
    // completion must not throw focus across the page
    if (texComplete(el)) e.preventDefault();
  });

  // direct children (Overview) + .right tabs (categories); #navProjects tabs
  // are (re)bound by renderNav on every render, so exclude them here.
  document.querySelectorAll('#nav > .tab[data-v], #nav .right .tab[data-v]').forEach(t =>
    t.addEventListener('click', () => go(t.dataset.v)));
  document.getElementById('openModal')?.addEventListener('click', () => openModal());
  document.getElementById('gitBtn')?.addEventListener('click', openGitPanel);

  // profile menu — placeholder items for now; functionality comes later
  const pb = document.getElementById('profileBtn');
  if (pb) pb.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('profileMenu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'profileMenu';
    menu.innerHTML = ['About You', 'Manage Projects', 'Project History', 'Settings']
      .map(t => `<div class="pmItem" data-pm="${esc(t)}">${esc(t)}</div>`).join('');
    pb.appendChild(menu);
    menu.querySelectorAll('.pmItem').forEach(it => it.addEventListener('click', () => {
      // no stopPropagation: the document once-listener below closes the menu
      if (it.dataset.pm === 'Manage Projects') { go('manage'); return; }
      if (it.dataset.pm === 'About You') { go('about'); return; }
      if (it.dataset.pm === 'Settings') { go('settings'); return; }
      toast(`${it.dataset.pm} — coming soon`);
    }));
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });
  const gback = document.getElementById('gitBack');
  gback?.addEventListener('click', e => { if (e.target === gback) closeGitPanel(); });
  const back = document.getElementById('modalBack');
  back?.addEventListener('click', e => { if (e.target === back) closeModal(); });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '0' && e.key <= '5') {
      e.preventDefault();
      if (e.key === '0') { go('ov'); return; }
      const k = projKeys()[+e.key - 1];
      if (k) go(k);
    }
    if (e.key === 'Escape') { closeModal(); closeGitPanel(); }
  });
}

(async function init() {
  try {
    wireGlobal();
    await loadState();
    renderAll();
    connectWS();
    startHeartbeat();
    // deep links: #cats, #ov, #<projectKey>, #new or #new:<category> (Add Task)
    const h = decodeURIComponent((location.hash || '').slice(1));
    if (h === 'git') { openGitPanel(); }
    else if (h === 'new' || h.startsWith('new:')) {
      openModal();
      const cat = h.slice(4);
      if (form && state.categories?.[cat]) { form.category = cat; renderModal(); }
    } else {
      const [v, sub] = h.split(':');
      if (v === 'cats' || v === 'ov' || state.projects[v]) {
        if (sub === 'console' && state.projects[v]) perOf(v).fileTab = 'tail';
        go(v);
      }
    }
  } catch (err) {
    console.error('[ui] init failed', err);
    toast('UI failed to initialise: ' + (err.message || err));
  }
})();
