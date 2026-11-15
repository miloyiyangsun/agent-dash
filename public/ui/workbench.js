// workbench.js — 工作台视图骨架（T2）。任务树 T3、详情 T4、右栏 T5 在这里继续。
// The main script owns state/data; this file only draws the three-column stage
// and reuses its transcript renderer (renderTranscript / loadConvo).
(() => {
  'use strict';

  const t = (k) => (typeof L !== 'undefined' && L[k] != null ? L[k] : (window.I18N?.en?.[k] ?? k));
  const esc = (s) => (typeof window.esc === 'function' ? window.esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const dotClass = (st) => (st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`);
  const activeStatus = (st) => ['thinking', 'tool', 'typing', 'waiting'].includes(st);

  let convo = { key: null, at: null, messages: null, private: false, busy: false };

  function sessionTitle(s) {
    const tag = typeof taskTag === 'function' ? taskTag(s) : '';
    const body = typeof taskBody === 'function' ? taskBody(s) : '';
    const first = body ? body.split(/[。！？.!?\n]/)[0].trim().slice(0, 90) : '';
    return [tag, first || s.title || s.project || s.agentName || s.agent].filter(Boolean).join(' · ');
  }

  function wbTime(s, now) {
    if (!s.startedAt) return typeof timeLabel === 'function' ? timeLabel(s, now) : '';
    const end = activeStatus(s.status) ? now : (s.lastEventAt || now);
    return typeof dur === 'function' ? dur(Math.max(0, end - s.startedAt)) : '';
  }

  function renderList(list, now) {
    const box = document.getElementById('wbList');
    if (!box) return;
    const html = list.map((s) => {
      const on = state.wbSel === s.key;
      return `<button type="button" class="wb-row${on ? ' on' : ''}" data-key="${esc(s.key)}" style="--s:${statusColor(s.status)}" title="${esc(s.prompt || '')}">
        <span class="ui-dot ${dotClass(s.status)}"></span>
        <span class="wb-row-title">${esc(sessionTitle(s))}</span>
        <span class="wb-row-time ui-num">${esc(wbTime(s, now))}</span>
      </button>`;
    }).join('');
    if (box.dataset.html !== html) {
      box.innerHTML = html;
      box.dataset.html = html;
    }
    const count = document.getElementById('wbCount');
    if (count) count.textContent = list.length;
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

  function render() {
    const wbEl = document.getElementById('wb');
    if (!wbEl || wbEl.hidden) return;
    const now = Date.now() - (state.skew || 0);
    const list = typeof visible === 'function' ? visible() : [];
    if (state.wbSel && !list.some((s) => s.key === state.wbSel)) {
      state.wbSel = null;
      convo = { key: null, at: null, messages: null, private: false, busy: false };
      window.dispatchEvent(new CustomEvent('wb:select', { detail: { key: null } }));
    }
    renderList(list, now);
    renderDetail(now);
  }

  function select(key) {
    state.wbSel = key;
    if (convo.key !== key) convo = { key, at: null, messages: null, private: false, busy: false };
    document.getElementById('wb')?.classList.remove('wb-left-open');
    window.dispatchEvent(new CustomEvent('wb:select', { detail: { key } }));
    render();
  }

  function setRight(open) {
    const wbEl = document.getElementById('wb');
    if (!wbEl) return;
    wbEl.classList.toggle('wb-right-open', open);
    wbEl.classList.toggle('wb-right-closed', !open);
  }

  function init() {
    const box = document.getElementById('wbList');
    box?.addEventListener('click', (e) => {
      const row = e.target.closest('.wb-row');
      if (row) select(row.dataset.key);
    });
    document.getElementById('wbRightHide')?.addEventListener('click', () => setRight(false));
    document.getElementById('wbRightShow')?.addEventListener('click', () => setRight(true));
    document.getElementById('wbLeftTab')?.addEventListener('click', () => document.getElementById('wb')?.classList.add('wb-left-open'));
    document.getElementById('wbLeftClose')?.addEventListener('click', () => document.getElementById('wb')?.classList.remove('wb-left-open'));
    const narrow = matchMedia('(max-width: 1200px)');
    const resetRight = () => setRight(!narrow.matches);
    resetRight();
    narrow.addEventListener('change', resetRight);
    window.addEventListener('wb:filter', render);
    window.addEventListener('wb:query', render);
    render();
  }

  window.Workbench = { init, render, select, onLang: render };
  init();
})();
