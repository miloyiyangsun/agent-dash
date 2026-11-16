// workbench.js — 工作台视图（T2 三栏骨架 / T3 左栏任务树）。
// The main script owns state/data; this file draws the three-column stage and
// the task tree, and hands the middle/right columns to detail.js and aside.js.
(() => {
  'use strict';

  const t = (k) => {
    const lang = typeof langCode !== 'undefined' ? langCode : 'en';
    const dict = typeof L !== 'undefined' ? L : null;
    return dict?.[k] ?? (lang.startsWith('zh') ? window.I18N?.['zh-CN']?.[k] : null) ?? window.I18N?.en?.[k] ?? k;
  };
  const esc = (s) => (typeof window.esc === 'function' ? window.esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const dotClass = (st) => (st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`);

  const ACTIVE = new Set(['thinking', 'tool', 'typing', 'directing']);
  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting', 'directing']);
  const STATUS_BAR_ORDER = ['thinking', 'tool', 'typing', 'waiting', 'directing', 'error', 'done', 'interrupted', 'idle'];
  const ST_VAR = {
    thinking: '--st-thinking',
    tool: '--st-tool',
    typing: '--st-typing',
    waiting: '--st-waiting',
    directing: '--st-directing',
    done: '--st-done',
    error: '--st-error',
    interrupted: '--st-interrupted',
    idle: '--st-interrupted',
  };
  const STATUS_FILTERS = [
    { key: 'all', i18n: 'wbFilterAll' },
    { key: 'active', i18n: 'wbFilterActive' },
    { key: 'needsYou', i18n: 'wbFilterNeeds' },
    { key: 'done', i18n: 'wbFilterDone' },
    { key: 'error', i18n: 'wbFilterError' },
  ];
  const FILTER_ALIAS = {
    all: 'all',
    needsYou: 'needsYou',
    working: 'active',
    active: 'active',
    finished: 'done',
    done: 'done',
    error: 'error',
  };
  const NOISE_TITLES = new Set(['new session', 'new chat', 'untitled', '新会话', '新會話', '新对话', '新對話', '无标题', '無標題']);

  const reduced = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };

  // ---------- title extraction (pure) ----------

  // "任务 T9：", "任務 T8a —", "Task T3:", "任务：", "任务 T8b（第二半）："
  // → { tag, body }. "任务书：…" is prose, not a task prefix, and is left alone.
  function stripTask(text) {
    const src = String(text || '');
    const m = /^\s*(?:任務|任务|Task)\s*/i.exec(src);
    if (!m) return { tag: '', body: src };
    let rest = src.slice(m[0].length);
    let tag = '';
    const tm = /^([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)/.exec(rest);
    if (tm) {
      tag = tm[1];
      rest = rest.slice(tm[0].length);
    } else if (!/^\s*[：:]/.test(rest) && !/^\s/.test(rest)) {
      return { tag: '', body: src };
    }
    rest = rest.replace(/^\s*(?:[：:]|—|–|--|-)\s*/, '');
    rest = rest.replace(/^\s*[（(【\[][^）)】\]]{0,60}[）)】\]]\s*[：:]?\s*/, '');
    return { tag, body: rest };
  }

  // A leading "工作目錄 D:\…。" sentence says where, not what.
  const WORKDIR_RE = /^\s*(?:工作目錄|工作目录|工作資料夾|工作资料夹|工作文件夹|工作路徑|工作路径|工作區|工作区|專案目錄|专案目录|項目目錄|项目目录|目錄|目录|cwd|working\s+directory)\s*[：:]?\s*[^\n。！？]*[。！？]?\s*/i;
  function stripWorkdir(text) {
    return String(text || '').replace(WORKDIR_RE, '');
  }

  // System-generated openings that say nothing about the task: compaction
  // continuations, local-command caveats, slash-command wrappers, interrupted
  // markers and bare XML-ish tag lines. Drop them and look at what follows.
  const SYS_BLOCK_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>\s*/i;
  const TAG_ONLY_LINE_RE = /^\s*<\/?[a-zA-Z][\w:-]*(?:\s[^>]*)?>\s*$/;
  function stripLeadingNoise(src) {
    let s = String(src || '').replace(/\r\n?/g, '\n');
    for (let guard = 0; guard < 24; guard++) {
      const before = s;
      s = s.replace(/^\s+/, '');
      if (/^This session is being continued from a previous conversation\b/i.test(s)) {
        // The rest is the compaction summary, not a user task. Only a real
        // request appended after "## My request:" survives.
        const m = s.match(/##\s*My request:\s*/i);
        if (!m) return '';
        s = s.slice(m.index + m[0].length);
        continue;
      }
      s = s.replace(/^Caveat: The messages below[^\n]*(?:\n(?!\s*\n)[^\n]*)*/i, '');
      s = s.replace(/^\[Request interrupted[^\]]*\]\s*/i, '');
      s = s.replace(SYS_BLOCK_RE, '');
      const nl = s.indexOf('\n');
      const first = nl === -1 ? s : s.slice(0, nl + 1);
      if (first && TAG_ONLY_LINE_RE.test(first)) {
        s = s.slice(first.length);
        continue;
      }
      if (s === before) break;
    }
    return s.trim();
  }

  function squash(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // First sentence: 。！？, newline, or an English ". " / final ".". Paths and
  // version numbers ("a.md", "v1.2.3") do not end a sentence because the dot is
  // not followed by whitespace.
  function firstSentence(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    return squash(raw.split(/[。！？!?]|\r?\n|\.(?=\s|$)/)[0]);
  }

  function clip(text, n) {
    const s = String(text || '').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  function plain(text) {
    return String(text || '').replace(/\*\*|__|`/g, '').replace(/^#+\s*/, '');
  }

  function isTaskId(value) {
    const s = String(value || '').trim();
    return s.length <= 14 && /\d/.test(s) && /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/.test(s);
  }

  // A title that only says when or where is no title: "2026-11-15",
  // "2026_11_15 10:32", "D:\\work\\app" all fall back to the project name.
  const DATE_TITLE_RE = /^\d{4}[-_./年]\d{1,2}[-_./月]\d{1,2}日?(?:[ T]\d{1,2}[:：]\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
  function isDateTitle(text) {
    return DATE_TITLE_RE.test(String(text || '').trim());
  }
  const PATH_TITLE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])[^\n]*$/;
  const REL_PATH_TITLE_RE = /^(?:[\w.@+-]+[\\/])+[\w.@+-]*$/;
  function isPathTitle(text) {
    const s = String(text || '').trim().replace(/^["'`]|["'`]$/g, '');
    return PATH_TITLE_RE.test(s) || REL_PATH_TITLE_RE.test(s);
  }
  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString(typeof langCode !== 'undefined' ? langCode : undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // Returns { tag, title }. deepseek runs take the task line out of the prompt;
  // ordinary sessions prefer their own title, then summary / firstPrompt /
  // prompt, and only fall back to the project name when all of those are noise.
  function titleOf(s) {
    if (!s || typeof s !== 'object') return { tag: '', title: '' };
    const rawTitle = String(s.title || '').trim();
    const prompt = String(s.prompt || '');
    const deepseek = s.agent === 'deepseek' || (s.agent === 'dsh' && !!s.parentId);
    let tag = '';
    let title = '';
    let fromReply = false;

    const clean = (src) => {
      const stripped = stripLeadingNoise(src);
      const p = stripTask(stripped);
      return {
        tag: isTaskId(p.tag) ? p.tag : '',
        text: plain(firstSentence(stripWorkdir(p.body || stripped))),
      };
    };
    const noise = (text) => {
      const t = String(text || '').trim();
      if (NOISE_TITLES.has(t.toLowerCase().replace(/[.。]+$/, ''))) return true;
      if (isDateTitle(t) || isPathTitle(t)) return true;
      return /^This session is being continued\b/i.test(t) ||
        /^Caveat: The messages below\b/i.test(t) ||
        /^\[Request interrupted\b/i.test(t);
    };

    if (deepseek) {
      const p = clean(prompt);
      tag = p.tag;
      title = p.text;
      if (!tag && isTaskId(rawTitle)) tag = rawTitle;
      if (!title && rawTitle && !isTaskId(rawTitle)) {
        const fallback = clean(rawTitle);
        if (!noise(fallback.text)) {
          title = fallback.text;
          if (!tag && fallback.tag) tag = fallback.tag;
        }
      }
      // Old run logs have no prompt in the snapshot; the reply is the only
      // human-readable trace left, so use its first sentence rather than the
      // project name.
      if (!title) {
        const fallback = clean(String(s.reply || ''));
        if (fallback.text && !noise(fallback.text)) {
          title = fallback.text;
          fromReply = true;
        }
      }
    } else {
      for (const src of [rawTitle, s.summary, s.firstPrompt, prompt]) {
        if (typeof src !== 'string' || !src.trim()) continue;
        if (isTaskId(src.trim())) {
          if (!tag) tag = src.trim();
          continue;
        }
        const p = clean(src);
        if (!p.text || noise(p.text)) continue;
        title = p.text;
        if (p.tag) tag = p.tag;
        break;
      }
      if (!tag) {
        const pp = clean(prompt);
        if (pp.tag) tag = pp.tag;
      }
    }
    if (!title) title = s.project || s.agentName || s.agent || '';
    if (isDateTitle(title)) {
      const at = Number(s.startedAt) || Number(s.turnStartedAt) || Number(s.lastEventAt) || Date.now();
      title = t('untitledSession')(hhmm(at));
    }
    return { tag, title: clip(title, 36), fromReply };
  }

  // ---------- formatting ----------

  function fmtDur(ms) {
    if (typeof dur === 'function') {
      try { return dur(ms); } catch { /* fall through */ }
    }
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  function relTime(ts, now) {
    if (!ts) return '';
    if (typeof ago === 'function') {
      try { return ago(ts, now); } catch { /* fall through */ }
    }
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return t('justNow');
    const m = Math.round(s / 60);
    if (m < 60) return t('minutesAgo')(m);
    const h = Math.round(m / 60);
    if (h < 24) return t('hoursAgo')(h);
    return t('daysAgo')(Math.round(h / 24));
  }

  function rowTime(s, now) {
    const start = Number(s.startedAt) || Number(s.turnStartedAt) || 0;
    const turn = Number(s.turnStartedAt) || 0;
    if (!start) return '';
    const live = LIVE.has(s.status);
    const end = live ? now : (Number(s.lastEventAt) || Number(s.turnStartedAt) || now);
    let begin = start;
    // Some finished run logs carry a lastEventAt earlier than startedAt; the
    // turn start is the reliable earlier boundary in that case.
    if (end < begin && turn && turn < end) begin = turn;
    const ms = end - begin;
    if (ms > 0) return fmtDur(ms);
    return live ? '0s' : '—';
  }

  function secondLine(s, ti) {
    const st = s.status || 'idle';
    if (st === 'directing') {
      return { text: `${t('directing')} · ${t('directingCount')(Number(s.runningChildren) || 0)}`, cls: 'wb-directing', mono: false };
    }
    if (st === 'waiting') return { text: t('secondWaiting'), cls: 'wb-wait', mono: false };
    if (st === 'error') {
      if (ti && ti.fromReply) return { text: t('secondError'), cls: 'wb-err', mono: false };
      const msg = plain(firstSentence(s.error)) || t('secondError');
      return { text: clip(msg, 90), cls: 'wb-err', mono: false };
    }
    if (st === 'interrupted') return { text: t('secondInterrupted'), cls: '', mono: false };
    if (st === 'done') {
      // When the title itself came from the reply, repeating it here would be
      // noise; the check mark plus the state is enough.
      if (ti && ti.fromReply) return { text: t('secondDone'), cls: '', mono: false };
      const msg = plain(firstSentence(s.reply));
      return { text: msg ? '✓ ' + clip(msg, 90) : t('secondDone'), cls: '', mono: false };
    }
    if (ACTIVE.has(st)) {
      const act = plain(squash(s.activity));
      if (act) return { text: clip(act, 90), cls: '', mono: true };
      return { text: (typeof L !== 'undefined' && L[st]) || st, cls: '', mono: false };
    }
    return { text: t('secondIdle'), cls: '', mono: false };
  }

  function highlight(text, q) {
    const src = String(text || '');
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return esc(src);
    const lower = src.toLowerCase();
    let out = '';
    let i = 0;
    let at;
    while ((at = lower.indexOf(needle, i)) !== -1) {
      out += esc(src.slice(i, at)) + '<mark>' + esc(src.slice(at, at + needle.length)) + '</mark>';
      i = at + needle.length;
      if (i >= src.length) break;
    }
    out += esc(src.slice(i));
    return out;
  }

  function searchHit(s, ti, q) {
    if (!q) return true;
    const hay = [ti.title, ti.tag, s.title, s.prompt, s.project, s.agentName, s.agent].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }

  function agentLabel(a) {
    return (typeof AGENT_NAME !== 'undefined' && AGENT_NAME[a]) || a;
  }

  // ---------- view state ----------

  let statusFilter = 'all';
  const agentFilter = new Set();
  let query = '';
  let cursor = null;
  // Set from the relation graph's “N more done → workbench” link: show one
  // master group only, with a dismissible chip above the list.
  let focusGroupKey = null;
  let focusGroupTitle = '';

  let filtersEl = null;
  let focusEl = null;
  let statusRowEl = null;
  let agentRowEl = null;
  const statusChips = new Map();
  const agentChips = new Map();
  let agentSig = '';
  let emptyEl = null;

  const rowCache = new Map();
  const groupCache = new Map();
  const knownSessionKeys = new Set();
  let firstTreeRender = true;
  let lastByKey = new Map();
  let lastSelectable = [];
  let lastOpenKeys = new Set();
  let lastGKeyOf = new Map();
  let lastFilterSig = null;
  let lastViewSig = null;
  let wasVisible = false;
  let activeKeyNow = null;

  // ---------- collapse state (wmad.wbCollapsed) ----------

  function storeGet(key, fallback) {
    try { return typeof store !== 'undefined' ? store.get(key, fallback) : fallback; } catch { return fallback; }
  }
  function storeSet(key, value) {
    try { if (typeof store !== 'undefined') store.set(key, value); } catch { /* private mode */ }
  }
  function readCollapsed() {
    const raw = storeGet('wbCollapsed', {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  let collapsedMap = readCollapsed();
  function collapsedLookup(gkey) {
    const key = 'g:' + gkey;
    return Object.prototype.hasOwnProperty.call(collapsedMap, key) ? !!collapsedMap[key] : undefined;
  }
  function setCollapsed(gkey, value) {
    const key = 'g:' + gkey;
    const next = {};
    for (const k of Object.keys(collapsedMap)) if (k !== key) next[k] = collapsedMap[k];
    next[key] = !!value;
    collapsedMap = next;
    storeSet('wbCollapsed', next);
  }
  function isCollapsed(g, now) {
    const explicit = collapsedLookup(g.key);
    if (explicit !== undefined) return explicit;
    if (g.kind !== 'master' || !g.kids.length) return false;
    if (!g.kids.every((k) => k.status === 'done')) return false;
    const last = g.kids.reduce((m, k) => Math.max(m, Number(k.lastEventAt) || Number(k.startedAt) || 0), 0);
    return last > 0 && now - last > 2 * 3600 * 1000;
  }

  // ---------- grouping ----------

  // Row order everywhere: needs you → error → running → idle → interrupted →
  // done. Running rows read newest start first; finished rows newest finish
  // first. Task ids never participate.
  const SORT_RANK = { waiting: 0, error: 1, thinking: 2, tool: 2, typing: 2, directing: 2, idle: 3, interrupted: 4, done: 5 };
  const sortRank = (s) => SORT_RANK[s?.status || 'idle'] ?? 3;
  function sortTime(s, rank) {
    if (rank === 2) return Number(s.startedAt) || Number(s.lastEventAt) || 0;
    if (rank === 5) return Number(s.lastEventAt) || Number(s.startedAt) || 0;
    return Number(s.lastEventAt) || Number(s.startedAt) || 0;
  }
  function compareRows(a, b) {
    const ra = sortRank(a);
    const rb = sortRank(b);
    if (ra !== rb) return ra - rb;
    const ta = sortTime(a, ra);
    const tb = sortTime(b, rb);
    if (ta !== tb) return tb - ta;
    return String(a.key).localeCompare(String(b.key));
  }
  const groupRows = (g) => (g.kind === 'master' ? (g.visibleKids || g.kids) : (g.rows || []));
  function groupLead(g) {
    let rank = 6;
    let time = 0;
    for (const s of groupRows(g)) {
      const r = sortRank(s);
      const t = sortTime(s, r);
      if (r < rank || (r === rank && t > time)) { rank = r; time = t; }
    }
    return { rank, time };
  }
  function compareGroups(a, b) {
    const la = groupLead(a);
    const lb = groupLead(b);
    return la.rank - lb.rank || lb.time - la.time || String(a.key).localeCompare(String(b.key));
  }

  function buildTree(sessions) {
    const byKey = new Map();
    const byRef = new Map();
    for (const s of sessions) {
      byKey.set(s.key, s);
      if (s.id) byRef.set(String(s.id), s);
      if (s.sessionId) byRef.set(String(s.sessionId), s);
    }

    const kidsByMaster = new Map();
    const orphans = [];
    for (const s of sessions) {
      if (!s.parentId) continue;
      if (!(s.agent === 'deepseek' || s.agent === 'dsh')) continue;
      const parent = byRef.get(String(s.parentId));
      if (parent && parent.key !== s.key) {
        if (!kidsByMaster.has(parent.key)) kidsByMaster.set(parent.key, []);
        kidsByMaster.get(parent.key).push(s);
      } else {
        orphans.push(s);
      }
    }

    // A session that is itself a master is drawn once, as a group header.
    const masterKeys = new Set(kidsByMaster.keys());
    for (const [mk, kids] of [...kidsByMaster]) {
      const kept = kids.filter((k) => !masterKeys.has(k.key));
      if (kept.length) kidsByMaster.set(mk, kept);
      else kidsByMaster.delete(mk);
    }
    const shownMasterKeys = new Set(kidsByMaster.keys());
    const shownChildKeys = new Set();
    for (const kids of kidsByMaster.values()) for (const k of kids) shownChildKeys.add(k.key);

    const groups = [];
    for (const [mk, kids] of kidsByMaster) {
      const master = byKey.get(mk);
      if (!master) continue;
      kids.sort(compareRows);
      groups.push({ key: 'master:' + master.key, kind: 'master', master, kids });
    }
    groups.sort(compareGroups);

    const orphanRows = orphans.filter((s) => !shownMasterKeys.has(s.key));
    const orphanKeys = new Set(orphanRows.map((s) => s.key));
    const other = sessions
      .filter((s) => !shownChildKeys.has(s.key) && !shownMasterKeys.has(s.key) && !orphanKeys.has(s.key))
      .sort(compareRows);
    orphanRows.sort(compareRows);

    return { groups, other, orphans: orphanRows };
  }

  // ---------- DOM: rows and groups ----------

  function makeRow(s) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'wb-task';
    el.dataset.key = s.key;
    el.innerHTML = `<span class="wb-l1"><span class="ui-dot st-interrupted"></span><span class="wb-title-wrap"><span class="ui-chip wb-tag" hidden></span><span class="wb-note" hidden>${esc(t('noOriginal'))}</span><span class="wb-task-title"></span></span><span class="wb-task-time ui-num"></span></span><span class="wb-l2"></span>`;
    return {
      el,
      dot: el.querySelector('.ui-dot'),
      tagEl: el.querySelector('.wb-tag'),
      noteEl: el.querySelector('.wb-note'),
      titleEl: el.querySelector('.wb-task-title'),
      timeEl: el.querySelector('.wb-task-time'),
      l2El: el.querySelector('.wb-l2'),
      dotCls: '',
      tag: null,
      tagHit: false,
      note: null,
      titleHtml: null,
      time: null,
      l2: null,
      l2Cls: null,
      titleAttr: null,
      status: '',
    };
  }

  function updateRow(entry, s, now, ti, isChild) {
    const st = s.status || 'idle';
    const dot = 'ui-dot ' + dotClass(st);
    if (entry.dotCls !== dot) {
      entry.dot.className = dot;
      entry.dotCls = dot;
    }
    if (entry.tag !== ti.tag) {
      entry.tagEl.textContent = ti.tag;
      entry.tagEl.hidden = !ti.tag;
      entry.tag = ti.tag;
    }
    const note = ti.fromReply ? t('noOriginal') : '';
    if (entry.note !== note) {
      entry.noteEl.textContent = note;
      entry.noteEl.hidden = !note;
      entry.note = note;
    }
    const needle = query.trim().toLowerCase();
    const tagHit = !!(needle && ti.tag && ti.tag.toLowerCase().includes(needle));
    if (entry.tagHit !== tagHit) {
      entry.tagEl.classList.toggle('is-hit', tagHit);
      entry.tagHit = tagHit;
    }
    const titleHtml = highlight(ti.title, query);
    if (entry.titleHtml !== titleHtml) {
      entry.titleEl.innerHTML = titleHtml;
      entry.titleHtml = titleHtml;
    }
    const time = rowTime(s, now);
    if (entry.time !== time) {
      entry.timeEl.textContent = time;
      entry.time = time;
    }
    const l2 = secondLine(s, ti);
    if (entry.l2 !== l2.text) {
      entry.l2El.textContent = l2.text;
      entry.l2 = l2.text;
    }
    const cls = 'wb-l2' + (l2.mono ? ' wb-act' : '') + (l2.cls ? ' ' + l2.cls : '');
    if (entry.l2Cls !== cls) {
      entry.l2El.className = cls;
      entry.l2Cls = cls;
    }
    entry.el.classList.toggle('wb-child', !!isChild);
    entry.el.classList.toggle('on', activeKeyNow === s.key);
    const tip = String(s.prompt || '').slice(0, 500);
    if (entry.titleAttr !== tip) {
      entry.el.title = tip;
      entry.titleAttr = tip;
    }
    entry.status = st;
  }

  function makeGroup(g) {
    const el = document.createElement('div');
    el.className = 'wb-group' + (g.kind === 'master' ? '' : ' wb-section');
    el.dataset.gkey = g.key;
    el.innerHTML = '<div class="wb-group-head" tabindex="-1"><button type="button" class="wb-arrow" aria-expanded="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button><span class="wb-group-title"></span><span class="wb-group-count ui-num"></span><span class="wb-bar"></span><span class="wb-group-time"></span></div><div class="wb-kids"></div>';
    return {
      el,
      head: el.querySelector('.wb-group-head'),
      arrow: el.querySelector('.wb-arrow'),
      titleEl: el.querySelector('.wb-group-title'),
      countEl: el.querySelector('.wb-group-count'),
      barEl: el.querySelector('.wb-bar'),
      timeEl: el.querySelector('.wb-group-time'),
      kidsEl: el.querySelector('.wb-kids'),
      masterKey: null,
      kind: g.kind,
      titleHtml: null,
      count: null,
      barSig: null,
      time: null,
      lastActivity: 0,
      collapsed: false,
    };
  }

  function updateGroup(entry, g, now, collapsed) {
    const master = g.kind === 'master';
    const ti = master ? titleOf(g.master) : null;
    const titleText = master ? ti.title : (g.kind === 'other' ? t('wbOther') : t('wbUnassigned'));
    const titleHtml = master ? highlight(titleText, query) : esc(titleText);
    if (entry.titleHtml !== titleHtml) {
      entry.titleEl.innerHTML = titleHtml;
      entry.titleHtml = titleHtml;
    }
    const count = master ? g.kids.length : g.rows.length;
    if (entry.count !== count) {
      entry.countEl.textContent = String(count);
      entry.count = count;
    }
    if (master) {
      const counts = new Map();
      for (const k of g.kids) {
        const st = k.status || 'idle';
        counts.set(st, (counts.get(st) || 0) + 1);
      }
      const sig = STATUS_BAR_ORDER.map((st) => counts.get(st) || 0).join(',');
      if (entry.barSig !== sig) {
        entry.barSig = sig;
        entry.barEl.textContent = '';
        for (const st of STATUS_BAR_ORDER) {
          const n = counts.get(st) || 0;
          if (!n) continue;
          const seg = document.createElement('i');
          seg.style.flexGrow = String(n);
          seg.style.background = `var(${ST_VAR[st] || '--st-interrupted'})`;
          entry.barEl.appendChild(seg);
        }
      }
      entry.barEl.hidden = false;
      const last = g.kids.reduce((m, k) => Math.max(m, Number(k.lastEventAt) || Number(k.startedAt) || 0), 0);
      entry.lastActivity = last;
      const time = last ? relTime(last, now) : '';
      if (entry.time !== time) {
        entry.timeEl.textContent = time;
        entry.time = time;
      }
      entry.timeEl.hidden = !time;
      entry.head.dataset.master = g.master.key;
    } else {
      entry.barEl.hidden = true;
      entry.timeEl.hidden = true;
      entry.lastActivity = 0;
      delete entry.head.dataset.master;
    }
    entry.el.classList.toggle('wb-section', !master);
    entry.el.classList.toggle('collapsed', !!collapsed);
    entry.arrow.setAttribute('aria-expanded', String(!collapsed));
    entry.head.classList.toggle('on', master && activeKeyNow === g.master.key);
    entry.el.dataset.gkey = g.key;
  }

  // Reorder only when the DOM order actually differs, so a stable tree never
  // moves under the pointer and hover/selection survive every data push.
  function orderInto(container, els) {
    let ref = container.firstChild;
    for (const el of els) {
      if (ref === el) {
        ref = ref.nextSibling;
        continue;
      }
      container.insertBefore(el, ref || null);
    }
  }

  // ---------- filters ----------

  function ensureFilters() {
    if (filtersEl && filtersEl.isConnected) return;
    const left = document.getElementById('wbLeft');
    const list = document.getElementById('wbList');
    if (!left || !list) return;
    filtersEl = document.createElement('div');
    filtersEl.className = 'wb-filters';
    filtersEl.innerHTML = '<div class="wb-filter-row" data-row="status"></div><div class="wb-filter-row" data-row="agent"></div>';
    statusRowEl = filtersEl.querySelector('[data-row="status"]');
    agentRowEl = filtersEl.querySelector('[data-row="agent"]');
    left.insertBefore(filtersEl, list);
    focusEl = document.createElement('div');
    focusEl.className = 'wb-focus';
    focusEl.hidden = true;
    focusEl.innerHTML = '<span class="wb-focus-lab"></span><button type="button" class="wb-focus-x" data-wb-focus-clear></button>';
    left.insertBefore(focusEl, list);
    focusEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-wb-focus-clear]')) clearFocus();
    });
    for (const f of STATUS_FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-chip wb-fchip';
      b.dataset.wbStatus = f.key;
      b.innerHTML = `<span>${esc(t(f.i18n))}</span><span class="ui-num"></span>`;
      b.addEventListener('click', () => {
        statusFilter = f.key;
        render();
      });
      statusRowEl.appendChild(b);
      statusChips.set(f.key, b);
    }
    agentRowEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wb-agent]');
      if (!b) return;
      const a = b.dataset.wbAgent;
      if (!a) agentFilter.clear();
      else if (agentFilter.has(a)) agentFilter.delete(a);
      else agentFilter.add(a);
      render();
    });
  }

  function renderFilters(sessions) {
    if (!statusRowEl || !agentRowEl) return;
    const base = sessions.filter((s) => !agentFilter.size || agentFilter.has(s.agent));
    const counts = {
      all: base.length,
      active: base.filter((s) => ACTIVE.has(s.status)).length,
      needsYou: base.filter((s) => s.status === 'waiting').length,
      done: base.filter((s) => s.status === 'done' || s.status === 'interrupted').length,
      error: base.filter((s) => s.status === 'error').length,
    };
    for (const f of STATUS_FILTERS) {
      const chip = statusChips.get(f.key);
      if (!chip) continue;
      const lbl = chip.querySelector('span');
      if (lbl && lbl.textContent !== t(f.i18n)) lbl.textContent = t(f.i18n);
      const n = chip.querySelector('.ui-num');
      if (n) n.textContent = String(counts[f.key] || 0);
      chip.classList.toggle('is-accent', statusFilter === f.key);
      chip.setAttribute('aria-pressed', String(statusFilter === f.key));
    }

    const countsByAgent = new Map();
    for (const s of sessions) countsByAgent.set(s.agent, (countsByAgent.get(s.agent) || 0) + 1);
    const agents = [...countsByAgent.keys()].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));
    const sig = agents.join('|') + '|' + (typeof langCode !== 'undefined' ? langCode : '');
    if (sig !== agentSig) {
      agentSig = sig;
      agentRowEl.textContent = '';
      agentChips.clear();
      const add = (value, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ui-chip wb-fchip';
        b.dataset.wbAgent = value;
        b.innerHTML = `<span>${esc(label)}</span><span class="ui-num"></span>`;
        agentRowEl.appendChild(b);
        agentChips.set(value, b);
      };
      add('', t('wbFilterAll'));
      for (const a of agents) add(a, agentLabel(a));
    }
    for (const [a, chip] of agentChips) {
      const n = chip.querySelector('.ui-num');
      if (n) n.textContent = String(a ? countsByAgent.get(a) || 0 : sessions.length);
      chip.classList.toggle('is-accent', a ? agentFilter.has(a) : agentFilter.size === 0);
    }
    updateAgentOverflow();
  }

  // F5: the agent row is one horizontal strip; the fade mask only turns on
  // when the chips really overflow, so a short row keeps crisp edges.
  function updateAgentOverflow() {
    if (!agentRowEl) return;
    agentRowEl.classList.toggle('is-over', agentRowEl.scrollWidth > agentRowEl.clientWidth + 1);
  }

  function makeEmpty() {
    const el = document.createElement('div');
    el.className = 'wb-empty-list';
    return el;
  }

  function renderFocus() {
    if (!focusEl) return;
    focusEl.hidden = !focusGroupKey;
    if (!focusGroupKey) return;
    const lab = focusEl.querySelector('.wb-focus-lab');
    const text = t('wbFocusOnly')(focusGroupTitle || focusGroupKey);
    if (lab.textContent !== text) lab.textContent = text;
    const x = focusEl.querySelector('.wb-focus-x');
    if (x.textContent !== t('wbFocusClear')) x.textContent = t('wbFocusClear');
  }

  // ---------- FLIP (200ms, transform/opacity only) ----------

  function snapshotRects() {
    const map = new Map();
    for (const entry of groupCache.values()) {
      if (entry.el.isConnected && entry.el.offsetParent !== null) map.set(entry.el, entry.el.getBoundingClientRect());
    }
    for (const entry of rowCache.values()) {
      if (entry.el.isConnected && entry.el.offsetParent !== null) map.set(entry.el, entry.el.getBoundingClientRect());
    }
    return map;
  }

  function enter(el) {
    if (typeof el.animate !== 'function') return;
    el.animate(
      [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' },
    );
  }

  // A task that just showed up gets a 1.2s accent wash, so the eye catches it.
  function flashNew(el) {
    if (reduced()) return;
    el.classList.remove('wb-new');
    void el.offsetWidth;
    el.classList.add('wb-new');
    clearTimeout(el._newT);
    el._newT = setTimeout(() => el.classList.remove('wb-new'), 1300);
  }

  function flip(first) {
    if (!first || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return;
    const movedGroups = new Set();
    const groupDeltas = new Map();
    for (const [el, r] of first) {
      if (!el.classList.contains('wb-group') || !el.isConnected || el.offsetParent === null) continue;
      const dy = r.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 0.5) {
        movedGroups.add(el);
        groupDeltas.set(el, dy);
      }
    }
    for (const [el, dy] of groupDeltas) {
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    for (const [el, r] of first) {
      if (el.classList.contains('wb-group') || !el.isConnected || el.offsetParent === null) continue;
      const group = el.closest('.wb-group');
      if (group && movedGroups.has(group)) continue;
      const dy = r.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    const newGroups = new Set();
    for (const entry of groupCache.values()) {
      if (entry.el.isConnected && entry.el.offsetParent !== null && !first.has(entry.el)) newGroups.add(entry.el);
    }
    for (const el of newGroups) enter(el);
    for (const entry of rowCache.values()) {
      if (!entry.el.isConnected || entry.el.offsetParent === null || first.has(entry.el)) continue;
      const group = entry.el.closest('.wb-group');
      if (group && newGroups.has(group)) continue;
      if (group && movedGroups.has(group)) {
        // The group itself is already sliding; fade the new row in place so its
        // transform does not compound with the parent's.
        entry.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
        continue;
      }
      enter(entry.el);
    }
  }

  // ---------- render ----------

  // The filtered, grouped tree that both the workbench list and the timeline
  // draw. Filters and search live in this module, so the timeline reuses this
  // instead of keeping a second copy of the rules.
  function buildView(sessions, now) {
    const tree = buildTree(sessions);
    const q = query.trim().toLowerCase();
    const titleCache = new Map();
    const getTitle = (s) => {
      let v = titleCache.get(s.key);
      if (!v) {
        v = titleOf(s);
        titleCache.set(s.key, v);
      }
      return v;
    };
    const agentOk = (s) => !agentFilter.size || agentFilter.has(s.agent);
    const statusOk = (s) => {
      if (statusFilter === 'all') return true;
      if (statusFilter === 'active') return ACTIVE.has(s.status);
      if (statusFilter === 'needsYou') return s.status === 'waiting';
      if (statusFilter === 'done') return s.status === 'done' || s.status === 'interrupted';
      if (statusFilter === 'error') return s.status === 'error';
      return true;
    };

    const viewGroups = [];
    let visibleRowCount = 0;
    for (const g of tree.groups) {
      if (focusGroupKey && g.master.key !== focusGroupKey) continue;
      const masterHit = q ? searchHit(g.master, getTitle(g.master), q) : false;
      const kids = g.kids.filter((k) => agentOk(k) && statusOk(k) && (!q || masterHit || searchHit(k, getTitle(k), q)));
      if (!kids.length) continue;
      visibleRowCount += kids.length;
      viewGroups.push({ ...g, visibleKids: kids });
    }
    const other = focusGroupKey ? [] : tree.other.filter((s) => agentOk(s) && statusOk(s) && searchHit(s, getTitle(s), q)).sort(compareRows);
    const orphans = focusGroupKey ? [] : tree.orphans.filter((s) => agentOk(s) && statusOk(s) && searchHit(s, getTitle(s), q)).sort(compareRows);
    if (other.length) {
      visibleRowCount += other.length;
      viewGroups.push({ key: 'section:other', kind: 'other', rows: other });
    }
    if (orphans.length) {
      visibleRowCount += orphans.length;
      viewGroups.push({ key: 'section:orphan', kind: 'orphan', rows: orphans });
    }
    // Filters can hide a group's leading rows; order the visible master groups
    // by the rows that remain. The catch-all sections stay at the bottom, with
    // their own rows sorted above.
    viewGroups.sort((a, b) => {
      const sa = a.kind === 'master' ? 0 : 1;
      const sb = b.kind === 'master' ? 0 : 1;
      return sa - sb || (sa === 0 ? compareGroups(a, b) : 0);
    });

    const collapsedByG = new Map();
    for (const g of viewGroups) collapsedByG.set(g.key, isCollapsed(g, now));

    return { viewGroups, getTitle, collapsedByG, visibleRowCount };
  }

  function render() {
    const wbEl = document.getElementById('wb');
    if (!wbEl || wbEl.hidden) {
      wasVisible = false;
      return;
    }
    const justShown = !wasVisible;
    wasVisible = true;
    const now = Date.now() - (state.skew || 0);
    const sessions = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    lastByKey = new Map(sessions.map((s) => [s.key, s]));
    if (focusGroupKey && !lastByKey.has(focusGroupKey)) {
      focusGroupKey = null;
      focusGroupTitle = '';
    }

    if (state.wbSel && !lastByKey.has(state.wbSel)) {
      state.wbSel = null;
      window.dispatchEvent(new CustomEvent('wb:select', { detail: { key: null } }));
    }
    if (cursor && !lastByKey.has(cursor)) cursor = null;

    const present = new Set(sessions.map((s) => s.agent));
    for (const a of [...agentFilter]) if (!present.has(a)) agentFilter.delete(a);

    const { viewGroups, getTitle, collapsedByG, visibleRowCount } = buildView(sessions, now);

    const selectable = [];
    const openKeys = new Set();
    const gkeyOf = new Map();
    for (const g of viewGroups) {
      if (g.kind === 'master') {
        selectable.push(g.master.key);
        openKeys.add(g.master.key);
        gkeyOf.set(g.master.key, g.key);
      }
      const rows = g.kind === 'master' ? g.visibleKids : g.rows;
      for (const s of rows) gkeyOf.set(s.key, g.key);
      if (collapsedByG.get(g.key)) continue;
      for (const s of rows) {
        selectable.push(s.key);
        openKeys.add(s.key);
      }
    }
    lastSelectable = selectable;
    lastOpenKeys = openKeys;
    lastGKeyOf = gkeyOf;
    activeKeyNow = cursor && openKeys.has(cursor) ? cursor : (state.wbSel && openKeys.has(state.wbSel) ? state.wbSel : null);

    const filterSig = statusFilter + '|' + [...agentFilter].sort().join(',') + '|' + query.trim().toLowerCase();
    const viewSig = viewGroups
      .map((g) => g.key + ':' + (g.kind === 'master' ? g.visibleKids.map((k) => k.key).join(',') : g.rows.map((k) => k.key).join(',')))
      .join('|');
    const animate = !justShown && lastViewSig != null && viewSig !== lastViewSig && filterSig === lastFilterSig && !reduced();
    const firstRects = animate ? snapshotRects() : null;

    ensureFilters();
    renderFilters(sessions);
    renderFocus();

    const box = document.getElementById('wbList');
    if (box) {
      const desiredGroups = [];
      for (const g of viewGroups) {
        let entry = groupCache.get(g.key);
        if (!entry) {
          entry = makeGroup(g);
          groupCache.set(g.key, entry);
        }
        const collapsed = collapsedByG.get(g.key);
        entry.collapsed = collapsed;
        entry.masterKey = g.kind === 'master' ? g.master.key : null;
        entry.kind = g.kind;
        updateGroup(entry, g, now, collapsed);
        desiredGroups.push(entry.el);

        const rows = g.kind === 'master' ? g.visibleKids : g.rows;
        const desiredRows = [];
        for (const s of rows) {
          const fresh = !knownSessionKeys.has(s.key);
          let re = rowCache.get(s.key);
          if (!re) {
            re = makeRow(s);
            rowCache.set(s.key, re);
            if (fresh && !firstTreeRender && ACTIVE.has(s.status || '')) flashNew(re.el);
          }
          updateRow(re, s, now, getTitle(s), g.kind === 'master');
          desiredRows.push(re.el);
        }
        const keep = new Set(desiredRows);
        for (const child of [...entry.kidsEl.children]) {
          if (!keep.has(child)) {
            rowCache.delete(child.dataset.key);
            child.remove();
          }
        }
        orderInto(entry.kidsEl, desiredRows);
      }

      const keepGroups = new Set(desiredGroups);
      for (const [gkey, entry] of [...groupCache]) {
        if (keepGroups.has(entry.el)) continue;
        for (const child of [...entry.kidsEl.children]) rowCache.delete(child.dataset.key);
        entry.el.remove();
        groupCache.delete(gkey);
      }

      const isEmpty = desiredGroups.length === 0;
      if (isEmpty) {
        if (!emptyEl) emptyEl = makeEmpty();
        const msg = sessions.length ? t('wbNoMatch') : t('wbNoSessions');
        if (emptyEl.dataset.msg !== msg) {
          emptyEl.dataset.msg = msg;
          emptyEl.innerHTML = `<p>${esc(msg)}</p><button type="button" class="ui-btn" data-wb-clear>${esc(t('wbClearFilters'))}</button>`;
        }
        if (!emptyEl.isConnected) box.appendChild(emptyEl);
      } else if (emptyEl && emptyEl.isConnected) {
        emptyEl.remove();
      }
      orderInto(box, desiredGroups);

      const countEl = document.getElementById('wbCount');
      if (countEl) countEl.textContent = String(visibleRowCount);
    }

    if (animate && firstRects) flip(firstRects);

    for (const s of sessions) knownSessionKeys.add(s.key);
    firstTreeRender = false;
    lastFilterSig = filterSig;
    lastViewSig = viewSig;
    renderDetail(now);
  }

  // ---------- middle column (T2) ----------

  function renderDetail(now) {
    const box = document.getElementById('wbDetail');
    if (!box) return;
    const s = state.data.sessions.find((x) => x.key === state.wbSel);
    if (!s) {
      if (window.WbDetail) window.WbDetail.clear(box);
      else {
        const html = `<div class="wb-empty">${esc(t('wbEmptySelect'))}</div>`;
        if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
      }
      window.WbAside?.render?.(document.getElementById('wbAside'), null, now);
      return;
    }
    // T4a: the detail pane owns its own header, strip, tabs and transcript.
    if (window.WbDetail) window.WbDetail.render(box, s, now);
    // T5: the right column mirrors the selected task (properties / files / images).
    window.WbAside?.render?.(document.getElementById('wbAside'), s, now);
  }

  function setRight(open) {
    const wbEl = document.getElementById('wb');
    if (!wbEl) return;
    wbEl.classList.toggle('wb-right-open', open);
    wbEl.classList.toggle('wb-right-closed', !open);
  }

  // ---------- selection, collapse, keyboard ----------

  function select(key) {
    if (!key) return;
    state.wbSel = key;
    cursor = key;
    activeKeyNow = key;
    document.getElementById('wb')?.classList.remove('wb-left-open');
    window.dispatchEvent(new CustomEvent('wb:select', { detail: { key } }));
    render();
  }

  function elementFor(key) {
    const re = rowCache.get(key);
    if (re && re.el.isConnected) return re.el;
    for (const entry of groupCache.values()) {
      if (entry.masterKey === key && entry.el.isConnected) return entry.head;
    }
    return null;
  }

  function scrollKeyIntoView(key) {
    const el = elementFor(key);
    if (!el) return;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { try { el.scrollIntoView(); } catch { /* detached */ } }
  }

  function focusKey(key) {
    const el = elementFor(key);
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* detached */ } }
  }

  function updateOnClasses() {
    for (const [key, entry] of rowCache) entry.el.classList.toggle('on', key === activeKeyNow);
    for (const entry of groupCache.values()) {
      entry.head.classList.toggle('on', !!entry.masterKey && entry.masterKey === activeKeyNow);
    }
  }

  function moveCursor(delta) {
    const keys = lastSelectable;
    if (!keys.length) return;
    let idx = keys.indexOf(cursor);
    if (idx < 0) idx = keys.indexOf(state.wbSel);
    let next;
    if (idx < 0) next = delta > 0 ? keys[0] : keys[keys.length - 1];
    else next = keys[Math.max(0, Math.min(keys.length - 1, idx + delta))];
    cursor = next;
    activeKeyNow = next;
    updateOnClasses();
    scrollKeyIntoView(next);
    focusKey(next);
  }

  function currentGroupKey() {
    const key = cursor || state.wbSel;
    return key ? (lastGKeyOf.get(key) || null) : null;
  }

  function collapseCurrent(collapse) {
    const gkey = currentGroupKey();
    if (!gkey) return;
    const entry = groupCache.get(gkey);
    if (!entry || entry.collapsed === collapse) return;
    setCollapsed(gkey, collapse);
    if (collapse && cursor && lastGKeyOf.get(cursor) === gkey) cursor = entry.masterKey || null;
    render();
  }

  function toggleGroup(gkey) {
    const entry = groupCache.get(gkey);
    if (!entry) return;
    const collapse = !entry.collapsed;
    setCollapsed(gkey, collapse);
    if (collapse && cursor && lastGKeyOf.get(cursor) === gkey) cursor = entry.masterKey || null;
    render();
  }

  function clearSearch() {
    query = '';
    state.wbQuery = '';
    const input = document.getElementById('wbSearch');
    if (input) input.value = '';
    render();
  }

  function clearFilters() {
    statusFilter = 'all';
    state.wbFilter = 'all';
    agentFilter.clear();
    query = '';
    state.wbQuery = '';
    focusGroupKey = null;
    focusGroupTitle = '';
    const input = document.getElementById('wbSearch');
    if (input) input.value = '';
    render();
  }

  function clearFocus() {
    if (!focusGroupKey) return;
    focusGroupKey = null;
    focusGroupTitle = '';
    render();
  }

  // Called from the relation graph: jump to the workbench, show just this
  // master's group, and put its header on screen.
  function focusGroup(key) {
    if (!key) { clearFocus(); return; }
    const s = (state.data.sessions || []).find((x) => x.key === key);
    if (!s) return;
    focusGroupKey = key;
    focusGroupTitle = titleOf(s).title;
    statusFilter = 'all';
    state.wbFilter = 'all';
    agentFilter.clear();
    query = '';
    state.wbQuery = '';
    const input = document.getElementById('wbSearch');
    if (input) input.value = '';
    if (typeof goToScreen === 'function') goToScreen('workbench');
    render();
    requestAnimationFrame(() => {
      const entry = groupCache.get('master:' + key);
      if (!entry) return;
      try { entry.el.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); } catch { /* detached */ }
    });
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      const wbEl = document.getElementById('wb');
      if (wbEl && wbEl.classList.contains('wb-left-open')) {
        wbEl.classList.remove('wb-left-open');
        e.preventDefault();
        return;
      }
      if (!query) {
        if (focusGroupKey) { e.preventDefault(); clearFocus(); }
        return;
      }
      if (document.querySelector('details.menu[open]')) return;
      const lb = document.getElementById('lightbox');
      if (lb && lb.classList.contains('on')) return;
      e.preventDefault();
      clearSearch();
      return;
    }
    const ae = document.activeElement;
    const editable = (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) ||
      (ae && ae.closest && ae.closest('input, textarea, select, [contenteditable]'));
    if (editable) return;
    // The timeline has its own j/k; only move this tree while it is on screen.
    const wbEl = document.getElementById('wb');
    if (!wbEl || wbEl.hidden || (typeof state !== 'undefined' && state.view !== 'workbench')) return;
    if ((e.key === 'j' || e.key === 'J') && !e.shiftKey) { e.preventDefault(); moveCursor(1); return; }
    if ((e.key === 'k' || e.key === 'K') && !e.shiftKey) { e.preventDefault(); moveCursor(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); return; }
    if (e.key === '[') { e.preventDefault(); collapseCurrent(true); return; }
    if (e.key === ']') { e.preventDefault(); collapseCurrent(false); return; }
    if (e.key === 'Enter') {
      const interactive = ae && /^(BUTTON|A|SUMMARY|INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '');
      if (interactive) return;
      if (cursor) { e.preventDefault(); select(cursor); }
    }
  }

  // Only the duration text is touched every second; the tree never re-orders
  // for a clock tick.
  function tickTimes() {
    const wbEl = document.getElementById('wb');
    if (!wbEl || wbEl.hidden || (typeof state !== 'undefined' && state.view !== 'workbench')) return;
    const now = Date.now() - (state.skew || 0);
    for (const entry of rowCache.values()) {
      if (!entry.status || !LIVE.has(entry.status)) continue;
      const s = lastByKey.get(entry.el.dataset.key);
      if (!s) continue;
      const time = rowTime(s, now);
      if (entry.time !== time) {
        entry.timeEl.textContent = time;
        entry.time = time;
      }
    }
    for (const entry of groupCache.values()) {
      if (!entry.lastActivity) continue;
      const time = relTime(entry.lastActivity, now);
      if (entry.time !== time) {
        entry.timeEl.textContent = time;
        entry.time = time;
      }
    }
  }

  // ---------- boot ----------

  function init() {
    ensureFilters();
    const box = document.getElementById('wbList');
    box?.addEventListener('click', (e) => {
      const clear = e.target.closest('[data-wb-clear]');
      if (clear) { clearFilters(); return; }
      const arrow = e.target.closest('.wb-arrow');
      if (arrow) {
        const group = arrow.closest('.wb-group');
        if (group) toggleGroup(group.dataset.gkey);
        return;
      }
      const task = e.target.closest('.wb-task');
      if (task) { select(task.dataset.key); return; }
      const head = e.target.closest('.wb-group-head');
      if (head) {
        const group = head.closest('.wb-group');
        if (!group) return;
        if (head.dataset.master) select(head.dataset.master);
        else toggleGroup(group.dataset.gkey);
      }
    });

    document.getElementById('wbRightHide')?.addEventListener('click', () => setRight(false));
    document.getElementById('wbRightShow')?.addEventListener('click', () => setRight(true));
    document.getElementById('wbLeftClose')?.addEventListener('click', () => document.getElementById('wb')?.classList.remove('wb-left-open'));
    // Below 900px the tree is a drawer: the top bar's 任务 button opens it,
    // and a press anywhere outside the drawer closes it.
    document.getElementById('tbTasks')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('wb')?.classList.toggle('wb-left-open');
    });
    document.addEventListener('pointerdown', (e) => {
      const wbEl = document.getElementById('wb');
      if (!wbEl || !wbEl.classList.contains('wb-left-open')) return;
      if (e.target.closest('#wbLeft') || e.target.closest('#tbTasks')) return;
      wbEl.classList.remove('wb-left-open');
    }, true);
    const drawerMQ = matchMedia('(max-width: 900px)');
    drawerMQ.addEventListener('change', (e) => {
      if (!e.matches) document.getElementById('wb')?.classList.remove('wb-left-open');
    });
    const narrow = matchMedia('(max-width: 1200px)');
    const resetRight = () => setRight(!narrow.matches);
    resetRight();
    narrow.addEventListener('change', resetRight);

    window.addEventListener('wb:filter', (e) => {
      statusFilter = FILTER_ALIAS[e.detail?.filter] || 'all';
      render();
    });
    window.addEventListener('wb:query', (e) => {
      query = String(e.detail?.query || '');
      render();
    });
    document.addEventListener('keydown', onKeyDown);
    setInterval(tickTimes, 1000);
    window.addEventListener('resize', updateAgentOverflow);

    statusFilter = FILTER_ALIAS[state.wbFilter] || 'all';
    query = String(state.wbQuery || '');
    render();
  }

  function debugOrder() {
    return [...document.querySelectorAll('#wbList .wb-task')].map((el) => el.dataset.key);
  }

  function debugGroups() {
    return [...document.querySelectorAll('#wbList .wb-group')].map((el) => ({
      key: el.dataset.gkey,
      collapsed: el.classList.contains('collapsed'),
      kids: [...el.querySelectorAll('.wb-task')].map((k) => k.dataset.key),
    }));
  }

  window.Workbench = {
    init, render, select, onLang: render, titleOf,
    fmtDur, relTime, secondLine, rowTime, searchHit, buildTree, buildView, isCollapsed, setCollapsed,
    focusGroup, clearFocus,
    STATUS_FILTERS, FILTER_ALIAS, debugOrder, debugGroups,
  };
  init();
})();
