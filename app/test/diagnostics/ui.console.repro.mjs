// Diagnostic repro for the console-shift report: drives the real dashboard in
// headless Chrome, replays a realistic Claude turn through the stubbed WS, and
// measures what moves at the three suspect moments:
//   A. composer submit (Enter)
//   B. mid-stream rendering (smoothness, wipes, scroll jumps)
//   C. turn completion (status → waiting, transcript refresh)
// Run:  node test/ui.console.repro.mjs     (writes /tmp/cp-ui/{report.json,*.png})
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, chunked } from '../uiHarness.mjs';

const OUT = '/tmp/cp-ui';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const report = {};
const SPY = () => {
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  window.__sets = [];
  Object.defineProperty(Element.prototype, 'scrollTop', {
    get() { return desc.get.call(this); },
    set(v) {
      if (this.id === 'consoleBox') {
        window.__sets.push({
          t: Math.round(performance.now()),
          to: Math.round(v),
          was: Math.round(desc.get.call(this)),
          at: new Error().stack.split('\n').slice(2, 4).map((s) => s.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' ← '),
        });
      }
      return desc.set.call(this, v);
    },
    configurable: true,
  });
};
const ui = await startUI({
  seed: ({ projRoots }) => {
    fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), [
      'using LinearAlgebra', '',
      'β = 0.96',
      'function solve(m; β = β)',
      '    return β .* m',
      'end', '',
    ].join('\n'));
  },
});
const { sb, page, wsPush, takeShifts } = ui;

