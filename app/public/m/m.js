// Central Planner — phone view. Same REST + WS API as the desktop app;
// scoped to the away-from-desk loop: see tasks, unblock sessions, launch,
// add tasks, open artifacts. No build step; everything through esc().
'use strict';

const enc = encodeURIComponent;

const state = {
  projects: {}, categories: {}, tasks: {}, artifacts: [],
  ledger: null, sessions: [],
};
const ui = {
  tab: 'tasks',          // 'tasks' | 'art'
  open: null,            // { project, id } — task sheet
  addOpen: false,
};
const transcripts = {};  // `${p}/${id}` → { entries, fetched }
const liveBufs = {};     // `${p}/${id}` → in-turn assistant text
const pendingPerms = {}; // `${p}/${id}` → [{requestId, tool, input}, …]
const drafts = {};       // `${p}/${id}` → unsent composer text (survives re-renders)

/* ───────── helpers ───────── */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const hrs = (s) => ((s || 0) / 3600).toFixed(1);
function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function ago(iso) {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
const OVS = { auto: 'AUTO', propose: 'PROP', coop: 'COOP', manual: 'MAN' };
const projColor = (k) => state.projects[k]?.color || '#888';
const projName = (k) => state.projects[k]?.name || k;
const taskOf = (p, id) => (state.tasks[p] || []).find(t => t && t.id === id) || null;

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = String(msg);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { toast(data.error || `${method} failed (${res.status})`); return null; }
    return data;
  } catch (err) {
    toast('offline? ' + (err.message || err));
    return null;
  }
}

/* ───────── data ───────── */

async function loadState() {
  const d = await api('GET', '/api/state');
  if (!d) return;
  state.projects = d.projects || {};
  state.categories = d.categories || {};
  state.tasks = d.tasks || {};
  state.artifacts = Array.isArray(d.artifacts) ? d.artifacts : [];
  state.ledger = d.ledger || null;
  state.sessions = Array.isArray(d.sessions) ? d.sessions : [];
}

async function refreshTranscript(p, id) {
  const k = `${p}/${id}`;
  const d = await api('GET', `/api/transcript/${enc(p)}/${enc(id)}`);
  transcripts[k] = { entries: (d && d.transcript) || [], fetched: true };
  if (ui.open && ui.open.project === p && ui.open.id === id) renderTask();
}

/* ───────── websocket ───────── */

let wsFirst = true;
function connectWS() {
  let ws;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { setTimeout(connectWS, 3000); return; }
  ws.onopen = async () => {
    if (!wsFirst) { await loadState(); renderAll(); }
    wsFirst = false;
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { handleEvent(msg.type, msg.payload); } catch (err) { console.warn(err); }
  };
}

