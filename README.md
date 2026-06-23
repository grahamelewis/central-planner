# Central Planner

A local, single-user dashboard that runs a **[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) coding session per task**, organized by research project. Each task gets a resumable Claude session with a per-project workbench: a live conversation console, HTML/PDF artifact viewers, a LaTeX live-recompile pane, change-history with one-click rewind, project lineage (tasks hand off to one another), and a time/token ledger.

It's one Node process serving a browser UI — no build step, no database, no accounts. Your tasks, transcripts, and ledger are plain JSON in the folder.

<!-- screenshot: add a dashboard screenshot/GIF here before publishing -->

> ⚠️ **This runs real, billed Claude calls and has no authentication.**
> Launching a task, sending a message, and the profile feature each spawn a real
> Claude Agent SDK session billed to your `ANTHROPIC_API_KEY` — there is **no
> spend cap**. The server binds to `localhost` and has no login of its own; don't
> expose it publicly. A task's session can run tools (including bash) inside that
> project's folder, so keep each project's `root` narrow.

## Quickstart

**The easy way** — let Claude set you up:

```bash
git clone <this-repo> central-planner && cd central-planner
claude            # then type:  /setup
```

On a fresh clone, Claude reads the tool's docs and walks you through it — checking
prerequisites, installing, writing your config, and starting the server — pausing
for your confirmation at each step. (Requires [Claude Code](https://docs.claude.com/en/docs/claude-code).)

**Or by hand:**

```bash
cd app && npm install && cd ..
export ANTHROPIC_API_KEY=sk-ant-...        # from https://platform.claude.com
cp config.example.json config.json         # then edit: your name + projects
cd app && npm start                        # → http://localhost:4242
```

Then open **Manage Projects** (top-left name menu) to add your project folders
with the built-in folder picker. Full details in [`SETUP.md`](SETUP.md).

## Prerequisites

- **Node ≥ 20**
- An **`ANTHROPIC_API_KEY`** (pay-as-you-go; get one at <https://platform.claude.com>)
- Optional, per-feature: `latexmk` + a TeX distribution (live PDF recompile);
  `julia` / `python` / `R` (the in-app file runner)

## Configuration

All per-user settings live in a gitignored **`config.json`** at the repo root
(template: [`config.example.json`](config.example.json)): your display name, your
projects (each with a folder `root`, a display `name`, a `color`, and a `status`
of `active` / `trial` / `inactive`), optional ntfy push notifications, and the
port. Categories (which prime each task's session) come from `categories.json`,
falling back to the shipped `categories.example.json`.

## Architecture

A single Node process (Express + WebSocket) owns all state; the browser is a thin
view. One task = one resumable Agent SDK session. File watchers surface HTML/PDF
artifacts and recompile watched `.tex` files; an append-only JSONL ledger tracks
time and tokens; each turn's file edits are snapshotted for rewind. The full
interface contract (routes, WS events, JSON schemas) is in
[`app/CONTRACT.md`](app/CONTRACT.md).

```
app/
  server.js        Express + WebSocket server
  lib/             sessions, watchers, ledger, taskStore, projectStore, runner, snapshots, …
  public/          the dashboard frontend (no build step) + public/m/ (phone view)
  test/            node --test suite (billing-safe)
config.example.json, categories.example.json   templates
CLAUDE.md, SETUP.md                            guided-setup docs
```

## Tests

```bash
cd app && npm test      # node --test test/*.test.mjs
```

The suite is **billing-safe**: the harness stubs the WebSocket and intercepts the
billed routes, so `npm test` never makes a real Claude call.

## Remote / always-on (optional)

By default Central Planner is localhost-only. To run it always-on and reach it
from your other devices over a private [Tailscale](https://tailscale.com) network,
see [`app/deploy/REMOTE.md`](app/deploy/REMOTE.md). Never expose it on a public
tunnel or bind it to `0.0.0.0` — it has no authentication.

## License

[MIT](LICENSE).

## Disclaimer

An independent project, not affiliated with or endorsed by Anthropic. It uses the
Claude Agent SDK, which is Anthropic's proprietary software under its own terms;
your use of the SDK and the Claude API is governed by Anthropic's agreements.
