// lib/dataview.js — server-side data head viewer.
// Reads ONLY the head of a data file (pandas via a short inline python script,
// Rscript+jsonlite for .rds/.rdata, a naive node parser as the csv/tsv
// fallback) and returns either a JSON object or a complete standalone dark
// HTML page meant for a sandboxed iframe. Never throws; results cached by
// file mtime.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PROJECTS } from './config.js';
import { containedPath } from './paths.js';

const PY_EXTS = new Set(['csv', 'tsv', 'parquet', 'feather', 'dta', 'xlsx', 'xls']);
const R_EXTS = new Set(['rds', 'rdata']);

const CHILD_TIMEOUT_MS = 15000;
// worst case rows=500 × 80 cols × ~200-char cells ≈ 8MB of JSON — keep headroom
const STDOUT_CAP = 12 * 1024 * 1024;
// formats whose readers load the whole object before .head() (no streaming
// API): refuse absurd files instead of grinding the server
const WHOLE_FILE_EXTS = new Set(['rds', 'rdata', 'feather', 'xlsx', 'xls']);
const WHOLE_FILE_MAX = 500 * 1024 * 1024;
const CELL_MAX = 200;
const COL_MAX = 80;

const CACHE = new Map(); // `${abs}::${rows}` → { mtimeMs, result, isError, ts }
const CACHE_MAX = 50;
const ERROR_TTL_MS = 30000; // errors retry after 30s (e.g. pandas got installed)
const INFLIGHT = new Map(); // key → Promise — dedup concurrent identical requests

// ---------------------------------------------------------------------------
// child runner — argv arrays only, 15s → SIGKILL, 2MB stdout cap, never throws
// ---------------------------------------------------------------------------

function runChild(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ error: err.message });
    }
    let out = '';
    let errBuf = '';
    let settled = false;
    let truncated = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish({ error: `${path.basename(cmd)} timed out after ${CHILD_TIMEOUT_MS / 1000}s` });
    }, CHILD_TIMEOUT_MS);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      if (out.length > STDOUT_CAP) {
        truncated = true;
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    });
    child.stderr.on('data', (c) => {
      errBuf = (errBuf + c.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      finish({ error: err.code === 'ENOENT' ? `${cmd} not found on PATH` : err.message });
    });
    child.on('close', (code) => {
      if (truncated) return finish({ error: `preview output exceeded ${STDOUT_CAP / 1024 / 1024}MB cap` });
      finish({ code, stdout: out, stderr: errBuf });
    });
  });
}

// same venv preference as runner.js commandFor()
function pythonFor(root) {
  const venv = ['.venv/bin/python', 'venv/bin/python']
    .map((v) => path.join(root, v))
    .find((v) => fs.existsSync(v));
  return venv || 'python3';
}

// ---------------------------------------------------------------------------
// inline python: head-only reads per extension, ONE JSON object on stdout
// ---------------------------------------------------------------------------

