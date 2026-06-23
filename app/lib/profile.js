// lib/profile.js — the About You profile. Bio + work interests are WRITTEN BY
// CLAUDE (a one-shot, tool-less haiku call over the project abstracts, task
// history and activity), never typed by the user. Stored at ROOT/profile.json
// — a data file like tasks/, so it's transparent and survives restarts.
// NOTE: generateProfile() is a BILLED call — never hit POST /api/profile/generate
// from smoke tests; the UI's ↻ button is the intended trigger.
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ROOT, PROJECTS, USER_NAME } from './config.js';
import { allTasks, getAbstract, getCategories } from './taskStore.js';
import { dailyActivity } from './ledger.js';

const PROFILE_FILE = path.join(ROOT, 'profile.json');
const MODEL = 'claude-haiku-4-5-20251001'; // cheap, plenty for a bio
const NAME = USER_NAME || 'Researcher';

const log = (...a) => console.log('[profile]', ...a);
const logErr = (...a) => console.error('[profile]', ...a);

export function readProfile() {
  try {
    const p = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    return {
      name: p.name || NAME,
      bio: typeof p.bio === 'string' ? p.bio : null,
      interests: Array.isArray(p.interests) ? p.interests.filter(s => typeof s === 'string').slice(0, 4) : [],
      generatedAt: p.generatedAt || null,
      model: p.model || null,
    };
  } catch {
    return { name: NAME, bio: null, interests: [], generatedAt: null, model: null };
  }
}

function writeProfile(p) {
  const tmp = PROFILE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PROFILE_FILE);
}

/* ── material Claude reads before writing the profile ── */
function gatherMaterial() {
  const parts = [];
  for (const key of Object.keys(PROJECTS)) {
    const abs = (getAbstract(key) || '').trim();
    if (abs) parts.push(`## Project "${PROJECTS[key].name}" — living abstract\n${abs.slice(0, 1400)}`);
  }
  let cats = {};
  try { cats = getCategories() || {}; } catch { /* fine */ }
  const catNames = Object.entries(cats).map(([k, c]) => c.name || k);
  if (catNames.length) parts.push(`## Work categories\n${catNames.join(' · ')}`);

  const taskLines = [];
  const handoffs = [];
  try {
    const byProject = allTasks();
    for (const [key, ts] of Object.entries(byProject)) {
      for (const t of (ts || [])) {
        if (!t || !t.title) continue;
        taskLines.push(`- [${key}/${t.category || '?'}] ${t.title} (${t.status})`);
        if (t.handoff && t.handoff.summary) handoffs.push(`- ${String(t.handoff.summary).slice(0, 240)}`);
      }
    }
  } catch (err) { logErr('task material failed:', err.message); }
  if (taskLines.length) parts.push(`## Recent tasks\n${taskLines.slice(-30).join('\n')}`);
  if (handoffs.length) parts.push(`## Completed-work summaries\n${handoffs.slice(-10).join('\n')}`);

  try {
    const { days } = dailyActivity();
    const totals = Object.values(days).reduce((a, d) => {
      a.seconds += d.seconds; a.tokens += d.tokens;
      for (const [k, s] of Object.entries(d.perProject)) a.per[k] = (a.per[k] || 0) + s;
      return a;
    }, { seconds: 0, tokens: 0, per: {} });
    const top = Object.entries(totals.per).sort((a, b) => b[1] - a[1])[0];
    parts.push(`## Activity\n${(totals.seconds / 3600).toFixed(1)} logged hours, `
      + `${Math.round(totals.tokens / 1000)}k Claude tokens`
      + (top ? `, most time in "${PROJECTS[top[0]]?.name || top[0]}"` : ''));
  } catch (err) { logErr('activity material failed:', err.message); }

  return parts.join('\n\n').slice(0, 16000);
}

export function parseProfileJson(text) { // exported for tests — parsing is the fragile part
  // the model is told to answer with bare JSON, but defend against fences/prose
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const bio = typeof obj.bio === 'string' ? obj.bio.trim().slice(0, 420) : null;
  let interests = Array.isArray(obj.interests)
    ? obj.interests.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 48))
    : [];
  interests = interests.slice(0, 4);
  if (!bio || interests.length < 3) return null;
  return { bio, interests };
}

let inflight = null; // single concurrent generation

/** BILLED: one-shot haiku call → { bio, interests } written to profile.json. */
export function generateProfile() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const material = gatherMaterial();
      const prompt = [
        `You are writing the dashboard profile of a researcher (first name: ${NAME}).`,
        'Below is what their research dashboard knows: project abstracts, task history,',
        'completed-work summaries and activity. Write:',
        '',
        '1. "bio": 2–3 sentences, first person, plain and specific — what they work on',
        '   and how. Grounded ONLY in the material; no hype words, no "passionate".',
        '2. "interests": exactly 3 or 4 short noun phrases (2–5 words each) naming the',
        '   research areas YOU judge central to this work. You choose — they cannot.',
        '',
        'Answer with ONLY a JSON object: {"bio": "...", "interests": ["...", "..."]}',
        '',
        '--- MATERIAL ---',
        material,
      ].join('\n');

      const q = query({
        prompt,
        options: {
          cwd: ROOT,
          model: MODEL,
          maxTurns: 1,
          permissionMode: 'dontAsk', // any tool attempt is denied — pure text turn
          systemPrompt: 'You write short, accurate researcher profiles. You answer with strict JSON only.',
          disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'Task', 'WebSearch', 'WebFetch', 'NotebookEdit'],
        },
      });
      const timer = setTimeout(() => { try { q.interrupt(); } catch { /* done */ } }, 90_000);
      let finalText = '';
      let costUsd = 0;
      try {
        for await (const msg of q) {
          if (msg && msg.type === 'result') {
            finalText = msg.result || '';
            costUsd = Number(msg.total_cost_usd) || 0;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseProfileJson(finalText);
      if (!parsed) return { error: 'Claude did not return a usable profile — try again' };
      const profile = {
        name: NAME,
        ...parsed,
        generatedAt: new Date().toISOString(),
        model: MODEL,
        costUsd,
      };
      writeProfile(profile);
      log(`profile written (${profile.interests.length} interests, $${costUsd.toFixed ? costUsd.toFixed(4) : costUsd})`);
      return readProfile();
    } catch (err) {
      logErr('generate failed:', err.message);
      return { error: err.message };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
