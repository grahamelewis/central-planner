// lib/pins.js — kind-aware pinned context.
// Pins come in three kinds: code/text (read on demand by the session), data
// (we inject a generated "data card": schema, sample rows, scale — never the
// content), and folders (an annotated tree map). Cards are cached by mtime.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ARTIFACT_GLOBS } from './config.js';
import { containedPath } from './paths.js';

const pexecFile = promisify(execFile);
const logErr = (...a) => console.error('[pins]', ...a);

export const DATA_EXTS = ['csv', 'tsv', 'parquet', 'dta', 'rds', 'rdata', 'feather', 'xlsx', 'xls'];

const ignoreDirSet = new Set(ARTIFACT_GLOBS.ignoreDirs || []);
const CARD_CACHE = new Map(); // abs → { stamp, card }

export function pinKind(fileish) {
  const f = String(fileish || '');
  if (f.endsWith('/')) return 'folder';
  const ext = f.split('.').pop().toLowerCase();
  return DATA_EXTS.includes(ext) ? 'data' : 'code';
}

function human(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
  return bytes + ' B';
}

// ---------------------------------------------------------------------------
// Data cards
// ---------------------------------------------------------------------------

// crude type inference for the csv sample
function inferType(values) {
  let num = 0, int = 0, date = 0, filled = 0;
  for (const v of values) {
    if (v === '' || v == null) continue;
    filled++;
    if (/^-?\d+$/.test(v)) { int++; num++; }
    else if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(v)) num++;
    else if (/^\d{4}-\d{2}-\d{2}/.test(v)) date++;
  }
  if (!filled) return 'empty';
  if (num === filled) return int === filled ? 'int' : 'float';
  if (date === filled) return 'date';
  return 'str';
}

// quote-aware record scanner: respects newlines INSIDE quoted fields
function scanCsvRecords(text, delim, maxRecords) {
  const records = [];
  let field = '', record = [], inQ = false, sawQuotedNl = false;
  for (let i = 0; i < text.length && records.length < maxRecords; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQ = false;
      } else {
        if (ch === '\n') sawQuotedNl = true;
        field += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === delim) {
      record.push(field); field = '';
    } else if (ch === '\n') {
      record.push(field.replace(/\r$/, ''));
      if (record.some(f => f !== '')) records.push(record);
      record = []; field = '';
    } else {
      field += ch;
    }
  }
  return { records, sawQuotedNl };
}

const stripCtl = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·');