const PY_HEAD = `
import sys, json, math

def fail(msg):
    print(json.dumps({"error": str(msg)[:500]}))
    sys.exit(0)

p, ext, n = sys.argv[1], sys.argv[2], max(1, min(500, int(sys.argv[3])))
try:
    import pandas as pd
except ImportError:
    fail("pandas not installed for " + sys.executable)

total = None
note = None
try:
    if ext in ("csv", "tsv"):
        df = pd.read_csv(p, sep="\\t" if ext == "tsv" else ",", nrows=n)
    elif ext == "parquet":
        try:
            import pyarrow.parquet as pq
        except ImportError:
            fail("pyarrow not installed for " + sys.executable)
        f = pq.ParquetFile(p)
        total = f.metadata.num_rows
        try:
            df = next(f.iter_batches(batch_size=n)).to_pandas().head(n)
        except StopIteration:
            df = f.schema_arrow.empty_table().to_pandas()
    elif ext == "feather":
        df = pd.read_feather(p)
        total = len(df)
        df = df.head(n)
    elif ext == "dta":
        with pd.read_stata(p, chunksize=n) as rdr:
            t = getattr(rdr, "nobs", None)
            total = int(t) if isinstance(t, (int, float)) else None
            try:
                df = next(iter(rdr))
            except StopIteration:
                df = pd.DataFrame()
        df = df.head(n)
    elif ext in ("xlsx", "xls"):
        df = pd.read_excel(p, nrows=n)
    else:
        fail("unsupported extension ." + ext)
except SystemExit:
    raise
except ImportError as e:
    fail(str(e)[:300] + " (interpreter: " + sys.executable + ")")
except Exception as e:
    fail(type(e).__name__ + ": " + str(e)[:300])

if len(df.columns) > 80:
    note = "showing first 80 of %d columns" % len(df.columns)
    df = df.iloc[:, :80]

cols = [{"name": str(c), "dtype": str(t)} for c, t in zip(df.columns, df.dtypes)]

def cell(v):
    try:
        if v is None or pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass  # array-likes: fall through to str()
    if isinstance(v, (bytes, bytearray)):
        v = repr(v)
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            pass
    if hasattr(v, "item"):
        try:
            v = v.item()  # numpy scalar -> python scalar
        except Exception:
            pass
    if isinstance(v, bool) or isinstance(v, int):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    s = str(v)
    return s if len(s) <= 200 else s[:200] + "\\u2026"

rows_out = [[cell(v) for v in r] for r in df.itertuples(index=False, name=None)]
print(json.dumps({"columns": cols, "rows": rows_out, "nrows_shown": len(rows_out),
                  "total_rows": int(total) if total is not None else None, "note": note},
                 ensure_ascii=False, default=str))
`;

