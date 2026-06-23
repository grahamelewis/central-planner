# projectManager — Build Contract (v1)

Single Node.js process serving a research-project dashboard. **All modules MUST conform to this
contract exactly** — module interfaces, REST routes, WS event names, and JSON schemas below are
frozen. Plain JavaScript, ESM (`"type":"module"`), Node >= 20. No TypeScript, no bundler, no
frameworks beyond the fixed dependency list.

## Fixed dependencies (package.json already written — do not add others)
- express ^4
- ws ^8
- chokidar ^4
- @anthropic-ai/claude-agent-sdk (latest)

## File tree & ownership

```
projectManager/
  app/
    server.js            ← Agent CORE
    lib/config.js        ← already written (read it; import from it)
    lib/events.js        ← Agent CORE
    lib/taskStore.js     ← Agent CORE
    lib/ledger.js        ← Agent CORE
    lib/sessions.js      ← Agent SESSIONS
    lib/watchers.js      ← Agent WATCHERS
    public/index.html    ← Agent FRONTEND
    public/app.js        ← Agent FRONTEND
    public/style.css     ← Agent FRONTEND
  tasks/<project>.json   ← seed data already written (taskStore reads/writes)
  categories.json        ← seed data already written
  abstracts/<key>.md     ← seed data already written (living abstracts)
  ledger/ledger.jsonl    ← append-only, ledger.js owns
```

Each agent writes ONLY its own files. Import other modules per the signatures below and trust them.

## lib/config.js (already exists — import, never modify)

```js
export const PORT = 4242;
export const ROOT;          // absolute path to projectManager/
export const APP_DIR;       // projectManager/app
export const PROJECTS = {   // key → { name, root, color, texWatch, status }  (loaded from config.json)
  myproject: { name:'My Project', root:'/absolute/path/to/project', color:'#7ef5c2', texWatch:null, status:'active' },
  // … one entry per project …
};
export const ARTIFACT_GLOBS;   // { ignoreDirs: [...], maxDepth: 6 }
export const WEEKLY_HOUR_TARGET = 35;
export const WEEKLY_TOKEN_BUDGET_USD = 60;
```

## lib/events.js (Agent CORE)

WS hub + event bus. Exports:

```js
export function initWss(httpServer)        // attach ws.Server at path '/ws'
export function broadcast(type, payload)   // JSON.stringify({type, payload}) to all clients
export function onClientConnect(fn)        // fn(socketSend) called per new client (send snapshot)
```

## lib/taskStore.js (Agent CORE)

Owns `ROOT/tasks/<project>.json` (each file = JSON array of task objects) and `ROOT/categories.json`.
Synchronous fs is fine. Every mutation: write file atomically (tmp+rename), then
`broadcast('task:update', {project, task})`.

```js
export function listTasks(project)             // → Task[]
export function allTasks()                     // → {project: Task[]}
export function getTask(project, id)           // → Task | null
export function createTask(project, fields)    // assigns id `${project.slice(0,3)}-<n>`, created ISO; → Task
export function updateTask(project, id, patch) // shallow merge, appends {ts,note} to task.log if patch.logNote; → Task
export function getCategories()                // → categories.json parsed
export function getAbstract(project)           // → string (abstracts/<project>.md contents or '')
```

### Task schema (canonical)

```json
{
  "id": "myp-001",
  "title": "...", "description": "...",
  "project": "myproject",
  "category": "calibration",
  "upstream": ["myp-000"],
  "priority": "high|medium|low",
  "oversight": "auto|propose|coop|manual",
  "status": "queued|running|waiting|done|manual",
  "question": null,
  "context": {
    "include_abstract": true, "include_last_session": true,
    "include_sibling_tasks": true, "include_category_primer": true,
    "web_search": { "enabled": false, "sources": [] },
    "files": ["relative/or/absolute/paths"],
    "notes": "..."
  },
  "budget": { "tokens": 500000 },
  "session": null,
  "handoff": null,
  "created": "ISO", "due": null, "log": []
}
```

`session` when set: `{ sdkSessionId, startedAt, lastTurnAt, tokensIn, tokensOut, costUsd, turns }`.
`handoff` when set: `{ summary, artifacts: [[path, note],...], numbers: [[k,v],...], decisions: [..], next }`.

## lib/ledger.js (Agent CORE)

Append-only JSONL at `ROOT/ledger/ledger.jsonl`. Lines:
`{"ts":ISO,"type":"time","project":k,"seconds":30}` and
`{"ts":ISO,"type":"tokens","project":k,"taskId":id,"in":n,"out":n,"costUsd":x}`.