try {
  // ---- stage: a task mid-conversation (waiting + session ⇒ composer shows) ----
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha',
    title: 'Calibrate model',
    description: 'Fit β to the 1997 cohort.',
    category: 'calibration',
    oversight: 'coop',
    context: { files: ['model.jl'] },
  });
  const id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 'sess-fixture', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 32000, tokensOut: 1200, costUsd: 0.42, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({
    created: created.created,
    entries: [
      { role: 'user', text: 'Calibrate the model to the 1997 cohort.', ts: created.created },
      {
        role: 'assistant',
        text: 'Done — $\\beta = 0.96$ fits best.\n\n- moment match: **0.83**\n- residual autocorrelation is negligible\n\nNext I would try the 2005 cohort.',
        ts: created.created,
      },
    ],
  }));
  const { body: st } = await sb.fetchJson('GET', '/api/state');
  const task = st.tasks.alpha.find((t) => t.id === id);

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  // markdown/katex arrive from CDNs; tolerate offline (app falls back to plain)
  await page.waitForFunction(() => window.marked && window.renderMathInElement, null, { timeout: 8000 }).catch(() => {});
  await sleep(800); // transcript fetch + initial render settle
  report.libs = await page.evaluate(() => ({
    marked: !!window.marked, dompurify: !!window.DOMPurify, katex: !!window.renderMathInElement,
  }));

  const snap = () => page.evaluate(() => {
    const on = document.querySelector('#v-alpha .ctabs .ctab.on');
    const box = document.querySelector('#v-alpha #consoleBox');
    const r = box && box.getBoundingClientRect();
    const round = (n) => Math.round(n);
    return {
      activeTab: on ? on.textContent.trim() : null,
      consoleRect: r ? { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } : null,
      scroll: box ? { top: round(box.scrollTop), height: round(box.scrollHeight), client: round(box.clientHeight) } : null,
      tail: box ? box.innerText.slice(-220) : null,
    };
  });

  // ════ A. composer submit ════════════════════════════════════════════════
  await takeShifts();
  report.A = { before: await snap() };
  await page.screenshot({ path: `${OUT}/A0-before-submit.png` });

  await page.fill('#composerInput', 'Try β = 0.97 and report the fit.');
  await page.press('#composerInput', 'Enter');
  await sleep(180);
  report.A.afterEnter = await snap();
  await page.screenshot({ path: `${OUT}/A1-after-enter.png` });

  // what the real server broadcasts right after POST /message
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await sleep(180);
  report.A.afterServerEvents = await snap();
  report.A.shifts = await takeShifts();
  await page.screenshot({ path: `${OUT}/A2-running.png` });

  // ════ B. streaming ═══════════════════════════════════════════════════════
  // instrument: scroll log per frame, console wipes (sentinel removal)
  await page.evaluate(() => {
    window.__scrollLog = [];
    const loop = () => {
      const box = document.querySelector('#v-alpha #consoleBox');
      if (box) {
        window.__scrollLog.push({
          t: Math.round(performance.now()),
          top: Math.round(box.scrollTop),
          sh: box.scrollHeight,
        });
      }
      requestAnimationFrame(loop);
    };
    loop();

    window.__wipes = 0;
    const wrap = document.querySelector('#v-alpha #consoleBox .csegWrap');
    if (wrap) {
      if (wrap.firstElementChild) wrap.firstElementChild.dataset.sentinel = '1';
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.removedNodes) {
            if (n && n.dataset && n.dataset.sentinel) window.__wipes++;
          }
        }
      }).observe(wrap, { childList: true });
    }
  });

  const push = (chunk) => wsPush('session:stream', { project: 'alpha', id, chunk });
  const answer1 = "I'll refit with $\\beta = 0.97$ and compare the moment match.\n\n";
  const code = '```julia\nβ = 0.97\nsol = solve(model; β)\nmatch = moments(sol, data)\n```\n';
  const answer2 = 'Running it now — the **key moment** is the cohort debt ratio, $d_{1997} = 0.41$.\n';
  const answer3 = '\nThe fit **improves**: match = 0.87 vs 0.83 at $\\beta=0.96$.\n\n| β | match |\n|---|---|\n| 0.96 | 0.83 |\n| 0.97 | **0.87** |\n';
  const chunks = [
    '⟐ claude-opus-4-8 · auto\n',
    '\n∴ thinking…\n',
    ...chunked('The user wants a refit at β = 0.97. I should rerun the calibration and compare moment matches against the 0.96 baseline before reporting.', 40),
    '\n— answer —\n',
    ...chunked(answer1, 24),
    ...chunked(code, 30),
    ...chunked(answer2, 24),
    '\n[tool: Bash] julia calibrate.jl --beta 0.97 — rerun calibration\n',
    '[result] match = 0.87 (baseline 0.83) — improved\n',
    ...chunked(answer3, 28),
  ];
  for (const c of chunks) { await push(c); await sleep(70); }
  await sleep(450);

  report.B = {
    wipes: await page.evaluate(() => window.__wipes),
    sentinelAlive: await page.evaluate(() => !!document.querySelector('#v-alpha #consoleBox [data-sentinel]')),
    shifts: await takeShifts(),
    after: await snap(),
  };
  await page.screenshot({ path: `${OUT}/B1-streamed.png` });

  // ── B2: a reader scrolled UP must not be yanked while more text streams ──
  await page.evaluate(SPY);
  report.B2css = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#v-alpha #consoleBox'));
    return { scrollBehavior: cs.scrollBehavior, overflowAnchor: cs.overflowAnchor };
  });
  const anchorBefore = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    box.scrollTop = Math.max(0, box.scrollHeight / 2 - box.clientHeight);
    const seg = box.querySelectorAll('.cseg')[1];
    if (seg) seg.dataset.anchor = '1';
    const r = seg ? seg.getBoundingClientRect() : null;
    return { segY: r ? Math.round(r.y) : null, scrollTop: Math.round(box.scrollTop) };
  });
  for (const c of [
    ...chunked('\nContinuing: now checking the 2005 cohort with the same β to see whether the match generalises.\n', 20),
    '\n[tool: Bash] julia calibrate.jl --cohort 2005\n',
    '[result] match = 0.79\n',
  ]) { await push(c); await sleep(60); }
  await sleep(350);
  const anchorAfter = await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    const seg = box.querySelector('[data-anchor]');
    const r = seg ? seg.getBoundingClientRect() : null;
    return { segY: r ? Math.round(r.y) : null, scrollTop: Math.round(box.scrollTop) };
  });
  report.B2 = { anchorBefore, anchorAfter, sets: await page.evaluate(() => window.__sets) };
  await page.screenshot({ path: `${OUT}/B2-scrolled-up.png` });

  // ════ C. completion ══════════════════════════════════════════════════════
  await push('\n— turn done · 8.2s · 32k in / 1k out —\n');
  await sleep(200);
  await takeShifts();
  report.C = { before: await snap() };
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', {
    project: 'alpha', id, status: 'waiting', tokens: { in: 32000, out: 1400 }, costUsd: 0.18,
  });
  await sleep(600); // refreshTranscript round-trip + renders
  report.C.after = await snap();
  report.C.shifts = await takeShifts();
  report.C.wipesTotal = await page.evaluate(() => window.__wipes);
  await page.screenshot({ path: `${OUT}/C1-done.png` });

  // ── scroll-jump analysis: frame-to-frame scrollTop deltas > 40px ──
  const scrollLog = await page.evaluate(() => window.__scrollLog);
  const jumps = [];
  for (let i = 1; i < scrollLog.length; i++) {
    const d = scrollLog[i].top - scrollLog[i - 1].top;
    if (Math.abs(d) > 40) jumps.push({ t: scrollLog[i].t, delta: d, top: scrollLog[i].top });
  }
  report.scrollJumps = jumps;
  report.scrollFrames = scrollLog.length;

  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

  // ── human summary ──
  const fmtShift = (s) => `    value=${s.value} ${s.sources.map((x) => `${x.node} y:${x.from.y}→${x.to.y} h:${x.from.h}→${x.to.h}`).join(' | ')}`;
  console.log('\n═══ A. submit ═══');
  console.log('  tab before:', report.A.before.activeTab, '→ after Enter:', report.A.afterEnter.activeTab);
  console.log('  console rect before:', JSON.stringify(report.A.before.consoleRect));
  console.log('  console rect after Enter:', JSON.stringify(report.A.afterEnter.consoleRect));
  console.log('  console rect after server events:', JSON.stringify(report.A.afterServerEvents.consoleRect));
  console.log('  console tail after submit:', JSON.stringify(report.A.afterEnter.tail));
  console.log('  layout shifts:', report.A.shifts.length);
  report.A.shifts.slice(0, 8).forEach((s) => console.log(fmtShift(s)));
  console.log('\n═══ B. streaming ═══');
  console.log('  console wipes during stream:', report.B.wipes, '· sentinel survived:', report.B.sentinelAlive);
  console.log('  layout shifts during stream:', report.B.shifts.length,
    'total value:', report.B.shifts.reduce((n, s) => n + s.value, 0).toFixed(3));
  report.B.shifts.slice(0, 10).forEach((s) => console.log(fmtShift(s)));
  console.log('  B2 scrolled-up reader: anchor y', report.B2.anchorBefore.segY, '→', report.B2.anchorAfter.segY,
    '· scrollTop', report.B2.anchorBefore.scrollTop, '→', report.B2.anchorAfter.scrollTop);
  console.log('\n═══ C. completion ═══');
  console.log('  rect before:', JSON.stringify(report.C.before.consoleRect), '→ after:', JSON.stringify(report.C.after.consoleRect));
  console.log('  scroll before:', JSON.stringify(report.C.before.scroll), '→ after:', JSON.stringify(report.C.after.scroll));
  console.log('  layout shifts:', report.C.shifts.length, '· total wipes:', report.C.wipesTotal);
  report.C.shifts.slice(0, 8).forEach((s) => console.log(fmtShift(s)));
  console.log('\n═══ scroll jumps (>40px/frame) ═══');
  console.log(' ', jumps.length ? JSON.stringify(jumps.slice(0, 12)) : 'none', `(${report.scrollFrames} frames observed)`);
  console.log(`\nscreenshots + report.json → ${OUT}`);
} finally {
  await ui.stop();
}