async function pyHead(abs, ext, rows, root) {
  const py = pythonFor(root);
  const run = await runChild(py, ['-c', PY_HEAD, abs, ext, String(rows)]);
  let result = null;
  if (!run.error && run.code === 0) {
    try { result = JSON.parse(run.stdout); } catch { /* malformed — handled below */ }
  }
  if (!result || typeof result !== 'object') {
    const why = run.error
      || (run.stderr || '').trim().split('\n').pop()
      || `python exited with code ${run.code}`;
    result = { error: `python preview failed: ${String(why).slice(0, 300)}` };
  }
  // csv/tsv must keep working with no usable python — degrade to the node parser
  if (result.error && (ext === 'csv' || ext === 'tsv')) {
    return csvFallback(abs, ext, rows, result.error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// node csv/tsv fallback — naive quote-aware scanner, dtype "text"
// ---------------------------------------------------------------------------

const truncCell = (s) => (s.length > CELL_MAX ? s.slice(0, CELL_MAX) + '…' : s);

function csvFallback(abs, ext, rows, why) {
  try {
    const delim = ext === 'tsv' ? '\t' : ',';
    const st = fs.statSync(abs);
    const cap = Math.min(st.size, 8 * 1024 * 1024);
    const buf = Buffer.alloc(cap);
    const fd = fs.openSync(abs, 'r');
    const n = fs.readSync(fd, buf, 0, cap, 0);
    fs.closeSync(fd);
    let text = buf.toString('utf8', 0, n);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
    const wholeFile = n >= st.size;

    // small state machine: quoted fields may hold delimiters/newlines/"" quotes
    const records = [];
    let field = '';
    let record = [];
    let inQ = false;
    let i = 0;
    for (; i < text.length && records.length < rows + 1; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
          else inQ = false;
        } else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { record.push(field); field = ''; }
      else if (ch === '\n') {
        record.push(field.replace(/\r$/, ''));
        if (record.length > 1 || record[0] !== '') records.push(record);
        record = []; field = '';
      } else field += ch;
    }
    const scannedAll = i >= text.length;
    if (scannedAll && wholeFile && (field !== '' || record.length)) {
      record.push(field.replace(/\r$/, '')); // last line, no trailing newline
      if (record.length > 1 || record[0] !== '') records.push(record);
    }

    const header = records.shift() || [];
    let note = `naive node parser (${why})`;
    let names = header.map((h, j) => h || `(col ${j + 1})`);
    if (names.length > COL_MAX) {
      note += `; showing first ${COL_MAX} of ${names.length} columns`;
      names = names.slice(0, COL_MAX);
    }
    const columns = names.map((name) => ({ name: truncCell(name), dtype: 'text' }));
    const data = records.slice(0, rows).map((r) =>
      columns.map((_, j) => (r[j] === undefined ? null : truncCell(r[j]))));
    return {
      columns,
      rows: data,
      nrows_shown: data.length,
      // exact only when the whole file fit in the buffer AND the scan finished
      total_rows: scannedAll && wholeFile ? records.length : null,
      note,
    };
  } catch (err) {
    return { error: `csv fallback failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// R: .rds / .rdata via Rscript + jsonlite (same JSON shape)
// ---------------------------------------------------------------------------

// NOTE: Rscript -e mangles backslashes in the expression, so this R source
// must contain none — control chars are built via rawToChar() instead.
const R_HEAD = `
args <- commandArgs(trailingOnly = TRUE)
p <- args[[1]]; ext <- args[[2]]; n <- max(1, min(500, as.integer(args[[3]])))
BS <- rawToChar(as.raw(92)); DQ <- rawToChar(as.raw(34)); NL <- rawToChar(as.raw(10))
emit_err <- function(m) {
  m <- gsub(BS, paste0(BS, BS), m, fixed = TRUE)
  m <- gsub(DQ, paste0(BS, DQ), m, fixed = TRUE)
  m <- gsub(NL, " ", m, fixed = TRUE)
  cat(paste0("{", DQ, "error", DQ, ": ", DQ, substr(m, 1, 500), DQ, "}"))
}
invisible(tryCatch({
  if (!requireNamespace("jsonlite", quietly = TRUE))
    stop("R / jsonlite not available for .rds preview")
  obj <- if (ext == "rds") readRDS(p) else {
    e <- new.env(); nms <- load(p, envir = e); get(nms[[1]], envir = e)
  }
  if (!is.data.frame(obj)) obj <- as.data.frame(obj)
  total <- nrow(obj)
  note <- NULL
  if (ncol(obj) > 80) {
    note <- sprintf("showing first 80 of %d columns", ncol(obj))
    obj <- obj[, 1:80, drop = FALSE]
  }
  h <- utils::head(obj, n)
  cols <- lapply(names(h), function(cn) list(name = cn, dtype = class(h[[cn]])[[1]]))
  cellfn <- function(v) {
    if (length(v) != 1) return(paste(format(v), collapse = ", "))
    if (is.na(v)) return(NULL)
    if (is.numeric(v) || is.logical(v)) return(v)
    s <- as.character(format(v))
    if (nchar(s) > 200) s <- paste0(substr(s, 1, 200), "…")
    s
  }
  rows <- lapply(seq_len(nrow(h)), function(i) unname(lapply(h, function(col) cellfn(col[[i]]))))
  cat(jsonlite::toJSON(list(columns = cols, rows = rows, nrows_shown = nrow(h),
      total_rows = total, note = note), auto_unbox = TRUE, null = "null", na = "null", digits = NA))
}, error = function(e) emit_err(conditionMessage(e))))
`;

async function rHead(abs, ext, rows) {
  const run = await runChild('Rscript', ['--vanilla', '-e', R_HEAD, abs, ext, String(rows)]);
  if (run.error) {
    return { error: /not found on PATH/.test(run.error) ? 'R / jsonlite not available for .rds preview' : run.error };
  }
  try {
    const result = JSON.parse(run.stdout);
    if (result && typeof result === 'object') return result;
  } catch { /* malformed — handled below */ }
  const why = (run.stderr || '').trim().split('\n').pop() || `Rscript exited with code ${run.code}`;
  return { error: `R preview failed: ${String(why).slice(0, 300)}` };
}

// ---------------------------------------------------------------------------
// HTML rendering — complete standalone dark page, no scripts, no externals
// ---------------------------------------------------------------------------

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0c0e1a; color: #a8aec8;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.hdr { padding: 10px 14px; color: #7ef5c2; font-weight: 600;
  border-bottom: 1px solid #232845; }
.note { padding: 6px 14px; color: #6d749b; font-style: italic; }
.msg { padding: 14px; color: #f5a07e; white-space: pre-wrap; }
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th { position: sticky; top: 0; z-index: 1; background: #141831; color: #7ef5c2;
  text-align: left; font-weight: 600; padding: 6px 10px;
  border-bottom: 1px solid #2a3055; white-space: nowrap; }
th .dt { display: block; color: #6d749b; font-weight: 400; font-size: 10px; }
td { padding: 4px 10px; border-bottom: 1px solid #1a1f38; vertical-align: top;
  max-width: 420px; white-space: pre-wrap; overflow-wrap: anywhere; }
tbody tr:nth-child(even) { background: #11142a; }
td.num { text-align: right; color: #c3c9e8; }
td.null { color: #3d4366; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderHtml(rel, result) {
  if (result.error) {
    return page(`${rel} — error`,
      `<div class="hdr">${esc(rel)} — preview failed</div>\n<div class="msg">${esc(result.error)}</div>`);
  }
  const cols = result.columns || [];
  const total = result.total_rows != null ? Number(result.total_rows).toLocaleString('en-US') : '?';
  const headerLine = `${rel} — first ${result.nrows_shown} of ${total} rows × ${cols.length} cols`;
  const thead = cols.map((c) =>
    `<th>${esc(c.name)}<span class="dt">${esc(c.dtype)}</span></th>`).join('');
  const tbody = (result.rows || []).map((r) => {
    const tds = cols.map((_, j) => {
      const v = r[j];
      if (v === null || v === undefined) return '<td class="null">∅</td>';
      if (typeof v === 'number') return `<td class="num">${esc(v)}</td>`;
      return `<td>${esc(v)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('\n');
  return page(headerLine, [
    `<div class="hdr">${esc(headerLine)}</div>`,
    result.note ? `<div class="note">${esc(result.note)}</div>` : '',
    `<table>\n<thead><tr>${thead}</tr></thead>\n<tbody>\n${tbody}\n</tbody>\n</table>`,
  ].filter(Boolean).join('\n'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function headObject(project, rel, rows) {
  try {
    if (!Object.prototype.hasOwnProperty.call(PROJECTS, project)) {
      return { error: `unknown project: ${project}` };
    }
    const contained = containedPath(project, rel);
    if (!contained) return { error: `not found or outside the project: ${rel}` };
    const { abs, root } = contained;
    let st;
    try { st = fs.statSync(abs); } catch { return { error: `not found: ${rel}` }; }
    if (!st.isFile()) return { error: `${rel} is not a file` };

    const key = `${abs}::${rows}`;
    const hit = CACHE.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs
      && !(hit.isError && Date.now() - hit.ts > ERROR_TTL_MS)) {
      return hit.result;
    }
    const running = INFLIGHT.get(key); // a 15s spawn may already be under way
    if (running) return running;

    const ext = path.extname(abs).slice(1).toLowerCase();
    const work = (async () => {
      if (WHOLE_FILE_EXTS.has(ext) && st.size > WHOLE_FILE_MAX) {
        return { error: `.${ext} preview reads the whole file and this one is `
          + `${Math.round(st.size / 1e6)}MB — too large to preview safely` };
      }
      let result;
      if (PY_EXTS.has(ext)) result = await pyHead(abs, ext, rows, root);
      else if (R_EXTS.has(ext)) result = await rHead(abs, ext, rows);
      else result = { error: `unsupported file type: .${ext || '(none)'}` };
      CACHE.set(key, { mtimeMs: st.mtimeMs, result, isError: !!result.error, ts: Date.now() });
      if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value); // FIFO
      return result;
    })();
    INFLIGHT.set(key, work);
    try {
      return await work;
    } finally {
      INFLIGHT.delete(key);
    }
  } catch (err) {
    console.error('[dataview]', err.message);
    return { error: err.message };
  }
}

/**
 * Head preview of a data file inside a project.
 * format 'json' → the result object (or { error }); format 'html' → { html }
 * (a complete standalone dark page; error pages included), plus `error` when
 * the preview failed so callers can pick a status code. Never throws.
 */
export async function dataHead(project, rel, { rows = 50, format = 'html' } = {}) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(rows) || 50)));
  const relStr = String(rel || '');
  const result = await headObject(project, relStr, n);
  if (format === 'json') return result;
  const html = renderHtml(relStr, result);
  return result.error ? { html, error: result.error } : { html };
}
