// Focused debug: which completion-time render loses the console element/scroll?
// Stages a short stream, then fires the three completion events one at a time,
// checking element identity + scrollTop after each.
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep, chunked } from '../uiHarness.mjs';

const ui = await startUI({
  seed: ({ projRoots }) => {
    fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'β = 0.96\n');
  },
});
const { sb, page, wsPush } = ui;

try {
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate model', description: 'Fit β.',
    category: 'calibration', oversight: 'coop', context: { files: ['model.jl'] },
  });
  const id = created.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${id}`, {
    status: 'waiting',
    session: { sdkSessionId: 's', startedAt: created.created, lastTurnAt: created.created, tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1 },
  });
  const tdir = path.join(sb.root, 'transcripts', 'alpha');
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({
    created: created.created,
    entries: [{ role: 'user', text: 'Calibrate.', ts: created.created }],
  }));
  const { body: st } = await sb.fetchJson('GET', '/api/state');
  const task = st.tasks.alpha.find((t) => t.id === id);

  page.on('console', (m) => { if (m.type() !== 'debug') console.log('  [page]', m.text()); });

  // spy: every scrollTop WRITE to the console box, with the call site
  await page.addInitScript(() => {
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
            attached: this.isConnected,
            sh: this.scrollHeight,
            ch: this.clientHeight,
            at: new Error().stack.split('\n').slice(2, 5).map((s) => s.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' ← '),
          });
        }
        return desc.set.call(this, v);
      },
      configurable: true,
    });
  });

  await page.goto(`${sb.base}/#alpha:console`);
  await page.waitForSelector('#v-alpha #consoleBox', { timeout: 15000 });
  if (process.env.NO_ANCHOR) {
    await page.addStyleTag({ content: '.consoleBox { overflow-anchor: none; }' });
    console.log('  (overflow-anchor: none applied)');
  }
  await sleep(800);

  // mark task running + stream enough text that the console can scroll
  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'running' } });
  await wsPush('session:status', { project: 'alpha', id, status: 'running' });
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push(`step ${i}: refining the estimate, residual ${(1 / i).toFixed(4)}`);
  for (const c of chunked('⟐ model · auto\n\n— answer —\n' + lines.join('\n'), 400)) {
    await wsPush('session:stream', { project: 'alpha', id, chunk: c });
    await sleep(40);
  }
  await sleep(400);

  const tag = () => page.evaluate(() => {
    const b = document.querySelector('#v-alpha #consoleBox');
    if (b) b.__tagged = true;
    return b ? { scrollTop: Math.round(b.scrollTop), sh: b.scrollHeight } : null;
  });
  const check = (label) => page.evaluate((l) => {
    const b = document.querySelector('#v-alpha #consoleBox');
    return {
      label: l,
      sameEl: !!(b && b.__tagged),
      scrollTop: b ? Math.round(b.scrollTop) : null,
      sh: b ? b.scrollHeight : null,
      scrolledFlag: b ? !!b._scrolled : null,
      wrapN: b ? (b.querySelector('.csegWrap')?._n ?? null) : null,
    };
  }, label);

  console.log('staged:', JSON.stringify(await tag()));
  await page.evaluate(() => { window.__sets = []; }); // only completion-time writes

  await wsPush('task:update', { project: 'alpha', task: { ...task, status: 'waiting' } });
  await sleep(60);
  console.log('after task:update:        ', JSON.stringify(await check('task:update')));

  await tag();
  await wsPush('session:status', { project: 'alpha', id, status: 'waiting', tokens: { in: 1, out: 1 }, costUsd: 0 });
  await sleep(60);
  console.log('after session:status:     ', JSON.stringify(await check('session:status')));

  await tag();
  await sleep(600); // let refreshTranscript's fetch resolve → renderWB
  console.log('after transcript refresh: ', JSON.stringify(await check('refresh')));

  const sets = await page.evaluate(() => window.__sets);
  console.log('\nscrollTop writes during completion:');
  for (const s of sets) {
    console.log(`  t=${s.t} ${s.was}→${s.to} attached=${s.attached} sh=${s.sh} ch=${s.ch}\n      ${s.at}`);
  }
} finally {
  await ui.stop();
}
