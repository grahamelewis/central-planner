// test/uiHarness.mjs — drive the real dashboard in headless Chrome against a
// sandboxed server (serverHarness.mjs).
//
// Two safety layers against billed Claude calls:
//   1. page.route() fulfills /launch and /message before they leave the browser
//   2. the WebSocket is stubbed, so the page never talks to the real session
//      machinery anyway — tests push synthetic WS events via wsPush()
//
// Instrumentation (installed before the page loads):
//   window.__shifts    — Layout Instability API entries with per-node sources
//   window.__ws        — the stubbed socket; wsPush() feeds it server events
import { chromium } from 'playwright-core';
import { startSandbox } from './serverHarness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function startUI({ seed, viewport = { width: 1600, height: 1000 }, trial = [] } = {}) {
  const sb = await startSandbox({ seed, trial });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  // ---- safety: billed routes never reach the server ----
  await page.route('**/api/tasks/*/*/message', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/tasks/*/*/launch', (r) => r.fulfill({ json: { ok: true } }));
  await page.route('**/api/profile/generate', (r) => r.fulfill({ status: 502, json: { error: 'blocked in ui tests' } }));

  await page.addInitScript(() => {
    // stub the WebSocket: the app assigns on* properties, never addEventListener
    window.__wsSent = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        window.__ws = this;
        setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
      }
      send(d) { window.__wsSent.push(String(d)); }
      close() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    };

    // layout-shift telemetry: which nodes moved, from where to where
    window.__shifts = [];
    const describe = (n) => {
      if (!n || !n.tagName) return '?';
      const id = n.id ? `#${n.id}` : '';
      const cls = n.className && typeof n.className === 'string'
        ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${n.tagName.toLowerCase()}${id}${cls}`;
    };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__shifts.push({
            t: Math.round(e.startTime),
            value: +e.value.toFixed(4),
            sources: (e.sources || []).map((s) => ({
              node: describe(s.node),
              from: { x: s.previousRect.x, y: s.previousRect.y, w: s.previousRect.width, h: s.previousRect.height },
              to: { x: s.currentRect.x, y: s.currentRect.y, w: s.currentRect.width, h: s.currentRect.height },
            })),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* older chrome — shifts just stay empty */ }
  });

  /** Feed the page one synthetic server WS event. */
  const wsPush = (type, payload) => page.evaluate(([t, p]) => {
    if (window.__ws && window.__ws.onmessage) {
      window.__ws.onmessage({ data: JSON.stringify({ type: t, payload: p }) });
    }
  }, [type, payload]);

  /** Drain and reset the layout-shift log. */
  const takeShifts = () => page.evaluate(() => {
    const s = window.__shifts;
    window.__shifts = [];
    return s;
  });

  return {
    sb,
    browser,
    page,
    wsPush,
    takeShifts,
    async stop() {
      await browser.close().catch(() => {});
      await sb.stop();
    },
  };
}

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Split `text` into chunks of `n`-ish chars — adversarial mid-token splits. */
export function chunked(text, n = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}
