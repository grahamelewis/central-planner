# Running Central Planner always-on, and using it from anywhere

This is optional. By default Central Planner runs on your own machine at
`http://localhost:4242`. If you want it always-on and reachable from your other
devices (laptop, phone), this guide sets that up with [Tailscale](https://tailscale.com)
— a private network between your own devices, with no port forwarding and
nothing exposed publicly. The example uses macOS (`launchd`); the same idea
works on Linux with `systemd`.

The server owns all state (tasks, Claude sessions, transcripts, ledger, run
output); browsers are thin views. So you run ONE server on an always-on
machine (the "host") and connect to it from any browser — every device sees the
same thing, live.

**Trust model — read this.** The app has NO login of its own. Privacy comes
entirely from the network layer: locally it binds `127.0.0.1` only; with
`tailscale serve` it's reachable by every device signed into *your* Tailscale
account — and each of those then has full control, including running code and
spending API money. Keep your tailnet to your own devices; **never** use a
Tailscale funnel / public share, and never bind the server to `0.0.0.0`.

**If you sync the repo folder across machines (e.g. via Dropbox/iCloud): never
run two servers at once.** Both write tasks/ledger into the folder, and a synced
copy would create conflict files. Pick one host; the others only browse.

## One-time setup

### Every device
1. Install Tailscale: <https://tailscale.com/download> (or `brew install --cask tailscale`).
2. Sign in with the **same account** on each device. Each gets a stable private
   address that works on any network.

### The host (the always-on machine)
1. Make sure the project folders listed in your `config.json` exist on this
   machine at the paths you configured. If you sync the repo, also make sure
   it's fully synced here first.
2. Install dependencies (and rebuild native deps if the host's CPU arch differs
   from where you first installed): `cd <path-to-repo>/app && npm install`.
3. Make sure `ANTHROPIC_API_KEY` is available to the server's environment (see
   the PATH/env note in `deploy/local.projectmanager.plist`).
4. Install the always-on service. On macOS, edit `WorkingDirectory` in
   `deploy/local.projectmanager.plist` to your repo's `app/` path, then:
   ```bash
   cp <path-to-repo>/app/deploy/local.projectmanager.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/local.projectmanager.plist
   ```
   It starts at login and restarts if it crashes. Logs: `/tmp/projectmanager.log`.
5. Expose it to your tailnet (HTTPS, your devices only):
   ```bash
   tailscale serve --bg 4242
   ```
   This persists across reboots. `tailscale serve status` shows the URL —
   something like `https://<host-name>.<tailnet>.ts.net`.
6. Keep the host awake: System Settings → Energy → "Prevent automatic sleeping
   when the display is off" (or `sudo pmset -a sleep 0`). Claude sessions and
   latexmk watches run here, so it must stay up.

### Other computers
Nothing to install beyond Tailscale. Browse to the serve URL from step 5. On the
host itself, `http://127.0.0.1:4242` keeps working.

### Phone
1. Install the Tailscale app, sign into the same account, toggle it on.
2. Open `https://<host-name>.<tailnet>.ts.net/m/` — the phone view: tasks
   grouped by who's-waiting, tap to answer Claude / launch / interrupt / read
   handoffs, ＋ to add tasks. (Phones hitting the root URL are redirected to
   `/m/` automatically.)
3. Share → **Add to Home Screen** to install it as a standalone app.
4. **Push notifications** (optional): set a *random* `notifications.ntfyTopic`
   in `config.json` (the topic is the only secret — anyone who knows it can read
   your pushes), install the **ntfy** app, and subscribe to that topic. Sessions
   ping you on: Claude asking a question, approval needed, task complete, turn
   failed. After `tailscale serve` is up, set `notifications.ntfyClickBase` in
   `config.json` to the serve URL so tapping a notification opens that task.

## What carries across machines (and what doesn't)

Carries (lives on the server): tasks, oversight, context packets, running Claude
sessions and their transcripts, run output, PDF watches, the ledger, file edits.

Stays per-browser (localStorage): unsaved editor drafts, closed-tab state, panel
divider positions. Save (⌘S) before switching machines and the text is on disk —
the other machine sees it instantly.

Quirks when remote:
- The ＋ pin button and the project folder picker use the in-app file search
  instead of the native dialog (the dialog would open on the host's screen).
- ▶ run executes on the host — output streams to wherever you're watching.

## Undo

```bash
launchctl unload ~/Library/LaunchAgents/local.projectmanager.plist
tailscale serve --bg=false 4242   # or: tailscale serve reset
```