```js
export function logTime(project, seconds)
export function logTokens(project, taskId, tokensIn, tokensOut, costUsd)
export function weekSummary()  // → { since, perProject: {k:{seconds,tokensIn,tokensOut,costUsd}},
                               //     totals: {seconds,tokens,costUsd},
                               //     hourTarget, tokenBudgetUsd }  (week starts Monday 00:00 local)
```
After logTime/logTokens: `broadcast('ledger:update', weekSummary())`.

## lib/sessions.js (Agent SESSIONS)

Drives Claude Code via `@anthropic-ai/claude-agent-sdk`'s `query()`. One *task* maps to one SDK
session id, reused across turns via `options.resume`. Each call to `query()` is one TURN: the
agent runs its agentic loop to completion for that turn (this is how autopilot does a whole task
in one turn). Process exits between turns; that's fine.

```js
export function launchTask(project, id)              // assemble context packet, start turn 1
export function sendMessage(project, id, text)       // resume session with a new user turn
export function interrupt(project, id)               // q.interrupt() on the active turn if any
export function activeSessions()                     // → [{project, id, startedAt, status}]
```

### SDK usage (essential API — follow this)

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
const q = query({
  prompt: text,                          // string per turn
  options: {
    cwd: PROJECTS[project].root,
    resume: task.session?.sdkSessionId,  // undefined on first turn
    permissionMode,                      // see oversight mapping
    settingSources: ['project'],         // respect each repo's .claude settings
    allowedTools,                        // see below
    systemPrompt: { type: 'preset', preset: 'claude_code', append: oversightAppendix },
    includePartialMessages: true,
  }
});
for await (const msg of q) {
  // msg.type === 'system' && msg.subtype === 'init'  → msg.session_id (store it)
  // msg.type === 'stream_event'                       → partial deltas:
  //     msg.event.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta'
  //     → broadcast('session:stream', {project, id, chunk: msg.event.delta.text})
  // msg.type === 'assistant' → full message; for tool_use blocks broadcast a one-line summary:
  //     broadcast('session:stream', {project, id, chunk:`\n[tool: ${block.name}] ${short}\n`})
  // msg.type === 'result' → msg.usage {input_tokens, output_tokens}, msg.total_cost_usd,
  //     msg.result (final text), msg.session_id
}
```

### Oversight → SDK mapping
- `auto`    → permissionMode `'auto'`  (model classifier approves routine calls; dangerous ones still ask; was `'acceptEdits'` in v1. The 🛡 per-task override can force `'bypassPermissions'` — passed with `allowDangerouslySkipPermissions: true`.)
- `propose` → permissionMode `'plan'`
- `coop`    → permissionMode `'auto'`  (classifier, same as auto — coop's oversight is conversational; 🛡 override `'default'` restores ask-first; was `'default'` in v1)
- `manual`  → launchTask must refuse (400)

`allowedTools`: omit (defaults) — but when `context.web_search.enabled`, ensure `'WebSearch'` and
`'WebFetch'` are included via `allowedTools: ['WebSearch','WebFetch']`? NO — allowedTools as an
allowlist would *restrict* everything else. Instead leave tools default; when web_search is
DISABLED pass `disallowedTools: ['WebSearch','WebFetch']`.

### Context packet (turn 1 prompt) — assemble in this order
1. Category primer: from `getCategories()[task.category].primer` (if include_category_primer)
2. Living abstract: `getAbstract(project)` (if include_abstract)
3. Upstream handoffs: for each `task.upstream` id, the upstream task's `handoff` JSON (if any)
4. Sibling tasks: one-line list of other tasks in the project w/ status (if include_sibling_tasks)
5. Pinned files: "Read these before starting:" + `context.files`
6. User notes: `context.notes`
7. The task itself: title + description
8. Protocol footer (ALWAYS, verbatim semantics):
   - "When the task is COMPLETE, end your final message with a fenced block:
     \`\`\`handoff\n{JSON matching handoff schema}\n\`\`\`"
   - "If you are blocked and need the user, end your message with a line starting `QUESTION:`."

### After each turn (result message)
- store/refresh `task.session` (sdkSessionId, counters += usage, costUsd += total_cost_usd, turns++)
- `logTokens(...)`
- parse final text: if a ```handoff fenced block parses as JSON → `updateTask(... {handoff, status:'waiting'})` —
  the handoff is a completion PROPOSAL; only the user closes a task (UI ✓ accept → PATCH `status:'done'`; v1 auto-closed here)
  else if /^QUESTION:(.*)$/m → status `'waiting'`, `question` = captured text
  else → status `'waiting'`, question null
- broadcast `session:status` `{project, id, status, tokens:{in,out}, costUsd}`
- on turn start: status `'running'`, broadcast same event
- on error: status `'waiting'`, broadcast with `error` field; never crash the server

Keep an in-memory transcript per task `{role, text, ts}[]` (user turns + final assistant texts +
streamed text accumulates into the pending assistant entry). Export it via
`getTranscript(project,id)` → array. (Server exposes it in /api/state.)

