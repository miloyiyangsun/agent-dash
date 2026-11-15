// detail.js — workbench middle column: task detail (T4a).
// Owns the sticky header, event strip, tabs, transcript blocks, final-answer
// summary, a master's child table, and incremental refresh with scroll-follow.
// Everything here reads the same session objects the left tree already has.
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
  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);

  const EV = {
    prompt: '--ev-prompt',
    think: '--ev-think',
    tool: '--ev-tool',
    say: '--ev-say',
    final: '--ev-final',
    error: '--ev-error',
  };

  const COPY_ICON = '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>';
  const FOLDER_ICON = '<svg class="ui-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2.5h8A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/></svg>';

  const S = {
    key: null,
    session: null,
    messages: [],
    at: null,
    loaded: false,
    busy: false,
    private: false,
    tab: 'all',
    blocks: [],
    dots: [],
    finalIdx: -1,
    nearBottom: true,
    newCount: 0,
    firstLoad: true,
    raf: 0,
    el: null,
  };

  let tipEl = null;
  let pillEl = null;
  let toastEl = null;
  let toastTimer = 0;

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
    const live = LIVE.has(s.status);
    let end = live ? now : (Number(s.lastEventAt) || Number(s.turnStartedAt) || now);
    if (end < start) end = start;
    return fmtDur(end - start);
  }

  function clip(text, n) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
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

  function hhmm(ms) {
    if (typeof window.hhmm === 'function') {
      try { return window.hhmm(ms); } catch { /* fall through */ }
    }
    if (!ms) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function hhmmss(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function shotUrl(key, im) {
    return `/api/ds/image?key=${encodeURIComponent(key)}&s=${im.start}&l=${im.len}`;
  }

  function relAgo(ts, now) {
    if (!ts) return '';
    if (typeof ago === 'function') {
      try { return ago(ts, now); } catch { /* fall through */ }
    }
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return t('justNow');
    const m = Math.round(s / 60);
    if (m < 60) return t('minutesAgo')(m);
    const h = Math.round(m / 60);
    return h < 24 ? t('hoursAgo')(h) : t('daysAgo')(Math.round(h / 24));
  }

  // ---------- light markdown ----------
  // Safety rule: escape the whole text first, then run a tiny grammar over the
  // escaped string. Only our own tags ever reach innerHTML; raw HTML and images
  // are never rendered. Thinking blocks and tool arguments stay plain text.

  function mdInline(src) {
    const codes = [];
    let s = String(src).replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(`<code class="md-code-i">${code}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    // Images degrade to their alt text; links keep their label, never an <a>.
    s = s.replace(/!\[([^\]]*)\]\([^)\s]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] || '');
  }

  // GFM table: a header row, a |---| separator, then data rows. Cells run
  // through the same inline renderer as everything else.
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  function tableCells(line) {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }
  function tableAlign(cell) {
    const c = String(cell).trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  function renderTable(head, aligns, rows) {
    const cell = (tag, text, k) =>
      `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(text || '')}</${tag}>`;
    const body = rows.length
      ? `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody>`
      : '';
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>${body}</table></div>`;
  }

  function renderMd(src) {
    const text = esc(String(src || '').replace(/\r\n?/g, '\n'));
    const lines = text.split('\n');
    const out = [];
    let para = [];
    let i = 0;
    const flush = () => {
      if (!para.length) return;
      out.push(`<p>${para.map((l) => mdInline(l)).join('<br>')}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flush();
        i++;
        const buf = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push(`<pre class="md-pre"><code>${buf.join('\n')}</code></pre>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        const head = tableCells(line);
        const aligns = tableCells(lines[i + 1]).map(tableAlign);
        let j = i + 2;
        const rows = [];
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
          rows.push(tableCells(lines[j]));
          j++;
        }
        out.push(renderTable(head, aligns, rows));
        i = j;
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        const n = h[1].length;
        out.push(`<h${n} class="md-h">${mdInline(h[2])}</h${n}>`);
        i++;
        continue;
      }
      if (/^\s*&gt;\s?/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        out.push(`<blockquote class="md-quote">${buf.map((l) => mdInline(l)).join('<br>')}</blockquote>`);
        continue;
      }
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flush();
        const ordered = !!ol;
        const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length) {
          const m = re.exec(lines[i]);
          if (!m) break;
          items.push(`<li>${mdInline(m[1])}</li>`);
          i++;
        }
        out.push(ordered ? `<ol class="md-list">${items.join('')}</ol>` : `<ul class="md-list">${items.join('')}</ul>`);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out.join('');
  }

  // ---------- message classification ----------

  function kindOf(m) {
    if (m.role === 'user') return 'prompt';
    if (m.role === 'thinking') return 'think';
    if (m.role === 'tool') return 'tool';
    if (m.role === 'final') return 'final';
    return 'say';
  }

  function evOf(m) {
    if (m.role === 'final' && m.isError) return 'error';
    return kindOf(m);
  }

  function typeLabel(m, isChild) {
    if (m.role === 'user') return isChild ? t('typeDelegate') : t('typePrompt');
    if (m.role === 'thinking') return t('typeThink');
    if (m.role === 'tool') return t('typeTool');
    if (m.role === 'final') return m.isError ? t('finalError') : t('finalAnswer');
    return t('typeReply');
  }

  // Claude transcripts only carry a one-line description ("Bash: …"), so the
  // tool name is the leading word; deepseek messages already have m.name.
  function toolNameOf(m) {
    if (m.name) return m.name;
    const mm = /^([A-Za-z][\w.-]*)(?::\s|\s|$)/.exec(String(m.text || ''));
    return mm ? mm[1] : '';
  }

  function sigOf(m) {
    const text = typeof m.text === 'string' ? m.text : '';
    const res = m.result && typeof m.result.text === 'string' ? m.result.text : '';
    const imgs = Array.isArray(m.images) ? m.images.map((x) => `${x.start}:${x.len}`).join(',') : '';
    return [m.role, m.kind || '', m.at || 0, m.name || '', text.length, text.slice(0, 48), res.length, res.slice(0, 24), imgs].join('|');
  }

  // ---------- skeleton ----------

  function skeleton(box) {
    box.innerHTML = `
      <div class="dt" data-tab="all">
        <div class="dt-sticky">
          <header class="dt-head">
            <div class="dt-head-text">
              <div class="dt-title-row"><span class="ui-chip dt-tag" hidden></span><span class="dt-orig" hidden>${esc(t('noOriginal'))}</span><h1 class="dt-title"></h1></div>
              <div class="dt-meta"></div>
            </div>
            <div class="dt-head-actions"></div>
          </header>
          <div class="dt-strip"><div class="dt-strip-inner"></div></div>
          <div class="dt-tabs-row">
            <div class="ui-seg dt-tabs" role="group">
              <button type="button" data-tab="all" aria-pressed="true">${esc(t('tabAll'))} <b class="ui-num"></b></button>
              <button type="button" data-tab="tools" aria-pressed="false">${esc(t('tabTools'))} <b class="ui-num"></b></button>
              <button type="button" data-tab="replies" aria-pressed="false">${esc(t('tabReplies'))} <b class="ui-num"></b></button>
              <button type="button" data-tab="images" aria-pressed="false">${esc(t('tabImages'))} <b class="ui-num"></b></button>
            </div>
            <span class="dt-live-note"></span>
          </div>
        </div>
        <div class="dt-content">
          <div class="dt-sum" hidden></div>
          <div class="dt-children" hidden></div>
          <div class="dt-skel" aria-hidden="true"><i style="width:92%"></i><i style="width:74%"></i><i style="width:86%"></i><i style="width:58%"></i></div>
          <div class="dt-blocks"></div>
          <div class="dt-imgrid" hidden></div>
          <div class="dt-note" hidden></div>
        </div>
      </div>`;
    const root = box.querySelector('.dt');
    S.el = {
      root,
      tag: root.querySelector('.dt-tag'),
      orig: root.querySelector('.dt-orig'),
      title: root.querySelector('.dt-title'),
      meta: root.querySelector('.dt-meta'),
      actions: root.querySelector('.dt-head-actions'),
      strip: root.querySelector('.dt-strip-inner'),
      tabs: root.querySelector('.dt-tabs'),
      liveNote: root.querySelector('.dt-live-note'),
      sum: root.querySelector('.dt-sum'),
      children: root.querySelector('.dt-children'),
      blocks: root.querySelector('.dt-blocks'),
      imgrid: root.querySelector('.dt-imgrid'),
      note: root.querySelector('.dt-note'),
      skel: root.querySelector('.dt-skel'),
    };
    S.tab = 'all';
  }

  // ---------- header ----------

  function findMaster(s) {
    if (!s.parentId) return null;
    const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    return list.find((x) => x.key !== s.key && (x.id === s.parentId || (x.sessionId && x.sessionId === s.parentId))) || null;
  }

  function masterTitle(master) {
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(master) : { tag: '', title: master.title || '' };
    const text = [ti.tag, ti.title].filter(Boolean).join(' · ') || master.project || master.agent || '';
    return clip(text, 30);
  }

  function metaHtml(s, master) {
    const st = s.status || 'idle';
    const items = [];
    items.push(`<span class="dt-m dt-m-fix"><span class="ui-dot ${dotClass(st)}"></span><b class="${st === 'thinking' ? 'ui-shimmer' : ''}" style="color:${statusColor(st)}">${esc(L[st] || st)}</b></span>`);
    if (s.agent) items.push(`<span class="dt-m dt-m-fix"><i>agent</i><span>${esc(agentLabel(s.agent))}</span></span>`);
    if (master) items.push(`<span class="dt-m dt-m-flex"><i>${esc(t('masterFrom'))}</i><button type="button" class="dt-link" data-master-key="${esc(master.key)}" title="${esc(master.title || master.project || '')}">${esc(masterTitle(master))}</button></span>`);
    if (startOf(s)) {
      items.push(`<span class="dt-m dt-m-fix"><i>${esc(t('metaStart'))}</i><span class="ui-num">${hhmm(startOf(s))}</span></span>`);
      items.push(`<span class="dt-m dt-m-fix"><i>${esc(t('metaDuration'))}</i><span class="ui-num dt-dur"></span></span>`);
    }
    if (s.effort) items.push(`<span class="dt-m dt-m-fix"><i>${esc(t('metaEffort'))}</i><span>${esc(s.effort)}</span></span>`);
    // The run summary only counts images seen in its 1 MB tail; the transcript
    // window is what the image tab can actually show, so prefer that once loaded.
    const transcriptImages = S.messages.reduce((n, m) => n + (Array.isArray(m.images) ? m.images.length : 0), 0);
    const images = S.loaded ? transcriptImages : (Number(s.images) || 0);
    if (images) items.push(`<span class="dt-m dt-m-fix"><i>${esc(t('metaImages'))}</i><span class="ui-num">${images}</span></span>`);
    return items.join('');
  }

  function hasFinal() {
    return S.messages.some((m) => m.role === 'final');
  }

  function renderHead(s, now) {
    if (!S.el) return;
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || '' };
    const tag = ti.tag || '';
    S.el.tag.hidden = !tag;
    if (S.el.tag.textContent !== tag) S.el.tag.textContent = tag;
    if (S.el.orig) S.el.orig.hidden = !ti.fromReply;
    const title = ti.title || s.project || s.agent || '';
    if (S.el.title.textContent !== title) S.el.title.textContent = title;

    const master = findMaster(s);
    const html = metaHtml(s, master);
    if (S.el.meta.dataset.sig !== html) {
      S.el.meta.innerHTML = html;
      S.el.meta.dataset.sig = html;
    }
    const d = S.el.meta.querySelector('.dt-dur');
    if (d) d.textContent = durText(s, now);

    const resume = typeof window.resumeCmd === 'function' ? window.resumeCmd(s) : '';
    const acts = [];
    if (hasFinal()) acts.push(`<button type="button" class="ui-btn dt-jump" data-jump-final>${esc(t('jumpFinal'))}</button>`);
    if (resume) acts.push(`<button type="button" class="ui-btn dt-icon-btn" data-copy-resume="${esc(resume)}" title="${esc(t('copyResume'))}" aria-label="${esc(t('copyResume'))}">${COPY_ICON}</button>`);
    if (s.cwd) acts.push(`<button type="button" class="ui-btn dt-icon-btn" data-copy-cwd="${esc(s.cwd)}" title="${esc(t('copyCwd'))}" aria-label="${esc(t('copyCwd'))}">${FOLDER_ICON}</button>`);
    const asig = acts.join('');
    if (S.el.actions.dataset.sig !== asig) {
      S.el.actions.innerHTML = asig;
      S.el.actions.dataset.sig = asig;
    }
  }

  // ---------- a master's children ----------

  function childDur(k, now) {
    const start = startOf(k);
    if (!start) return '—';
    const live = LIVE.has(k.status);
    let end = live ? now : (Number(k.lastEventAt) || now);
    if (end < start) end = start;
    return fmtDur(end - start);
  }

  function renderChildren(s) {
    if (!S.el) return;
    const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const kids = list
      .filter((x) => x.key !== s.key && x.parentId && (x.parentId === s.id || (s.sessionId && x.parentId === s.sessionId)))
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
    const sig = kids.map((k) => `${k.key}|${k.status}|${k.title}|${k.lastEventAt || 0}`).join(';');
    if (S.el.children.dataset.sig !== sig) {
      S.el.children.dataset.sig = sig;
      S.el.children.hidden = !kids.length;
      if (kids.length) {
        S.el.children.innerHTML = `<div class="dt-children-head">${esc(t('childrenHead'))} · <span class="ui-num">${kids.length}</span></div>` + kids.map((k) => {
          const kt = window.Workbench?.titleOf ? window.Workbench.titleOf(k) : { tag: '', title: k.title || '' };
          return `<button type="button" class="dt-child" data-child-key="${esc(k.key)}">
            <span class="ui-dot ${dotClass(k.status)}"></span>
            ${kt.tag ? `<span class="ui-chip dt-child-tag">${esc(kt.tag)}</span>` : ''}
            <span class="dt-child-title">${esc(kt.title || k.project || k.agent || '')}</span>
            <span class="dt-child-dur ui-num"></span>
          </button>`;
        }).join('');
      } else {
        S.el.children.innerHTML = '';
      }
    }
    const now = Date.now() - (state.skew || 0);
    for (const el of S.el.children.querySelectorAll('.dt-child[data-child-key]')) {
      const k = list.find((x) => x.key === el.dataset.childKey);
      const d = el.querySelector('.dt-child-dur');
      if (k && d) d.textContent = childDur(k, now);
    }
  }

  // ---------- transcript blocks ----------

  function foldHtml(text, lines, cls, md) {
    const src = String(text || '');
    const long = src.length > lines * 96 || src.split('\n').length > lines;
    const content = md ? renderMd(src) : esc(src);
    const inner = md
      ? `<div class="${cls} md${long ? ' md-clamp' : ''}" style="--clamp-lines:${lines}">${content}</div>`
      : `<div class="${cls} dt-clamp c${lines}">${content}</div>`;
    return long ? `<details class="dt-fold"><summary>${inner}</summary></details>` : inner;
  }

  function shotGrid(images, name, key, cls) {
    if (!Array.isArray(images) || !images.length) return '';
    return `<div class="dt-shots${cls ? ' ' + cls : ''}">${images.map((im, i) => {
      const url = shotUrl(key, im);
      const cap = t('imgCap')(name, i + 1);
      return `<button type="button" class="dt-shot" data-shot="${esc(url)}" data-cap="${esc(cap)}" title="${esc(t('openImage'))}"><img loading="lazy" src="${esc(url)}" alt=""></button>`;
    }).join('')}</div>`;
  }

  function buildBlock(m, idx, s) {
    const isChild = !!s && s.agent === 'deepseek';
    const kind = kindOf(m);
    const ev = evOf(m);
    const el = document.createElement('section');
    el.className = 'dt-blk';
    el.dataset.kind = kind;
    el.dataset.ev = ev;
    el.dataset.idx = String(idx);
    el.style.setProperty('--ev', `var(${EV[ev] || '--ev-tool'})`);

    const head = document.createElement('div');
    head.className = 'dt-blk-head';
    head.innerHTML = '<span class="dt-blk-type"></span><span class="dt-blk-name" hidden></span><span class="dt-blk-time ui-num"></span>';
    head.querySelector('.dt-blk-type').textContent = typeLabel(m, isChild);
    const nameEl = head.querySelector('.dt-blk-name');
    if (m.role === 'tool') {
      const name = toolNameOf(m);
      nameEl.hidden = !name;
      nameEl.textContent = name;
    }
    head.querySelector('.dt-blk-time').textContent = m.at ? hhmmss(m.at) : '';
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dt-blk-body';
    const text = String(m.text || '');
    if (kind === 'prompt') {
      body.innerHTML = `<div class="dt-prompt">${foldHtml(text, 6, 'dt-body-text', true)}</div>`;
    } else if (kind === 'think') {
      body.innerHTML = foldHtml(text, 3, 'dt-think-text');
    } else if (kind === 'tool') {
      let html = '';
      if (text) {
        const argLines = text.split('\n').length;
        const pre = `<pre class="dt-args">${esc(text)}</pre>`;
        html += argLines > 8 || text.length > 8 * 96
          ? `<details class="dt-argfold"><summary>${esc(t('argFold')(argLines))}</summary>${pre}</details>`
          : pre;
      }
      const resultText = m.result && typeof m.result.text === 'string' ? m.result.text : '';
      const images = Array.isArray(m.images) ? m.images : [];
      if (resultText || images.length) {
        const resLines = resultText ? resultText.split('\n').length : 0;
        const title = resultText ? t('resultFold')(resLines) : t('resultImages')(images.length);
        html += `<details class="dt-result"><summary>${esc(title)}</summary>${resultText ? `<pre class="dt-result-pre">${esc(resultText)}</pre>` : ''}${shotGrid(images, m.name, s.key)}</details>`;
      }
      if (!html) html = `<div class="dt-note-inline">${esc(t('noArgResult'))}</div>`;
      body.innerHTML = html;
    } else if (kind === 'final') {
      body.innerHTML = `<div class="dt-final${m.isError ? ' is-error' : ''}"><div class="dt-final-text md">${renderMd(text)}</div></div>`;
    } else {
      body.innerHTML = `<div class="dt-say md">${renderMd(text)}</div>`;
    }
    el.appendChild(body);
    return el;
  }

  function rebuildBlocks(list) {
    if (!S.el) return;
    S.el.blocks.textContent = '';
    S.blocks = list.map((m, i) => {
      const el = buildBlock(m, i, S.session);
      S.el.blocks.appendChild(el);
      return el;
    });
  }

  // ---------- summary card ----------

  function renderSummary() {
    if (!S.el) return;
    const fi = S.messages.findIndex((m) => m.role === 'final');
    S.finalIdx = fi;
    const s = S.session;
    const live = s && LIVE.has(s.status);
    const show = fi >= 0 && !live;
    S.el.sum.hidden = !show;
    if (!show) return;
    const m = S.messages[fi];
    const all = String(m.text || '').replace(/\r\n?/g, '\n').split('\n');
    let from = 0;
    while (from < all.length && !all[from].trim()) from++;
    const preview = all.slice(from, from + 6).join('\n');
    const clipped = all.slice(from + 6).some((line) => line.trim());
    const sig = `${preview.length}|${preview.slice(0, 64)}|${clipped}|${!!m.isError}`;
    if (S.el.sum.dataset.sig === sig) return;
    S.el.sum.dataset.sig = sig;
    S.el.sum.classList.toggle('is-error', !!m.isError);
    S.el.sum.innerHTML = `<div class="dt-sum-head"><span>${m.isError ? t('finalError') : t('finalAnswer')}</span><button type="button" class="dt-link" data-jump-final>${t('jumpFull')}</button></div><div class="dt-sum-text md${clipped ? ' is-clipped' : ''}">${renderMd(preview)}</div>`;
  }

  // ---------- tabs, counts, images ----------

  function updateCounts() {
    if (!S.el) return;
    const tools = S.messages.filter((m) => m.role === 'tool').length;
    const replies = S.messages.filter((m) => m.role === 'assistant' || m.role === 'final').length;
    const images = S.messages.reduce((n, m) => n + (Array.isArray(m.images) ? m.images.length : 0), 0);
    const vals = { all: S.messages.length, tools, replies, images };
    for (const b of S.el.tabs.querySelectorAll('[data-tab]')) {
      const n = b.querySelector('.ui-num');
      if (n) n.textContent = String(vals[b.dataset.tab] ?? 0);
    }
  }

  function rebuildImageGrid() {
    if (!S.el) return;
    const key = S.session ? S.session.key : '';
    const items = [];
    for (const m of S.messages) {
      if (!Array.isArray(m.images) || !m.images.length) continue;
      for (let i = 0; i < m.images.length; i++) {
        const url = shotUrl(key, m.images[i]);
        const cap = t('imgCap')(m.name, i + 1);
        items.push(`<button type="button" class="dt-shot" data-shot="${esc(url)}" data-cap="${esc(cap)}" title="${esc(t('openImage'))}"><img loading="lazy" src="${esc(url)}" alt=""></button>`);
      }
    }
    S.el.imgrid.hidden = S.tab !== 'images';
    const html = items.join('');
    if (S.el.imgrid.dataset.sig !== html) {
      S.el.imgrid.dataset.sig = html;
      S.el.imgrid.innerHTML = items.length ? html : `<div class="dt-note-inline">${esc(t('noImages'))}</div>`;
    }
  }

  function setTab(tab) {
    if (!S.el) return;
    S.tab = tab;
    S.el.root.dataset.tab = tab;
    for (const b of S.el.tabs.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (tab === 'images') rebuildImageGrid();
    updateVisibleDots();
  }

  // ---------- event strip ----------

  function buildStrip() {
    if (!S.el) return;
    const inner = S.el.strip;
    const n = S.messages.length;
    const width = inner.clientWidth || 800;
    let gap = n > 110 ? 0 : n > 80 ? 1 : n > 50 ? 2 : 4;
    let size = 6;
    // Gap bottoms out at 0; a very dense run shrinks the dots as well so every
    // message keeps a visible mark instead of losing the tail off the edge.
    if (n && n * size + (n - 1) * gap > width) {
      gap = 0;
      size = Math.max(2, Math.min(6, Math.floor(width / n)));
    }
    inner.style.gap = `${gap}px`;
    inner.style.setProperty('--dot-size', `${size}px`);
    const frag = document.createDocumentFragment();
    S.dots = [];
    S.messages.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dt-ev';
      b.dataset.idx = String(i);
      b.style.setProperty('--ev', `var(${EV[evOf(m)] || '--ev-tool'})`);
      b.setAttribute('aria-label', `${typeLabel(m, S.session && S.session.agent === 'deepseek')}${m.at ? ' ' + hhmm(m.at) : ''}`);
      frag.appendChild(b);
      S.dots.push(b);
    });
    inner.replaceChildren(frag);
    updateVisibleDots();
  }

  // ---------- message sync ----------

  function afterSync(wasNear, added, appended) {
    updateCounts();
    buildStrip();
    renderSummary();
    rebuildImageGrid();
    renderHead(S.session, Date.now() - (state.skew || 0));
    updateLiveNote();

    const mid = document.getElementById('wbMid');
    if (!mid) return;
    if (S.firstLoad) {
      S.firstLoad = false;
      const live = S.session && LIVE.has(S.session.status);
      requestAnimationFrame(() => {
        if (!S.el) return;
        mid.scrollTop = live ? mid.scrollHeight : 0;
        S.nearBottom = nearBottom();
        updateVisibleDots();
        updateLiveNote();
      });
      return;
    }
    if (appended && added > 0) {
      const live = S.session && LIVE.has(S.session.status);
      if (live && wasNear) {
        requestAnimationFrame(() => {
          if (!S.el) return;
          mid.scrollTop = mid.scrollHeight;
          S.nearBottom = true;
          updateVisibleDots();
          updateLiveNote();
        });
      } else if (!wasNear) {
        S.newCount += added;
        showPill();
      }
    }
  }

  function syncMessages(list) {
    const old = S.messages;
    const oldSigs = old.map(sigOf);
    const newSigs = list.map(sigOf);
    const same = oldSigs.length === newSigs.length && oldSigs.every((x, i) => x === newSigs[i]);
    if (same) {
      S.messages = list;
      updateCounts();
      renderSummary();
      rebuildImageGrid();
      return;
    }
    if (!S.el) {
      S.messages = list;
      return;
    }
    const wasNear = nearBottom();
    let k = -1;
    if (oldSigs.length && newSigs.length) {
      for (let i = 0; i < oldSigs.length; i++) {
        if (oldSigs[i] === newSigs[0]) { k = i; break; }
      }
    }
    let kept = false;
    if (k >= 0) {
      const keep = oldSigs.length - k;
      if (newSigs.length >= keep) {
        kept = true;
        for (let i = 0; i < keep; i++) {
          if (oldSigs[k + i] !== newSigs[i]) { kept = false; break; }
        }
      }
    }

    if (kept && k > 0) {
      // The log window slid: drop the blocks that fell off the front, then
      // append. Compensate scroll when the reader is not at the bottom.
      const mid = document.getElementById('wbMid');
      const before = mid ? mid.scrollHeight : 0;
      for (let i = 0; i < k; i++) {
        const el = S.blocks[i];
        if (el) el.remove();
      }
      S.blocks.splice(0, k);
      for (let i = 0; i < S.blocks.length; i++) S.blocks[i].dataset.idx = String(i);
      if (mid && !wasNear) {
        const after = mid.scrollHeight;
        mid.scrollTop = Math.max(0, mid.scrollTop - (before - after));
      }
      const appendFrom = oldSigs.length - k;
      for (let i = appendFrom; i < list.length; i++) {
        const el = buildBlock(list[i], i, S.session);
        S.el.blocks.appendChild(el);
        S.blocks.push(el);
      }
      const added = list.length - appendFrom;
      S.messages = list;
      afterSync(wasNear, added, true);
      return;
    }

    if (kept && k === 0 && newSigs.length >= oldSigs.length) {
      for (let i = oldSigs.length; i < list.length; i++) {
        const el = buildBlock(list[i], i, S.session);
        S.el.blocks.appendChild(el);
        S.blocks.push(el);
      }
      const added = list.length - oldSigs.length;
      S.messages = list;
      afterSync(wasNear, added, true);
      return;
    }

    if (newSigs.length === oldSigs.length) {
      // Same positions, some messages grew (a tool result landed). Replace only
      // those blocks so the rest of the DOM and the scroll position stay put.
      const mid = document.getElementById('wbMid');
      const viewTop = mid ? mid.getBoundingClientRect().top : 0;
      for (let i = 0; i < list.length; i++) {
        if (oldSigs[i] === newSigs[i]) continue;
        const oldEl = S.blocks[i];
        if (!oldEl) continue;
        const above = oldEl.getBoundingClientRect().top < viewTop;
        const hBefore = oldEl.offsetHeight;
        const next = buildBlock(list[i], i, S.session);
        oldEl.replaceWith(next);
        S.blocks[i] = next;
        if (above && mid) mid.scrollTop += next.offsetHeight - hBefore;
      }
      S.messages = list;
      afterSync(wasNear, 0, false);
      return;
    }

    rebuildBlocks(list);
    S.messages = list;
    afterSync(wasNear, 0, false);
  }

  // ---------- scroll, follow and overlays ----------

  function midRect() {
    const mid = document.getElementById('wbMid');
    return mid ? mid.getBoundingClientRect() : null;
  }

  function nearBottom() {
    const mid = document.getElementById('wbMid');
    if (!mid) return true;
    return mid.scrollHeight - mid.scrollTop - mid.clientHeight < 80;
  }

  function updateVisibleDots() {
    const r = midRect();
    if (!r || !S.dots.length) return;
    const top = r.top + 118;
    const bottom = r.bottom;
    for (let i = 0; i < S.dots.length; i++) {
      const el = S.blocks[i];
      if (!el || el.offsetParent === null) {
        S.dots[i].classList.remove('is-vis');
        continue;
      }
      const br = el.getBoundingClientRect();
      S.dots[i].classList.toggle('is-vis', br.bottom > top && br.top < bottom);
    }
  }

  function updateLiveNote() {
    if (!S.el) return;
    const live = S.session && LIVE.has(S.session.status);
    S.el.liveNote.textContent = live ? (S.nearBottom ? t('liveFollow') : t('livePaused')) : '';
  }

  function ensurePill() {
    if (pillEl) return pillEl;
    pillEl = document.createElement('button');
    pillEl.type = 'button';
    pillEl.className = 'dt-new';
    pillEl.hidden = true;
    pillEl.addEventListener('click', () => {
      const mid = document.getElementById('wbMid');
      if (mid) {
        try { mid.scrollTo({ top: mid.scrollHeight, behavior: 'smooth' }); } catch { mid.scrollTop = mid.scrollHeight; }
      }
      S.newCount = 0;
      showPill();
    });
    document.body.appendChild(pillEl);
    return pillEl;
  }

  function positionPill() {
    const b = ensurePill();
    const r = midRect();
    if (!r) { b.hidden = true; return; }
    b.style.left = `${r.left + r.width / 2}px`;
    b.style.top = `${r.bottom - 48}px`;
  }

  function showPill() {
    const b = ensurePill();
    b.hidden = !S.newCount;
    if (S.newCount) b.textContent = t('newMessages')(S.newCount);
    positionPill();
  }

  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.className = 'dt-toast';
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function positionToast() {
    if (!toastEl || !toastEl.classList.contains('on')) return;
    const r = midRect();
    if (!r) return;
    toastEl.style.left = `${r.left + r.width / 2}px`;
    toastEl.style.top = `${r.bottom - 56}px`;
  }

  function toast(text) {
    const el = ensureToast();
    el.textContent = text;
    el.classList.add('on');
    positionToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 1500);
  }

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
    toast(ok ? t('copied') : t('copyFailed'));
  }

  function onScroll() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => {
      S.raf = 0;
      const nb = nearBottom();
      const changed = nb !== S.nearBottom;
      S.nearBottom = nb;
      if (nb && S.newCount) {
        S.newCount = 0;
        showPill();
      }
      if (changed) updateLiveNote();
      updateVisibleDots();
      positionPill();
      positionToast();
    });
  }

  // ---------- event strip tooltip ----------

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'dt-ev-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(dot) {
    const i = Number(dot.dataset.idx);
    const m = S.messages[i];
    if (!m) return;
    const el = ensureTip();
    const label = typeLabel(m, S.session && S.session.agent === 'deepseek') + (m.role === 'tool' && m.name ? ` · ${m.name}` : '');
    const at = m.at ? hhmmss(m.at) : '';
    const body = clip(m.text || (m.result && m.result.text) || '', 60);
    el.textContent = [label, at, body].filter(Boolean).join(' · ');
    const r = dot.getBoundingClientRect();
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = `${r.top - 6}px`;
    el.hidden = false;
  }

  function hideTip() {
    if (tipEl) tipEl.hidden = true;
  }

  // ---------- jumping ----------

  function jumpToBlock(idx) {
    if (!S.el) return;
    if (S.tab !== 'all') setTab('all');
    requestAnimationFrame(() => {
      const el = S.blocks[idx];
      if (!el) return;
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { el.scrollIntoView(); }
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
      clearTimeout(el._flashT);
      el._flashT = setTimeout(() => el.classList.remove('is-flash'), 950);
    });
  }

  function jumpToFinal() {
    if (S.finalIdx < 0) return;
    jumpToBlock(S.finalIdx);
  }

  // ---------- data ----------

  async function ensureConvo(s) {
    if (S.busy || S.key !== s.key) return;
    if (S.loaded && S.at === s.lastEventAt) return;
    S.busy = true;
    try {
      const r = await fetch(`/api/transcript?key=${encodeURIComponent(s.key)}&limit=300`);
      const d = await r.json().catch(() => ({}));
      if (S.key !== s.key) return;
      S.loaded = true;
      S.private = !!d.private;
      S.at = s.lastEventAt;
      const list = Array.isArray(d.messages) ? d.messages : [];
      if (S.private) {
        syncMessages([]);
        showNote(t('privateNote'));
      } else {
        syncMessages(list);
        showNote(list.length ? '' : t('noMessages'));
      }
      window.dispatchEvent(new CustomEvent('wb:convo', { detail: { key: s.key } }));
    } catch {
      if (S.key === s.key) showNote(t('noMessages'));
    } finally {
      if (S.key === s.key) {
        S.busy = false;
        if (S.el && S.el.skel) {
          S.el.skel.remove();
          S.el.skel = null;
        }
      }
    }
  }

  function showNote(text) {
    if (!S.el) return;
    S.el.note.hidden = !text;
    S.el.note.textContent = text || '';
  }

  // ---------- empty state (T8) ----------

  const ES_ACTIVE = new Set(['thinking', 'tool', 'typing']);

  function esMasterTitle(s) {
    const master = findMaster(s);
    if (!master) return '';
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(master) : { title: master.title || '' };
    return clip(ti.title || master.project || master.agent || '', 24);
  }

  function esCard(s, now) {
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || '' };
    const st = s.status || 'idle';
    const second = window.Workbench?.secondLine ? window.Workbench.secondLine(s, ti) : { text: s.activity || '', mono: true };
    const need = st === 'waiting' || st === 'error';
    const color = st === 'waiting' ? '--st-waiting' : '--st-error';
    const orig = ti.fromReply ? `<span class="wb-es-note">${t('noOriginal')}</span>` : '';
    const from = esMasterTitle(s);
    return `<button type="button" class="wb-es-card${need ? ' is-need' : ''}" data-es-key="${esc(s.key)}"${need ? ` style="--es-s:var(${color})"` : ''}>
      <span class="wb-es-top"><span class="ui-dot ${dotClass(st)}"></span>${ti.tag ? `<span class="ui-chip wb-es-tag">${esc(ti.tag)}</span>` : ''}<span class="wb-es-time ui-num" data-es-dur="${esc(s.key)}">${esc(durText(s, now))}</span></span>
      <span class="wb-es-name">${orig}${esc(ti.title || s.project || s.agent || '')}</span>
      <span class="wb-es-act${second.mono ? ' is-mono' : ''}" data-es-act="${esc(s.key)}">${esc(second.text || '')}</span>
      ${from ? `<span class="wb-es-from">${t('masterFrom')} ${esc(from)}</span>` : ''}
    </button>`;
  }

  function esRecent(s, now) {
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { title: s.title || '' };
    const orig = ti.fromReply ? `<span class="wb-es-note">${t('noOriginal')}</span>` : '';
    return `<button type="button" class="wb-es-row" data-es-key="${esc(s.key)}">
      <span class="ui-dot st-done"></span>
      <span class="wb-es-row-title">${orig}${esc(ti.title || s.project || s.agent || '')}</span>
      <span class="wb-es-row-meta ui-num"><span data-es-ago="${esc(s.key)}">${esc(relAgo(Number(s.lastEventAt) || 0, now))}</span> · ${esc(durText(s, now))}</span>
    </button>`;
  }

  function emptyState(box, now) {
    const sessions = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const rank = (s) => (s.status === 'waiting' ? 0 : s.status === 'error' ? 1 : ES_ACTIVE.has(s.status) ? 2 : 9);
    const todoAll = sessions
      .filter((s) => rank(s) < 9)
      .sort((a, b) => rank(a) - rank(b) || (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
    const todo = todoAll.slice(0, 4);
    const recent = sessions
      .filter((s) => s.status === 'done')
      .sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0))
      .slice(0, 5);
    const sig = todoAll.map((s) => `${s.key}:${s.status}`).join(',') + '|' + recent.map((s) => s.key).join(',') + '|' + (typeof langCode !== 'undefined' ? langCode : '');
    if (box.dataset.esSig === sig && box.querySelector('.wb-es')) {
      tickEmpty(now);
      return;
    }
    box.dataset.esSig = sig;
    box.dataset.html = '';
    if (!todoAll.length && !recent.length) {
      box.innerHTML = `<div class="wb-es-quiet"><span class="wb-es-seal" aria-hidden="true"></span><p>${t('wbQuiet')}</p></div>`;
      return;
    }
    const todoHtml = todoAll.length
      ? `<section class="wb-es-sec"><h3 class="wb-es-h">${t('wbActive')} <span class="ui-num">${todoAll.length}</span></h3><div class="wb-es-grid">${todo.map((s) => esCard(s, now)).join('')}</div>${todoAll.length > todo.length ? `<button type="button" class="wb-es-more" data-es-more>${t('wbMore')(todoAll.length - todo.length)}</button>` : ''}</section>`
      : '';
    const recentHtml = recent.length
      ? `<section class="wb-es-sec"><h3 class="wb-es-h">${t('wbRecentDone')}</h3><div class="wb-es-recent">${recent.map((s) => esRecent(s, now)).join('')}</div></section>`
      : '';
    box.innerHTML = `<div class="wb-es">${todoHtml}${recentHtml}</div>`;
    tickEmpty(now);
  }

  function tickEmpty(now) {
    const box = document.getElementById('wbDetail');
    if (!box || !box.querySelector('.wb-es')) return;
    const sessions = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const byKey = new Map(sessions.map((s) => [s.key, s]));
    for (const el of box.querySelectorAll('[data-es-dur]')) {
      const s = byKey.get(el.dataset.esDur);
      if (s) el.textContent = durText(s, now);
    }
    for (const el of box.querySelectorAll('[data-es-ago]')) {
      const s = byKey.get(el.dataset.esAgo);
      if (s && s.lastEventAt) el.textContent = relAgo(Number(s.lastEventAt), now);
    }
    for (const el of box.querySelectorAll('[data-es-act]')) {
      const s = byKey.get(el.dataset.esAct);
      if (!s) continue;
      const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || '' };
      const second = window.Workbench?.secondLine ? window.Workbench.secondLine(s, ti) : { text: s.activity || '', mono: true };
      el.textContent = second.text || '';
      el.classList.toggle('is-mono', !!second.mono);
    }
  }

  // ---------- entry points ----------

  function render(box, s, now) {
    if (S.key !== s.key) {
      S.key = s.key;
      S.session = s;
      S.messages = [];
      S.at = null;
      S.loaded = false;
      S.busy = false;
      S.private = false;
      S.blocks = [];
      S.dots = [];
      S.finalIdx = -1;
      S.nearBottom = true;
      S.newCount = 0;
      S.firstLoad = true;
      S.el = null;
      hideTip();
      showPill();
      skeleton(box);
      // skeleton replaced the empty-state DOM; drop its cache marker so a later
      // clear() cannot mistake this detail for the empty state.
      box.dataset.html = '';
      const mid = document.getElementById('wbMid');
      if (mid) mid.scrollTop = 0;
      setTab('all');
    }
    S.session = s;
    renderHead(s, now);
    renderChildren(s);
    updateLiveNote();
    if (!S.loaded || S.at !== s.lastEventAt) ensureConvo(s);
    positionPill();
  }

  function clear(box) {
    S.key = null;
    S.session = null;
    S.messages = [];
    S.at = null;
    S.loaded = false;
    S.busy = false;
    S.private = false;
    S.blocks = [];
    S.dots = [];
    S.finalIdx = -1;
    S.newCount = 0;
    S.firstLoad = true;
    S.el = null;
    hideTip();
    showPill();
    emptyState(box, Date.now() - (state.skew || 0));
  }

  // ---------- ticking durations ----------

  function tick() {
    const now = Date.now() - (state.skew || 0);
    if (!S.el || !S.key) {
      tickEmpty(now);
      return;
    }
    const list = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const s = list.find((x) => x.key === S.key) || S.session;
    if (!s) return;
    S.session = s;
    const d = S.el.meta.querySelector('.dt-dur');
    if (d) d.textContent = durText(s, now);
    for (const el of S.el.children.querySelectorAll('.dt-child[data-child-key]')) {
      const k = list.find((x) => x.key === el.dataset.childKey);
      const d2 = el.querySelector('.dt-child-dur');
      if (k && d2) d2.textContent = childDur(k, now);
    }
  }

  // ---------- events ----------

  function init() {
    const box = document.getElementById('wbDetail');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const more = e.target.closest('[data-es-more]');
      if (more) { window.dispatchEvent(new CustomEvent('wb:filter', { detail: { filter: 'working' } })); return; }
      const pick = e.target.closest('[data-es-key]');
      if (pick) { window.Workbench?.select?.(pick.dataset.esKey); return; }
      const tabBtn = e.target.closest('.dt-tabs [data-tab]');
      if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
      const dot = e.target.closest('.dt-ev');
      if (dot) { jumpToBlock(Number(dot.dataset.idx)); return; }
      const master = e.target.closest('[data-master-key]');
      if (master) { window.Workbench?.select?.(master.dataset.masterKey); return; }
      const child = e.target.closest('.dt-child[data-child-key]');
      if (child) { window.Workbench?.select?.(child.dataset.childKey); return; }
      const copyResume = e.target.closest('[data-copy-resume]');
      if (copyResume) { copyText(copyResume.dataset.copyResume); return; }
      const copyCwd = e.target.closest('[data-copy-cwd]');
      if (copyCwd) { copyText(copyCwd.dataset.copyCwd); return; }
      if (e.target.closest('[data-jump-final]')) jumpToFinal();
    });
    box.addEventListener('mouseover', (e) => {
      const dot = e.target.closest('.dt-ev');
      if (dot) showTip(dot);
    });
    box.addEventListener('mouseout', (e) => {
      const dot = e.target.closest('.dt-ev');
      if (dot && !dot.contains(e.relatedTarget)) hideTip();
    });
    document.getElementById('wbMid')?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => {
      if (S.messages.length) buildStrip();
      updateVisibleDots();
      positionPill();
      positionToast();
    });
    setInterval(tick, 1000);
  }

  window.WbDetail = {
    render,
    clear,
    onLang: () => { if (S.key) S.key = null; S.el = null; },
    jumpToFinal,
    jumpToBlock,
    convo: () => ({ key: S.key, messages: S.messages, loaded: S.loaded }),
    md: renderMd,
    debug: () => ({ key: S.key, messages: S.messages.length, blocks: S.blocks.length, tab: S.tab, at: S.at, busy: S.busy, loaded: S.loaded }),
  };
  init();
})();