function handleEvent(type, p) {
  switch (type) {
    case 'task:update': {
      if (!p || !p.task) break;
      const arr = state.tasks[p.project] || (state.tasks[p.project] = []);
      const i = arr.findIndex(t => t && t.id === p.task.id);
      if (i >= 0) arr[i] = p.task; else arr.push(p.task);
      renderAll();
      break;
    }
    case 'session:status': {
      if (!p) break;
      const t = taskOf(p.project, p.id);
      if (t && p.status) t.status = p.status;
      if (p.error) toast(p.error);
      if (p.status && p.status !== 'running') {
        delete liveBufs[`${p.project}/${p.id}`];
        refreshTranscript(p.project, p.id);
      }
      renderAll();
      break;
    }
    case 'session:stream': {
      if (!p) break;
      const k = `${p.project}/${p.id}`;
      liveBufs[k] = ((liveBufs[k] || '') + String(p.chunk ?? '')).slice(-60000);
      if (ui.open && ui.open.project === p.project && ui.open.id === p.id) {
        const live = document.getElementById('mLive');
        if (live) {
          live.textContent = liveBufs[k];
          live.scrollTop = live.scrollHeight;
        } else renderTask();
      }
      break;
    }
    case 'session:permission': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      (pendingPerms[pk] = pendingPerms[pk] || []).push({ requestId: p.requestId, tool: p.tool, input: p.input });
      toast(`⏳ approval needed — ${p.tool}`);
      renderAll();
      break;
    }
    case 'session:permission:resolved': {
      if (!p || !p.project) break;
      const pk = `${p.project}/${p.id}`;
      if (pendingPerms[pk]) {
        pendingPerms[pk] = pendingPerms[pk].filter(x => x.requestId !== p.requestId);
        if (!pendingPerms[pk].length) delete pendingPerms[pk];
      }
      renderAll();
      break;
    }
    case 'ledger:update': {
      state.ledger = p || state.ledger;
      renderChip();
      break;
    }
    case 'artifact:new': {
      const a = p && p.artifact;
      if (!a) break;
      const i = state.artifacts.findIndex(x => x.project === a.project && x.rel === a.rel);
      if (i >= 0) state.artifacts.splice(i, 1);
      state.artifacts.unshift(a);
      if (ui.tab === 'art') renderMain();
      break;
    }
    case 'state': { /* full snapshot on (re)connect */
      if (p) {
        state.projects = p.projects || state.projects;
        state.categories = p.categories || state.categories;
        state.tasks = p.tasks || state.tasks;
        state.artifacts = Array.isArray(p.artifacts) ? p.artifacts : state.artifacts;
        state.ledger = p.ledger || state.ledger;
        renderAll();
      }
      break;
    }
    default: break;
  }
}

/* ───────── render: chrome ───────── */

function renderChip() {
  const t = state.ledger?.totals;
  document.getElementById('wkChip').innerHTML = t
    ? `wk <b>${hrs(t.seconds)}h</b> · <b class="y">${fmtTok(t.tokens)} tok</b>` : '—';
}

function renderAll() {
  renderChip();
  renderMain();
  if (ui.open) renderTask();
}

/* ───────── render: task list / artifacts ───────── */

function allTasksFlat() {
  const out = [];
  for (const k of Object.keys(state.projects)) {
    for (const t of state.tasks[k] || []) {
      if (!t) continue;
      // hide archived tasks UNLESS they still need you — an archived task that
      // is running/waiting (Claude asking, or a handoff to accept) must stay
      // reachable from the phone, which has no archived view
      if (t.archived && !(t.status === 'running' || t.status === 'waiting')) continue;
      out.push({ k, t });
    }
  }
  return out;
}

function card({ k, t }) {
  const stat = t.status === 'running' ? '<span class="stat run">● running</span>'
    : t.status === 'waiting' ? '<span class="stat wait">⏸ waiting on you</span>'
    : t.status === 'queued' ? '<span class="stat queue">queued</span>'
    : t.status === 'manual' ? '<span class="stat">todo</span>'
    : '<span class="stat done">✓ done</span>';
  const when = t.session?.lastTurnAt || t.created;
  return `<div class="card" data-p="${esc(k)}" data-id="${esc(t.id)}">
    <div class="t"><span class="dot" style="background:${esc(projColor(k))}"></span>${esc(t.title)}</div>
    <div class="sub">${stat}
      <span class="ovs ${esc(t.oversight)}">${OVS[t.oversight] || ''}</span>
      <span>${esc(projName(k))}</span>
      <span>${esc(ago(when))}</span></div>
    ${t.status === 'waiting' && t.question ? `<div class="q">❓ ${esc(t.question)}</div>` : ''}
  </div>`;
}

function section(title, items, emptyNote) {
  if (!items.length && !emptyNote) return '';
  return `<div class="sh">${title} <span class="n">${items.length || ''}</span></div>`
    + (items.length ? items.map(card).join('') : `<div class="empty">${emptyNote}</div>`);
}

