// Console rendering regressions — the dashboard's Claude interface.
// Drives the real frontend in headless Chrome (system Chrome via
// playwright-core); skips cleanly on machines without Chrome.
//
// Guards the fixes for:
//   · scroll-behavior:smooth race — completion renders ratcheted the console
//     to the top (scroll captured mid-animation)
//   · full console wipes when streaming re-segments the tail
//   · stick-to-bottom dragging a reader who had scrolled up (height heuristic
//     broke when scrollback < threshold; now an explicit _follow intent bit)
//   · typed prompts never appearing in the console (hard to scroll back and
//     see what you asked)
// Tests share one staged session and run in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, chunked } from './uiHarness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, wsPush, id, task;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'β = 0.96\n');
    },
  });
  ({ sb, page, wsPush } = ui);
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate model', description: 'Fit β.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({
    created: created.created,
    entries: [
      { role: 'user', text: 'Calibrate the model to the 1997 cohort.', ts: created.created },
      { role: 'assistant', text: 'Done — moment match **0.83**.', ts: created.created },
    ],
  }));
  ({ body: { tasks: { alpha: [task] } } } = await sb.fetchJson('GET', '/api/state'));

  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#v-alpha .wb .ctabs', { timeout: 15000 });
  await page.waitForFunction(() => window.marked && window.DOMPurify, null, { timeout: 8000 }).catch(() => {});
  await sleep(700);
});
after(async () => { if (ui) await ui.stop(); });

const consoleState = () => page.evaluate(() => {
  const box = document.querySelector('#v-alpha #consoleBox');
  const on = document.querySelector('#v-alpha .ctabs .ctab.on');
  return {
    activeTab: on ? on.textContent.trim() : null,
    text: box ? box.innerText : null,
    scrollTop: box ? Math.round(box.scrollTop) : null,
    maxScroll: box ? Math.round(box.scrollHeight - box.clientHeight) : null,
  };
});
const stream = async (text, n = 30, everyMs = 25) => {
  for (const chunk of chunked(text, n)) {
    await wsPush('session:stream', { project: 'alpha', id, chunk });
    await sleep(everyMs);
  }
  await sleep(300); // reveal pump catches up
};

test('Enter in the composer jumps to the console and shows the typed prompt', opts, async () => {
  await page.fill('#composerInput', 'Try β = 0.97 and report the fit.');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  const s = await consoleState();
  assert.match(s.activeTab, /console/);
  assert.ok(s.text.includes('Try β = 0.97 and report the fit.'), 'sent prompt is visible in the console');
  assert.equal(await page.inputValue('#composerInput'), '', 'composer cleared');
});

test('streaming renders incrementally — the console DOM is never wiped', opts, async () => {
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  await page.evaluate(() => {
    const wrap = document.querySelector('#v-alpha #consoleBox .csegWrap');
    window.__wipes = 0;
    if (wrap.firstElementChild) wrap.firstElementChild.dataset.sentinel = '1';
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.removedNodes) {
          if (n && n.dataset && n.dataset.sentinel) window.__wipes++;
        }
      }
    }).observe(wrap, { childList: true });
  });
  // a stream that re-segments its tail: fence opens chunks before it closes,
  // marker lines complete across chunk boundaries
  await stream('⟐ model · auto\n\n∴ thinking…\nRefit and compare.\n\n— answer —\n'
    + 'Refit at $\\beta = 0.97$:\n\n```julia\nsol = solve(m; β = 0.97)\n```\n'
    + 'The **fit improves** to 0.87.\n'
    + '\n[tool: Bash] julia calibrate.jl — rerun\n[result] match = 0.87\n'
    + Array.from({ length: 30 }, (_, i) => `step ${i}: residual ${(1 / (i + 1)).toFixed(3)}`).join('\n'), 22);
  assert.equal(await page.evaluate(() => window.__wipes), 0, 'no full console wipes during streaming');
  const s = await consoleState();
  assert.ok(Math.abs(s.scrollTop - s.maxScroll) <= 2, `console follows the stream to the bottom (${s.scrollTop}/${s.maxScroll})`);
});

test('a reader who scrolled up is not dragged while streaming continues', opts, async () => {
  await page.evaluate(() => {
    document.querySelector('#v-alpha #consoleBox').scrollTop = 0; // user scrolls to the top
  });
  await sleep(80); // scroll event → follow intent off
  await stream('\nMore output that must not yank the reader:\n'
    + Array.from({ length: 12 }, (_, i) => `extra line ${i}`).join('\n'), 25);
  const s = await consoleState();
  assert.equal(s.scrollTop, 0, 'scrolled-up reader stays put');
});

test('turn completion preserves the reader position (no jump to top or bottom)', opts, async () => {
  await stream('\n— turn done · 2.0s · 1k in / 1k out —\n');
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting', tokens: { in: 1, out: 1 }, costUsd: 0 });
  await sleep(600); // task:update + session:status + transcript-refresh renders
  const s = await consoleState();
  assert.equal(s.scrollTop, 0, 'completion renders keep the scrolled-up position');
});

