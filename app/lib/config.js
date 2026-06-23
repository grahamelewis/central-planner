// Shared configuration — single source of truth for paths and projects.
// Other modules import from here; do not duplicate these constants.
//
// All user-specific values live in a gitignored `config.json` at the repo root
// (see config.example.json for the shape). This file is just the loader: it
// resolves each setting as  env var > config.json > built-in default. The repo
// ships with NO personal data — projects/name come only from config.json, which
// the guided setup writes. The CP_* env vars still take precedence so the test
// harness (test/serverHarness.mjs) keeps running against throwaway dirs:
//   CP_ROOT           data root (tasks/, ledger/, snapshots/, transcripts/, …)
//   CP_PORT           listen port
//   CP_PROJECTS_JSON  the whole projects object as JSON
//   CP_NTFY_TOPIC     override ntfy topic ('' silences pushes)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

export const APP_DIR = path.resolve(__dirname, '..');          // .../projectManager/app
// dataRoot is env-only (CP_ROOT): it locates config.json itself, so it can't
// live inside that file. Defaults to the repo root (the parent of app/).
export const ROOT = env.CP_ROOT ? path.resolve(env.CP_ROOT) : path.resolve(APP_DIR, '..');

// Load config.json from the data root. Missing → blank (triggers first-run
// setup). Malformed → fail SOFT: log loudly and start blank so the dashboard
// still loads and the user can fix the file, rather than crashing the server.
function loadUserConfig() {
  const file = path.join(ROOT, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // no config.json yet — fresh clone / pre-setup
  }
  try {
    const cfg = JSON.parse(raw);
    return (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  } catch (err) {
    console.error(`\n[config] ${file} is not valid JSON: ${err.message}`);
    console.error('[config] starting with NO projects — fix config.json and restart.\n');
    return {};
  }
}

const CFG = loadUserConfig();
const ntfy = (CFG.notifications && typeof CFG.notifications === 'object') ? CFG.notifications : {};

export const PORT = env.CP_PORT ? Number(env.CP_PORT) : (CFG.port || 4242);

// PROJECTS stays a plain, MUTABLE object — the in-process tests (paths/pins)
// inject and delete their own key. Never freeze it or make it a getter.
export const PROJECTS = env.CP_PROJECTS_JSON
  ? JSON.parse(env.CP_PROJECTS_JSON)
  : (CFG.projects && typeof CFG.projects === 'object' ? CFG.projects : {});

// Display name shown top-left and in the generated profile. Blank → the UI
// shows a neutral placeholder until setup runs.
export const USER_NAME = (CFG.user && typeof CFG.user.name === 'string') ? CFG.user.name : '';

export const ARTIFACT_GLOBS = (CFG.artifactGlobs && typeof CFG.artifactGlobs === 'object')
  ? CFG.artifactGlobs
  : {
    ignoreDirs: ['node_modules', '.git', 'data', '_literature', 'literature', '.claude', 'renv', '.venv', '__pycache__'],
    maxDepth: 6,
  };

export const WEEKLY_HOUR_TARGET = typeof CFG.weeklyHourTarget === 'number' ? CFG.weeklyHourTarget : 35;

// Push notifications via ntfy.sh. The topic is the only secret — anyone who
// knows it can read/send on it, so keep it random. Empty string disables
// notifications. Default is OFF — a clone must opt in via config.json.
export const NTFY_TOPIC = env.CP_NTFY_TOPIC !== undefined ? env.CP_NTFY_TOPIC : (ntfy.ntfyTopic || '');
// Base URL notifications link to (e.g. a tailscale serve URL). Empty → no link.
export const NTFY_CLICK_BASE = ntfy.ntfyClickBase || '';
// ntfy.sh is a PUBLIC broker — anyone who learns the topic can read pushes.
// false (default): notifications carry only the task title + event type.
// true: include question text / handoff summaries / tool details in the body.
export const NTFY_DETAIL = ntfy.ntfyDetail === true;
