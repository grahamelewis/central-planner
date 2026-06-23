// lib/git.js — git operations per project (info / pull / sync / file diff).
// Every git call uses execFile with an args array (never a shell string) and a
// non-interactive env (GIT_TERMINAL_PROMPT=0, ssh BatchMode) so nothing can
// prompt — failures surface fast instead. Never throws out of exported functions.
import fs from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECTS } from './config.js';

const execFileAsync = promisify(execFile);

const OUTPUT_CAP = 20000; // combined stdout+stderr returned to the UI
const DIFF_CAP = 60000;   // unified diff text
const DIRTY_CAP = 200;    // max status entries reported

function rootOf(project) {
  const cfg = PROJECTS[project];
  return cfg && cfg.root ? cfg.root : null;
}

// Run one git command in `root`. Never throws — returns
// { ok, code, stdout, stderr, message }. code is the numeric exit code when
// available (null on spawn errors / timeouts / maxBuffer overflows).
async function git(root, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
      },
    });
    return { ok: true, code: 0, stdout, stderr, message: null };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      message: err.killed ? `git ${args[0]} timed out` : err.message,
    };
  }
}

function combined(r) {
  return `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(0, OUTPUT_CAP);
}

// Parse `git status --porcelain=v1 -z` output. -z entries are NUL-separated;
// rename/copy entries are followed by ONE extra NUL-separated token (the
// original path) which we must skip — the first path is the new path.
function parseStatusZ(out) {
  const entries = [];
  const tokens = (out || '').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.length < 4 || t[2] !== ' ') continue;
    const code = t.slice(0, 2);
    entries.push({ code, path: t.slice(3) });
    if (code.includes('R') || code.includes('C')) i++; // skip the orig path token
  }
  return entries;
}

function isConflictCode(code) {
  return code.includes('U') || code === 'AA' || code === 'DD';
}

async function currentUpstream(root) {
  const r = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// Best-effort `git rebase --abort` so a failed pull --rebase can't leave the
// repo wedged mid-rebase. Returns true if an in-progress rebase was aborted.
async function abortRebase(root) {
  const r = await git(root, ['rebase', '--abort']);
  return r.ok;
}

export async function gitInfo(project) {
  try {
    const root = rootOf(project);
    if (!root) return { error: 'unknown project' };

    const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.stdout.trim() !== 'true') return { repo: false };

    const top = await git(root, ['rev-parse', '--show-toplevel']);
    if (!top.ok || !top.stdout.trim()) return { repo: false };
    // Only treat as a repo if the project root ITSELF is the toplevel or sits
    // inside one (guards against realpath/symlink mismatches).
    try {
      const realRoot = fs.realpathSync(root);
      const realTop = fs.realpathSync(top.stdout.trim());
      if (realRoot !== realTop && !realRoot.startsWith(realTop + path.sep)) {
        return { repo: false };
      }
    } catch {
      return { repo: false };
    }

    // branch — symbolic-ref works even in empty repos; on detached HEAD it
    // fails and we fall back to the short hash.
    let branch = null;
    const sym = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (sym.ok && sym.stdout.trim()) {
      branch = sym.stdout.trim();
    } else {
      const head = await git(root, ['rev-parse', '--short', 'HEAD']);
      if (head.ok && head.stdout.trim()) branch = `${head.stdout.trim()} (detached)`;
    }

    const upstream = await currentUpstream(root);

    const remote = await git(root, ['remote', 'get-url', 'origin']);
    const remoteUrl = remote.ok && remote.stdout.trim() ? remote.stdout.trim() : null;

    // ahead/behind vs upstream — left = behind, right = ahead.
    let ahead = null;
    let behind = null;
    if (upstream) {
      const lr = await git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      if (lr.ok) {
        const m = lr.stdout.trim().split(/\s+/);
        behind = Number(m[0]) || 0;
        ahead = Number(m[1]) || 0;
      }
      // on failure ahead/behind stay null — never report a broken check as "in sync"
    }

    const st = await git(root, ['status', '--porcelain=v1', '-z']);
    const entries = st.ok ? parseStatusZ(st.stdout) : [];
    const conflicted = entries.some((e) => isConflictCode(e.code));
    const dirty = entries
      .slice(0, DIRTY_CAP)
      .map((e) => ({ s: e.code.trim(), path: e.path }));

    // last commit — null for empty repos (git log fails without HEAD)
    let lastCommit = null;
    const log = await git(root, ['log', '-1', '--format=%h%x00%s%x00%aI%x00%an']);
    if (log.ok && log.stdout.trim()) {
      const [hash, msg, when, author] = log.stdout.replace(/\n+$/, '').split('\0');
      if (hash) lastCommit = { hash, msg: msg || '', when: when || null, author: author || '' };
    }

    return {
      repo: true,
      root,
      branch,
      upstream,
      remoteUrl,
      ahead,
      behind,
      dirty,
      lastCommit,
      conflicted,
    };
  } catch (err) {
    console.error('[git] gitInfo error:', err.message);
    return { error: err.message };
  }
}

export async function gitPull(project) {
  try {
    const root = rootOf(project);
    if (!root) return { error: 'unknown project' };

    const r = await git(root, ['pull', '--rebase', '--autostash']);
    const output = combined(r);
    if (r.ok) return { ok: true, output };

    // Don't leave the repo wedged mid-rebase.
    const aborted = await abortRebase(root);
    const error = aborted
      ? 'git pull --rebase failed; ran `git rebase --abort` so the repo is back on the original branch'
      : `git pull --rebase failed: ${(r.stderr || r.message || '').trim().split('\n')[0] || 'unknown error'}`;
    console.error(`[git] pull failed (${project}):`, error);
    return { ok: false, error, output };
  } catch (err) {
    console.error('[git] gitPull error:', err.message);
    return { error: err.message };
  }
}

// One-button update: add -A → commit (if anything staged) → pull --rebase
// --autostash (if an upstream exists) → push. Stops at the first failed step.
// Never force-pushes.
export async function gitSync(project, message) {
  try {
    const root = rootOf(project);
    if (!root) return { error: 'unknown project' };

    const steps = [];
    let committed = false;
    let pushed = false;
    const fail = () => ({ ok: false, steps, committed, pushed });

    // a. stage everything
    let r = await git(root, ['add', '-A']);
    steps.push({ step: 'add', ok: r.ok, output: combined(r) });
    if (!r.ok) return fail();

    // b. commit — gate on what's actually STAGED after add -A (porcelain can
    // be non-empty with nothing stageable, e.g. dirty submodules, and
    // `git commit` would then fail and wedge the sync)
    const staged = await git(root, ['diff', '--cached', '--quiet']);
    // exit 0 → nothing staged; exit 1 → staged changes exist
    if (staged.ok) {
      steps.push({ step: 'commit', ok: true, output: 'nothing to commit' });
    } else {
      const msg = message || `checkpoint: ${new Date().toISOString().slice(0, 16)}`;
      r = await git(root, ['commit', '-m', msg]);
      steps.push({ step: 'commit', ok: r.ok, output: combined(r) });
      if (!r.ok) return fail();
      committed = true;
    }

    // c. pull --rebase --autostash (only when an upstream exists)
    const upstream = await currentUpstream(root);
    if (!upstream) {
      steps.push({ step: 'pull', ok: true, output: 'no upstream' });
    } else {
      r = await git(root, ['pull', '--rebase', '--autostash']);
      if (r.ok) {
        steps.push({ step: 'pull', ok: true, output: combined(r) });
      } else {
        const aborted = await abortRebase(root);
        const note = aborted
          ? '\n[git] pull failed mid-rebase — ran `git rebase --abort` to restore the repo'
          : '';
        steps.push({
          step: 'pull',
          ok: false,
          output: (combined(r) + note).slice(0, OUTPUT_CAP),
        });
        return fail();
      }
    }

    // d. push (set upstream on first push)
    if (upstream) {
      r = await git(root, ['push']);
    } else {
      const sym = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
      const branch = sym.ok ? sym.stdout.trim() : '';
      if (!branch) {
        steps.push({ step: 'push', ok: false, output: 'cannot push: detached HEAD or no branch' });
        return fail();
      }
      r = await git(root, ['push', '-u', 'origin', branch]);
    }
    steps.push({ step: 'push', ok: r.ok, output: combined(r) });
    if (!r.ok) return fail();
    pushed = true;

    return { ok: true, steps, committed, pushed };
  } catch (err) {
    console.error('[git] gitSync error:', err.message);
    return { error: err.message };
  }
}

// Unified diff for one file (vs HEAD); untracked files diff against /dev/null
// so brand-new files still show their content.
export async function gitFileDiff(project, rel) {
  try {
    const root = rootOf(project);
    if (!root) return { error: 'unknown project' };
    if (
      typeof rel !== 'string' ||
      !rel.trim() ||
      rel.startsWith('/') ||
      rel.includes('\0') ||
      // proper containment instead of a blanket '..' substring ban — a file
      // literally named 'notes..md' is legitimate
      !(path.resolve(root, rel) === root || path.resolve(root, rel).startsWith(root + path.sep))
    ) {
      return { error: 'bad path' };
    }

    const r = await git(root, ['diff', 'HEAD', '--', rel]);
    let diff = r.ok ? r.stdout : '';

    if (!diff.trim()) {
      const st = await git(root, ['status', '--porcelain', '-z', '--', rel]);
      const untracked = st.ok && st.stdout.startsWith('??');
      if (untracked) {
        // --no-index exits 1 when the files differ — that's success here.
        const ni = await git(root, ['diff', '--no-index', '--', '/dev/null', rel]);
        if (ni.stdout && (ni.ok || ni.code === 1)) diff = ni.stdout;
      }
    }

    return { diff: diff.slice(0, DIFF_CAP) };
  } catch (err) {
    console.error('[git] gitFileDiff error:', err.message);
    return { error: err.message };
  }
}

// ── profile page: recent commits across every project repo ──────────────────

let commitsCache = null; // { at, data } — git log across 5 repos isn't free

/**
 * Recent commits across all project repos, newest first.
 * → [{ project, hash, short, author, ts, subject }]  (≤ cap total)
 */
export async function recentCommits({ perRepo = 25, cap = 60 } = {}) {
  if (commitsCache && Date.now() - commitsCache.at < 60_000) return commitsCache.data;
  const all = [];
  await Promise.all(Object.keys(PROJECTS).map(async (project) => {
    const root = rootOf(project);
    if (!root || !fs.existsSync(path.join(root, '.git'))) return;
    // %x1f (unit sep) between fields, %x1e (record sep) between commits —
    // subjects can contain anything printable except control chars
    const r = await git(root, [
      'log', `-n${perRepo}`, '--no-merges',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
    ]);
    if (!r.ok) return; // empty repo / no HEAD — just skip
    for (const rec of r.stdout.split('\x1e')) {
      const line = rec.replace(/^\n/, '');
      if (!line.trim()) continue;
      const [hash, short, author, ts, subject] = line.split('\x1f');
      if (!hash || !ts) continue;
      all.push({ project, hash, short, author, ts, subject: (subject || '').slice(0, 200) });
    }
  }));
  all.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const data = all.slice(0, cap);
  commitsCache = { at: Date.now(), data };
  return data;
}
