# Central Planner

Central Planner is a local, single-user research-project dashboard. It runs a
**Claude Agent SDK coding session per task**, with a per-project workbench, live
HTML/PDF artifact viewers, a LaTeX live-recompile pane, change-history with
rewind, and a time/token ledger. The server and browser frontend live in `app/`
(see `app/README.md` for the tour and `app/CONTRACT.md` for the architecture).

## How it runs
- `cd app && npm install`, then `npm start` → http://localhost:4242
- Requires **Node ≥ 20** and an **`ANTHROPIC_API_KEY`** in the environment — the
  dashboard's task sessions are real, **billed** Claude calls.
- Per-user config lives in a gitignored `config.json` at the repo root
  (template: `config.example.json`). The repo ships with none.

## First-run setup (guided)
If there is **no `config.json`** at the repo root, this is a fresh install and
the user is setting up. Help them get running:
1. First **read** `README.md` and `SETUP.md` and give the user a short summary of
   what this tool is and the steps you'll take — **do NOT edit any files or run
   any commands until they confirm the plan.**
2. After they confirm, follow `SETUP.md`: verify Node ≥ 20 and that
   `ANTHROPIC_API_KEY` is set (explain how to get/set it if not), run
   `npm install` in `app/`, write a minimal `config.json` from
   `config.example.json` (ask for their name and, optionally, a first project
   folder), then start the server.
3. Point them to the **Manage Projects** tab to add the rest of their projects
   using the built-in folder picker.

Confirm before each file write or command. The `/setup` command re-runs this
walkthrough at any time.

## Safety & cost (make sure the user knows)
- Task launches, messages, and profile generation spawn **real, billed** Claude
  calls — there is **no spend cap**.
- The dashboard has **no authentication** and binds to localhost. Don't expose
  it publicly; for remote access use a private network (e.g. Tailscale), never a
  public tunnel, and never bind to `0.0.0.0`.
- A task's session can run tools (including bash) inside that project's folder,
  and bash side-effects are not covered by the rewind safety net. Keep each
  project `root` narrow.

## Developing / testing
- Architecture and the interface contract: `app/CONTRACT.md`.
- Run tests: `cd app && npm test` (`node --test test/*.test.mjs`). Tests are
  billing-safe — the harness stubs the WebSocket and intercepts billed routes.
  **Never** hit POST `/api/tasks/:p/:id/launch`, `/message`, or
  `/api/profile/generate` in smoke tests; they spawn real billed calls. Use GET
  routes and `/api/state`.
