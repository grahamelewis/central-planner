// Minimal faithful DOM stub for hl.js paintHL testing.
// Output of hl.js only ever contains <span class="..."> ... </span> with all
// text escaped via esc(), so a depth-counting parser is exact.

const LN_OPEN = '<span class="ln">';

export function parseLnSpans(html) {
  const inners = [];
  let i = 0;
  while (i < html.length) {
    if (!html.startsWith(LN_OPEN, i)) {
      throw new Error('innerHTML parse: expected <span class="ln"> at index ' + i +
        ' got ' + JSON.stringify(html.slice(i, i + 40)));
    }
    let depth = 1, j = i + LN_OPEN.length;
    const start = j;
    while (depth > 0) {
      const o = html.indexOf('<span', j);
      const c = html.indexOf('</span>', j);
      if (c < 0) throw new Error('innerHTML parse: unbalanced spans');
      if (o >= 0 && o < c) { depth++; j = o + 5; }
      else { depth--; j = c + 7; }
    }
    inners.push(html.slice(start, j - 7));
    i = j;
  }
  return inners;
}

export class FakeFragment {
  constructor() { this.children = []; }
  appendChild(n) {
    if (!n) throw new Error('appendChild: bad arg');
    this.children.push(n);
    return n;
  }
}

export class FakeSpan {
  constructor(tag) { this.tagName = (tag || 'span').toUpperCase(); this.className = ''; this._html = ''; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
}

export class FakeCode {
  constructor() { this._kids = []; } // never reassigned -> live collection semantics
  get children() { return this._kids; }
  get childElementCount() { return this._kids.length; }
  set innerHTML(v) {
    const inners = parseLnSpans(String(v));
    this._kids.length = 0; // mutate in place: stays live
    for (const inner of inners) {
      const s = new FakeSpan('span');
      s.className = 'ln';
      s._html = inner;
      this._kids.push(s);
    }
  }
  get innerHTML() {
    return this._kids.map(k => `<span class="${k.className}">${k._html}</span>`).join('');
  }
  removeChild(n) {
    if (n == null) throw new Error('removeChild: null/undefined (real DOM throws TypeError)');
    const idx = this._kids.indexOf(n);
    if (idx < 0) throw new Error('removeChild: node is not a child (NotFoundError)');
    this._kids.splice(idx, 1);
    return n;
  }
  insertBefore(n, ref) {
    if (n == null) throw new Error('insertBefore: null/undefined node');
    let idx;
    if (ref == null) idx = this._kids.length;
    else {
      idx = this._kids.indexOf(ref);
      if (idx < 0) throw new Error('insertBefore: ref is not a child (NotFoundError)');
    }
    const nodes = (n instanceof FakeFragment) ? n.children.splice(0, n.children.length) : [n];
    this._kids.splice(idx, 0, ...nodes);
    return n;
  }
}

export function installDocument() {
  globalThis.document = {
    createElement: (tag) => new FakeSpan(tag),
    createDocumentFragment: () => new FakeFragment(),
  };
}

// ---- verification helpers ----

const UNESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
export function stripToText(html) {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot);/g, (m) => UNESC[m]);
}
