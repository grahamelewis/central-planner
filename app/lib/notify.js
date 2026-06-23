// lib/notify.js — push notifications via ntfy.sh.
// Fire-and-forget: a notification must never block or fail a session turn.
// Phone setup: install the ntfy app and subscribe to NTFY_TOPIC.
import { NTFY_TOPIC, NTFY_CLICK_BASE, NTFY_DETAIL } from './config.js';

const logErr = (...a) => console.error('[notify]', ...a);

/**
 * Send a push. taskRef = { project, id } adds a deep link into the phone app
 * when NTFY_CLICK_BASE is configured.
 */
export function notify(title, body, { tags = '', priority = 'default', taskRef = null } = {}) {
  if (!NTFY_TOPIC) return;
  // JSON publish format — plain headers are byte-strings and choke on
  // unicode (em-dashes, emoji); the JSON body is full UTF-8
  const msg = {
    topic: NTFY_TOPIC,
    title: String(title).slice(0, 120),
    // privacy default: session content (questions, commands, summaries) stays
    // on this machine — the push says WHAT KIND of attention is needed, the
    // dashboard shows the substance. NTFY_DETAIL=true opts into full bodies.
    message: NTFY_DETAIL ? String(body || '').slice(0, 600) : 'open Central Planner for details',
    priority: priority === 'high' ? 4 : 3,
  };
  if (tags) msg.tags = String(tags).split(',');
  if (taskRef && NTFY_CLICK_BASE) {
    msg.click = `${NTFY_CLICK_BASE.replace(/\/$/, '')}/m/#t=${encodeURIComponent(taskRef.project)}/${encodeURIComponent(taskRef.id)}`;
  }
  fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  }).catch((err) => logErr('push failed:', err.message));
}
