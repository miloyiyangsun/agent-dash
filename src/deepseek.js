'use strict';

// DeepSeek sub-agents are launched by ask_deepseek.py as real `claude.exe -p`
// processes, and that script keeps one JSONL per child plus a small .meta.json
// with the prompt and the requested effort tier. Those logs carry what the
// Claude Code transcript drops: thinking, tool arguments, tool results, and the
// images the child actually looked at.
//
// This adapter turns each run into an ordinary session so the office and the
// side list can render it like any other agent. It only ever reads.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
// Opening a conversation re-reads a bigger window; older runs get the tail only.
const TRANSCRIPT_TAIL = 8 * 1024 * 1024;
const TRANSCRIPT_LIMIT = 120;
const TEXT_MAX = 6000;
const THINK_MAX = 4000;
const RESULT_MAX = 2500;
const ARG_MAX = 400;
const MAX_TRACKERS = 40;
// A pid can be recycled, so a child also counts as live while its log is warm.
const LIVE_MS = 120_000;

// Same shape as parsers.dayKey: a local, sortable YYYY-MM-DD key.
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function readRange(file, start, end) {
  const len = Math.max(0, Math.min(end, Number.MAX_SAFE_INTEGER) - start);
  if (!len) return Buffer.alloc(0);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return Buffer.alloc(0); }
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// Tool arguments arrive as objects; one readable line is what a bubble can show.
function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description', 'query', 'skill', 'name']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ');
  }
  const all = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return all ? String(all).trim().replace(/\s+/g, ' ') : '';
}

function describeTool(name, input) {
  const arg = toolArg(input);
  return arg ? `${name}: ${clip(arg, ARG_MAX)}` : String(name || 'tool');
}

// "任务 T8a：..." → "T8a", so parallel children of one brain are tellable apart.
function taskTag(prompt) {
  if (!prompt) return null;
  const m = String(prompt).match(/^\s*(?:任务|Task)\s*([A-Za-z]{0,3}\d+[A-Za-z]?)/);
  return m ? m[1] : null;
}

function firstLine(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// The main brain's Bash command is `python …ask_deepseek.py [flags] "任务 …"`.
// Pull the prompt back out of it so a running child can be matched to the turn
// that spawned it even before ask_deepseek.py has printed the run file name.
function extractPrompt(command) {
  const at = String(command || '').indexOf('ask_deepseek.py');
  if (at < 0) return null;
  let rest = String(command).slice(at + 'ask_deepseek.py'.length).trim();
  for (;;) {
    const m = rest.match(/^--(?:cwd|effort|model|thinking-tokens)\s+("[^"]*"|'[^']*'|\S+)\s*/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  const quoted = rest.match(/^"([\s\S]*)"\s*$/);
  if (quoted) return quoted[1];
  const single = rest.match(/^'([\s\S]*)'\s*$/);
  if (single) return single[1];
  return rest.trim() || null;
}

function samePrompt(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 48);
  return norm(a) === norm(b);
}

function newSession(base, file) {
  return {
    agent: 'deepseek',
    id: base,
    sessionId: null,
    parentId: null,
    subagent: false,
    file,
    base,
    status: 'thinking',
    activity: null,
    prompt: null,
    cwd: null,
    model: null,
    title: null,
    reply: null,
    error: null,
    effort: null,
    cost: null,
    turns: 0,
    numTurns: null,
    thinkingTokens: 0,
    outTokens: 0,
    images: 0,
    startedAt: null,
    lastEventAt: null,
    turnStartedAt: null,
    finishedAt: null,
    done: false,
    isError: false,
    pid: null,
    mtime: 0,
    pending: new Map(),
  };
}

function bump(s, at) {
  if (at && at > (s.lastEventAt || 0)) s.lastEventAt = at;
}

function apply(s, o) {
  if (!o || typeof o !== 'object') return;
  const at = o.timestamp ? Date.parse(o.timestamp) : null;
  const t = o.type;

  if (t === 'system') {
    if (o.subtype === 'init') {
      if (!s.sessionId && o.session_id) s.sessionId = o.session_id;
      if (o.cwd) s.cwd = o.cwd;
      if (!s.startedAt) s.startedAt = at || s.startedAt;
    } else if (o.subtype === 'thinking_tokens') {
      const n = Number(o.estimated_tokens);
      if (Number.isFinite(n) && n > s.thinkingTokens) s.thinkingTokens = n;
    }
    bump(s, at);
    return;
  }

  if (t === 'assistant') {
    const msg = o.message || {};
    if (msg.model) s.model = msg.model;
    bump(s, at);
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c.type === 'text' && c.text) {
        s.reply = c.text;
        if (s.status !== 'tool') s.status = 'typing';
      } else if (c.type === 'thinking') {
        if (c.thinking && s.status !== 'tool') s.status = 'thinking';
      } else if (c.type === 'tool_use') {
        const label = describeTool(c.name, c.input);
        s.pending.set(c.id, { name: c.name, label });
        s.status = 'tool';
        s.activity = clip(label, 120);
      }
    }
    if (!s.turnStartedAt) s.turnStartedAt = at || s.startedAt;
    s.turns += 1;
    if (!s.startedAt) s.startedAt = at || s.startedAt;
    return;
  }

  if (t === 'user') {
    const msg = o.message || {};
    let settled = false;
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c.type !== 'tool_result') continue;
      s.pending.delete(c.tool_use_id);
      settled = true;
      if (Array.isArray(c.content)) {
        for (const part of c.content) if (part && part.type === 'image') s.images += 1;
      }
    }
    if (settled && !s.pending.size) {
      s.status = 'thinking';
      s.activity = null;
    }
    bump(s, at);
    return;
  }

  if (t === 'result') {
    s.done = true;
    s.isError = !!o.is_error;
    s.status = s.isError ? 'error' : 'done';
    s.pending.clear();
    s.activity = null;
    if (typeof o.result === 'string' && o.result.trim()) s.reply = o.result;
    if (Number.isFinite(o.total_cost_usd)) s.cost = o.total_cost_usd;
    if (Number.isFinite(o.num_turns)) s.numTurns = o.num_turns;
    const usage = o.usage || {};
    if (Number.isFinite(usage.output_tokens)) s.outTokens = usage.output_tokens;
    const think = usage.output_tokens_details && usage.output_tokens_details.thinking_tokens;
    if (Number.isFinite(think) && think > s.thinkingTokens) s.thinkingTokens = think;
    s.finishedAt = at || Date.now();
    bump(s, at);
  }
}