test('an at-bottom console stays pinned to the bottom through completion', opts, async () => {
  await page.evaluate(() => {
    const box = document.querySelector('#v-alpha #consoleBox');
    box.scrollTop = box.scrollHeight; // user scrolls back down → follow resumes
  });
  await sleep(80);
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await stream('\nwrapping up: final summary line.\n');
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting' });
  await sleep(600);
  const s = await consoleState();
  assert.ok(Math.abs(s.scrollTop - s.maxScroll) <= 2, `still at the bottom (${s.scrollTop}/${s.maxScroll})`);
});

test('a second prompt sent mid-conversation appears in the live console', opts, async () => {
  await page.fill('#composerInput', 'Now check the 2005 cohort please.');
  await page.press('#composerInput', 'Enter');
  await sleep(300);
  const s = await consoleState();
  const t = s.text;
  assert.ok(t.includes('Now check the 2005 cohort please.'), 'second prompt visible in the console');
  assert.ok(t.indexOf('Try β = 0.97') < t.indexOf('Now check the 2005 cohort'),
    'messages appear in conversation order');
});

// Switching away from a scrolled-up console and back must not snap it to the
// bottom. A module-level consoleView map saves each console's {scrollTop,follow}
// per task (renderWB) and restores it when the console re-mounts (wireWB).
// Regression: A→B→A used to reset A to the bottom, losing the reader's place.
test('switching tasks preserves a scrolled-up console (A→B→A is not reset)', opts, async () => {
  // seed a SECOND task in alpha so there are two task tabs to switch between
  const { body: b2 } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Second task', description: 'Another.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  const id2 = b2.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id2}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 's2', startedAt: b2.created, lastTurnAt: b2.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.writeFileSync(path.join(tdir, `${id2}.json`), JSON.stringify({
    created: b2.created,
    entries: [{ role: 'user', text: 'Second task seed.', ts: b2.created }],
  }));
  await wsPush('task:update', { project: 'alpha', task: { ...task, id: id2, title: 'Second task' } });
  await sleep(200);

  // select a task tab by data-id; open the ≋ console tab of the current task
  const selectTask = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  const openConsole = async () => {
    await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
    await sleep(300);
  };

  // task A (the shared `id`): make its console overflow, then open it
  await selectTask(id);
  await openConsole();
  await stream('\n' + Array.from({ length: 60 }, (_, i) => `scrollback line ${i} — filler to overflow the short viewport`).join('\n') + '\n', 28);

  // user scrolls UP to read; capture the position
  await page.evaluate(() => { document.querySelector('#v-alpha #consoleBox').scrollTop = 50; });
  await sleep(120); // scroll event → follow intent off
  const before = await consoleState();
  assert.ok(before.maxScroll > 60, `A console overflows (maxScroll=${before.maxScroll})`);
  assert.ok(Math.abs(before.scrollTop - 50) <= 6, `A scrolled up to ~50 (got ${before.scrollTop})`);

  // switch to B and back (task switch resets fileTab → re-open A's console)
  await selectTask(id2);
  await selectTask(id);
  await openConsole();

  const back = await consoleState();
  assert.ok(Math.abs(back.scrollTop - 50) <= 6,
    `A's scroll is preserved on return (got ${back.scrollTop}, expected ~50)`);
  assert.ok(back.scrollTop < back.maxScroll - 10,
    `A is NOT snapped to the bottom (scrollTop=${back.scrollTop}, maxScroll=${back.maxScroll})`);
});

// Switching PROJECTS (top-nav tabs) and back must also preserve the console
// scroll. renderAll only re-renders the entered view, so the outgoing project's
// renderWB never fires to capture its scroll — go() now saves it on leave, and
// the wireWB restore defers via requestAnimationFrame because the returning
// view is rendered while still display:none (geometry reads 0 until .show).
// Regression: alpha → beta → alpha used to reset alpha's console to the bottom.
test('switching projects preserves a scrolled-up console (alpha→beta→alpha is not reset)', opts, async () => {
  // the harness seeds a `beta` project too; give it a task so it has a workbench
  const { body: bBeta } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'beta', title: 'Beta task', description: 'In the other project.',
    category: 'calibration', oversight: 'coop', context: {},
  });
  const idBeta = bBeta.id;
  await sb.fetchJson('PATCH', `/api/tasks/beta/${idBeta}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 'sb', startedAt: bBeta.created, lastTurnAt: bBeta.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const btdir = path.join(sb.root, 'transcripts', 'beta');
  fs.mkdirSync(btdir, { recursive: true });
  fs.writeFileSync(path.join(btdir, `${idBeta}.json`), JSON.stringify({
    created: bBeta.created,
    entries: [{ role: 'user', text: 'Beta task seed.', ts: bBeta.created }],
  }));
  await sleep(150);

  const goProject = async (v) => {
    await page.evaluate((x) => {
      document.querySelector(`#navProjects .tab[data-v="${x}"]`).click();
    }, v);
    await sleep(300);
  };
  // select task `id` in alpha and open its console
  const selectTaskA = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  const openConsoleA = async () => {
    await page.evaluate(() => { document.querySelector('#v-alpha .ctab.console').click(); });
    await sleep(300);
  };

  // make alpha's task `id` console overflow and scroll the reader up
  await goProject('alpha');
  await selectTaskA(id);
  await openConsoleA();
  await stream('\n' + Array.from({ length: 60 }, (_, i) => `cross-proj line ${i} — filler to overflow the short viewport`).join('\n') + '\n', 28);
  await page.evaluate(() => { document.querySelector('#v-alpha #consoleBox').scrollTop = 50; });
  await sleep(120); // scroll event → follow intent off
  const before = await consoleState();
  assert.ok(before.maxScroll > 60, `alpha console overflows (maxScroll=${before.maxScroll})`);
  assert.ok(Math.abs(before.scrollTop - 50) <= 6, `alpha scrolled up to ~50 (got ${before.scrollTop})`);

  // switch to the beta PROJECT via the top nav, then back to alpha
  await goProject('beta');
  await goProject('alpha');
  await openConsoleA(); // re-open the console tab if the return reset the file tab
  await sleep(200); // wireWB restore defers to requestAnimationFrame once visible

  const back = await consoleState();
  assert.ok(Math.abs(back.scrollTop - 50) <= 6,
    `alpha's scroll is preserved across the project switch (got ${back.scrollTop}, expected ~50)`);
  assert.ok(back.scrollTop < back.maxScroll - 10,
    `alpha is NOT snapped to the bottom on return (scrollTop=${back.scrollTop}, maxScroll=${back.maxScroll})`);
});