async function csvCard(abs, st) {
  const ext = abs.split('.').pop().toLowerCase();
  const delim = ext === 'tsv' ? '\t' : ',';
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(256 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let text = buf.toString('utf8', 0, n);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  const { records, sawQuotedNl } = scanCsvRecords(text, delim, 7);
  const header = (records[0] || ['']).map(stripCtl);
  const sample = records.slice(1, 7).map(r => r.map(stripCtl));

  // row count: exact line count via wc; flag as approximate when quoted
  // newlines exist (records ≠ lines then) or the file lacks a trailing newline
  let rows = null;
  let rowsNote = '';
  try {
    const { stdout } = await pexecFile('wc', ['-l', abs], { timeout: 30000 });
    rows = Math.max(0, parseInt(stdout.trim(), 10) - 1);
    if (sawQuotedNl) rowsNote = ' (approx — quoted multi-line fields present)';
    else if (n > 0 && buf[n - 1] !== 0x0a && n === st.size) rows += 1; // no trailing newline
  } catch { /* unknown */ }

  const types = header.map((_, i) => inferType(sample.map(r => (r[i] ?? '').trim())));
  const colLines = header.map((h, i) => `  ${h || `(col ${i + 1})`}: ${types[i]}`);
  const sampleLines = sample.slice(0, 5).map(r => '  ' + r.map(v => {
    const one = v.replace(/\n/g, '⏎');
    return one.length > 24 ? one.slice(0, 21) + '…' : one;
  }).join(' | '));

  return [
    `format: ${ext} · size: ${human(st.size)}${rows != null ? ` · rows: ${rows.toLocaleString()}${rowsNote}` : ''} · cols: ${header.length}`,
    `columns (type inferred from sample):`,
    ...colLines.slice(0, 60),
    header.length > 60 ? `  … ${header.length - 60} more columns` : null,
    `sample rows:`,
    `  ${header.map(h => h.length > 24 ? h.slice(0, 21) + '…' : h).join(' | ')}`,
    ...sampleLines,
  ].filter(Boolean).join('\n');
}

// binary formats → python (pandas/pyarrow); degrades to a stub when missing
const PY_CARD = `
import sys, os, json
p = sys.argv[1]; ext = p.rsplit('.', 1)[-1].lower()
def emit(rows, cols, dtypes, sample):
    print(f"rows: {rows if rows is not None else '?'} | cols: {cols}")
    print("columns:")
    for c, t in list(dtypes)[:60]:
        print(f"  {c}: {t}")
    if len(dtypes) > 60: print(f"  ... {len(dtypes)-60} more columns")
    print("sample rows:")
    print(sample)
if ext == 'parquet':
    try:
        import pyarrow.parquet as pq
        f = pq.ParquetFile(p); md = f.metadata
        import pandas as pd
        df = next(f.iter_batches(batch_size=5)).to_pandas()
        emit(md.num_rows, md.num_columns, [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
        sys.exit(0)
    except ImportError: pass
import pandas as pd
if ext == 'dta':
    rdr = pd.read_stata(p, chunksize=5); df = next(rdr)
    emit(None, len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
elif ext in ('xlsx', 'xls'):
    df = pd.read_excel(p, nrows=5)
    emit(None, len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
elif ext == 'feather':
    df = pd.read_feather(p)
    emit(len(df), len(df.columns), [(c, str(t)) for c, t in zip(df.columns, df.dtypes)], df.head(5).to_string(max_colwidth=24))
else:
    print("(no python reader for ." + ext + ")")
`;

async function binaryCard(abs, st) {
  const ext = abs.split('.').pop().toLowerCase();
  if (ext === 'rds' || ext === 'rdata') {
    // R serialized — describing it needs R; keep it a stub with instructions
    return `format: ${ext} · size: ${human(st.size)}\n(R serialized object — inspect via: Rscript -e 'str(readRDS("${abs}"), max.level=2)')`;
  }
  try {
    const { stdout } = await pexecFile('python3', ['-c', PY_CARD, abs], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return `format: ${ext} · size: ${human(st.size)}\n${stdout.trim().slice(0, 4000)}`;
  } catch (err) {
    return `format: ${ext} · size: ${human(st.size)}\n(schema unavailable: ${String(err.message || err).split('\n')[0].slice(0, 160)} — inspect via bash)`;
  }
}

// ---------------------------------------------------------------------------
// Folder maps
// ---------------------------------------------------------------------------

function folderTree(abs) {
  const lines = [];
  let entries = 0;
  const MAX_ENTRIES = 120, MAX_DEPTH = 3, MAX_PER_DIR = 25;
  const walk = (dir, depth, indent) => {
    if (depth > MAX_DEPTH || entries >= MAX_ENTRIES) return;
    let kids;
    try {
      kids = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && !e.name.includes('\r'))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    } catch { return; }
    const shown = kids.slice(0, MAX_PER_DIR);
    for (const e of shown) {
      if (entries >= MAX_ENTRIES) { lines.push(`${indent}… (cap reached)`); return; }
      entries++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirSet.has(e.name)) { lines.push(`${indent}${e.name}/ (ignored)`); continue; }
        let count = 0;
        try { count = fs.readdirSync(p).length; } catch { /* */ }
        lines.push(`${indent}${e.name}/ (${count} entries)`);
        walk(p, depth + 1, indent + '  ');
      } else {
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* */ }
        lines.push(`${indent}${e.name} (${human(size)})`);
      }
    }
    if (kids.length > MAX_PER_DIR) lines.push(`${indent}… ${kids.length - MAX_PER_DIR} more`);
  };
  walk(abs, 0, '');
  return lines.join('\n') || '(empty)';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate the injectable card for a data or folder pin. */
export async function pinCard(project, fileish) {
  try {
    const rel = String(fileish).replace(/\/+$/, '');
    const contained = containedPath(project, rel);
    if (!contained) return { error: `not found or outside the project: ${fileish}` };
    const { abs } = contained;
    const st = fs.statSync(abs);
    // kind from the disk, not the pin string: callers (the dashboard included)
    // strip the trailing slash folder pins are stored with, and a suffix-only
    // check then misreads every folder pin as 'code' and refuses the card
    const kind = st.isDirectory() ? 'folder' : pinKind(fileish);
    if (kind === 'code') return { error: 'code pins have no card — the session reads them' };

    // cache key: folders by 60s TTL (dir mtime is unreliable), files by mtime
    const stamp = kind === 'folder' ? Math.floor(Date.now() / 60000) : st.mtimeMs;
    const hit = CARD_CACHE.get(abs);
    if (hit && hit.stamp === stamp) return { kind, card: hit.card };

    let card;
    if (kind === 'folder') {
      if (!st.isDirectory()) return { error: `${fileish} is not a directory` };
      card = `folder map of ${rel}/:\n${folderTree(abs)}`;
    } else {
      if (!st.isFile()) return { error: `${fileish} is not a file` };
      const ext = abs.split('.').pop().toLowerCase();
      card = (ext === 'csv' || ext === 'tsv')
        ? await csvCard(abs, st)
        : await binaryCard(abs, st);
    }
    CARD_CACHE.set(abs, { stamp, card });
    if (CARD_CACHE.size > 200) CARD_CACHE.delete(CARD_CACHE.keys().next().value);
    return { kind, card };
  } catch (err) {
    logErr('pinCard failed:', err.message);
    return { error: err.message };
  }
}
