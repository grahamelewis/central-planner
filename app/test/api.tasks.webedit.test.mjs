// Guards the correctness contract behind the in-task "web search toggle" UI.
//
// The toggle flips one nested flag — context.web_search.enabled — but
// updateTask() merges patches with a SHALLOW top-level spread
// ({ ...task, ...patch }), so the whole `context` object is REPLACED, never
// deep-merged. A partial `{ context: { web_search } }` patch would therefore
// wipe files/notes/flags. The frontend dodges this by PATCHing the FULL
// context with only web_search.enabled flipped. These tests document and
// protect that behavior at the server level. Complements api.tasks.test.mjs
// (which covers CREATE-time deep merge and PATCH's top-level shallow merge);
// here we focus on the web_search toggle round-trip specifically.
//
// BILLING-SAFE: only POST/PATCH/GET on /api/tasks and /api/state. Never
// /launch, /message, or /api/profile/generate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from './serverHarness.mjs';

let sb;
before(async () => { sb = await startSandbox(); });
after(async () => { if (sb) await sb.stop(); });

// Pull the live context for a task straight from /api/state — the same source
// the frontend reads before building its full-context PATCH.
async function currentTask(project, id) {
  const { body: state } = await sb.fetchJson('GET', '/api/state');
  return state.tasks[project].find((t) => t.id === id);
}

test('full-context PATCH flips web_search and preserves the rest of context', async () => {
  // This is the exact pattern the web-search toggle uses: read the current
  // context, spread it, and override only web_search.
  const { status, body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha',
    title: 'Toggle target',
    context: {
      web_search: { enabled: false, sources: [] },
      files: ['notes.md'],
      notes: 'keep me',
      include_abstract: true,
    },
  });
  assert.equal(status, 201);
  assert.equal(created.context.web_search.enabled, false);

  const current = await currentTask('alpha', created.id);
  const { body: patched } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${created.id}`, {
    context: { ...current.context, web_search: { enabled: true, sources: [] } },
  });

  assert.equal(patched.context.web_search.enabled, true, 'toggle took effect');
  assert.deepEqual(patched.context.files, ['notes.md'], 'files survived the toggle');
  assert.equal(patched.context.notes, 'keep me', 'notes survived the toggle');
  assert.equal(patched.context.include_abstract, true, 'flags survived the toggle');

  // And it is durable: re-read from /api/state.
  const refetched = await currentTask('alpha', created.id);
  assert.equal(refetched.context.web_search.enabled, true);
  assert.deepEqual(refetched.context.files, ['notes.md']);
  assert.equal(refetched.context.notes, 'keep me');
});

test('partial-context PATCH is lossy — the rationale for sending full context', async () => {
  // If the frontend PATCHed ONLY the changed slice, the shallow top-level
  // merge in updateTask() would REPLACE context wholesale, dropping files /
  // notes / flags. We assert that loss here so the full-context approach has a
  // documented reason to exist. (Verified against real behavior: nothing
  // re-fills context defaults on PATCH, unlike createTask — so the keys we
  // never sent simply vanish.)
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha',
    title: 'Lossy patch victim',
    context: {
      web_search: { enabled: false, sources: [] },
      files: ['important.md'],
      notes: 'do not lose me',
      include_abstract: true,
    },
  });
  assert.deepEqual(created.context.files, ['important.md']);

  const { body: patched } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${created.id}`, {
    context: { web_search: { enabled: true, sources: [] } },
  });

  // context was REPLACED, not merged: only web_search remains.
  assert.equal(patched.context.web_search.enabled, true);
  assert.equal(patched.context.files, undefined, 'files were wiped by the partial PATCH');
  assert.equal(patched.context.notes, undefined, 'notes were wiped by the partial PATCH');
  assert.equal(patched.context.include_abstract, undefined, 'flags were wiped by the partial PATCH');
  assert.deepEqual(Object.keys(patched.context), ['web_search'],
    'PATCH does a shallow top-level merge — partial context obliterates the rest');
});

test('sources are preserved when toggling enabled via full-context PATCH', async () => {
  const { body: created } = await sb.fetchJson('POST', '/api/tasks', {
    project: 'alpha',
    title: 'Sourced search',
    context: { web_search: { enabled: true, sources: ['arxiv.org'] } },
  });
  assert.deepEqual(created.context.web_search.sources, ['arxiv.org']);

  const current = await currentTask('alpha', created.id);
  const { body: patched } = await sb.fetchJson('PATCH', `/api/tasks/alpha/${created.id}`, {
    // flip enabled, carry sources through unchanged via the full context spread
    context: { ...current.context, web_search: { ...current.context.web_search, enabled: false } },
  });

  assert.equal(patched.context.web_search.enabled, false, 'enabled flipped to false');
  assert.deepEqual(patched.context.web_search.sources, ['arxiv.org'], 'sources untouched by the toggle');
});
