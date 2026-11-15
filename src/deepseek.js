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
// Old runs beyond the tracker cap only need the init line and the result line.
const LITE_HEAD = 64 * 1024;
const LITE_TAIL = 256 * 1024;
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
// The prompt can be quoted, wrapped in a heredoc (`"$(cat <<'EOF' … EOF)"`), or
// read from a temp file, and the invocation may be followed by redirections or
// more commands. Pull the first plausible prompt back out of it so a running
// child can be matched to the turn that spawned it even before the run file is
// named. Returns null for a command that merely mentions the script name.
function readPromptFile(file) {
  const p = String(file || '').replace(/^["']|["']$/g, '').trim();
  if (!p) return null;
  const st = statSafe(p);
  if (!st || !st.isFile() || st.size > 1024 * 1024) return null;
  try {
    const text = fs.readFileSync(p, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function promptFromArgs(args) {
  let rest = String(args || '');
  for (;;) {
    const m = rest.match(/^\s+--(?:cwd|effort|model|thinking-tokens)(?:\s+|=)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  rest = rest.replace(/^\s+/, '');
  if (!rest) return null;

  const heredoc = (s) => {
    const m = s.match(/^\$\(cat\s+<<\s*'?([A-Za-z0-9_]+)'?\s*\r?\n([\s\S]*?)\r?\n\1\s*\)/);
    return m ? m[2].trim() || null : null;
  };
  const at = heredoc(rest);
  if (at) return at;
  const file = (s) => {
    const m = s.match(/^\$\(cat\s+("[^"]*"|'[^']*'|[^)]+)\)/);
    return m ? readPromptFile(m[1]) : null;
  };
  const fromFile = file(rest);
  if (fromFile) return fromFile;

  if (rest[0] === '"') {
    const inner = rest.slice(1);
    const sub = heredoc(inner) || file(inner);
    if (sub) return sub;
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) { out += inner[i + 1]; i++; continue; }
      if (ch === '"') return out.trim() || null;
      out += ch;
    }
    return out.trim() || null;
  }
  if (rest[0] === "'") {
    const end = rest.indexOf("'", 1);
    return end < 0 ? null : rest.slice(1, end).trim() || null;
  }
  // Unquoted prompt: stop at the first shell separator or redirection.
  const bare = rest.split(/\s*(?:;|\||&|>|<)\s*/)[0].trim();
  return bare || null;
}

// A command may mention the script in prose (`echo '… ask_deepseek.py' >> …`)
// without running it. A real invocation is followed by an argument or a flag.
function askArgs(command) {
  const src = String(command || '');
  let from = 0;
  for (;;) {
    const at = src.indexOf('ask_deepseek.py', from);
    if (at < 0) return null;
    from = at + 'ask_deepseek.py'.length;
    let rest = src.slice(from);
    // The script path itself may be quoted: python -I "…/ask_deepseek.py"
    if (/^["'`]/.test(rest)) rest = rest.slice(1);
    if (/^\s+(?![>&|])/.test(rest)) return rest;
  }
}

function extractPrompt(command) {
  const rest = askArgs(command);
  return rest ? promptFromArgs(rest) : null;
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
    events: [],
  };
}

function bump(s, at) {
  if (at && at > (s.lastEventAt || 0)) s.lastEventAt = at;
}

// The timeline draws one tick per tool call / reply / final answer / error.
// Events are [ms, letter]; past 400 entries every other one is dropped so the
// head and tail survive and a long run still costs the page a small array.
const EVENTS_MAX = 400;
function pushEvent(s, at, type) {
  const ts = Number.isFinite(at) ? at : Date.now();
  s.events.push([ts, type]);
  if (s.events.length <= EVENTS_MAX) return;
  const keep = [];
  for (let i = 0; i < s.events.length; i++) {
    if (i === 0 || i === s.events.length - 1 || i % 2 === 1) keep.push(s.events[i]);
  }
  s.events = keep;
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
        pushEvent(s, at, 's');
      } else if (c.type === 'thinking') {
        if (c.thinking && s.status !== 'tool') s.status = 'thinking';
      } else if (c.type === 'tool_use') {
        const label = describeTool(c.name, c.input);
        s.pending.set(c.id, { name: c.name, label });
        s.status = 'tool';
        s.activity = clip(label, 120);
        pushEvent(s, at, 't');
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

  if (t === 'error') {
    pushEvent(s, at, 'e');
    bump(s, at);
    return;
  }

  if (t === 'result') {
    s.done = true;
    s.isError = !!o.is_error;
    s.status = s.isError ? 'error' : 'done';
    s.pending.clear();
    s.activity = null;
    pushEvent(s, at, s.isError ? 'e' : 'f');
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
    this.lites = new Map();      // file -> { mtime, size, session } (old runs, summary only)
    this.meta = new Map();       // file -> { mtime, data }
    this.tcache = new Map();     // key|limit -> { mtime, size, messages }
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
    // The newest runs get a live tracker; older runs inside the window keep a
    // head+tail summary only (no incremental stream; transcript read on demand).
    next.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const full = next.slice(0, MAX_TRACKERS);
    const old = next.slice(MAX_TRACKERS);
    const fullSet = new Set(full.map((f) => f.file));
    for (const f of full) if (!this.trackers.has(f.file)) this.open(f, now);
    for (const file of [...this.trackers.keys()]) if (!fullSet.has(file)) this.trackers.delete(file);
    for (const f of old) {
      const hit = this.lites.get(f.file);
      if (hit && hit.mtime === f.st.mtimeMs && hit.size === f.st.size) continue;
      this.lites.set(f.file, { mtime: f.st.mtimeMs, size: f.st.size, session: this.summary(f, now) });
    }
    for (const file of [...this.lites.keys()]) {
      if (!seen.has(file) || fullSet.has(file)) this.lites.delete(file);
    }
    this.files = full;
    return true;
  }

  // A fresh run: parse its head (the init line) and its tail (whatever has piled
  // up already). Tracked runs then follow only what is appended from here on.
  open(f, now) {
    const s = this.build(f, now, HEAD_BYTES, TAIL_BYTES);
    this.trackers.set(f.file, { session: s, offset: f.st.size, partial: '' });
  }

  // Old runs beyond the tracker cap: a small head+tail read, pruned state, no
  // offset. The result line carries the authoritative turn count.
  summary(f, now) {
    const s = this.build(f, now, LITE_HEAD, LITE_TAIL);
    s.pending = new Map();
    s.activity = null;
    if (s.prompt) s.prompt = clip(s.prompt, 4000);
    if (s.reply) s.reply = clip(s.reply, 4000);
    if (s.error) s.error = clip(s.error, 1000);
    return s;
  }

  build(f, now, headBytes, tailBytes) {
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

    const size = f.st.size;
    const readHead = Math.min(size, headBytes);
    const head = readRange(f.file, 0, readHead);
    const parts = head.toString('utf8').split('\n');
    if (readHead < size) parts.pop();
    for (const line of parts) this.applyLine(s, line);

    if (size > readHead) {
      const tailStart = Math.max(readHead, size - tailBytes);
      const tail = readRange(f.file, tailStart, size);
      const tailParts = tail.toString('utf8').split('\n');
      // The first piece starts mid-line; the last is dropped in case it is partial.
      tailParts.shift();
      tailParts.pop();
      for (const line of tailParts) this.applyLine(s, line);
    }
    if (!s.title) s.title = taskTag(s.prompt);
    return s;
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

  // Old runs were written before ask_deepseek.py learned to save the prompt in a
  // meta file. The brain's own Bash command still carries the original text, so
  // DelegationIndex is the fallback when the meta is missing.
  delegatedPrompt(s) {
    const rec = s.delegate || this.delegations.lookup(s);
    const text = rec && typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
    return text || null;
  }

  sessions(now = Date.now()) {
    const out = [];
    const groups = [
      { lite: false, list: [...this.trackers.values()].map((t) => t.session) },
      { lite: true, list: [...this.lites.values()].map((l) => l.session) },
    ];
    for (const { lite, list } of groups) {
      for (const s of list) {
        const meta = this.loadMeta(s.file);
        if (meta && s.pid == null && Number.isFinite(meta.pid)) s.pid = meta.pid;
        s.delegate = this.delegations.parentOf(s);
        // Order: meta.prompt → the prompt inside the delegation command → empty.
        if (!s.prompt) {
          const fromDelegate = this.delegatedPrompt(s);
          if (fromDelegate) {
            s.prompt = fromDelegate;
            if (!s.title) s.title = taskTag(fromDelegate);
          }
        }
        // ask_deepseek.py now records the brain's own session id in the meta.
        // That explicit link wins over any transcript-based guess.
        const metaParent = meta && typeof meta.parent_session_id === 'string' ? meta.parent_session_id : null;
        s.parentId = metaParent || (s.delegate ? s.delegate.sessionId : null);

        const quiet = now - (s.lastEventAt || s.mtime || now);
        let status = s.status;
        if (!s.done && !this.alive(s, now) && quiet > 20_000) status = 'interrupted';
        if (s.done && s.isError) status = 'error';

        const live = !s.done;
        if (!lite && !live && quiet > this.windowMs) continue;
        s.status = status;
        s.stuck = 0;
        // The result line's num_turns covers the whole run; the event counter
        // only sees the head+tail window, so prefer the authoritative number.
        if (Number.isFinite(s.numTurns) && s.numTurns > 0) s.turns = s.numTurns;
        if (status === 'tool' && s.activity) {
          const stuckAfter = 10 * 60_000;
          if (quiet > stuckAfter) s.stuck = Math.floor(quiet / 60_000);
        }
        // A run that started before midnight still belongs to the day it last moved.
        s.daily = { day: dayKey(s.lastEventAt || now), turns: s.turns, tokens: s.outTokens || s.thinkingTokens || 0 };
        out.push(s);
      }
    }
    return out;
  }

  // Child runs write a normal Claude Code transcript too; those rows carry no
  // tool results and no thinking, so the richer run record replaces them.
  childSessionIds() {
    const ids = new Set();
    for (const t of this.trackers.values()) if (t.session.sessionId) ids.add(t.session.sessionId);
    for (const l of this.lites.values()) if (l.session.sessionId) ids.add(l.session.sessionId);
    return ids;
  }

  // ---- transcript: what the child read, thought and said, in order ----------

  sessionFor(key) {
    for (const t of this.trackers.values()) if (`deepseek:${t.session.base}` === key) return t.session;
    for (const l of this.lites.values()) if (`deepseek:${l.session.base}` === key) return l.session;
    return null;
  }

  transcript(key, opts) {
    const s = this.sessionFor(key);
    if (!s) return null;
    const st = statSafe(s.file);
    if (!st) return null;
    const n = Number(opts && opts.limit);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.floor(n))) : TRANSCRIPT_LIMIT;
    const cacheKey = `${key}|${limit}`;
    const cached = this.tcache.get(cacheKey);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.messages;

    const start = Math.max(0, st.size - TRANSCRIPT_TAIL);
    const buf = readRange(s.file, start, st.size);
    const messages = [];
    const tools = new Map();
    let offset = start;
    let pendingImages = 0;

    const push = (m) => {
      if (messages.length >= limit) messages.shift();
      messages.push(m);
    };
    // transcript() can be called before sessions(); apply the same meta →
    // delegation fallback so old runs still lead with their original prompt.
    if (!s.prompt) {
      const fromDelegate = this.delegatedPrompt(s);
      if (fromDelegate) {
        s.prompt = fromDelegate;
        if (!s.title) s.title = taskTag(fromDelegate);
      }
    }
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
    // Cache the array itself: the API wraps it as { messages }, so a cached
    // wrapper here would double-nest on every hit after the first read.
    this.tcache.set(cacheKey, { mtime: st.mtimeMs, size: st.size, messages });
    if (this.tcache.size > 64) this.tcache.delete(this.tcache.keys().next().value);
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
          const m = {
            role: 'tool',
            id: c.id,
            name: c.name,
            path: (c.input && (c.input.file_path || c.input.notebook_path || c.input.path)) || null,
            text: clip(toolArg(c.input), ARG_MAX),
            at,
            result: null,
            images: [],
          };
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
    const s = this.sessionFor(key);
    if (!s) return null;
    const st = statSafe(s.file);
    if (!st) return null;
    if (!Number.isFinite(start) || !Number.isFinite(len) || start < 0 || len <= 0) return null;
    if (len > 24 * 1024 * 1024) return null;
    if (start + len > st.size) return null;
    const raw = readRange(s.file, start, start + len);
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
    // First sight: read the whole log (up to 128 MB). A busy brain transcript
    // can exceed 40 MB, and its oldest delegations are exactly the ones a short
    // tail window used to miss.
    const first = prev ? prev.offset : Math.max(0, st.size - 128 * 1024 * 1024);
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
      // Tool results are where the run file name shows up, but they never repeat
      // the script name, so the old "ask_deepseek only" filter dropped every
      // exact match. A result for one of our tool_uses can be many megabytes and
      // only the run name matters, so grab it from the raw line and move on.
      const note = line.indexOf('<task-notification>') >= 0;
      if (line.indexOf('ask_deepseek') < 0) {
        const idm = line.match(/"tool_use_id"\s*:\s*"([^"]+)"/);
        if (idm && this.byToolUse.has(idm[1])) {
          const m = line.match(/run-(\d{8}-\d{6})\.jsonl/);
          if (m) {
            const rec = this.byToolUse.get(idm[1]);
            if (!rec.run) { rec.run = `run-${m[1]}`; this.byRun.set(rec.run, idm[1]); changed = true; }
          }
          continue;
        }
        if (!note) continue;
      }
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      // api-request-blob lines repeat the same tool_use without a timestamp.
      if (o.type !== 'assistant' && o.type !== 'user') continue;
      const content = (o.message && o.message.content) || [];

      // A background delegation finishes via a notification. It names the
      // original tool_use and the task output file, whose tail carries the run
      // file name that a foreground tool_result would have printed directly.
      const noteText = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((x) => (x && x.text) || '').join('\n') : '';
      if (noteText.indexOf('<task-notification>') >= 0) {
        const tu = noteText.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
        const of = noteText.match(/<output-file>([^<]+)<\/output-file>/);
        if (tu && of && this.byToolUse.has(tu[1].trim())) {
          const rec = this.byToolUse.get(tu[1].trim());
          if (!rec.run) {
            const run = this.runFromTaskOutput(of[1].trim());
            if (run) { rec.run = run; this.byRun.set(run, tu[1].trim()); changed = true; }
          }
        }
      }

      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === 'tool_use' && c.input && typeof c.input.command === 'string'
          && c.input.command.includes('ask_deepseek.py')) {
          const args = askArgs(c.input.command);
          if (!args) continue; // a mention, not an invocation
          if (this.byToolUse.has(c.id)) continue;
          const at = o.timestamp ? Date.parse(o.timestamp) : null;
          this.byToolUse.set(c.id, { sessionId: o.sessionId || sessionId, at, prompt: promptFromArgs(args), run: null });
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

  // The task output tail ends with ask_deepseek.py's "完整记录 …run-….jsonl".
  runFromTaskOutput(file) {
    const st = statSafe(file);
    if (!st || !st.isFile()) return null;
    const tail = readRange(file, Math.max(0, st.size - 256 * 1024), st.size);
    const m = tail.toString('utf8').match(/run-(\d{8}-\d{6})\.jsonl/);
    return m ? `run-${m[1]}` : null;
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