// Switching PROJECTS and back must not leave the Claude composer dead. renderWB
// runs while the returning view is still display:none (the .show toggle happens
// after), so the composer's autosize() read scrollHeight 0 and pinned the
// textarea to height:0 — present in the DOM but unclickable. Fix: the initial
// autosize defers via requestAnimationFrame when the input has no layout yet
// (clientHeight 0), sizing it after .show gives the view geometry.
// Regression: alpha → beta → alpha left #composerInput at height 0, swallowing
// clicks (elementFromPoint hit the wrapper div, not the textarea).
test('switching projects keeps the composer clickable (alpha→beta→alpha is not dead)', opts, async () => {
  // give beta a waiting task so it has a workbench to switch to
  const { body: bBeta } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'beta', title: 'Beta composer task', description: 'In the other project.',
    category: 'calibration', oversight: 'coop', context: {},
  });
  const idBeta = bBeta.id;
  await sb.fetchJson('PATCH', `/api/tasks/beta/${idBeta}`, {
    status: 'waiting',
    session: {
      sdkSessionId: 'sbc', startedAt: bBeta.created, lastTurnAt: bBeta.created,
      tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1,
    },
  });
  const btdir = path.join(sb.root, 'transcripts', 'beta');
  fs.mkdirSync(btdir, { recursive: true });
  fs.writeFileSync(path.join(btdir, `${idBeta}.json`), JSON.stringify({
    created: bBeta.created,
    entries: [{ role: 'user', text: 'Beta composer seed.', ts: bBeta.created }],
  }));
  await sleep(150);

  const goProject = async (v) => {
    await page.evaluate((x) => {
      document.querySelector(`#navProjects .tab[data-v="${x}"]`).click();
    }, v);
    await sleep(300);
  };
  // select alpha's waiting task `id` so its composer (status !== done) shows
  const selectTaskA = async (tid) => {
    await page.evaluate((x) => {
      const el = [...document.querySelectorAll('#v-alpha .ptab.tk[data-id]')].find(e => e.dataset.id === x);
      el.click();
    }, tid);
    await sleep(250);
  };
  // composer geometry + what actually sits under its center point
  const composerProbe = () => page.evaluate(() => {
    const inp = document.querySelector('#v-alpha #composerInput');
    if (!inp) return { exists: false };
    const r = inp.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                          Math.round(r.top + r.height / 2));
    return { exists: true, height: Math.round(r.height), hitIsComposer: hit === inp };
  });

  // show alpha's composer
  await goProject('alpha');
  await selectTaskA(id);
  const start = await composerProbe();
  assert.ok(start.height > 0, `composer has height before the switch (got ${start.height})`);

  // leave to beta, come back to alpha, re-select the task
  await goProject('beta');
  await goProject('alpha');
  await selectTaskA(id);
  await sleep(160); // initial autosize defers to requestAnimationFrame once visible

  const back = await composerProbe();
  assert.ok(back.exists, 'composer still present after the project switch');
  assert.ok(back.height > 0, `composer is not pinned to height 0 on return (got ${back.height})`);
  assert.ok(back.hitIsComposer, 'composer center is hittable (not occluded by a height:0 collapse)');

  // a real click must land in the textarea and typing must reach .value
  await page.click('#v-alpha #composerInput');
  await page.fill('#v-alpha #composerInput', ''); // clear any restored draft
  await page.type('#v-alpha #composerInput', 'alive after switch');
  assert.equal(await page.inputValue('#v-alpha #composerInput'), 'alive after switch',
    'click + type lands in the composer after the project switch');
});