function renderMain() {
  const host = document.getElementById('view');
  document.querySelectorAll('#tabbar [data-tab]').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === ui.tab));

  if (ui.tab === 'art') {
    host.innerHTML = `<div class="sh">recent artifacts</div>` +
      (state.artifacts.slice(0, 30).map(a => `
        <div class="art" data-u="/artifact/${enc(a.project)}/${a.rel.split('/').map(enc).join('/')}">
          <span class="ic">${a.kind === 'pdf' ? '◫' : '⌗'}</span>
          <span class="an"><b>${esc(a.name)}</b>
            <span>${esc(projName(a.project))} · ${esc(ago(a.mtime))}</span></span>
          <span class="open">open ↗</span>
        </div>`).join('')
        || '<div class="empty">no artifacts yet — html and pdf files appear here as sessions create them</div>');
    host.querySelectorAll('.art').forEach(el =>
      el.addEventListener('click', () => window.open(el.dataset.u, '_blank')));
    return;
  }

  const all = allTasksFlat();
  // a task with a pending approval needs you, whatever its status says
  const needsApproval = all.filter(x => (pendingPerms[`${x.k}/${x.t.id}`] || []).length);
  const waiting = all.filter(x => x.t.status === 'waiting' && !needsApproval.includes(x));
  const running = all.filter(x => x.t.status === 'running');
  const queued = all.filter(x => x.t.status === 'queued');
  const manual = all.filter(x => x.t.status === 'manual');
  const done = all.filter(x => x.t.status === 'done')
    .sort((a, b) => Date.parse(b.t.session?.lastTurnAt || b.t.created) - Date.parse(a.t.session?.lastTurnAt || a.t.created))
    .slice(0, 5);

  host.innerHTML =
    section('⏳ approval needed', needsApproval, '') +
    section('⏸ needs you', waiting, '') +
    section('● running', running.filter(x => !needsApproval.includes(x)), '') +
    section('queued', queued, 'nothing queued — ＋ to add a task') +
    section('todo (manual)', manual, '') +
    section('recently done', done, '');

  host.querySelectorAll('.card').forEach(el =>
    el.addEventListener('click', () => openTask(el.dataset.p, el.dataset.id)));
}

/* ───────── task sheet ───────── */

function openTask(p, id) {
  ui.open = { project: p, id };
  const k = `${p}/${id}`;
  if (!transcripts[k]) { transcripts[k] = { entries: [], fetched: false }; refreshTranscript(p, id); }
  renderTask();
  document.getElementById('taskSheet').classList.add('show');
}

function closeTask() {
  ui.open = null;
  document.getElementById('taskSheet').classList.remove('show');
}

function handoffHtml(t) {
  const h = t.handoff || {};
  const arts = Array.isArray(h.artifacts) ? h.artifacts : [];
  const nums = Array.isArray(h.numbers) ? h.numbers : [];
  const decs = Array.isArray(h.decisions) ? h.decisions : [];
  return `<div class="handoff">
    <div class="hh">${t.status === 'done' ? '✓ COMPLETE — HANDOFF' : '📋 PROPOSED HANDOFF — NOT YET ACCEPTED'}</div>
    <div class="hsum">${esc(h.summary || '')}</div>
    ${arts.length ? '<div class="hsec">files that matter</div>' + arts.map(a => {
      const [f, n] = Array.isArray(a) ? a : [a, ''];
      return `<div class="hrow">${esc(f)}${n ? ' — ' + esc(n) : ''}</div>`;
    }).join('') : ''}
    ${nums.length ? '<div class="hsec">key numbers</div>' + nums.map(x => {
      const [kk, v] = Array.isArray(x) ? x : [x, ''];
      return `<div class="hrow">${esc(kk)}: <b>${esc(v)}</b></div>`;
    }).join('') : ''}
    ${decs.length ? '<div class="hsec">decisions</div>' + decs.map(d => `<div class="hrow">· ${esc(d)}</div>`).join('') : ''}
    ${h.next ? `<div class="hsec">note downstream</div><div class="hrow">${esc(h.next)}</div>` : ''}
  </div>`;
}