class DeepSeek {
  constructor({ dir = path.join(os.homedir(), '.claude', 'deepseek-runs'), claudeDir, hours = 24, interval = 1000 } = {}) {
    this.dir = dir;
    this.claudeDir = claudeDir || null;
    this.windowMs = hours * 3600 * 1000;
    this.interval = interval;
    this.trackers = new Map();   // file -> { session, offset, partial }
    this.meta = new Map();       // file -> { mtime, data }
    this.tcache = new Map();     // key -> { mtime, size, messages }
    this.lastScan = 0;
    this.files = [];
    this.delegations = new DelegationIndex(claudeDir, hours);
    this.resizeVia = null;
  }

  start() { return this; }

  // Read a run's .meta.json once per mtime: prompt, effort tier, pid, start time.
  loadMeta(file) {
    const metaFile = file.replace(/\.jsonl$/, '.meta.json');
    const st = statSafe(metaFile);
    if (!st) return null;
    const cached = this.meta.get(metaFile);
    if (cached && cached.mtime === st.mtimeMs) return cached.data;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { data = null; }
    this.meta.set(metaFile, { mtime: st.mtimeMs, data });
    return data;
  }

  pidAlive(pid) {
    if (!Number.isFinite(pid)) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
  }

  scan(now) {
    if (now - this.lastScan < 2000) return false;
    this.lastScan = now;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return false; }
    const files = [];
    for (const name of names) {
      if (!name.startsWith('run-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(this.dir, name);
      const st = statSafe(file);
      if (!st) continue;
      files.push({ file, base: name.slice(0, -'.jsonl'.length), st });
    }
    const next = [];
    const seen = new Set();
    for (const f of files) {
      if (f.st.mtimeMs < now - this.windowMs) continue;
      next.push(f);
      seen.add(f.file);
    }
    // Keep the live ones and the newest finished ones; drop the rest.
    next.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (next.length > MAX_TRACKERS) next.length = MAX_TRACKERS;
    for (const f of next) if (!this.trackers.has(f.file)) this.open(f, now);
    for (const file of [...this.trackers.keys()]) if (!seen.has(file)) this.trackers.delete(file);
    this.files = next;
    return true;
  }

  // A fresh run: parse its head (the init line) and its tail (whatever has piled
  // up already), then follow only what is appended from here on.
  open(f, now) {
    const meta = this.loadMeta(f.file);
    const s = newSession(f.base, f.file);
    if (meta) {
      if (meta.prompt) s.prompt = meta.prompt;
      if (meta.cwd) s.cwd = meta.cwd;
      if (meta.effort) s.effort = meta.effort;
      if (meta.model) s.title = null;
      if (Number.isFinite(meta.started_ts)) s.startedAt = Math.round(meta.started_ts * 1000);
      if (Number.isFinite(meta.pid)) s.pid = meta.pid;
    }
    s.mtime = f.st.mtimeMs;
    if (!s.startedAt) s.startedAt = Math.round(f.st.birthtimeMs || f.st.mtimeMs);

    const t = { session: s, offset: 0, partial: '' };
    this.trackers.set(f.file, t);

    const size = f.st.size;
    const readHead = Math.min(size, HEAD_BYTES);
    const head = readRange(f.file, 0, readHead);
    const parts = head.toString('utf8').split('\n');
    if (readHead < size) parts.pop();
    for (const line of parts) this.applyLine(s, line);

    if (size > readHead) {
      const tailStart = Math.max(readHead, size - TAIL_BYTES);
      const tail = readRange(f.file, tailStart, size);
      const tailParts = tail.toString('utf8').split('\n');
      // The first piece starts mid-line; the last is dropped in case it is partial.
      tailParts.shift();
      tailParts.pop();
      for (const line of tailParts) this.applyLine(s, line);
    }
    t.offset = size;
    if (!s.title) s.title = taskTag(s.prompt);
  }

  applyLine(s, line) {
    let text = line.trim();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM on the first line
    if (!text || text.charCodeAt(0) !== 0x7b) return; // '{' only: skip warnings and markers
    try { apply(s, JSON.parse(text)); } catch {}
  }

  feed(t, chunk) {
    const text = t.partial + chunk.toString('utf8');
    const lines = text.split('\n');
    t.partial = lines.pop() || '';
    for (const line of lines) this.applyLine(t.session, line);
  }

  tick(now = Date.now()) {
    const scanned = this.scan(now);
    let changed = scanned;
    for (const f of this.files) {
      const t = this.trackers.get(f.file);
      if (!t) continue;
      if (f.st.size < t.offset) { // truncated or replaced: start over
        this.trackers.delete(f.file);
        this.open(f, now);
        changed = true;
        continue;
      }
      t.session.mtime = f.st.mtimeMs;
      if (f.st.size === t.offset) continue;
      const chunk = readRange(f.file, t.offset, f.st.size);
      t.offset = f.st.size;
      this.feed(t, chunk);
      changed = true;
    }
    const linked = this.delegations.tick(this) || false;
    return changed || linked;
  }

  alive(s, now) {
    const quiet = now - (s.lastEventAt || s.mtime || now);
    if (s.done) return false;
    if (quiet < 12_000) return true;
    return this.pidAlive(s.pid) && quiet < LIVE_MS;
  }

  sessions(now = Date.now()) {
    const out = [];
    for (const t of this.trackers.values()) {
      const s = t.session;
      const meta = this.loadMeta(s.file);
      if (meta && s.pid == null && Number.isFinite(meta.pid)) s.pid = meta.pid;
      s.delegate = this.delegations.parentOf(s);
      s.parentId = s.delegate ? s.delegate.sessionId : null;

      const quiet = now - (s.lastEventAt || s.mtime || now);
      let status = s.status;
      if (!s.done && !this.alive(s, now) && quiet > 20_000) status = 'interrupted';
      if (s.done && s.isError) status = 'error';

      const live = !s.done;
      if (!live && quiet > this.windowMs) continue;
      s.status = status;
      s.stuck = 0;
      if (status === 'tool' && s.activity) {
        const stuckAfter = 10 * 60_000;
        if (quiet > stuckAfter) s.stuck = Math.floor(quiet / 60_000);
      }
      s.daily = { day: dayKey(now), turns: s.turns, tokens: s.outTokens || s.thinkingTokens || 0 };
      out.push(s);
    }
    return out;
  }

  // Child runs write a normal Claude Code transcript too; those rows carry no
  // tool results and no thinking, so the richer run record replaces them.
  childSessionIds() {
    const ids = new Set();
    for (const t of this.trackers.values()) if (t.session.sessionId) ids.add(t.session.sessionId);
    return ids;
  }

  // ---- transcript: what the child read, thought and said, in order ----------

  transcript(key) {
    const t = [...this.trackers.values()].find((x) => `deepseek:${x.session.base}` === key);
    if (!t) return null;
    const s = t.session;
    const st = statSafe(s.file);
    if (!st) return null;
    const cached = this.tcache.get(key);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.messages;

    const start = Math.max(0, st.size - TRANSCRIPT_TAIL);
    const buf = readRange(s.file, start, st.size);
    const messages = [];
    const tools = new Map();
    let offset = start;
    let pendingImages = 0;

    const push = (m) => {
      if (messages.length >= TRANSCRIPT_LIMIT) messages.shift();
      messages.push(m);
    };
    if (s.prompt) push({ role: 'user', text: clip(s.prompt, TEXT_MAX), at: s.startedAt, kind: 'prompt' });

    let pos = 0;
    while (pos <= buf.length) {
      let nl = buf.indexOf(0x0a, pos);
      if (nl < 0) nl = buf.length;
      const lineStart = offset + pos;
      const raw = buf.subarray(pos, nl);
      pos = nl + 1;

      if (raw.length && raw[0] === 0x7b) { // '{'
        let o = null;
        try { o = JSON.parse(raw.toString('utf8')); } catch { o = null; }
        // One line can hold several tool results (parallel calls), so the image
        // ordinal has to run across the whole line, not per message.
        if (o) this.emitTranscript(o, raw, lineStart, s, push, tools, { n: 0 }, () => pendingImages++);
      }
      if (pos > buf.length) break;
    }

    for (const m of messages) if (m.images && m.images.length) m.hasImages = m.images.length;
    const out = { messages, images: pendingImages, at: st.mtimeMs, run: s.base };
    this.tcache.set(key, { mtime: st.mtimeMs, size: st.size, messages: out });
    return messages;
  }

  emitTranscript(o, raw, lineStart, s, push, tools, ordinal, countImage) {
    const at = o.timestamp ? Date.parse(o.timestamp) : null;
    if (o.type === 'assistant') {
      for (const c of (o.message && o.message.content) || []) {
        if (c.type === 'text' && c.text && c.text.trim()) {
          push({ role: 'assistant', text: clip(c.text, TEXT_MAX), at, kind: 'text' });
        } else if (c.type === 'thinking' && c.thinking && c.thinking.trim()) {
          push({ role: 'thinking', text: clip(c.thinking, THINK_MAX), at, kind: 'thinking' });
        } else if (c.type === 'tool_use') {
          const m = { role: 'tool', id: c.id, name: c.name, text: clip(toolArg(c.input), ARG_MAX), at, result: null, images: [] };
          tools.set(c.id, m);
          push(m);
        }
      }
      return;
    }
    if (o.type === 'user') {
      for (const c of (o.message && o.message.content) || []) {
        if (c.type !== 'tool_result') continue;
        const m = tools.get(c.tool_use_id);
        if (!m) continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content || '') }];
        const texts = [];
        for (const p of parts) {
          if (p.type === 'text') texts.push(p.text);
          else if (p.type === 'image') {
            // Record where the base64 payload sits so it can be served on demand.
            const found = this.locateImage(raw, ordinal.n++);
            if (found) m.images.push({ start: lineStart + found.start, len: found.len, mime: 'image/jpeg' });
            countImage();
          }
        }
        m.result = { text: clip(texts.join('\n'), RESULT_MAX), at };
      }
      return;
    }
    if (o.type === 'result') {
      push({
        role: 'final',
        text: clip(typeof o.result === 'string' ? o.result : '', TEXT_MAX),
        at,
        cost: Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null,
        turns: Number.isFinite(o.num_turns) ? o.num_turns : null,
        isError: !!o.is_error,
      });
    }
  }

  // The nth `"data":"<base64>"` in this line, as byte offsets inside the line.
  locateImage(raw, n) {
    const needle = Buffer.from('"data":"');
    let from = 0;
    for (let i = 0; i <= n; i++) {
      const at = raw.indexOf(needle, from);
      if (at < 0) return null;
      const start = at + needle.length;
      const end = raw.indexOf(0x22, start); // closing quote
      if (end < 0) return null;
      if (i === n) return { start, len: end - start };
      from = end;
    }
    return null;
  }

  // Serve one embedded image straight out of the run log, never via memory cache.
  image(key, start, len) {
    const t = [...this.trackers.values()].find((x) => `deepseek:${x.session.base}` === key);
    if (!t) return null;
    const st = statSafe(t.session.file);
    if (!st) return null;
    if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0) return null;
    if (len > 24 * 1024 * 1024) return null;
    if (start + len > st.size) return null;
    const raw = readRange(t.session.file, start, start + len);
    if (!raw.length) return null;
    // What sits in the log is base64 text; the browser wants actual bytes.
    const text = raw.toString('latin1');
    const mime = text.startsWith('/9j/') ? 'image/jpeg'
      : text.startsWith('iVBOR') ? 'image/png'
        : text.startsWith('R0lGOD') ? 'image/gif'
          : text.startsWith('UklGR') ? 'image/webp' : 'application/octet-stream';
    let buf = null;
    try { buf = Buffer.from(text, 'base64'); } catch { return null; }
    if (!buf || !buf.length) return null;
    return { mime, buf };
  }
}

