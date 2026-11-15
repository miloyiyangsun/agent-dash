// workbench.js — 工作台视图（T2 三栏骨架 / T3 左栏任务树）。
// The main script owns state/data; this file draws the three-column stage, the
// task tree, and reuses its transcript renderer (renderTranscript / loadConvo).
(() => {
  'use strict';

  const t = (k) => (typeof L !== 'undefined' && L[k] != null ? L[k] : (window.I18N?.en?.[k] ?? k));
  const esc = (s) => (typeof window.esc === 'function' ? window.esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const dotClass = (st) => (st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`);

  const ACTIVE = new Set(['thinking', 'tool', 'typing']);
  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);
  const STATUS_BAR_ORDER = ['thinking', 'tool', 'typing', 'waiting', 'error', 'done', 'interrupted', 'idle'];
  const ST_VAR = {
    thinking: '--st-thinking',
    tool: '--st-tool',
    typing: '--st-typing',
    waiting: '--st-waiting',
    done: '--st-done',
    error: '--st-error',
    interrupted: '--st-interrupted',
    idle: '--st-interrupted',
  };
  const STATUS_FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'needsYou', label: '需要你' },
    { key: 'done', label: '已完成' },
    { key: 'error', label: '出错' },
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
      const p = stripTask(src);
      return {
        tag: isTaskId(p.tag) ? p.tag : '',
        text: plain(firstSentence(stripWorkdir(p.body || src))),
      };
    };
    const noise = (text) => NOISE_TITLES.has(String(text || '').toLowerCase().replace(/[.。]+$/, ''));

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
    if (s < 45) return '现在';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
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
    if (st === 'waiting') return { text: '等你回复', cls: 'wb-wait', mono: false };
    if (st === 'error') {
      if (ti && ti.fromReply) return { text: '出错', cls: 'wb-err', mono: false };
      const msg = plain(firstSentence(s.error)) || '出错';
      return { text: clip(msg, 90), cls: 'wb-err', mono: false };
    }
    if (st === 'interrupted') return { text: '中断', cls: '', mono: false };
    if (st === 'done') {
      // When the title itself came from the reply, repeating it here would be
      // noise; the check mark plus the state is enough.
      if (ti && ti.fromReply) return { text: '✓ 已完成', cls: '', mono: false };
      const msg = plain(firstSentence(s.reply));
      return { text: msg ? '✓ ' + clip(msg, 90) : '✓ 已完成', cls: '', mono: false };
    }
    if (ACTIVE.has(st)) {
      const act = plain(squash(s.activity));
      if (act) return { text: clip(act, 90), cls: '', mono: true };
      return { text: (typeof L !== 'undefined' && L[st]) || st, cls: '', mono: false };
    }
    return { text: '待命', cls: '', mono: false };
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
  let convo = { key: null, at: null, messages: null, private: false, busy: false };

  let filtersEl = null;
  let statusRowEl = null;
  let agentRowEl = null;
  const statusChips = new Map();
  const agentChips = new Map();
  let agentSig = '';
  let emptyEl = null;

  const rowCache = new Map();
  const groupCache = new Map();
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

  function byStartDesc(a, b) {
    return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) || String(a.key).localeCompare(String(b.key));
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
      kids.sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || String(a.key).localeCompare(String(b.key)));
      groups.push({ key: 'master:' + master.key, kind: 'master', master, kids });
    }
    groups.sort((a, b) => {
      const at = a.kids.reduce((m, k) => Math.max(m, Number(k.startedAt) || 0), 0);
      const bt = b.kids.reduce((m, k) => Math.max(m, Number(k.startedAt) || 0), 0);
      return bt - at || String(a.master.key).localeCompare(String(b.master.key));
    });

    const orphanRows = orphans.filter((s) => !shownMasterKeys.has(s.key));
    const orphanKeys = new Set(orphanRows.map((s) => s.key));
    const other = sessions
      .filter((s) => !shownChildKeys.has(s.key) && !shownMasterKeys.has(s.key) && !orphanKeys.has(s.key))
      .sort(byStartDesc);
    orphanRows.sort(byStartDesc);

    return { groups, other, orphans: orphanRows };
  }

  // ---------- DOM: rows and groups ----------

  function makeRow(s) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'wb-task';
    el.dataset.key = s.key;
    el.innerHTML = '<span class="wb-l1"><span class="ui-dot st-interrupted"></span><span class="wb-title-wrap"><span class="ui-chip wb-tag" hidden></span><span class="wb-task-title"></span></span><span class="wb-task-time ui-num"></span></span><span class="wb-l2"></span>';
    return {
      el,
      dot: el.querySelector('.ui-dot'),
      tagEl: el.querySelector('.wb-tag'),
      titleEl: el.querySelector('.wb-task-title'),
      timeEl: el.querySelector('.wb-task-time'),
      l2El: el.querySelector('.wb-l2'),
      dotCls: '',
      tag: null,
      tagHit: false,
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
    const titleText = master ? ti.title : (g.kind === 'other' ? '其他会话' : '未归属');
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
    for (const f of STATUS_FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-chip wb-fchip';
      b.dataset.wbStatus = f.key;
      b.innerHTML = `<span>${esc(f.label)}</span><span class="ui-num"></span>`;
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
      const n = chip.querySelector('.ui-num');
      if (n) n.textContent = String(counts[f.key] || 0);
      chip.classList.toggle('is-accent', statusFilter === f.key);
      chip.setAttribute('aria-pressed', String(statusFilter === f.key));
    }

    const countsByAgent = new Map();
    for (const s of sessions) countsByAgent.set(s.agent, (countsByAgent.get(s.agent) || 0) + 1);
    const agents = [...countsByAgent.keys()].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));
    const sig = agents.join('|');
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
      add('', '全部');
      for (const a of agents) add(a, agentLabel(a));
    }
    for (const [a, chip] of agentChips) {
      const n = chip.querySelector('.ui-num');
      if (n) n.textContent = String(a ? countsByAgent.get(a) || 0 : sessions.length);
      chip.classList.toggle('is-accent', a ? agentFilter.has(a) : agentFilter.size === 0);
    }
  }

  function makeEmpty() {
    const el = document.createElement('div');
    el.className = 'wb-empty-list';
    return el;
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

    if (state.wbSel && !lastByKey.has(state.wbSel)) {
      state.wbSel = null;
      convo = { key: null, at: null, messages: null, private: false, busy: false };
      window.dispatchEvent(new CustomEvent('wb:select', { detail: { key: null } }));
    }
    if (cursor && !lastByKey.has(cursor)) cursor = null;

    const present = new Set(sessions.map((s) => s.agent));
    for (const a of [...agentFilter]) if (!present.has(a)) agentFilter.delete(a);

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
      const masterHit = q ? searchHit(g.master, getTitle(g.master), q) : false;
      const kids = g.kids.filter((k) => agentOk(k) && statusOk(k) && (!q || masterHit || searchHit(k, getTitle(k), q)));
      if (!kids.length) continue;
      visibleRowCount += kids.length;
      viewGroups.push({ ...g, visibleKids: kids });
    }
    const other = tree.other.filter((s) => agentOk(s) && statusOk(s) && searchHit(s, getTitle(s), q));
    const orphans = tree.orphans.filter((s) => agentOk(s) && statusOk(s) && searchHit(s, getTitle(s), q));
    if (other.length) {
      visibleRowCount += other.length;
      viewGroups.push({ key: 'section:other', kind: 'other', rows: other });
    }
    if (orphans.length) {
      visibleRowCount += orphans.length;
      viewGroups.push({ key: 'section:orphan', kind: 'orphan', rows: orphans });
    }

    const collapsedByG = new Map();
    for (const g of viewGroups) collapsedByG.set(g.key, isCollapsed(g, now));

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

    const filterSig = statusFilter + '|' + [...agentFilter].sort().join(',') + '|' + q;
    const viewSig = viewGroups
      .map((g) => g.key + ':' + (g.kind === 'master' ? g.visibleKids.map((k) => k.key).join(',') : g.rows.map((k) => k.key).join(',')))
      .join('|');
    const animate = !justShown && lastViewSig != null && viewSig !== lastViewSig && filterSig === lastFilterSig && !reduced();
    const firstRects = animate ? snapshotRects() : null;

    ensureFilters();
    renderFilters(sessions);

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
          let re = rowCache.get(s.key);
          if (!re) {
            re = makeRow(s);
            rowCache.set(s.key, re);
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
        const msg = sessions.length ? '没有符合筛选条件的任务' : '暂无会话';
        if (emptyEl.dataset.msg !== msg) {
          emptyEl.dataset.msg = msg;
          emptyEl.innerHTML = `<p>${esc(msg)}</p><button type="button" class="ui-btn" data-wb-clear>清除筛选</button>`;
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

    lastFilterSig = filterSig;
    lastViewSig = viewSig;
    renderDetail(now);
  }

  // ---------- middle column (T2) ----------

  function sessionTitle(s) {
    const { tag, title } = titleOf(s);
    return [tag, title].filter(Boolean).join(' · ') || s.project || s.agent || '';
  }

  function wbTime(s, now) {
    return rowTime(s, now) || (typeof timeLabel === 'function' ? timeLabel(s, now) : '');
  }

  function renderDetail(now) {
    const box = document.getElementById('wbDetail');
    if (!box) return;
    const s = state.data.sessions.find((x) => x.key === state.wbSel);
    if (!s) {
      const html = `<div class="wb-empty">${esc(t('wbEmptySelect'))}</div>`;
      if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
      return;
    }
    if (convo.key !== s.key) convo = { key: s.key, at: null, messages: null, private: false, busy: false };
    // The side panel's loader is generic: pass our own transcript target.
    if (convo.at !== s.lastEventAt && !convo.busy) {
      loadConvo(s, convo, () => { if (state.wbSel === s.key) renderDetail(now); });
    }
    const body = convo.private
      ? `<div class="msgs-note">${esc(t('privateNote'))}</div>`
      : convo.messages == null ? `<div class="msgs-note">${esc(t('loadingMsgs'))}</div>`
        : !convo.messages.length ? `<div class="msgs-note">${esc(t('noMessages'))}</div>`
          : renderTranscript(convo.messages, s.key);
    const html = `<div class="wb-doc">
      <div class="wb-doc-head">
        <h1>${esc(sessionTitle(s))}</h1>
        <div class="wb-doc-meta" style="--s:${statusColor(s.status)}">
          <span class="ui-dot ${dotClass(s.status)}"></span>
          <b class="${s.status === 'thinking' ? 'ui-shimmer' : ''}" style="color:var(--s)">${esc(L[s.status] || s.status)}</b>
          ${s.project ? `<span>${esc(s.project)}</span>` : ''}
          <span class="ui-num">${esc(wbTime(s, now))}</span>
        </div>
      </div>
      <div class="wb-transcript">${body}</div>
    </div>`;
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
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
    if (convo.key !== key) convo = { key, at: null, messages: null, private: false, busy: false };
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
    const input = document.getElementById('wbSearch');
    if (input) input.value = '';
    render();
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!query) return;
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
    if (!wbEl || wbEl.hidden) return;
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
    document.getElementById('wbLeftTab')?.addEventListener('click', () => document.getElementById('wb')?.classList.add('wb-left-open'));
    document.getElementById('wbLeftClose')?.addEventListener('click', () => document.getElementById('wb')?.classList.remove('wb-left-open'));
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

  window.Workbench = { init, render, select, onLang: render, titleOf, debugOrder, debugGroups };
  init();
})();
