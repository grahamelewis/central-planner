// hl.js — tiny dependency-free syntax highlighter for the code pane.
// Line-based with a carry state for multiline constructs (block comments,
// triple-quoted strings), so edits re-tokenize only the changed lines and
// whatever the carry state invalidates downstream. Token classes (.kw .st
// .cm .fn .nm) are styled in style.css under .codeHalf; text always comes
// out of esc(), so a wrong color is the worst possible failure.

'use strict';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const span = (cls, s) => cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s);

/* Each language: one sticky-ish global regex with named groups, a keyword
   set for the generic `id` group, and a table of multiline openers whose
   {cls,end} configs double as the carry-state objects — they are stable
   references, so carry states compare with `===`.
   Group meanings: open (multiline opener) · cm (comment) · st (string) ·
   kwp (directly-keyword pattern) · fn (macro/decorator/var) · nm (number) ·
   id (identifier → kw if in the set). */

const JL_MULTI = { '#=': { cls: 'cm', end: '=#' }, '"""': { cls: 'st', end: '"""' } };
const PY_MULTI = { '"""': { cls: 'st', end: '"""' }, "'''": { cls: 'st', end: "'''" } };

const LANGS = {
  jl: {
    re: /(?<open>#=|""")|(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(?<fn>@[A-Za-z_]\w*!?)|(?<nm>\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*)|(?<id>[A-Za-z_]\w*!?)/g,
    multi: JL_MULTI,
    kw: new Set(('function end if elseif else for while begin let local global const return break continue '
      + 'module baremodule using import export struct mutable abstract primitive type quote do try catch '
      + 'finally macro where in isa true false nothing missing NaN Inf').split(' ')),
  },
  py: {
    re: /(?<open>[rbfuRBFU]{0,2}(?:"""|'''))|(?<cm>#[^\n]*)|(?<st>[rbfuRBFU]{0,2}"(?:\\.|[^"\\])*"|[rbfuRBFU]{0,2}'(?:\\.|[^'\\])*')|(?<fn>@[A-Za-z_][\w.]*)|(?<nm>\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*)|(?<id>[A-Za-z_]\w*)/g,
    multi: PY_MULTI,
    kw: new Set(('def class return if elif else for while in not and or is None True False import from as '
      + 'with try except finally lambda yield pass break continue raise assert del global nonlocal '
      + 'async await match case print').split(' ')),
  },
  r: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<nm>\b0x[\da-fA-F]+L?\b|\b\d+[\d.]*(?:[eE][+-]?\d+)?L?i?\b)|(?<id>[A-Za-z._][\w.]*)/g,
    multi: {},
    kw: new Set(('function if else for while repeat break next return in TRUE FALSE NULL NA NaN Inf '
      + 'library require source setwd c').split(' ')),
  },
  sh: {
    re: /(?<cm>#[^\n]*)|(?<st>"(?:\\.|[^"\\])*"|'[^']*')|(?<fn>\$\{[^}\n]*\}|\$\w+)|(?<nm>\b\d+\b)|(?<id>[A-Za-z_]\w*)/g,
    multi: {},
    kw: new Set(('if then else elif fi for while until do done case esac function in local export '
      + 'return exit set source echo cd').split(' ')),
  },
  tex: {
    re: /(?<cm>%[^\n]*)|(?<st>\$\$[^$]*\$\$|\$[^$\n]*\$)|(?<kwp>\\[A-Za-z@]+\*?|\\.)|(?<nm>\b\d[\d.]*\b)/g,
    multi: {},
    kw: new Set(),
  },
  json: {
    re: /(?<st>"(?:\\.|[^"\\])*")|(?<nm>-?\b\d[\d.]*(?:[eE][+-]?\d+)?\b)|(?<id>[A-Za-z]\w*)/g,
    multi: {},
    kw: new Set(['true', 'false', 'null']),
  },
  md: { custom: mdLine },
};

const EXT_LANG = {
  jl: 'jl', py: 'py', r: 'r', sh: 'sh', bash: 'sh', zsh: 'sh',
  tex: 'tex', sty: 'tex', cls: 'tex', bib: 'tex',
  json: 'json', md: 'md', rmd: 'md', qmd: 'md', markdown: 'md',
};

/** Is there a highlighter for this (lowercase) extension? */
export function hlFor(ext) { return EXT_LANG[ext] || null; }

/* markdown: headings/quotes/fences per line, light inline marks; fence
   bodies stay plain (we don't know their language cheaply) */
const MD_FENCE = { cls: '', end: '' }; // sentinel carry state
const MD_INLINE = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]*\]\([^)\n]*\)/g;
function mdLine(line, st) {
  if (st === MD_FENCE) {
    if (/^\s*(```|~~~)/.test(line)) return [span('cm', line), null];
    return [esc(line), MD_FENCE];
  }
  if (/^\s*(```|~~~)/.test(line)) return [span('cm', line), MD_FENCE];
  if (/^#{1,6}\s/.test(line)) return [span('kw', line), null];
  if (/^\s*>/.test(line)) return [span('cm', line), null];
  let out = '', last = 0, m;
  MD_INLINE.lastIndex = 0;
  while ((m = MD_INLINE.exec(line))) {
    out += esc(line.slice(last, m.index));
    out += span(m[0][0] === '`' ? 'st' : m[0][0] === '[' ? 'fn' : 'nm', m[0]);
    last = MD_INLINE.lastIndex;
  }
  return [out + esc(line.slice(last)), null];
}

/* tokenize one line given the carry state entering it → [html, exitState] */
function lineTok(L, line, st) {
  if (L.custom) return L.custom(line, st);
  let out = '';
  let i = 0;
  while (st) { // finish a multiline construct first
    const e = line.indexOf(st.end, i);
    if (e < 0) return [out + span(st.cls, line.slice(i)), st];
    out += span(st.cls, line.slice(i, e + st.end.length));
    i = e + st.end.length;
    st = null;
  }
  const re = L.re;
  re.lastIndex = i;
  let last = i, m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    const g = m.groups || {};
    const t = m[0];
    if (g.open != null) {
      // strip any string prefix (python r/b/f) so the opener finds its config
      const cfg = L.multi[t] || L.multi[t.replace(/^[A-Za-z]+/, '')];
      if (cfg) {
        const e = line.indexOf(cfg.end, m.index + t.length);
        if (e < 0) return [out + span(cfg.cls, line.slice(m.index)), cfg];
        out += span(cfg.cls, line.slice(m.index, e + cfg.end.length));
        re.lastIndex = e + cfg.end.length;
        last = re.lastIndex;
        continue;
      }
      out += esc(t);
    } else {
      const cls = g.cm != null ? 'cm' : g.st != null ? 'st' : g.kwp != null ? 'kw'
        : g.fn != null ? 'fn' : g.nm != null ? 'nm'
          : g.id != null ? (L.kw.has(t) ? 'kw' : '') : '';
      out += span(cls, t);
    }
    last = re.lastIndex;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
  }
  return [out + esc(line.slice(last)), null];
}

function mkLn(html) {
  const s = document.createElement('span');
  s.className = 'ln';
  s.innerHTML = html + '\n';
  return s;
}

/** One-shot highlight of a whole text → html string (read-only views). */
export function hlText(text, ext) {
  const lk = EXT_LANG[ext];
  if (!lk) return null;
  const L = LANGS[lk];
  let st = null, out = '';
  for (const line of String(text).split('\n')) {
    const [h, ns] = lineTok(L, line, st);
    out += h + '\n';
    st = ns;
  }
  return out;
}

/**
 * Paint/refresh the editor overlay. `codeEl` is the <code> inside the overlay
 * pre — one .ln span per line. `store` is a caller-kept cache object per file
 * ({lang, text, lines, states}); it survives re-renders, so a fresh empty
 * codeEl repaints fully while keystrokes hit the incremental path.
 */
export function paintHL(codeEl, text, ext, store) {
  const lk = EXT_LANG[ext];
  if (!lk) return false;
  const L = LANGS[lk];
  text = String(text);
  if (store.lang === lk && store.text === text && codeEl.childElementCount === (store.lines?.length || 0)) {
    return true; // up to date
  }

  // full render: first paint, language change, or DOM out of sync with cache
  if (store.lang !== lk || !store.lines || codeEl.childElementCount !== store.lines.length) {
    const nl = text.split('\n');
    let st = null, html = '';
    const states = [null];
    for (let i = 0; i < nl.length; i++) {
      const [h, ns] = lineTok(L, nl[i], st);
      html += '<span class="ln">' + h + '\n</span>';
      st = ns;
      states.push(st);
    }
    codeEl.innerHTML = html;
    store.lang = lk; store.text = text; store.lines = nl; store.states = states;
    return true;
  }

  // incremental: replace only the changed line range, then ripple the carry
  // state forward until it matches the cached entry state again
  const nl = text.split('\n');
  const old = store.lines, states = store.states;
  let pre = 0;
  const max = Math.min(nl.length, old.length);
  while (pre < max && nl[pre] === old[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && nl[nl.length - 1 - suf] === old[old.length - 1 - suf]) suf++;
  const oldEnd = old.length - suf, newEnd = nl.length - suf;

  let st = states[pre];
  const frag = document.createDocumentFragment();
  const midStates = [];
  for (let i = pre; i < newEnd; i++) {
    const [h, ns] = lineTok(L, nl[i], st);
    frag.appendChild(mkLn(h));
    st = ns;
    midStates.push(st);
  }
  const kids = codeEl.children; // live collection
  for (let i = oldEnd - 1; i >= pre; i--) codeEl.removeChild(kids[i]);
  codeEl.insertBefore(frag, codeEl.children[pre] || null);

  const newStates = states.slice(0, pre + 1).concat(midStates, states.slice(oldEnd + 1));
  // ripple: re-tokenize suffix lines while their entry state actually changed
  // (compare against the OLD cached entry — states[oldEnd + offset]); carry
  // states are stable object references, so identity comparison is exact
  let j = newEnd;
  while (j < nl.length && st !== states[oldEnd + (j - newEnd)]) {
    newStates[j] = st;
    const [h, ns] = lineTok(L, nl[j], st);
    codeEl.children[j].innerHTML = h + '\n';
    st = ns;
    j++;
  }
  if (j === nl.length) newStates[nl.length] = st;

  store.text = text; store.lines = nl; store.states = newStates;
  return true;
}