## lib/watchers.js (Agent WATCHERS)

```js
export function startArtifactWatchers()  // chokidar over each PROJECTS[k].root for **/*.html and **/*.pdf
export function getArtifacts()           // → [{project, path(abs), rel, name, mtime, kind:'html'|'pdf'}] newest-first, max 60
export function watchTex(project, texPathAbs)  // spawn latexmk -pvc; returns {ok} or {error}
export function unwatchTex(project)
export function getPdfWatches()          // → {project: {tex, pdf, state:'building'|'built'|'error', lastBuildMs, lastBuiltAt, pages}}
```

Rules:
- chokidar: ignore dirs named `node_modules|\.git|data|_literature|literature` and depth > 6;
  `ignoreInitial: false` but seed initial list without broadcasting; after ready, on add/change
  broadcast `artifact:new` {artifact}.
- latexmk: spawn `latexmk -pdf -pvc -interaction=nonstopmode -halt-on-error <file>` with
  `cwd: dirname(tex)`. NEVER pass user input through a shell — use spawn(cmd, argsArray).
  Parse stdout lines: on a line containing `Latexmk: All targets` or output-written → state 'built';
  broadcast `pdf:status` with the getPdfWatches()[project] entry. On start of a rebuild
  (`Latexmk: applying rule` / file-change detected) → state 'building', broadcast.
  Track build duration. Pages: parse `Output written on ... (N pages` from the .log if easy, else null.
- watchTex validates: texPathAbs must be inside the project root (path.resolve check) and end .tex.
- Kill latexmk child on unwatch and on process exit (SIGTERM, on 'exit' hook).

## server.js (Agent CORE)

Express + http + ws. Bind **127.0.0.1** only. Wire-up:
- `express.static(APP_DIR + '/public')`
- `GET /artifact/:project/*` → serve file at `PROJECTS[project].root + '/' + wildcard`.
  SECURITY: resolve and verify the result startsWith(projectRoot + sep); 403 otherwise.
  Set headers so html renders in iframe (default is fine; no CSP needed for v1).
- JSON body parsing; all /api errors → `res.status(4xx|500).json({error})`; wrap handlers in try/catch.

### REST routes
```
GET    /api/state                      → snapshot (below)
POST   /api/tasks                      {project, ...fields}        → Task (201)
PATCH  /api/tasks/:project/:id         {patch}                     → Task
POST   /api/tasks/:project/:id/launch                              → {ok:true}   (calls sessions.launchTask)
POST   /api/tasks/:project/:id/message {text}                      → {ok:true}   (sessions.sendMessage)
POST   /api/tasks/:project/:id/interrupt                           → {ok:true}
POST   /api/pdf/watch                  {project, tex}              → result of watchTex
DELETE /api/pdf/watch/:project                                     → {ok:true}
POST   /api/heartbeat                  {project, seconds}          → {ok:true}   (ledger.logTime)
GET    /api/transcript/:project/:id    → {transcript: [...]}
```

### GET /api/state snapshot shape (frontend depends on this exactly)
```json
{
  "projects": { "<key>": {"name","root","color","texWatch"} },
  "categories": { ... },
  "abstracts": { "<key>": "md string" },
  "tasks": { "<key>": [Task, ...] },
  "artifacts": [ ... getArtifacts() ],
  "pdf": { ... getPdfWatches() },
  "ledger": { ... weekSummary() },
  "sessions": [ ... activeSessions() ]
}
```

On WS client connect: send `{type:'state', payload: <same snapshot>}` via onClientConnect.
Startup: initWss, startArtifactWatchers, then for each project with `texWatch` set, watchTex it.
Log one line per request is unnecessary; keep console output minimal but log server start + errors.

## WS events (server → client) — names are frozen
```
state            full snapshot
task:update      {project, task}
session:stream   {project, id, chunk}
session:status   {project, id, status, tokens?, costUsd?, error?}
artifact:new     {artifact}
pdf:status       {project, entry}
ledger:update    weekSummary()
```
Client → server WS messages: none (frontend uses REST). Reconnect: client re-fetches /api/state.

## public/ (Agent FRONTEND)

Adapt the visual design of `dashboard_hybrid.html` — the original design mockup, not shipped in this repo (READ IT —
reuse its CSS wholesale into style.css, its layout into index.html, its render functions into
app.js) but replace ALL mock data with live data:

- On load: `fetch('/api/state')` → render; open `ws://localhost:4242/ws`; handle every event above
  (update state object, re-render affected view).
- Overview (bento): sessions cell (tasks with status running/waiting across projects), Up Next
  (queued+waiting+manual, waiting pinned), week ring + weekly ledger from `ledger` summary
  (hours per project; token cost vs budget), live deck tile (first pdf watch entry), artifact strip
  (artifacts list; click → open project workbench AND select it in show panel).
