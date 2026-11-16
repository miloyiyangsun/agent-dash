'use strict';

// The Claude desktop app (Code tab) keeps one small JSON record per
// conversation under <userData>/claude-code-sessions/<a>/<b>/local_<id>.json.
// Its cliSessionId is the id in ~/.claude/projects/.../<id>.jsonl, and
// title / titleSource are what the client shows (auto-generated or renamed by
// the user). Read-only: only those two fields plus timestamps are used.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DEPTH = 4;

function ls(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

// Chromium userData roots the desktop app may use. Kept under `home` so a
// --demo instance with an overridden home never reads the real client data.
function bases(home) {
  const out = [];
  if (process.env.CLAUDE_USER_DATA_DIR) out.push(process.env.CLAUDE_USER_DATA_DIR);
  // Every layout on every platform: the demo home is written with the Windows
  // one, and checking a missing directory costs nothing.
  out.push(
    path.join(home, 'AppData', 'Local'),
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, '.config'),
    path.join(home, 'Library', 'Application Support'),
  );
  return out;
}

function sessionDirs(home) {
  const out = [];
  const seen = new Set();
  const push = (dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const st = statSafe(dir);
    if (st && st.isDirectory()) out.push(dir);
  };
  const scan = (root) => {
    // Either <root>/claude-code-sessions or <root>/<profile>/claude-code-sessions.
    push(path.join(root, 'claude-code-sessions'));
    for (const e of ls(root)) {
      if (e.isDirectory()) push(path.join(root, e.name, 'claude-code-sessions'));
    }
  };
  for (const base of bases(home)) {
    for (const e of ls(base)) {
      if (e.isDirectory() && /^claude/i.test(e.name)) scan(path.join(base, e.name));
    }
  }
  return out;
}

function collectFiles(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  for (const e of ls(dir)) {
    const file = path.join(dir, e.name);
    if (e.isFile() && /^local_.*\.json$/i.test(e.name)) out.push(file);
    else if (e.isDirectory()) collectFiles(file, depth + 1, out);
  }
}

class ClientTitles {
  constructor({ home = os.homedir() } = {}) {
    this.home = home;
    this.cache = new Map(); // file -> { mtime, size, id, title, at, archived }
    this.titles = new Map(); // cliSessionId -> { title, at, archived }
    this.sig = '';
  }

  // Re-reads only files whose mtime/size changed. Returns true when the
  // id→title mapping changed, so a rename in the client shows up next scan.
  refresh() {
    const files = [];
    for (const dir of sessionDirs(this.home)) collectFiles(dir, 0, files);
    const seen = new Set();
    const next = new Map();
    for (const file of files) {
      seen.add(file);
      const st = statSafe(file);
      if (!st) continue;
      let row = this.cache.get(file);
      if (!row || row.mtime !== st.mtimeMs || row.size !== st.size) {
        row = { mtime: st.mtimeMs, size: st.size, id: null, title: null, at: 0, archived: false };
        try {
          const d = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (typeof d.cliSessionId === 'string' && d.cliSessionId && typeof d.title === 'string' && d.title.trim()) {
            row.id = d.cliSessionId;
            row.title = d.title.trim();
            row.at = Number(d.lastActivityAt) || Number(d.createdAt) || 0;
            row.archived = d.isArchived === true || d.isArchived === 'true';
          }
        } catch { /* the client may be mid-write */ }
        this.cache.set(file, row);
      }
      if (!row.id) continue;
      const prev = next.get(row.id);
      if (!prev || row.at > prev.at || (row.at === prev.at && prev.archived && !row.archived)) next.set(row.id, row);
    }
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
    const sig = [...next].map(([id, row]) => `${id}\u0000${row.title}`).sort().join('\u0001');
    const changed = sig !== this.sig;
    this.sig = sig;
    this.titles = next;
    return changed;
  }

  get(id) {
    if (!id) return null;
    return this.titles.get(String(id))?.title || null;
  }
}

module.exports = { ClientTitles, sessionDirs };