// The brain's transcript is where a delegation is born: a Bash tool_use whose
// command runs ask_deepseek.py, and later a tool_result naming the run file.
// Both halves are matched here so each child knows which session spawned it.
class DelegationIndex {
  constructor(claudeDir, hours = 24) {
    this.dir = claudeDir;
    this.windowMs = hours * 3600 * 1000;
    this.byToolUse = new Map(); // tool_use id -> { sessionId, at, prompt, run }
    this.byRun = new Map();     // run base -> tool_use id
    this.lastScan = 0;
    this.files = new Map();     // file -> { offset, partial, size }
  }

  scan(now) {
    if (!this.dir) return false;
    if (now - this.lastScan < 5000) return false;
    this.lastScan = now;
    let projects = [];
    try { projects = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return false; }
    let changed = false;
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.dir, p.name);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        const st = statSafe(file);
        if (!st || st.mtimeMs < now - this.windowMs) continue;
        if (this.read(file, st, name.slice(0, -'.jsonl'.length))) changed = true;
      }
    }
    return changed;
  }

  // Reads each brain transcript once and then only what was appended, so a 20 MB
  // session does not get re-parsed on every tick.
  read(file, st, sessionId) {
    const prev = this.files.get(file);
    // First sight: take the whole log when it is small enough, else its last 16 MB,
    // which still reaches back further than any child still on screen.
    const first = prev ? prev.offset : Math.max(0, st.size - 16 * 1024 * 1024);
    if (prev && st.size <= prev.offset) {
      if (st.size === prev.offset) return false;
      this.files.delete(file); // truncated: re-read below from the top
    }
    const start = this.files.get(file)?.offset ?? first;
    const buf = readRange(file, start, st.size);
    if (!buf.length) { this.files.set(file, { offset: st.size, partial: '', size: st.size }); return false; }
    const text = (this.files.get(file)?.partial || '') + buf.toString('utf8');
    const lines = text.split('\n');
    const partial = lines.pop() || '';
    this.files.set(file, { offset: st.size, partial, size: st.size });
    let changed = false;
    for (const line of lines) {
      if (line.indexOf('ask_deepseek') < 0) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      const content = (o.message && o.message.content) || [];
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === 'tool_use' && c.input && typeof c.input.command === 'string'
          && c.input.command.includes('ask_deepseek.py')) {
          const at = o.timestamp ? Date.parse(o.timestamp) : null;
          this.byToolUse.set(c.id, { sessionId: o.sessionId || sessionId, at, prompt: extractPrompt(c.input.command), run: null });
          changed = true;
        } else if (c.type === 'tool_result' && c.tool_use_id && this.byToolUse.has(c.tool_use_id)) {
          const rec = this.byToolUse.get(c.tool_use_id);
          const flat = Array.isArray(c.content)
            ? c.content.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n')
            : String(c.content || '');
          const m = flat.match(/run-(\d{8}-\d{6})\.jsonl/);
          if (m && !rec.run) { rec.run = `run-${m[1]}`; this.byRun.set(rec.run, c.tool_use_id); changed = true; }
        }
      }
    }
    return changed;
  }

  tick(watch) {
    const now = Date.now();
    let changed = this.scan(now);
    for (const t of watch.trackers.values()) {
      const s = t.session;
      const rec = this.lookup(s);
      if (rec !== s.delegate) { s.delegate = rec; changed = true; }
    }
    return changed;
  }

  lookup(s) {
    const id = this.byRun.get(s.base);
    if (id) return this.byToolUse.get(id) || null;
    if (!s.prompt) return null;
    // Still running: the run file name has not been printed yet, so fall back to
    // the prompt text embedded in the brain's own command.
    let best = null;
    for (const rec of this.byToolUse.values()) {
      if (rec.run) continue;
      if (!samePrompt(rec.prompt, s.prompt)) continue;
      if (!best || (rec.at || 0) < (best.at || 0)) best = rec;
    }
    return best;
  }

  parentOf(s) {
    return s.delegate || null;
  }
}

module.exports = { DeepSeek, DS_DIR: path.join(os.homedir(), '.claude', 'deepseek-runs'), extractPrompt, taskTag };
