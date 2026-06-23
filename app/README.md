# Central Planner

Research-project dashboard ("the social planner's problem, solved locally"):
Claude sessions per task, HTML/PDF artifact viewers, live latexmk slide
recompiles, time + token ledger. Lives in the `projectManager/` folder —
the folder name stays for path stability; the product is Central Planner.

## Run

```bash
cd ~/Dropbox/projectManager/app
npm start          # → http://127.0.0.1:4242  (localhost only — never expose)
```

## Layout

- `server.js` + `lib/` — Express + WebSocket server (port 4242)
  - `config.js` — project registry (paths, colors, optional `texWatch`), weekly targets
  - `taskStore.js` — reads/writes `../tasks/<project>.json` (the source of truth; editable by hand)
  - `sessions.js` — Claude Agent SDK: one task = one session, context packets, handoff parsing
  - `watchers.js` — chokidar artifact indexing + `latexmk -pvc` live PDF watches
  - `ledger.js` — `../ledger/ledger.jsonl` (your seconds + Claude tokens/cost, weekly summary)
- `public/` — the dashboard frontend (no build step)
- `public/m/` — the phone app (same API/WS; tasks, sessions, add, artifacts; PWA-installable)
- `../categories.json` — category primers injected into sessions
- `../abstracts/<project>.md` — living abstracts (edit freely; injected into context packets)

## Concepts

- **Task** = unit of work. Oversight: `auto` (runs to completion), `propose` (plan mode),
  `coop` (interactive turns), `manual` (no agent). Category primer + living abstract +
  upstream handoffs + pinned files + notes are assembled into the launch prompt.
- **Handoff**: a completing session ends with a ```handoff fenced JSON block; the server
  parses it into the task record and injects it into downstream tasks (`upstream: [...]`).
- **Show panel ＋**: pick any .html/.pdf to display, or a .tex to live-compile
  (latexmk -pvc; the panel reloads on every successful build). Saved htmls and
  recompiled pdfs refresh automatically via the artifact watcher. × closes a tab.
- **Editing**: pinned files open editable in the center pane — type, then ⌘S (or the save
  button) writes to disk atomically. Saves are refused (409) if the file changed on disk
  after you opened it, so a running session's edits never get clobbered silently.
- **Running**: ▶ run (or ⌘⏎ in the editor) executes the open file — `.jl` via julia (auto
  `--project=` from the nearest Project.toml), `.py` via the repo's venv else python3,
  `.r`/`.sh`, and `.tex` as a one-shot latexmk compile whose pdf then shows in the panel.
  Unsaved edits are saved first. Output streams into a ▶ output tab; one run per project
  at a time, stoppable from the UI. Server keeps the output tail so reloads don't lose it.
- **Change history**: every session turn that edits files records a change-set
  (journal + before/after blobs in `../snapshots/`). The Δ tab in the workbench shows
  highlighted diffs per file with one-click rewind; rewinds are themselves recorded, so
  they can be undone. Captures direct Edit/Write tool calls, not Bash side effects.
- **HTML editing**: ✎ edit in the show panel turns the rendered page itself editable
  (designMode) — type in place, format with the toolbar, ⌘S to save. Scripts are paused
  during editing so MathJax/plot code stays as source and the file round-trips faithfully.
- **Pin kinds**: code pins are read by the session on demand; data pins (.csv/.parquet/
  .dta/.xlsx/…) inject a generated schema card (columns, types, rows, sample) — never the
  contents; folder pins (🗀, trailing `/`) inject a size-annotated tree map. Cards
  regenerate when the file changes and are viewable in the center pane.
- **Pinning**: ＋ in the sidebar's Pinned files header opens the native macOS file dialog
  (served via osascript, so it yields real paths); picks must be inside the project root.
  If the dialog can't open, an in-app fuzzy file search appears instead.

## Notes

- Launching/messaging tasks spawns real Claude Code sessions (billed). Interrupt from the UI.
- Sessions run with `settingSources: ['project']`, so each repo's `.claude` settings apply.
- To run the server permanently on a desktop and use it from a laptop anywhere,
  see `deploy/REMOTE.md` (Tailscale + launchd; never run two servers at once).
