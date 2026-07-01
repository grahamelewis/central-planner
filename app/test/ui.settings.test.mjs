// Settings view + light/dark theme toggle: the profile menu opens Settings,
// the three-way control (system | dark | light) flips html[data-theme],
// persists in localStorage across reloads, and 'system' tracks
// prefers-color-scheme live.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startUI, sleep } from './uiHarness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;

const themeAttr = () => page.evaluate(() => document.documentElement.dataset.theme || null);
const stored = () => page.evaluate(() => localStorage.getItem('theme'));
const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

before(async () => {
  if (!hasChrome) return;
  ui = await startUI();
  ({ sb, page } = ui);
  // headless Chrome reports prefers-color-scheme: light by default — pin it
  // to dark so 'system' starts on the dashboard's classic look
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(sb.base);
  await page.waitForSelector('#bento', { timeout: 15000 });
  await sleep(300);
});
after(async () => { if (ui) await ui.stop(); });

test('default is system: dark OS → no data-theme, dark canvas', opts, async () => {
  assert.equal(await themeAttr(), null, 'no data-theme attribute');
  assert.equal(await stored(), null, 'nothing persisted yet');
  assert.match(await bodyBg(), /rgb\(16, 18, 32\)/, 'body paints the dark base');
});

test('system tracks prefers-color-scheme live', opts, async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(100);
  assert.equal(await themeAttr(), 'light', 'OS flip to light re-themes without a reload');
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(100);
  assert.equal(await themeAttr(), null, 'and back');
});

test('profile menu → Settings → Light: applies, persists, survives reload', opts, async () => {
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show #themeSeg');
  assert.equal(
    await page.evaluate(() => document.querySelector('#themeSeg .segOpt.on')?.dataset.th),
    'system', 'control starts on System');

  await page.click('#themeSeg .segOpt[data-th="light"]');
  assert.equal(await themeAttr(), 'light');
  assert.equal(await stored(), 'light');
  assert.match(await bodyBg(), /rgb\(238, 240, 247\)/, 'body paints the paper base');

  await page.reload();
  await page.waitForSelector('#bento', { timeout: 15000 });
  assert.equal(await themeAttr(), 'light', 'the head bootstrap re-applies before paint');
  assert.match(await bodyBg(), /rgb\(238, 240, 247\)/);
});

test('Dark forces dark even on a light OS; System returns to following it', opts, async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('#profileBtn');
  await page.click('#profileMenu .pmItem[data-pm="Settings"]');
  await page.waitForSelector('#v-settings.show #themeSeg');

  await page.click('#themeSeg .segOpt[data-th="dark"]');
  assert.equal(await themeAttr(), null, 'dark override beats the light OS');
  assert.equal(await stored(), 'dark');
  assert.match(await bodyBg(), /rgb\(16, 18, 32\)/);

  await page.click('#themeSeg .segOpt[data-th="system"]');
  assert.equal(await themeAttr(), 'light', 'system resumes following the (light) OS');
  assert.equal(await stored(), 'system');
});
