// Julia-style \symbol Tab-completion in text inputs (\varepsilon⇥ → ε).
// Composer + Add Task fields always; the code editor only for .jl files
// (Tab stays indentation elsewhere — .tex is full of intentional \alpha).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startUI, sleep } from './uiHarness.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hasChrome = fs.existsSync(CHROME);
const opts = { skip: hasChrome ? false : 'Google Chrome not installed' };

let ui, sb, page;

before(async () => {
  if (!hasChrome) return;
  ui = await startUI({
    seed: ({ projRoots }) => {
      fs.writeFileSync(path.join(projRoots.alpha, 'model.jl'), 'x = 1\n');
      fs.writeFileSync(path.join(projRoots.alpha, 'notes.tex'), '\\section{x}\n');
    },
  });
  ({ sb, page } = ui);
  const { body: t } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha', title: 'Calibrate', category: 'calibration', oversight: 'coop',
    context: { files: ['model.jl', 'notes.tex'] },
  });
  await sb.fetchJson('PATCH', `/api/tasks/alpha/${t.id}`, {
    status: 'waiting',
    session: { sdkSessionId: 's', startedAt: t.created, lastTurnAt: t.created, tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1 },
  });
  await page.goto(`${sb.base}/#alpha`);
  await page.waitForSelector('#composerInput', { timeout: 15000 });
  await sleep(400);
});
after(async () => { if (ui) await ui.stop(); });

test('composer: \\varepsilon + Tab → ε, mid-sentence and with sub/superscripts', opts, async () => {
  await page.click('#composerInput');
  await page.keyboard.type('Set \\varepsilon');
  await page.keyboard.press('Tab');
  await page.keyboard.type(' below \\beta');
  await page.keyboard.press('Tab');
  await page.keyboard.type('\\_t');
  await page.keyboard.press('Tab');
  await page.keyboard.type(' and x\\^2');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#composerInput'), 'Set ε below βₜ and x²');
});

test('composer: unknown \\name keeps the text and the focus', opts, async () => {
  await page.fill('#composerInput', '');
  await page.click('#composerInput');
  await page.keyboard.type('\\notathing');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#composerInput'), '\\notathing', 'text untouched');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'composerInput', 'focus not yanked');
  await page.fill('#composerInput', '');
});

test('editor: .jl files complete like the Julia REPL; plain Tab still indents', opts, async () => {
  await page.click('#v-alpha .ctabs .ctab[data-fi="0"]'); // model.jl
  await page.waitForSelector('#v-alpha #codeEditor');
  await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
  });
  await page.keyboard.type('\\sigma');
  await page.keyboard.press('Tab');
  let v = await page.inputValue('#v-alpha #codeEditor');
  assert.ok(v.endsWith('σ'), `completes in .jl (got …${JSON.stringify(v.slice(-8))})`);
  await page.keyboard.press('Tab');
  v = await page.inputValue('#v-alpha #codeEditor');
  assert.ok(v.endsWith('σ  '), 'plain Tab still indents');
});

test('editor: .tex files never convert — Tab is indentation only', opts, async () => {
  await page.click('#v-alpha .ctabs .ctab[data-fi="1"]'); // notes.tex
  await page.waitForSelector('#v-alpha #codeEditor[data-ext="tex"]');
  await page.evaluate(() => {
    const ed = document.querySelector('#v-alpha #codeEditor');
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
  });
  await page.keyboard.type('\\alpha');
  await page.keyboard.press('Tab');
  const v = await page.inputValue('#v-alpha #codeEditor');
  assert.ok(v.endsWith('\\alpha  '), `\\alpha stays literal + indent (got …${JSON.stringify(v.slice(-10))})`);
});

test('Add Task fields convert too', opts, async () => {
  await page.click('#openModal');
  await page.waitForSelector('#mDesc');
  await page.click('#mDesc');
  await page.keyboard.type('Estimate \\mu');
  await page.keyboard.press('Tab');
  await page.keyboard.type(' and \\Sigma');
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#mDesc'), 'Estimate μ and Σ');
  await page.keyboard.press('Escape'); // close the modal
});
