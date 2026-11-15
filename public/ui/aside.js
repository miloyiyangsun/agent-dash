// aside.js — workbench right column (T5): properties, changed files, images.
// Reads the same session objects as the left tree and the transcript messages
// the detail pane already loaded; it never fetches on its own.
(() => {
  'use strict';

  const esc = (s) => (typeof window.esc === 'function'
    ? window.esc(s)
    : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);
  const WRITE = new Set(['Write']);
  const EDIT = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
  const COPY_ICON = '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>';

  const S = {
    key: null,
    el: null,
    propSig: '',
    filesSig: '',
    imgSig: '',
    globalSig: '',
  };

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

  function startOf(s) {
    const a = Number(s.startedAt) || 0;
    const b = Number(s.turnStartedAt) || 0;
    if (a && b) return Math.min(a, b);
    return a || b;
  }

  function durText(s, now) {
    const start = startOf(s);
    if (!start) return '—';
    let end = LIVE.has(s.status) ? now : (Number(s.lastEventAt) || Number(s.turnStartedAt) || now);
    if (end < start) end = start;
    return fmtDur(end - start);
  }

  function stamp(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
    return h < 24 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
  }

  function fmtTokens(n) {
    if (typeof window.fmtTokens === 'function') {
      try { return window.fmtTokens(n); } catch { /* fall through */ }
    }
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(2)}M`;
  }

  function agentLabel(a) {
    return (typeof AGENT_NAME !== 'undefined' && AGENT_NAME[a]) || a;
  }

  function dotClass(st) {
    return st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`;
  }

  function statusColor(st) {
    if (typeof window.statusColor === 'function') {
      try { return window.statusColor(st); } catch { /* fall through */ }
    }
    return `var(--st-${st || 'interrupted'})`;
  }

  function titleOf(s) {
    return window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || '' };
  }

  function findMaster(s) {
    if (!s.parentId) return null;
    const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    return list.find((x) => x.key !== s.key && (x.id === s.parentId || (x.sessionId && x.sessionId === s.parentId))) || null;
  }

  function dirOf(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : '';
  }

  function baseOf(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function convoFor(s) {
    const c = window.WbDetail?.convo?.();
    if (!c || c.key !== s.key) return { messages: [], loaded: false };
    return c;
  }

  // ---------- skeleton ----------

  function ensure() {
    if (S.el && S.el.root.isConnected) return S.el;
    const box = document.getElementById('wbAside');
    if (!box) return null;
    box.innerHTML = `
      <div class="as">
        <section class="as-sec" data-global>
          <h3 class="as-title">今天</h3>
          <dl class="as-kv as-today"></dl>
        </section>
        <section class="as-sec" data-global>
          <h3 class="as-title">最近完成</h3>
          <div class="as-recent"></div>
        </section>
        <section class="as-sec" data-task hidden>
          <h3 class="as-title">属性</h3>
          <dl class="as-kv as-props"></dl>
        </section>
        <section class="as-sec" data-task data-files hidden>
          <h3 class="as-title">改过的文件 <span class="as-count ui-num"></span></h3>
          <div class="as-files"></div>
        </section>
        <section class="as-sec" data-task data-imgs hidden>
          <h3 class="as-title">图片 <span class="as-count ui-num"></span></h3>
          <div class="as-grid"></div>
        </section>
      </div>`;
    const root = box.querySelector('.as');
    S.el = {
      root,
      today: root.querySelector('.as-today'),
      recent: root.querySelector('.as-recent'),
      props: root.querySelector('.as-props'),
      files: root.querySelector('.as-files'),
      filesCount: root.querySelector('[data-files] .as-count'),
      imgSec: root.querySelector('[data-imgs]'),
      grid: root.querySelector('.as-grid'),
      imgCount: root.querySelector('[data-imgs] .as-count'),
    };
    return S.el;
  }

  function setMode(mode) {
    if (!S.el) return;
    if (S.el.root.dataset.mode === mode) return;
    S.el.root.dataset.mode = mode;
    for (const el of S.el.root.querySelectorAll('[data-global]')) el.hidden = mode !== 'global';
    for (const el of S.el.root.querySelectorAll('[data-task]')) el.hidden = mode !== 'task';
  }

  // ---------- properties ----------

  function lineHtml(value, label) {
    return `<span class="as-line"><span class="as-path" title="${esc(value)}">${esc(value)}</span><button type="button" class="as-copy" data-as-copy="${esc(value)}" title="复制${esc(label)}" aria-label="复制${esc(label)}">${COPY_ICON}</button></span>`;
  }

  function propRows(s) {
    const st = s.status || 'idle';
    const rows = [];
    rows.push(['状态', `<span class="as-status"><span class="ui-dot ${dotClass(st)}"></span><b class="${st === 'thinking' ? 'ui-shimmer' : ''}" style="color:${statusColor(st)}">${esc(L[st] || st)}</b></span>`]);
    if (s.agent) rows.push(['agent', `<span>${esc(agentLabel(s.agent))}</span>`]);
    const master = findMaster(s);
    if (master) {
      const mt = titleOf(master).title || master.project || master.agent || '';
      rows.push(['派自', `<button type="button" class="dt-link as-master" data-master-key="${esc(master.key)}" title="${esc(mt)}">${esc(mt)}</button>`]);
    }
    rows.push(['开始', `<span class="ui-num">${startOf(s) ? stamp(startOf(s)) : '—'}</span>`]);
    const live = LIVE.has(s.status);
    const end = live ? 0 : (Number(s.lastEventAt) || 0);
    rows.push(['结束', `<span class="ui-num">${end ? stamp(end) : '—'}</span>`]);
    rows.push(['用时', `<span class="ui-num as-dur">${durText(s, Date.now() - (state.skew || 0))}</span>`]);
    rows.push(['模型', s.model ? `<span class="as-mono">${esc(s.model)}</span>` : '<span class="as-dash">—</span>']);
    rows.push(['档位', s.effort ? `<span>${esc(s.effort)}</span>` : '<span class="as-dash">—</span>']);
    rows.push(['轮数', Number.isFinite(s.turns) && s.turns ? `<span class="ui-num">${s.turns}</span>` : '<span class="as-dash">—</span>']);
    if (s.thinkingTokens) rows.push(['思考 token', `<span class="ui-num">${fmtTokens(s.thinkingTokens)}</span>`]);
    if (s.cwd) rows.push(['工作目录', lineHtml(s.cwd, '工作目录')]);
    const resume = typeof window.resumeCmd === 'function' ? window.resumeCmd(s) : '';
    if (resume) rows.push(['续接命令', lineHtml(resume, '续接命令')]);
    if (s.agent === 'deepseek' && s.run) rows.push(['run 文件', `<span class="as-mono">${esc(s.run)}.jsonl</span>`]);
    return rows;
  }

  function renderProps(s, now) {
    if (!S.el) return;
    const rows = propRows(s);
    const sig = rows.map((r) => r[0] + '\u0000' + (r[0] === '用时' ? '' : r[1])).join('\u0001');
    if (S.propSig !== sig) {
      S.propSig = sig;
      S.el.props.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
    }
    const d = S.el.props.querySelector('.as-dur');
    if (d) d.textContent = durText(s, now);
  }

  // ---------- changed files ----------

  function filesOf(messages) {
    const map = new Map();
    messages.forEach((m, idx) => {
      if (!m || m.role !== 'tool') return;
      const name = m.name || (/^([A-Za-z][\w.-]*)/.exec(String(m.text || '')) || [])[1] || '';
      const isWrite = WRITE.has(name);
      const isEdit = EDIT.has(name);
      if (!isWrite && !isEdit) return;
      let p = m.path;
      if (!p) {
        const raw = String(m.text || '').trim();
        if (raw.startsWith(name + ' ')) p = raw.slice(name.length + 1).trim();
      }
      if (!p) return;
      p = p.replace(/^["']|["']$/g, '').trim();
      if (!p) return;
      const key = p.toLowerCase();
      const hit = map.get(key);
      if (hit) {
        hit.count += 1;
        hit.idx = idx;
        hit.action = isWrite ? '写' : '改';
        hit.path = p;
      } else {
        map.set(key, { path: p, action: isWrite ? '写' : '改', count: 1, idx });
      }
    });
    return [...map.values()].sort((a, b) => b.idx - a.idx);
  }

  function fileRow(f) {
    const dir = dirOf(f.path);
    return `<button type="button" class="as-file" data-file-idx="${f.idx}" title="${esc(f.path)}">
      <span class="as-file-main">
        <span class="as-file-name">${esc(baseOf(f.path))}</span>
        ${dir ? `<span class="as-file-dir">${esc(dir)}</span>` : ''}
      </span>
      <span class="as-pill ${f.action === '写' ? 'is-write' : 'is-edit'}">${f.action}</span>
      <span class="as-file-count ui-num">${f.count}</span>
    </button>`;
  }

  function renderFiles(s) {
    if (!S.el) return;
    const c = convoFor(s);
    const files = c.loaded ? filesOf(c.messages) : [];
    const sig = c.loaded ? files.map((f) => `${f.path}|${f.action}|${f.count}|${f.idx}`).join('\n') : 'loading';
    if (S.filesSig !== sig) {
      S.filesSig = sig;
      S.el.filesCount.textContent = c.loaded ? String(files.length) : '';
      S.el.files.innerHTML = !c.loaded
        ? '<div class="as-note">读取中…</div>'
        : files.length
          ? files.map(fileRow).join('')
          : '<div class="as-note">没有改动文件</div>';
    }
  }

  // ---------- images ----------

  function imagesOf(messages, key) {
    const out = [];
    for (const m of messages) {
      if (!Array.isArray(m.images) || !m.images.length) continue;
      m.images.forEach((im, i) => {
        out.push({
          url: `/api/ds/image?key=${encodeURIComponent(key)}&s=${im.start}&l=${im.len}`,
          cap: `${m.name || '工具'} · 图 ${i + 1}`,
        });
      });
    }
    return out;
  }

  function renderImages(s) {
    if (!S.el) return;
    const c = convoFor(s);
    const images = c.loaded ? imagesOf(c.messages, s.key) : [];
    const sig = images.map((x) => x.url).join('\n');
    if (S.imgSig !== sig) {
      S.imgSig = sig;
      S.el.imgCount.textContent = String(images.length);
      S.el.grid.innerHTML = images.map((x) => `<button type="button" class="as-shot" data-shot="${esc(x.url)}" data-cap="${esc(x.cap)}" title="点开看大图"><img loading="lazy" src="${esc(x.url)}" alt=""></button>`).join('');
    }
    S.el.imgSec.hidden = !images.length;
  }

  // ---------- global ----------

  function renderGlobal(now) {
    if (!S.el) return;
    const sessions = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const today = sessions.filter((s) => s.today);
    const done = today.filter((s) => s.status === 'done').length;
    const errors = today.filter((s) => s.status === 'error').length;
    let total = 0;
    let n = 0;
    for (const s of today) {
      const start = startOf(s);
      if (!start) continue;
      const end = LIVE.has(s.status) ? now : (Number(s.lastEventAt) || start);
      if (end > start) { total += end - start; n++; }
    }
    const rows = [
      ['任务数', `<span class="ui-num">${today.length}</span>`],
      ['完成数', `<span class="ui-num">${done}</span>`],
      ['出错数', `<span class="ui-num">${errors}</span>`],
      ['平均用时', `<span class="ui-num">${n ? fmtDur(total / n) : '—'}</span>`],
    ];
    const recent = sessions
      .filter((s) => s.status === 'done')
      .sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0))
      .slice(0, 5);
    const sig = rows.map((r) => r.join('\u0000')).join('\u0001') + '\u0002' + recent.map((s) => s.key).join(',') + '\u0003' + Math.floor(now / 60000);
    if (S.globalSig !== sig) {
      S.globalSig = sig;
      S.el.today.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
      S.el.recent.innerHTML = recent.length ? recent.map((s) => {
        const ti = titleOf(s);
        const sub = `${agentLabel(s.agent)}${s.lastEventAt ? ' · ' + relTime(s.lastEventAt, now) : ''}`;
        return `<button type="button" class="as-file as-recent" data-recent-key="${esc(s.key)}" title="${esc(ti.title || '')}">
          <span class="ui-dot st-done"></span>
          <span class="as-file-main">
            <span class="as-file-name">${esc(ti.title || s.project || s.agent || '')}</span>
            <span class="as-file-dir">${esc(sub)}</span>
          </span>
        </button>`;
      }).join('') : '<div class="as-note">今天还没有完成的任务</div>';
    }
  }

  // ---------- copy toast ----------

  let toastEl = null;
  let toastTimer = 0;

  async function copyText(text) {
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'dt-toast';
      document.body.appendChild(toastEl);
    }
    const box = document.getElementById('wbAside');
    const r = box?.getBoundingClientRect();
    if (r) {
      toastEl.style.left = `${r.left + r.width / 2}px`;
      toastEl.style.top = `${r.bottom - 40}px`;
    }
    toastEl.textContent = ok ? '已复制' : '复制失败';
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1500);
  }

  // ---------- entry points ----------

  function render(s, now) {
    const el = ensure();
    if (!el) return;
    now = Number(now) || Date.now() - (state.skew || 0);
    if (!s) {
      S.key = null;
      S.propSig = S.filesSig = S.imgSig = '';
      setMode('global');
      renderGlobal(now);
      return;
    }
    S.key = s.key;
    setMode('task');
    renderProps(s, now);
    renderFiles(s);
    renderImages(s);
  }

  function tick() {
    if (!S.el || !S.key) return;
    const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const s = list.find((x) => x.key === S.key);
    if (!s) return;
    const now = Date.now() - (state.skew || 0);
    const d = S.el.props.querySelector('.as-dur');
    if (d) d.textContent = durText(s, now);
  }

  function init() {
    const box = document.getElementById('wbAside');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-as-copy]');
      if (copy) { copyText(copy.dataset.asCopy); return; }
      const master = e.target.closest('[data-master-key]');
      if (master) { window.Workbench?.select?.(master.dataset.masterKey); return; }
      const file = e.target.closest('[data-file-idx]');
      if (file) { window.WbDetail?.jumpToBlock?.(Number(file.dataset.fileIdx)); return; }
      const recent = e.target.closest('[data-recent-key]');
      if (recent) { window.Workbench?.select?.(recent.dataset.recentKey); }
    });
    window.addEventListener('wb:select', (e) => {
      const key = e.detail?.key;
      const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
      render(key ? list.find((x) => x.key === key) || null : null);
    });
    window.addEventListener('wb:convo', (e) => {
      if (!S.key || (e.detail && e.detail.key !== S.key)) return;
      const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
      const s = list.find((x) => x.key === S.key);
      if (s) render(s);
    });
    setInterval(tick, 1000);
    render(null);
  }

  window.WbAside = { render, debug: () => ({ key: S.key, propSig: S.propSig, filesSig: S.filesSig, imgSig: S.imgSig }) };
  init();
})();