function permCardM(k) {
  const perm = (pendingPerms[k] || [])[0];
  if (!perm) return '';
  const inp = perm.input || {};
  const target = inp.file_path || inp.notebook_path || inp.path || '';
  let detail = '';
  if (perm.tool === 'Bash') {
    detail = `<pre class="mPermCmd">${esc(String(inp.command || '').slice(0, 600))}</pre>`;
  } else if (target) {
    detail = `<div class="mPermFile">${esc(target)}</div>`;
  }
  if (perm.tool === 'Edit') {
    detail += `<div class="mPermDiff"><span class="del">− ${esc(String(inp.old_string || '').slice(0, 220))}</span>
      <span class="add">+ ${esc(String(inp.new_string || '').slice(0, 220))}</span></div>`;
  }
  return `<div class="mPerm">
    <b>⏳ approval — ${esc(perm.tool)}</b>${inp.description ? `<div class="mPermDesc">${esc(String(inp.description).slice(0, 140))}</div>` : ''}
    ${detail}
    <div class="mPermBtns">
      <button class="abtn warn" id="aPermDeny">✗ deny</button>
      <button class="abtn go" id="aPermAllow">✓ approve</button>
    </div>
  </div>`;
}

function renderTask() {
  const sheet = document.getElementById('taskSheet');
  if (!ui.open) return;
  const { project: p, id } = ui.open;
  const t = taskOf(p, id);
  if (!t) { closeTask(); return; }

  const k = `${p}/${id}`;
  const tr = transcripts[k] || { entries: [], fetched: false };
  const live = liveBufs[k];

  const logHtml = tr.entries.map(e => `
    <div class="msg ${e.role === 'user' ? 'you' : ''}">
      <div class="who">${e.role === 'user' ? 'you' : 'claude'}</div>
      <div class="bub">${esc(e.text)}</div>
    </div>`).join('')
    + (live && t.status === 'running' ? `
    <div class="msg live"><div class="who">claude — live</div>
      <div class="bub" id="mLive">${esc(live)}</div></div>` : '');

  let actions = '';
  if (t.status === 'running') {
    actions = `<button class="abtn warn wide" id="aInterrupt">■ interrupt turn <span class="spin">⟳</span></button>`;
  } else if (t.status === 'queued') {
    actions = `<button class="abtn go wide" id="aLaunch">▶ Launch session</button>`;
  } else if (t.status === 'manual') {
    actions = `<button class="abtn go wide" id="aDone">✓ mark done</button>`;
  } else if (t.oversight !== 'manual' && t.status !== 'done') {
    actions = `${t.status === 'waiting' && t.handoff
      ? '<button class="abtn go wide" id="aAccept">✓ accept handoff — close task</button>' : ''}
      <textarea id="aText" rows="1" placeholder="${t.status === 'waiting' && t.question ? 'answer Claude…' : 'message the session…'}">${esc(drafts[k] || '')}</textarea>
      <button class="abtn go" id="aSend">↑</button>`;
  }

  sheet.innerHTML = `
    <div class="shHead">
      <button class="back" id="aBack">‹ back</button>
      <span class="ht">${esc(t.title)}</span>
    </div>
    <div class="shBody">
      <div class="meta">
        <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${esc(projColor(p))}"></span>
        <span class="mchip">${esc(projName(p))}</span>
        <span class="ovs ${esc(t.oversight)}">${OVS[t.oversight] || ''}</span>
        <span class="mchip">${esc(t.category || '')}</span>
        <span class="mchip">${esc(t.id)}</span>
      </div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
      ${permCardM(k)}
      ${t.status === 'waiting' && t.question ? `<div class="qbanner"><b>❓ CLAUDE IS ASKING</b>${esc(t.question)}</div>` : ''}
      ${t.status === 'waiting' && t.handoff ? `<div class="qbanner"><b>📋 PROPOSED COMPLETE</b>review the handoff — accept below, or reply to keep working</div>${handoffHtml(t)}` : ''}
      ${t.status === 'done' && t.handoff ? handoffHtml(t) : ''}
      ${tr.entries.length || live ? `<div class="sh" style="margin-top:4px;">session</div><div class="log">${logHtml}</div>`
        : (tr.fetched ? '<div class="empty">no session turns yet</div>' : '<div class="empty">loading transcript…</div>')}
    </div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}`;

  sheet.querySelector('#aBack').addEventListener('click', closeTask);
  const perm0 = (pendingPerms[k] || [])[0];
  if (perm0) {
    const resolvePerm = (allow) =>
      api('POST', `/api/tasks/${enc(p)}/${enc(id)}/permission`, { requestId: perm0.requestId, allow });
    sheet.querySelector('#aPermAllow')?.addEventListener('click', () => resolvePerm(true));
    sheet.querySelector('#aPermDeny')?.addEventListener('click', () => resolvePerm(false));
  }
  sheet.querySelector('#aLaunch')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/tasks/${enc(p)}/${enc(id)}/launch`);
    if (r) toast('session launched');
  });
  sheet.querySelector('#aInterrupt')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/tasks/${enc(p)}/${enc(id)}/interrupt`);
    if (r) toast('interrupt sent');
  });
  sheet.querySelector('#aDone')?.addEventListener('click', async () => {
    const r = await api('PATCH', `/api/tasks/${enc(p)}/${enc(id)}`, { status: 'done' });
    if (r) toast('marked done');
  });
  sheet.querySelector('#aAccept')?.addEventListener('click', async () => {
    const r = await api('PATCH', `/api/tasks/${enc(p)}/${enc(id)}`,
      { status: 'done', logNote: 'handoff accepted by user' });
    if (r) toast('task closed ✓');
  });
  const at = sheet.querySelector('#aText');
  at?.addEventListener('input', () => { drafts[k] = at.value; });
  const send = async () => {
    const text = at.value.trim();
    if (!text) return;
    at.value = '';
    delete drafts[k];
    const r = await api('POST', `/api/tasks/${enc(p)}/${enc(id)}/message`, { text });
    if (r) toast('sent — turn started');
  };
  sheet.querySelector('#aSend')?.addEventListener('click', send);
  at?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  const lastBub = sheet.querySelector('.log .msg:last-child .bub');
  if (lastBub) lastBub.scrollTop = lastBub.scrollHeight;
}