- Workbench per project: task tabs from tasks[project]; lineage from task.upstream (resolve ids →
  titles); center = code surface — v1 shows the *transcript-reported* files? NO: v1 center shows
  the task's `context.files` if they exist + a "⌨ tail" tab streaming session:stream chunks
  (append to a pre). Fetch file contents via /artifact/:project/<rel> as text for display
  (no syntax highlighting required; monospace pre is fine).
- Session pane (bottom right): transcript from /api/transcript + live chunks; composer POSTs
  /api/tasks/:p/:id/message; interrupt button POSTs interrupt; queued tasks show launch card w/
  context chips + Launch button → /launch; waiting tasks show task.question highlighted; done
  tasks show handoff card (render task.handoff) + closed bar.
- Show panel (top right): tabs = pdf watch (iframe `/artifact/<p>/<relpdf>` reloaded on pdf:status
  built) + html artifacts of that project (iframe sandboxed `sandbox="allow-scripts"`).
- Add Task modal: full form from mockup (title, description, category pills from categories,
  project, lineage = multiselect of existing project tasks, priority, oversight, context chips:
  abstract/last session/siblings/primer toggles, web search toggle, files (comma-separated text
  input), notes, launch: queue|start now). Save → POST /api/tasks (+ optional /launch). The JSON
  preview pane updates live from the actual form state (build the object, JSON.stringify, syntax
  highlight basic or plain).
- Categories view: render from categories data (read-only v1, ✎ disabled).
- Heartbeat: every 30s while document.hasFocus(), POST /api/heartbeat {project: currentView==
  overview ? null→skip : projectKey, seconds:30}. Only when a project view is open.
- Keyboard: ⌘0 overview, ⌘1..5 projects (order of PROJECTS keys).
- No build step: app.js plain ES module loaded with <script type="module">.

## Coding standards (all agents)
- ESM imports with explicit `.js` extensions.
- No top-level await in lib modules (server.js may use it).
- Every exported function defensive: bad project key or id → throw Error('...') which server
  catches → 400/404.
- Paths: always path.resolve + containment checks before reading user-supplied paths.
- Console: prefix logs `[core]`, `[sessions]`, `[watchers]`.

## v2 addendum — surface added since the v1 freeze (the lists above are historical)

New modules: `lib/runner.js` (run pinned files), `lib/pins.js` (data/folder cards),
`lib/snapshots.js` (change history + rewind), `lib/git.js`, `lib/notify.js` (ntfy push),
`lib/dataview.js` (pandas head-of-table preview), `public/hl.js` (editor syntax overlay),
`public/m/` (phone PWA).

### Routes added
```
DELETE /api/tasks/:project/:id                       delete task (+ transcript, snapshots)
POST   /api/tasks/:project/:id/permission            {requestId, allow, message?} approval-card answer
POST   /api/run               {project, rel}         run a file (runner.js); one per project
DELETE /api/run/:project                             stop the active run
GET    /api/ls/:project?rel=                         folder-pin browser listing
GET    /api/pincard/:project?rel=                    data/folder card (kind from on-disk stat)
GET    /api/datahead/:project?rel=&rows=&format=     head-rows preview (html default | json)
GET    /api/files/:project                           project file list (pin search)
POST   /api/pickfile                                 native macOS file dialog (local only)
GET    /api/snapshots/:project/:id  (+ diff/rewind)  change history
/api/git/*                                           status, pull, commit-push, delegate
PUT    /artifact/:project/*                          save editor buffer (mtime conflict guard)
```

### WS events added
`run:status` `run:stream` (`{chunk, off, fd?}` — off = cumulative bytes for reconnect dedup,
fd 2 = stderr) · `snapshot:new` · `session:permission` / `session:permission:resolved` ·
`proposal:*` (propose-mode previews). Snapshot adds a `runs` field ({project → run info incl. tail}).

### Task schema additions
`model` (per-task model override), `permMode` (null | 'default' | 'acceptEdits' | 'auto' |
'bypassPermissions' — prompting override; ignored for oversight 'propose', which always runs
plan mode), `archived`.

### Semantics changed from v1
- Handoff = completion **proposal**: post-turn stores it with status 'waiting'; only the user
  closes a task (✓ accept → PATCH status 'done', refused 409 while a turn is active). A
  successful turn without a handoff clears a previous proposal. Non-done upstream handoffs are
  injected flagged "PROPOSED, not yet accepted".
- Oversight → permissionMode: auto → 'auto' (classifier), coop → 'auto', propose → 'plan'
  (locked). 'bypassPermissions' is passed with `allowDangerouslySkipPermissions: true`.
