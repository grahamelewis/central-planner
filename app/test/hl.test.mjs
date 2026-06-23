// test/hl.test.mjs — hl.js syntax highlighter invariants.
//  1. round-trip fidelity: stripping tags + unescaping the highlighted HTML
//     must equal the original input (a wrong color is tolerable; lost/garbled
//     text is not).
//  2. incremental == fresh-full-render: paintHL after a sequence of edits must
//     produce byte-identical DOM to a from-scratch render of the same text.
// Uses the faithful depth-counting DOM stub in test/domstub.mjs.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { FakeCode, installDocument, stripToText } from './domstub.mjs';
import { APP_DIR } from './helpers.mjs';

installDocument();
const { paintHL, hlText } = await import(path.join(APP_DIR, 'public', 'hl.js'));

// Representative snippets per language (cover comments, strings, multiline
// constructs, and HTML-significant characters that must survive escaping).
const SNIPPETS = {
  jl: 'function f(x)\n    @assert x > 0  # check & <ok>\n    s = "a<b>&\\"c"\n    return x^2\nend\n#=\nblock comment with < > &\n=#\ndone',
  py: 'def g(n):\n    """doc <x> & "q" """\n    s = \'a<b>\' + "d&e"\n    # comment <tag>\n    return [i for i in range(n)]\nclass C: pass',
  r: 'f <- function(x) {\n  # comment <a&b>\n  y <- "str & <x>"\n  z <- c(1L, 2.5, 0xFFL)\n  TRUE & FALSE\n}',
  sh: '#!/bin/bash\n# a comment <x> & "q"\nfor f in *.txt; do\n  echo "hi $USER & ${HOME}"\ndone',
  md: '# Heading <x> &\n> a quote\ntext with `code` and **bold** and [link](http://u)\n```\nfenced < > & body\n```\nafter',
  json: '{\n  "key": "va<l&ue\\"",\n  "n": -1.5e3,\n  "ok": true,\n  "z": null\n}',
  tex: '% comment <x>\n\\section{Title & more}\ntext $x^2 + y$ and $$\\int_0^1$$ done',
};

function freshRender(text, ext) {
  const el = new FakeCode();
  const store = {};
  paintHL(el, text, ext, store);
  return el;
}

describe('hlFor / hlText basics', () => {
  test('hlText returns null for an unknown extension', async () => {
    assert.equal(hlText('x', 'zzz'), null);
  });

  for (const [ext, snip] of Object.entries(SNIPPETS)) {
    test(`hlText(${ext}) round-trips text exactly (strip tags + unescape === input)`, () => {
      const html = hlText(snip, ext);
      assert.ok(html != null, `hlText should support ${ext}`);
      // hlText appends a trailing \n per line; compare line-by-line content
      const got = stripToText(html);
      assert.equal(got, snip + '\n', `text fidelity for ${ext}`);
    });

    test(`hlText(${ext}) emits no unescaped < or & outside span tags`, () => {
      const html = hlText(snip, ext);
      // strip all span tags, then assert no raw < > remain (all should be &lt; etc.)
      const noTags = html.replace(/<span class="[^"]*">/g, '').replace(/<\/span>/g, '');
      assert.ok(!/[<>]/.test(noTags), `no raw angle brackets leak for ${ext}`);
    });
  }
});

describe('paintHL: incremental render === fresh full render', () => {
  // A handful of representative edit sequences per language. After each edit,
  // the incrementally-updated DOM must equal a from-scratch render.
  for (const [ext, snip] of Object.entries(SNIPPETS)) {
    test(`${ext}: a sequence of edits stays consistent with full render`, () => {
      const el = new FakeCode();
      const store = {};
      const lines = snip.split('\n');
      const edits = [
        snip,                                    // initial
        lines.slice(0, -1).join('\n'),           // delete last line
        lines.join('\n') + '\nappended tail',    // append a line
        lines.slice(1).join('\n'),               // delete first line
        ['NEW FIRST'].concat(lines).join('\n'),  // prepend a line
        lines.map((l, i) => (i === 1 ? l + ' edited' : l)).join('\n'), // edit line 1
        snip,                                    // back to original
      ];
      for (const text of edits) {
        paintHL(el, text, ext, store);
        // (a) text fidelity per line
        const want = text.split('\n');
        assert.equal(el.children.length, want.length, `line count for ${ext}`);
        for (let i = 0; i < want.length; i++) {
          assert.equal(stripToText(el.children[i].innerHTML), want[i] + '\n',
            `line ${i} text fidelity for ${ext}`);
        }
        // (b) byte-identical to a fresh full render
        assert.equal(el.innerHTML, freshRender(text, ext).innerHTML,
          `incremental === full for ${ext} after edit`);
        // (c) store invariants
        assert.equal(store.states.length, want.length + 1, `states length for ${ext}`);
      }
    });
  }

  test('multiline construct toggling ripples correctly (jl block comment)', () => {
    const el = new FakeCode();
    const store = {};
    const seq = [
      'a\nb\nc\nd\ne',
      'a\nb\n#=\nc\nd\ne',     // open a block comment mid-document
      'a\nb\n#=\nc\n=#\nd\ne', // close it
      'a\nb\nc\nd\ne',         // remove it again
    ];
    for (const text of seq) {
      paintHL(el, text, 'jl', store);
      assert.equal(el.innerHTML, freshRender(text, 'jl').innerHTML);
    }
  });

  test('markdown fence toggling ripples correctly', () => {
    const el = new FakeCode();
    const store = {};
    const seq = ['a\n```\nb\nc', 'a\n```\nb\nc\n```', 'a\nb\nc\n```', 'a\nb\nc'];
    for (const text of seq) {
      paintHL(el, text, 'md', store);
      assert.equal(el.innerHTML, freshRender(text, 'md').innerHTML);
    }
  });
});
