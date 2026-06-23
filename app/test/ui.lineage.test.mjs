// Add Task modal — archived tasks must be linkable as lineage.
// (They hold exactly the handoffs a follow-up task wants injected; only the
// picker used to exclude them.) Skips cleanly without Chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep } from './uiHarness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page, archivedId;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ sb, page } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Old calibration', category: 'calibration', oversight: 'coop',
  });
  archivedId = t.id;
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${archivedId}`, {
    archived: true,
    status: 'waiting',
    handoff: { summary: 'β = 0.96 calibrated', artifacts: [], numbers: [['beta', '0.96']], decisions: [], next: 'try 2005 cohort' },
  });
  await page.goto(`${sb.base}/#new`);
  await page.waitForSelector('#mUp, #modalForm', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

test('an archived task appears in the lineage picker, marked ▣', opts, async () => {
  const chip = await page.textContent(`#mUp .qchip[data-u="${archivedId}"]`);
  assert.ok(chip, 'archived task has a lineage chip');
  assert.ok(chip.includes('▣'), 'chip carries the archived marker');
  assert.ok(chip.includes('archived'), 'chip says archived instead of a stale status');
});

test('saving with an archived upstream stores the link', opts, async () => {
  await page.click(`#mUp .qchip[data-u="${archivedId}"]`);
  await page.fill('#mTitle', 'Follow-up calibration');
  await page.click('#mSave');
  await sleep(400);
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  const created = state.tasks.alpha.find((t) => t.title === 'Follow-up calibration');
  assert.ok(created, 'task was created');
  assert.deepEqual(created.upstream, [archivedId], 'archived task recorded as upstream');
});