/* ───────── add task ───────── */

let form = null;

function catGroups() {
  const order = [];
  const by = new Map();
  for (const [k, raw] of Object.entries(state.categories || {})) {
    const c = (typeof raw === 'string') ? { primer: raw } : (raw || {});
    const g = c.group || 'Other';
    if (!by.has(g)) { by.set(g, []); order.push(g); }
    by.get(g).push([k, c]);
  }
  return order.map(g => [g, by.get(g)]);
}
const GCOL = { Structural: 'var(--purple)', Empirics: 'var(--blue)', Literature: 'var(--yellow)', 'Final Goods': 'var(--green)' };

function openAdd() {
  form = {
    title: '', description: '', notes: '',
    category: Object.keys(state.categories || {})[0] || '',
    project: Object.keys(state.projects)[0] || '',
    oversight: 'coop',
  };
  ui.addOpen = true;
  renderAdd();
  document.getElementById('addSheet').classList.add('show');
}

function closeAdd() {
  ui.addOpen = false;
  form = null;
  document.getElementById('addSheet').classList.remove('show');
}

function renderAdd() {
  const sheet = document.getElementById('addSheet');
  const f = form;
  if (!f) return;
  sheet.innerHTML = `
    <div class="shHead">
      <button class="back" id="nBack">‹ cancel</button>
      <span class="ht">New task</span>
    </div>
    <div class="shBody">
      <div class="fld"><div class="flbl">Title</div>
        <input type="text" id="nTitle" placeholder="what needs doing?" value="${esc(f.title)}"></div>
      <div class="fld"><div class="flbl">Description — what does done look like?</div>
        <textarea id="nDesc" rows="3" placeholder="Done = …">${esc(f.description)}</textarea></div>
      <div class="fld"><div class="flbl">Project</div>
        <div class="pills">${Object.keys(state.projects).map(k =>
          `<span class="pill ${f.project === k ? 'on' : ''}" data-p="${esc(k)}">${esc(projName(k))}</span>`).join('')}</div></div>
      <div class="fld"><div class="flbl">Category</div>
        ${catGroups().map(([g, entries]) => `
        <div class="cgRow"><span class="gl" style="color:${GCOL[g] || 'var(--blue)'}">${esc(g)}</span>
          <div class="pills">${entries.map(([k, c]) =>
            `<span class="pill ${f.category === k ? 'on' : ''}" data-c="${esc(k)}">${esc(c.name || k)}</span>`).join('')}</div></div>`).join('')}</div>
      <div class="fld"><div class="flbl">Oversight</div>
        <div class="ovsRow">${[
          ['auto', 'Autopilot', 'runs to completion unattended'],
          ['propose', 'Propose first', 'plans, then waits for sign-off'],
          ['coop', 'Cooperative', 'short turns, live back-and-forth'],
          ['manual', 'Manual', 'no agent — a tracked todo'],
        ].map(([o, t2, d]) => `<div class="ovsCard ${f.oversight === o ? 'on' : ''}" data-o="${o}">
          <div class="ot"><span class="ovs ${o}">${OVS[o]}</span> ${t2}</div><div class="od">${d}</div></div>`).join('')}</div></div>
      <div class="fld"><div class="flbl">Notes for Claude</div>
        <textarea id="nNotes" rows="2" placeholder="background, constraints…">${esc(f.notes)}</textarea></div>
      <button class="abtn go wide" id="nSave" style="width:100%;">Save task</button>
      <div class="empty" style="text-align:center;margin-top:8px;">lineage and pinned files are desktop affordances — add them there later if needed</div>
    </div>`;

  sheet.querySelector('#nBack').addEventListener('click', closeAdd);
  sheet.querySelector('#nTitle').addEventListener('input', e => { f.title = e.target.value; });
  sheet.querySelector('#nDesc').addEventListener('input', e => { f.description = e.target.value; });
  sheet.querySelector('#nNotes').addEventListener('input', e => { f.notes = e.target.value; });
  sheet.querySelectorAll('[data-p]').forEach(el => el.addEventListener('click', () => { f.project = el.dataset.p; renderAdd(); }));
  sheet.querySelectorAll('[data-c]').forEach(el => el.addEventListener('click', () => { f.category = el.dataset.c; renderAdd(); }));
  sheet.querySelectorAll('[data-o]').forEach(el => el.addEventListener('click', () => { f.oversight = el.dataset.o; renderAdd(); }));
  sheet.querySelector('#nSave').addEventListener('click', async () => {
    if (!f.title.trim()) { toast('title required'); return; }
    const r = await api('POST', '/api/tasks', {
      project: f.project,
      title: f.title,
      description: f.description,
      category: f.category,
      oversight: f.oversight,
      status: f.oversight === 'manual' ? 'manual' : 'queued',
      context: { notes: f.notes },
    });
    if (!r) return;
    closeAdd();
    toast(`saved ${r.id || ''}`);
    ui.tab = 'tasks';
    renderMain();
  });
}

/* ───────── boot ───────── */

document.querySelectorAll('#tabbar [data-tab]').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.tab === 'add') { openAdd(); return; }
    ui.tab = b.dataset.tab;
    renderMain();
  }));

(async function init() {
  await loadState();
  renderAll();
  connectWS();
  // deep links: #t=project/taskId opens a task, #add opens the new-task form,
  // #art opens artifacts — notification links can target these
  const h = decodeURIComponent((location.hash || '').slice(1));
  if (h === 'add') openAdd();
  else if (h === 'art') { ui.tab = 'art'; renderMain(); }
  else if (h.startsWith('t=')) {
    const [p, id] = h.slice(2).split('/');
    if (taskOf(p, id)) openTask(p, id);
  }
})();
