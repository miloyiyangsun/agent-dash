// drawer.js — right-hand Agent panel (T10).
// List mode groups every visible task by status; detail mode reuses the
// workbench's detail.js transcript renderer and aside.js artifact extractor,
// so there is only one implementation of either.
(() => {
  'use strict';

  const esc = (s) => (typeof window.esc === 'function'
    ? window.esc(s)
    : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const t = (k) => {
    const lang = typeof langCode !== 'undefined' ? langCode : 'en';
    const dict = typeof L !== 'undefined' ? L : null;
    return dict?.[k] ?? (lang.startsWith('zh') ? window.I18N?.['zh-CN']?.[k] : null) ?? window.I18N?.en?.[k] ?? k;
  };
  const ACTIVE = new Set(['thinking', 'tool', 'typing']);
  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);
  const UNFINISHED = new Set(['thinking', 'tool', 'typing', 'waiting', 'error']);
  const RECENT_LIMIT = 10;
  const dotClass = (st) => (st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`);
  const statusColor = (st) => {
    if (typeof window.statusColor === 'function') {
      try { return window.statusColor(st); } catch { /* fall through */ }
    }
    return `var(--st-${st || 'interrupted'})`;
  };
  const nowMs = () => Date.now() - (typeof state !== 'undefined' ? (state.skew || 0) : 0);
  const firstLine = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
  const clip = (text, n) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
  };
  const fmtTokens = (n) => {
    if (typeof window.fmtTokens === 'function') {
      try { return window.fmtTokens(n); } catch { /* fall through */ }
    }
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(2)}M`;
  };
  const titleOf = (s) => (window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || '' });
  const rowTime = (s, now) => (window.Workbench?.rowTime ? window.Workbench.rowTime(s, now) : '');
  const secondLine = (s, ti) => (window.Workbench?.secondLine ? window.Workbench.secondLine(s, ti) : { text: s.activity || '', mono: true });

  const root = document.createElement('aside');
  root.id = 'agentDrawer';
  root.className = 'dr';
  root.hidden = true;
  root.innerHTML = `
    <button type="button" class="dr-strip" id="drStrip">
      <span class="dr-strip-label">Agent</span>
      <span class="dr-strip-badge ui-num" id="drStripBadge" hidden></span>
    </button>
    <div class="dr-panel">
      <div class="dr-list" id="drList">
        <header class="dr-head">
          <h2 class="dr-head-title" id="drTitle">Agent</h2>
          <span class="dr-count ui-num" id="drCount">0</span>
          <button type="button" class="dr-collapse" id="drCollapse"><svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg></button>
        </header>
        <div class="dr-rows" id="drRows"></div>
      </div>
      <div class="dr-detail" id="drDetail" hidden>
        <header class="dr-dhead">
          <button type="button" class="dr-back" id="drBack"><svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg></button>
          <img class="agent-logo dr-agent" alt="">
          <span class="ui-chip dr-tag" hidden></span>
          <span class="dr-dtitle"></span>
          <button type="button" class="ui-btn dr-openwb" id="drOpenWb"></button>
        </header>
        <div class="dr-body" id="drBody">
          <div class="dr-meta" id="drMeta"></div>
          <section class="dr-sec">
            <h3 class="dr-sec-h" id="drResH"></h3>
            <div class="dr-sumwrap" id="drSum"></div>
            <div class="dr-artifacts" id="drArtifacts"></div>
          </section>
          <section class="dr-sec dr-process-sec">
            <h3 class="dr-sec-h" id="drProcH"></h3>
            <div class="dr-transcript" id="drTranscript"></div>
          </section>
        </div>
      </div>
    </div>`;
  document.body.append(root);

  const el = {
    root,
    strip: document.getElementById('drStrip'),
    stripBadge: document.getElementById('drStripBadge'),
    list: document.getElementById('drList'),
    title: document.getElementById('drTitle'),
    count: document.getElementById('drCount'),
    collapse: document.getElementById('drCollapse'),
    rows: document.getElementById('drRows'),
    detail: document.getElementById('drDetail'),
    back: document.getElementById('drBack'),
    agent: root.querySelector('.dr-dhead .dr-agent'),
    tag: root.querySelector('.dr-dhead .dr-tag'),
    dtitle: root.querySelector('.dr-dhead .dr-dtitle'),
    openWb: document.getElementById('drOpenWb'),
    body: document.getElementById('drBody'),
    meta: document.getElementById('drMeta'),
    resH: document.getElementById('drResH'),
    sum: document.getElementById('drSum'),
    artifacts: document.getElementById('drArtifacts'),
    procH: document.getElementById('drProcH'),
    transcript: document.getElementById('drTranscript'),
  };

  let view = 'workbench';
  let expanded = (() => {
    const saved = typeof store !== 'undefined' ? store.get('drawer', null) : null;
    if (saved === true || saved === false) return saved;
    return window.innerWidth >= 1200;
  })();
  let mode = 'list';
  let sel = null;
  let recentAll = false;
  let resKey = null;
  let dtInst = null;
  let asInst = null;
  const rowCache = new Map();
  const groupCache = new Map();
  let lastByKey = new Map();

  function drawerVisible() {
    return typeof state !== 'undefined' && state.full
      && !(typeof popout !== 'undefined' && popout?.win)
      && (view === 'office' || view === 'topo');
  }

  function visibleList() {
    const base = typeof visible === 'function' ? visible() : (state?.data?.sessions || []);
    return Array.isArray(base) ? base : [];
  }

  function current() {
    const list = Array.isArray(state?.data?.sessions) ? state.data.sessions : [];
    return list.find((x) => x.key === sel) || null;
  }

  function findMaster(s) {
    if (!s.parentId) return null;
    const list = Array.isArray(state?.data?.sessions) ? state.data.sessions : [];
    return list.find((x) => x.key !== s.key && (x.id === s.parentId || (x.sessionId && x.sessionId === s.parentId))) || null;
  }

  function filterKey() {
    const raw = typeof state !== 'undefined' ? state.wbFilter : 'all';
    return window.Workbench?.FILTER_ALIAS?.[raw] || 'all';
  }

  function statusOk(s, f) {
    if (f === 'all') return true;
    if (f === 'active') return ACTIVE.has(s.status);
    if (f === 'needsYou') return s.status === 'waiting';
    if (f === 'done') return s.status === 'done' || s.status === 'interrupted';
    if (f === 'error') return s.status === 'error';
    return true;
  }

  function searchOk(s, q) {
    if (!q) return true;
    const ti = titleOf(s);
    if (window.Workbench?.searchHit) return window.Workbench.searchHit(s, ti, q);
    return [ti.title, ti.tag, s.title, s.prompt, s.project, s.agentName, s.agent].filter(Boolean).join('\n').toLowerCase().includes(q);
  }

  function byStart(a, b) {
    return (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || String(a.key).localeCompare(String(b.key));
  }
  function byEndDesc(a, b) {
    return (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0) || String(a.key).localeCompare(String(b.key));
  }

  function actionOf(s, ti) {
    const st = s.status || 'idle';
    if (s.stuck) return t('stuck')(s.stuck);
    if (s.activity) return s.activity;
    if (st === 'error') return clip(firstLine(s.error), 90);
    if (st === 'done') return s.reply ? `✓ ${clip(firstLine(s.reply), 90)}` : '';
    if (st === 'waiting') return t('secondWaiting');
    const second = secondLine(s, ti);
    const word = (typeof L !== 'undefined' && L[st]) || st;
    if (second.text && second.text !== word && second.text !== t('secondDone') && second.text !== t('secondIdle') && second.text !== t('secondInterrupted')) return second.text;
    return '';
  }

  function metaParts(s) {
    const parts = [];
    if (s.effort) parts.push(String(s.effort));
    if (Number.isFinite(s.turns) && s.turns) parts.push(t('drawerMetaTurns')(s.turns));
    if (s.thinkingTokens) parts.push(t('drawerMetaThink')(fmtTokens(s.thinkingTokens)));
    if (s.images) parts.push(t('drawerMetaImages')(s.images));
    return parts;
  }

  // ---------- list ----------

  function makeGroup(key, label) {
    const box = document.createElement('section');
    box.className = 'dr-group';
    box.dataset.g = key;
    box.innerHTML = '<div class="dr-ghead"><span class="dr-glabel"></span><span class="dr-gcount ui-num"></span></div><div class="dr-grows"></div><button type="button" class="dr-more" data-dr-more hidden></button>';
    const entry = {
      el: box,
      labelEl: box.querySelector('.dr-glabel'),
      countEl: box.querySelector('.dr-gcount'),
      rowsEl: box.querySelector('.dr-grows'),
      moreEl: box.querySelector('.dr-more'),
      label: null,
    };
    groupCache.set(key, entry);
    return entry;
  }

  function makeCard() {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'dr-card';
    card.innerHTML = `
      <span class="dr-l1"><img class="agent-logo dr-agent" alt=""><span class="ui-chip dr-tag" hidden></span><span class="dr-name"></span><span class="dr-time ui-num"></span></span>
      <span class="dr-l2"><span class="ui-dot"></span><span class="dr-st"></span><span class="dr-act"></span></span>
      <span class="dr-l3"><span class="dr-frommark"></span><span class="dr-fromtext"></span></span>
      <span class="dr-l4 ui-num"></span>`;
    return {
      el: card,
      agent: card.querySelector('.dr-agent'),
      tag: card.querySelector('.dr-tag'),
      name: card.querySelector('.dr-name'),
      time: card.querySelector('.dr-time'),
      dot: card.querySelector('.ui-dot'),
      st: card.querySelector('.dr-st'),
      act: card.querySelector('.dr-act'),
      l3: card.querySelector('.dr-l3'),
      fromMark: card.querySelector('.dr-frommark'),
      fromText: card.querySelector('.dr-fromtext'),
      l4: card.querySelector('.dr-l4'),
      agentId: null,
      tagText: null,
      nameText: null,
      timeText: null,
      dotCls: null,
      stText: null,
      actText: null,
      fromTextVal: null,
      l4Text: null,
      selected: null,
    };
  }

  function updateCard(entry, s, now) {
    const st = s.status || 'idle';
    const badge = window.OFFICE_AGENT_BADGES?.[s.agent];
    if (entry.agentId !== s.agent) {
      entry.agentId = s.agent;
      if (badge) {
        entry.agent.src = badge.logo;
        entry.agent.className = `agent-logo dr-agent${badge.mono ? ' mono' : ''}`;
        entry.agent.hidden = false;
      } else {
        entry.agent.hidden = true;
      }
    }
    const ti = titleOf(s);
    if (entry.tagText !== ti.tag) {
      entry.tagText = ti.tag;
      entry.tag.textContent = ti.tag;
      entry.tag.hidden = !ti.tag;
    }
    const name = ti.title || s.project || s.agent || '';
    if (entry.nameText !== name) {
      entry.nameText = name;
      entry.name.textContent = name;
      entry.el.title = String(s.prompt || s.title || name).slice(0, 500);
    }
    const time = rowTime(s, now);
    if (entry.timeText !== time) {
      entry.timeText = time;
      entry.time.textContent = time;
    }
    const dot = 'ui-dot ' + dotClass(st);
    if (entry.dotCls !== dot) {
      entry.dotCls = dot;
      entry.dot.className = dot;
    }
    if (entry.stText !== st) {
      entry.stText = st;
      entry.st.textContent = (typeof L !== 'undefined' && L[st]) || st;
      entry.st.style.color = statusColor(st);
    }
    const act = actionOf(s, ti);
    if (entry.actText !== act) {
      entry.actText = act;
      entry.act.textContent = act;
      entry.act.hidden = !act;
    }
    const master = findMaster(s);
    const promptLine = firstLine(s.prompt);
    const fromText = master && promptLine ? clip(promptLine, 90) : '';
    if (entry.fromTextVal !== fromText) {
      entry.fromTextVal = fromText;
      entry.l3.hidden = !fromText;
      entry.fromMark.textContent = fromText ? t('drawerFromMark') : '';
      entry.fromText.textContent = fromText;
      entry.fromText.title = promptLine;
    }
    const parts = metaParts(s);
    const l4 = parts.join(' · ');
    if (entry.l4Text !== l4) {
      entry.l4Text = l4;
      entry.l4.textContent = l4;
      entry.l4.hidden = !l4;
    }
    const selected = mode === 'detail' && sel === s.key;
    if (entry.selected !== selected) {
      entry.selected = selected;
      entry.el.classList.toggle('is-sel', selected);
    }
  }

  function orderInto(container, els) {
    let ref = container.firstChild;
    for (const node of els) {
      if (ref === node) {
        ref = ref.nextSibling;
        continue;
      }
      container.insertBefore(node, ref || null);
    }
  }

  function renderList() {
    if (!drawerVisible() || mode !== 'list') return;
    const now = nowMs();
    const all = visibleList();
    lastByKey = new Map(all.map((s) => [s.key, s]));
    const f = filterKey();
    const q = String(state?.wbQuery || '').trim().toLowerCase();
    const list = all.filter((s) => statusOk(s, f) && searchOk(s, q));
    el.count.textContent = String(list.length);
    const groups = [
      { key: 'needsYou', label: t('wbFilterNeeds'), items: list.filter((s) => s.status === 'waiting').sort(byStart) },
      { key: 'error', label: t('wbFilterError'), items: list.filter((s) => s.status === 'error').sort(byEndDesc) },
      { key: 'working', label: t('wbFilterActive'), items: list.filter((s) => ACTIVE.has(s.status)).sort(byStart) },
      { key: 'recent', label: t('wbRecentDone'), items: list.filter((s) => s.status === 'done' || s.status === 'interrupted').sort(byEndDesc), limit: recentAll ? Infinity : RECENT_LIMIT },
    ];

    const desiredGroups = [];
    for (const g of groups) {
      let entry = groupCache.get(g.key);
      if (!entry) entry = makeGroup(g.key, g.label);
      entry.labelEl.textContent = g.label;
      entry.countEl.textContent = String(g.items.length);
      entry.el.hidden = !g.items.length;
      const limit = g.limit ?? Infinity;
      const rows = g.items.slice(0, limit);
      const desiredRows = [];
      for (const s of rows) {
        let card = rowCache.get(s.key);
        if (!card) {
          card = makeCard();
          rowCache.set(s.key, card);
        }
        card.el.dataset.key = s.key;
        updateCard(card, s, now);
        desiredRows.push(card.el);
      }
      const keep = new Set(desiredRows);
      for (const child of [...entry.rowsEl.children]) {
        if (keep.has(child)) continue;
        rowCache.delete(child.dataset.key);
        child.remove();
      }
      orderInto(entry.rowsEl, desiredRows);
      if (g.key === 'recent' && g.items.length > RECENT_LIMIT) {
        entry.moreEl.hidden = false;
        entry.moreEl.textContent = recentAll ? t('drawerShowLess') : t('wbMore')(g.items.length - RECENT_LIMIT);
      } else {
        entry.moreEl.hidden = true;
      }
      if (g.items.length) desiredGroups.push(entry.el);
    }
    const keepGroups = new Set(desiredGroups);
    for (const [key, entry] of [...groupCache]) {
      if (keepGroups.has(entry.el)) continue;
      for (const child of [...entry.rowsEl.children]) rowCache.delete(child.dataset.key);
      entry.el.remove();
      groupCache.delete(key);
    }
    orderInto(el.rows, desiredGroups);
    if (!desiredGroups.length) {
      const msg = all.length ? t('wbNoMatch') : t('wbNoSessions');
      if (el.rows.dataset.empty !== msg) {
        el.rows.dataset.empty = msg;
        const note = document.createElement('div');
        note.className = 'dr-empty';
        note.textContent = msg;
        el.rows.append(note);
      }
    } else if (el.rows.querySelector('.dr-empty')) {
      el.rows.querySelector('.dr-empty').remove();
      delete el.rows.dataset.empty;
    }
  }

  // ---------- detail ----------

  function masterTitle(master) {
    const ti = titleOf(master);
    return clip([ti.tag, ti.title].filter(Boolean).join(' · ') || master.project || master.agent || '', 26);
  }

  function renderMeta(s) {
    const st = s.status || 'idle';
    const master = findMaster(s);
    const parts = [];
    parts.push(`<span class="dr-m"><span class="ui-dot ${dotClass(st)}"></span><b style="color:${statusColor(st)}">${esc((typeof L !== 'undefined' && L[st]) || st)}</b></span>`);
    parts.push(`<span class="dr-m"><i>${esc(t('metaDuration'))}</i><span class="ui-num dr-dur">${esc(rowTime(s, nowMs()))}</span></span>`);
    if (master) parts.push(`<span class="dr-m"><i>${esc(t('masterFrom'))}</i><button type="button" class="dt-link" data-dr-from="${esc(master.key)}" title="${esc(master.title || master.project || '')}">${esc(masterTitle(master))}</button></span>`);
    if (s.effort) parts.push(`<span class="dr-m"><i>${esc(t('metaEffort'))}</i><span>${esc(s.effort)}</span></span>`);
    el.meta.innerHTML = parts.join('');
  }

  function latestReply(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ((m.role === 'assistant' || m.role === 'final') && String(m.text || '').trim()) return m;
    }
    return null;
  }

  function renderResults() {
    const s = current();
    if (!s || !dtInst) return;
    const c = dtInst.convo();
    const live = LIVE.has(s.status);
    if (!c.loaded) {
      if (el.sum.dataset.sig !== 'loading') {
        el.sum.dataset.sig = 'loading';
        el.sum.innerHTML = `<div class="dr-note">${esc(t('loadingMsgs'))}</div>`;
      }
      el.artifacts.hidden = true;
      return;
    }
    if (c.private) {
      if (el.sum.dataset.sig !== 'private') {
        el.sum.dataset.sig = 'private';
        el.sum.innerHTML = `<div class="dr-note">${esc(t('privateNote'))}</div>`;
      }
      el.artifacts.hidden = true;
      return;
    }
    if (!c.messages.length) {
      if (el.sum.dataset.sig !== 'empty') {
        el.sum.dataset.sig = 'empty';
        el.sum.innerHTML = `<div class="dr-note">${esc(t('noMessages'))}</div>`;
      }
      el.artifacts.hidden = true;
      return;
    }
    const last = latestReply(c.messages);
    let html = '';
    if (live) {
      html = `<div class="dr-live"><span class="ui-dot ${dotClass(s.status)}"></span>${esc(t('drawerInProgress'))}</div>`;
      if (last) html += `<div class="dr-latest"><div class="dr-cap">${esc(t('drawerLatestReply'))}</div><div class="md dr-latest-md">${window.WbDetail?.md ? window.WbDetail.md(last.text) : esc(last.text)}</div></div>`;
    } else {
      html = window.WbDetail?.summaryCardHtml ? window.WbDetail.summaryCardHtml(c.messages, { lines: 8, expand: true }) : '';
      if (!html && last) html = `<div class="dr-latest"><div class="dr-cap">${esc(t('drawerLatestReply'))}</div><div class="md dr-latest-md">${window.WbDetail?.md ? window.WbDetail.md(last.text) : esc(last.text)}</div></div>`;
    }
    const sig = [c.messages.length, live, s.status, last ? String(last.text || '').length : 0, String(last ? last.text : '').slice(0, 40)].join('|');
    if (el.sum.dataset.sig !== sig) {
      el.sum.dataset.sig = sig;
      el.sum.innerHTML = html;
    }
    el.artifacts.hidden = false;
    asInst?.render(s, nowMs());
  }

  function renderDetail() {
    const s = current();
    if (!s) {
      back(false);
      return;
    }
    if (resKey !== s.key) {
      resKey = s.key;
      el.sum.dataset.sig = '';
    }
    const ti = titleOf(s);
    const badge = window.OFFICE_AGENT_BADGES?.[s.agent];
    if (badge) {
      el.agent.src = badge.logo;
      el.agent.className = `agent-logo dr-agent${badge.mono ? ' mono' : ''}`;
      el.agent.hidden = false;
    } else {
      el.agent.hidden = true;
    }
    el.tag.textContent = ti.tag;
    el.tag.hidden = !ti.tag;
    const title = ti.title || s.project || s.agent || '';
    if (el.dtitle.textContent !== title) {
      el.dtitle.textContent = title;
      el.dtitle.title = title;
    }
    renderMeta(s);
    if (!dtInst) {
      dtInst = window.WbDetail.create(el.transcript, {
        bare: true,
        compact: true,
        scrollEl: () => el.body,
        onConvo: () => renderResults(),
      });
    }
    if (!asInst) {
      asInst = window.WbAside.create(el.artifacts, {
        artifacts: true,
        convo: () => dtInst.convo(),
        jumpToBlock: (idx) => dtInst.jumpToBlock(idx),
      });
    }
    dtInst.render(s, nowMs());
    renderResults();
  }

  function setMode(next) {
    mode = next;
    el.list.hidden = next !== 'list';
    el.detail.hidden = next !== 'detail';
  }

  function openTask(key) {
    if (!key || !drawerVisible()) return;
    const s = (state?.data?.sessions || []).find((x) => x.key === key);
    if (!s) return;
    sel = key;
    if (!expanded) {
      expanded = true;
      store.set('drawer', true);
    }
    setMode('detail');
    root.classList.remove('is-collapsed');
    document.body.classList.add('drawer-open');
    document.body.classList.remove('drawer-collapsed');
    if (typeof office !== 'undefined' && office) office.selectedKey = key;
    window.dispatchEvent(new CustomEvent('drawer:select', { detail: { key } }));
    renderDetail();
    updateStrip();
  }

  function back(dispatch = true) {
    sel = null;
    resKey = null;
    setMode('list');
    if (typeof office !== 'undefined' && office) office.selectedKey = null;
    if (dispatch) window.dispatchEvent(new CustomEvent('drawer:select', { detail: { key: null } }));
    dtInst?.clear();
    asInst?.render(null);
    el.sum.dataset.sig = '';
    renderList();
    updateStrip();
  }

  function openInWorkbench() {
    if (!sel) return;
    const key = sel;
    if (typeof setView === 'function') setView('workbench');
    if (typeof state !== 'undefined') state.wbSel = key;
    if (window.Workbench?.select) window.Workbench.select(key);
    else window.dispatchEvent(new CustomEvent('wb:select', { detail: { key } }));
  }

  function setExpanded(next) {
    expanded = !!next;
    store.set('drawer', expanded);
    root.classList.toggle('is-collapsed', !expanded);
    updateVisibility();
  }

  function updateStrip() {
    const n = visibleList().filter((s) => UNFINISHED.has(s.status)).length;
    el.stripBadge.hidden = !n;
    el.stripBadge.textContent = n > 99 ? '99+' : String(n);
    const label = t('drawerExpand');
    el.strip.title = n ? `${label} · ${t('drawerUnfinished')} ${n}` : label;
    el.strip.setAttribute('aria-label', el.strip.title);
  }

  function updateVisibility() {
    const on = drawerVisible();
    root.hidden = !on;
    if (!on) {
      document.body.classList.remove('drawer-open', 'drawer-collapsed');
      return;
    }
    root.classList.toggle('is-collapsed', !expanded);
    document.body.classList.toggle('drawer-open', expanded);
    document.body.classList.toggle('drawer-collapsed', !expanded);
    if (mode === 'detail' && sel) renderDetail();
    else renderList();
    updateStrip();
  }

  function render() {
    if (!drawerVisible()) {
      updateVisibility();
      return;
    }
    if (mode === 'detail' && sel) {
      const s = current();
      if (!s) {
        back();
        return;
      }
      renderDetail();
    } else {
      renderList();
    }
    updateStrip();
  }

  function setView(next) {
    if (view === next) return;
    view = next;
    updateVisibility();
  }

  function tick() {
    if (!drawerVisible()) return;
    const now = nowMs();
    for (const [key, card] of rowCache) {
      const s = lastByKey.get(key);
      if (!s || !LIVE.has(s.status || '')) continue;
      const time = rowTime(s, now);
      if (card.timeText !== time) {
        card.timeText = time;
        card.time.textContent = time;
      }
    }
    if (mode === 'detail' && sel) {
      const s = current();
      const d = el.meta.querySelector('.dr-dur');
      if (s && d) d.textContent = rowTime(s, now);
    }
    updateStrip();
  }

  function applyStatic() {
    el.title.textContent = t('drawerTitle');
    el.collapse.title = t('drawerCollapse');
    el.collapse.setAttribute('aria-label', t('drawerCollapse'));
    el.back.title = t('drawerBack');
    el.back.setAttribute('aria-label', t('drawerBack'));
    el.openWb.textContent = t('drawerOpenWb');
    el.resH.textContent = t('drawerResults');
    el.procH.textContent = t('drawerProcess');
    updateStrip();
  }

  function onLang() {
    applyStatic();
    el.sum.dataset.sig = '';
    dtInst?.onLang();
    asInst?.onLang();
    render();
  }

  // ---------- events ----------

  el.rows.addEventListener('click', (e) => {
    const more = e.target.closest('[data-dr-more]');
    if (more) {
      recentAll = !recentAll;
      renderList();
      return;
    }
    const card = e.target.closest('.dr-card');
    if (card) openTask(card.dataset.key);
  });

  el.strip.addEventListener('click', () => setExpanded(true));
  el.collapse.addEventListener('click', () => setExpanded(false));

  el.detail.addEventListener('click', (e) => {
    if (e.target.closest('#drBack')) { back(); return; }
    if (e.target.closest('#drOpenWb')) { openInWorkbench(); return; }
    const from = e.target.closest('[data-dr-from]');
    if (from) { openTask(from.dataset.drFrom); return; }
    const more = e.target.closest('[data-sum-expand]');
    if (more) {
      const card = more.closest('.dr-sum');
      const text = card?.querySelector('.dr-sum-text');
      if (text) {
        const open = text.classList.toggle('is-open');
        more.textContent = open ? t('drawerShowLess') : t('drawerShowAll');
      }
    }
  });

  window.addEventListener('wb:filter', () => { if (drawerVisible() && mode === 'list') renderList(); });
  window.addEventListener('wb:query', () => { if (drawerVisible() && mode === 'list') renderList(); });
  window.addEventListener('drawer:select', () => { /* other views listen; keep the event public */ });
  document.addEventListener('keydown', (e) => {
    if (!drawerVisible() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Escape') return;
    const ae = document.activeElement;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || ae?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('details.menu[open]')) return;
    const help = document.getElementById('help');
    if (help && !help.hidden) return;
    const lb = document.getElementById('lightbox');
    if (lb && lb.classList.contains('on')) return;
    e.preventDefault();
    if (mode === 'detail') back();
    else if (expanded) setExpanded(false);
  });
  window.addEventListener('resize', () => { if (drawerVisible()) updateVisibility(); });
  setInterval(tick, 1000);

  applyStatic();
  root.classList.toggle('is-collapsed', !expanded);
  window.AgentDrawer = {
    openTask,
    back,
    setView,
    render,
    onLang,
    setExpanded,
    selected: () => sel,
    mode: () => mode,
    expanded: () => expanded,
    debug: () => ({ view, mode, sel, expanded, rows: rowCache.size, groups: groupCache.size }),
  };
})();
