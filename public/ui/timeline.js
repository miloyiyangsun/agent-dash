// timeline.js — 时间轴视图（T6）。
// One lane per task, grouped exactly like the workbench tree (same filters,
// same search, same collapse store). The right side is a fixed-width time
// window: no horizontal scrolling, wheel/drag only zooms or pans the domain.
(() => {
  'use strict';

  const esc = (s) => (typeof window.esc === 'function' ? window.esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const t = (k) => {
    const lang = typeof langCode !== 'undefined' ? langCode : 'en';
    const dict = typeof L !== 'undefined' ? L : null;
    return dict?.[k] ?? (lang.startsWith('zh') ? window.I18N?.['zh-CN']?.[k] : null) ?? window.I18N?.en?.[k] ?? k;
  };
  const WB = () => window.Workbench;
  const nowMs = () => Date.now() - (typeof state !== 'undefined' ? (state.skew || 0) : 0);

  const LIVE = new Set(['thinking', 'tool', 'typing', 'waiting']);
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
  const EV_CLASS = { t: 'ev-t', s: 'ev-s', f: 'ev-f', e: 'ev-e' };
  const EV_PRIO = { t: 0, s: 1, f: 2, e: 3 };
  const RANGES = [
    { key: '1h', i18n: 'tlRange1h', ms: 3600e3 },
    { key: '3h', i18n: 'tlRange3h', ms: 3 * 3600e3 },
    { key: '12h', i18n: 'tlRange12h', ms: 12 * 3600e3 },
    { key: 'all', i18n: 'tlRangeAll', ms: 0 },
  ];
  const RANGE_KEYS = new Set(RANGES.map((r) => r.key));
  const ROW_H = 28;

  const dotClass = (st) => (st === 'idle' ? 'st-interrupted' : `st-${st || 'interrupted'}`);
  const statusLabel = (st) => (typeof L !== 'undefined' && L[st]) || st;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Bar durations sit at 6px from the left edge; ticks under that text are
  // skipped instead of striking through it. Measure once per distinct string.
  let measureCtx = null;
  const durWidths = new Map();
  function durTextWidth(text) {
    if (!text) return 0;
    const hit = durWidths.get(text);
    if (hit != null) return hit;
    try {
      measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
      measureCtx.font = '11px "Cascadia Mono", "JetBrains Mono", ui-monospace, Consolas, monospace';
      const w = measureCtx.measureText(text).width;
      durWidths.set(text, w);
      return w;
    } catch {
      return text.length * 6.6;
    }
  }
  const DUR_PAD = 12;

  function clip(text, n) {
    const s = String(text || '').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  function fmtClock(ts, seconds) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return seconds ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function storeGet(key, fallback) {
    try { return typeof store !== 'undefined' ? store.get(key, fallback) : fallback; } catch { return fallback; }
  }
  function storeSet(key, value) {
    try { if (typeof store !== 'undefined') store.set(key, value); } catch { /* private mode */ }
  }

  // Some finished run logs carry a startedAt later than their last event; the
  // turn start is the reliable earlier boundary there (same rule as the tree).
  function startOf(s) {
    const start = Number(s.startedAt) || Number(s.turnStartedAt) || Number(s.lastEventAt) || 0;
    if (LIVE.has(s.status)) return start;
    const last = Number(s.lastEventAt) || 0;
    const turn = Number(s.turnStartedAt) || 0;
    if (last && last < start && turn && turn < last) return turn;
    return start;
  }
  function endOf(s, now) {
    const start = startOf(s);
    if (LIVE.has(s.status)) return Math.max(now, start);
    return Math.max(start, Number(s.lastEventAt) || Number(s.turnStartedAt) || start);
  }

  // ---------- view state ----------

  let rangeKey = RANGE_KEYS.has(storeGet('tlRange', '3h')) ? storeGet('tlRange', '3h') : '3h';
  let zoom = null;               // { t0, t1 } when the person zoomed or panned
  let dom = null;                // { t0, t1, w, scale, labelX }
  let raf = 0;
  let cursorKey = null;
  let selectableKeys = [];
  let lastByKey = new Map();

  const groupCache = new Map();
  const rowCache = new Map();

  let rootEl = null;
  let stageEl = null;
  let headEl = null;
  let headTrackEl = null;
  let rulerEl = null;
  let bandEl = null;
  let peakEl = null;
  let bodyEl = null;
  let groupsEl = null;
  let emptyEl = null;
  let emptyTextEl = null;
  let nowEl = null;
  let tipEl = null;
  let rangeSegEl = null;
  let resetEl = null;

  const drag = { active: false, moved: false, x: 0, t0: 0, t1: 0, scale: 1 };
  let suppressClick = false;
  let tipKey = null;

  // ---------- skeleton ----------

  function buildSkeleton(tl) {
    tl.innerHTML = `
      <div class="tl-view">
        <div class="tl-top">
          <div class="tl-legend" aria-hidden="true">
            <span><i class="tl-lg" style="--ev:var(--ev-tool)"></i>${esc(t('tlTools'))}</span>
            <span><i class="tl-lg" style="--ev:var(--ev-say)"></i>${esc(t('tlReplies'))}</span>
            <span><i class="tl-lg" style="--ev:var(--ev-final)"></i>${esc(t('tlFinal'))}</span>
            <span><i class="tl-lg" style="--ev:var(--ev-error)"></i>${esc(t('tlErrors'))}</span>
          </div>
          <div class="tl-actions">
            <div class="ui-seg tl-range" id="tlRange" role="group" aria-label="${esc(t('tlRangeAria'))}">
              ${RANGES.map((r) => `<button type="button" data-range="${r.key}">${esc(t(r.i18n))}</button>`).join('')}
            </div>
            <button type="button" class="ui-btn tl-reset" id="tlReset" hidden>${esc(t('tlReset'))}</button>
          </div>
        </div>
        <div class="tl-stage" id="tlStage">
          <div class="tl-head">
            <div class="tl-head-label"><span class="tl-cap">${esc(t('tlConcurrency'))}</span><span class="tl-peak ui-num" id="tlPeak"></span></div>
            <div class="tl-head-track" id="tlHeadTrack">
              <svg class="tl-band" id="tlBand" height="36" preserveAspectRatio="none" aria-hidden="true"></svg>
              <div class="tl-ruler" id="tlRuler"></div>
            </div>
          </div>
          <div class="tl-body" id="tlBody">
            <div class="tl-groups" id="tlGroups"></div>
            <div class="tl-empty" id="tlEmpty" hidden>
              <p class="tl-empty-text">${esc(t('tlNoTasks'))}</p>
              <button type="button" class="ui-btn" data-tl-12>${esc(t('tlSwitch12'))}</button>
            </div>
          </div>
          <div class="tl-now" id="tlNow" hidden><span class="tl-now-lab">${esc(t('tlNow'))}</span><i class="tl-now-tri"></i></div>
        </div>
      </div>`;

    rootEl = tl.querySelector('.tl-view');
    stageEl = tl.querySelector('#tlStage');
    headEl = tl.querySelector('.tl-head');
    headTrackEl = tl.querySelector('#tlHeadTrack');
    rulerEl = tl.querySelector('#tlRuler');
    bandEl = tl.querySelector('#tlBand');
    peakEl = tl.querySelector('#tlPeak');
    bodyEl = tl.querySelector('#tlBody');
    groupsEl = tl.querySelector('#tlGroups');
    emptyEl = tl.querySelector('#tlEmpty');
    emptyTextEl = tl.querySelector('.tl-empty-text');
    nowEl = tl.querySelector('#tlNow');
    rangeSegEl = tl.querySelector('#tlRange');
    resetEl = tl.querySelector('#tlReset');

    tipEl = document.createElement('div');
    tipEl.className = 'tl-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }

  // ---------- geometry ----------

  function overlaps(s, now) {
    if (!dom) return false;
    return endOf(s, now) >= dom.t0 && startOf(s) <= dom.t1;
  }

  function barGeom(s, now) {
    const st = startOf(s);
    const en = endOf(s, now);
    const left = Math.max(0, (st - dom.t0) * dom.scale);
    const right = Math.min(dom.w, (en - dom.t0) * dom.scale);
    return { left, width: Math.max(1, right - left), st, en };
  }

  function labelWidth() {
    const el = rootEl && rootEl.querySelector('.tl-head-label');
    return el ? el.getBoundingClientRect().width : 280;
  }

  function computeDomain(now, sessions) {
    let t0;
    let t1;
    if (zoom) {
      t0 = zoom.t0;
      t1 = zoom.t1;
    } else if (rangeKey === 'all') {
      let min = Infinity;
      for (const s of sessions) {
        const st = startOf(s);
        if (st > 0 && st < min) min = st;
      }
      if (!Number.isFinite(min)) min = now - 3 * 3600e3;
      const span0 = Math.max(60e3, now - min);
      const pad = clamp(span0 * 0.02, 30e3, 30 * 60e3);
      t0 = min - pad * 0.2;
      t1 = now + pad;
    } else {
      const span0 = (RANGES.find((r) => r.key === rangeKey) || RANGES[1]).ms;
      const pad = clamp(span0 * 0.02, 30e3, 30 * 60e3);
      t1 = now + pad;
      t0 = t1 - span0;
    }
    const w = headTrackEl.clientWidth;
    const span = Math.max(1, t1 - t0);
    return { t0, t1, w, scale: w / span, labelX: labelWidth() };
  }

  function spanNow() {
    return dom ? dom.t1 - dom.t0 : 1;
  }

  // ---------- tick marks ----------

  // One 1px line per event, merged by pixel: when several events land on the
  // same pixel the most telling one wins (error > final > reply > tool).
  function ticksSvg(s, start, scale, barW, skip) {
    const evs = Array.isArray(s.events) ? s.events : null;
    if (!evs || !evs.length) return '';
    const seen = new Map();
    for (const e of evs) {
      if (!e || e.length < 2) continue;
      const ts = Number(e[0]);
      const type = e[1];
      if (!Number.isFinite(ts) || !EV_CLASS[type]) continue;
      const x = Math.round((ts - start) * scale);
      if (x < 0 || x > barW) continue;
      if (x < skip) continue;
      const cur = seen.get(x);
      if (cur == null || (EV_PRIO[type] || 0) > (EV_PRIO[cur] || 0)) seen.set(x, type);
    }
    if (!seen.size) return '';
    const byType = new Map();
    for (const [x, type] of seen) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(x);
    }
    let out = `<svg class="tl-ticks-svg" width="${Math.max(1, barW)}" height="10" aria-hidden="true">`;
    for (const [type, xs] of byType) {
      let d = '';
      for (const x of xs) d += `M${x + 0.5} 1v8`;
      out += `<path class="${EV_CLASS[type]}" d="${d}"/>`;
    }
    return out + '</svg>';
  }

  // ---------- rows and groups ----------

  function makeRow() {
    const el = document.createElement('div');
    el.className = 'tl-row';
    el.setAttribute('role', 'button');
    el.tabIndex = -1;
    el.innerHTML = `<div class="tl-label"><span class="ui-dot st-interrupted"></span><span class="ui-chip tl-tag" hidden></span><span class="tl-note" hidden>${esc(t('noOriginal'))}</span><span class="tl-title"></span></div><div class="tl-track"><div class="tl-bar"><span class="tl-ticks"></span><span class="tl-dur ui-num"></span></div></div>`;
    return {
      el,
      key: null,
      dot: el.querySelector('.ui-dot'),
      dotCls: '',
      tagEl: el.querySelector('.tl-tag'),
      tag: null,
      noteEl: el.querySelector('.tl-note'),
      note: null,
      titleEl: el.querySelector('.tl-title'),
      title: null,
      barEl: el.querySelector('.tl-bar'),
      color: null,
      live: null,
      ticksEl: el.querySelector('.tl-ticks'),
      tickSig: null,
      durEl: el.querySelector('.tl-dur'),
      dur: null,
      showDur: null,
      sel: false,
      cur: false,
    };
  }

  function makeGroup(gkey, kind) {
    const el = document.createElement('div');
    el.className = 'tl-group' + (kind === 'master' ? '' : ' tl-section');
    el.dataset.gkey = gkey;
    el.innerHTML = `
      <div class="tl-ghead">
        <div class="tl-glabel">
          <button type="button" class="wb-arrow tl-arrow" aria-expanded="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
          <span class="tl-gtitle"></span>
          <span class="tl-gcount ui-num"></span>
        </div>
        <div class="tl-track tl-gtrack"><div class="tl-gdeco"></div></div>
      </div>
      <div class="tl-gbody">
        <div class="tl-grows"></div>
        <svg class="tl-conn" aria-hidden="true"></svg>
      </div>`;
    return {
      el,
      key: gkey,
      arrow: el.querySelector('.tl-arrow'),
      titleEl: el.querySelector('.tl-gtitle'),
      title: null,
      countEl: el.querySelector('.tl-gcount'),
      count: null,
      decoEl: el.querySelector('.tl-gdeco'),
      deco: null,
      rowsEl: el.querySelector('.tl-grows'),
      connEl: el.querySelector('.tl-conn'),
      collapsed: null,
    };
  }

  function updateRow(entry, s, now, ti) {
    entry.key = s.key;
    entry.el.dataset.key = s.key;
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
    if (entry.title !== ti.title) {
      entry.titleEl.textContent = ti.title;
      entry.titleEl.title = ti.title;
      entry.title = ti.title;
    }
    const geom = barGeom(s, now);
    entry.barEl.style.left = geom.left.toFixed(1) + 'px';
    entry.barEl.style.width = geom.width.toFixed(1) + 'px';
    const color = `var(${ST_VAR[st] || '--st-interrupted'})`;
    if (entry.color !== color) {
      entry.barEl.style.setProperty('--bar', color);
      entry.color = color;
    }
    const live = LIVE.has(st);
    if (entry.live !== live) {
      entry.barEl.classList.toggle('is-live', live);
      entry.live = live;
    }
    const dur = WB()?.fmtDur ? WB().fmtDur(geom.en - geom.st) : String(Math.round((geom.en - geom.st) / 1000)) + 's';
    const showDur = geom.width >= durTextWidth(dur) + DUR_PAD;
    if (entry.dur !== dur || entry.showDur !== showDur) {
      entry.durEl.textContent = showDur ? dur : '';
      entry.dur = dur;
      entry.showDur = showDur;
    }
    const evs = Array.isArray(s.events) ? s.events : null;
    const evSig = evs && evs.length ? `${evs.length}:${evs[0][0]}:${evs[evs.length - 1][0]}` : '0';
    const skip = showDur ? Math.ceil(durTextWidth(dur)) + DUR_PAD : 0;
    const sig = `${geom.st}|${dom.scale.toFixed(5)}|${Math.ceil(geom.width)}|${evSig}|${skip}`;
    if (entry.tickSig !== sig) {
      entry.ticksEl.innerHTML = ticksSvg(s, geom.st, dom.scale, Math.ceil(geom.width), skip);
      entry.tickSig = sig;
    }
    const sel = state.wbSel === s.key;
    if (entry.sel !== sel) {
      entry.el.classList.toggle('is-sel', sel);
      entry.sel = sel;
    }
    const cur = cursorKey === s.key;
    if (entry.cur !== cur) {
      entry.el.classList.toggle('is-cur', cur);
      entry.cur = cur;
    }
  }

  function updateGroup(entry, g, rows, now, collapsed) {
    const master = g.kind === 'master';
    const ti = master ? WB().titleOf(g.master) : null;
    const title = master ? ti.title : (g.kind === 'other' ? t('wbOther') : t('wbUnassigned'));
    if (entry.title !== title) {
      entry.titleEl.textContent = title;
      entry.titleEl.title = title;
      entry.title = title;
    }
    if (entry.count !== rows.length) {
      entry.countEl.textContent = String(rows.length);
      entry.count = rows.length;
    }
    if (entry.collapsed !== collapsed) {
      entry.el.classList.toggle('collapsed', collapsed);
      entry.arrow.setAttribute('aria-expanded', String(!collapsed));
      entry.collapsed = collapsed;
    }

    let deco = '';
    if (master) {
      const m = g.master;
      let last = endOf(m, now);
      for (const r of rows) last = Math.max(last, endOf(r, now));
      const x0 = clamp((startOf(m) - dom.t0) * dom.scale, 0, dom.w);
      const x1 = clamp((last - dom.t0) * dom.scale, 0, dom.w);
      if (x1 > x0) deco += `<i class="tl-mline" style="left:${x0.toFixed(1)}px;width:${(x1 - x0).toFixed(1)}px"></i>`;
      for (const r of rows) {
        const x = (startOf(r) - dom.t0) * dom.scale;
        if (x < -3 || x > dom.w + 3) continue;
        deco += `<i class="tl-gdot" style="left:${x.toFixed(1)}px"></i>`;
      }
    }
    if (entry.deco !== deco) {
      entry.decoEl.innerHTML = deco;
      entry.deco = deco;
    }

    // Dashed drop lines: each child's start on the master line down to its bar.
    if (master && !collapsed) {
      let conn = '';
      rows.forEach((r, i) => {
        const x = labelWidth() + barGeom(r, now).left;
        conn += `<line x1="${x.toFixed(1)}" y1="-15" x2="${x.toFixed(1)}" y2="${(i * ROW_H + ROW_H / 2).toFixed(1)}"/>`;
      });
      if (entry.connEl.dataset.sig !== conn) {
        entry.connEl.innerHTML = conn;
        entry.connEl.dataset.sig = conn;
      }
      entry.connEl.setAttribute('height', String(rows.length * ROW_H));
      entry.connEl.style.display = '';
    } else {
      entry.connEl.innerHTML = '';
      entry.connEl.dataset.sig = '';
      entry.connEl.style.display = 'none';
    }
  }

  // ---------- ruler and band ----------

  function rulerStep(span, w) {
    const steps = [
      15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
      60 * 60e3, 2 * 3600e3, 3 * 3600e3, 4 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3,
    ];
    // Aim for ~12 labels; the 3h window is the one preset that reads better
    // with half-hour marks than with quarter-hour ones.
    const target = span >= 2 * 3600e3 && span <= 4 * 3600e3 ? w / 6 : w / 12;
    for (const st of steps) if ((st / span) * w >= target - 0.5) return st;
    return steps[steps.length - 1];
  }

  function renderRuler() {
    const span = spanNow();
    const step = rulerStep(span, dom.w);
    const secs = step < 60e3;
    const first = Math.ceil(dom.t0 / step) * step;
    let html = '';
    for (let ts = first; ts <= dom.t1; ts += step) {
      const x = (ts - dom.t0) * dom.scale;
      if (x < -1 || x > dom.w + 1) continue;
      const labX = clamp(x, 16, dom.w - 16);
      html += `<i class="tl-rtick" style="left:${x.toFixed(1)}px"></i><span class="tl-rlab ui-num" style="left:${labX.toFixed(1)}px">${fmtClock(ts, secs)}</span>`;
    }
    rulerEl.innerHTML = html;
  }

  function renderBand(intervals) {
    const w = Math.max(1, Math.round(dom.w));
    const H = 36;
    const top = 4;
    const bottom = 34;
    const evs = [];
    for (const [a, b] of intervals) {
      const s0 = Math.max(a, dom.t0);
      const e0 = Math.min(b, dom.t1);
      if (e0 <= s0) continue;
      evs.push([s0, 1], [e0, -1]);
    }
    evs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let count = 0;
    let peak = 0;
    for (const [, d] of evs) {
      count += d;
      if (count > peak) peak = count;
    }
    peakEl.textContent = peak ? t('tlPeak')(peak) : '';
    bandEl.setAttribute('viewBox', `0 0 ${w} ${H}`);
    if (!evs.length) {
      bandEl.innerHTML = `<line class="tl-baseline" x1="0" y1="${bottom}" x2="${w}" y2="${bottom}"/>`;
      return;
    }
    const yOf = (n) => bottom - (n / peak) * (bottom - top);
    let d = `M0 ${bottom}`;
    let y = bottom;
    count = 0;
    let i = 0;
    while (i < evs.length) {
      const ts = evs[i][0];
      let delta = 0;
      while (i < evs.length && evs[i][0] === ts) {
        delta += evs[i][1];
        i++;
      }
      const x = clamp((ts - dom.t0) * dom.scale, 0, w);
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      count += delta;
      y = yOf(count);
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    d += ` L${w} ${y.toFixed(1)} L${w} ${bottom} Z`;
    bandEl.innerHTML = `<path class="tl-area" d="${d}"/><line class="tl-baseline" x1="0" y1="${bottom}" x2="${w}" y2="${bottom}"/>`;
  }

  // ---------- empty state ----------

  function renderEmpty(isEmpty, sessionCount) {
    groupsEl.hidden = isEmpty;
    emptyEl.hidden = !isEmpty;
    if (!isEmpty) return;
    const msg = sessionCount ? t('tlNoTasks') : t('tlNoData');
    if (emptyTextEl.textContent !== msg) emptyTextEl.textContent = msg;
  }

  // ---------- draw ----------

  function visible() {
    const tl = document.getElementById('tl');
    return !!tl && !tl.hidden && typeof state !== 'undefined' && state.view === 'timeline';
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(draw);
  }

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

  function updateNow(now) {
    if (!dom) return;
    const x = (now - dom.t0) * dom.scale;
    if (x < -1 || x > dom.w + 1) {
      nowEl.hidden = true;
      return;
    }
    nowEl.hidden = false;
    nowEl.style.transform = `translateX(${(dom.labelX + x).toFixed(1)}px)`;
    nowEl.classList.toggle('is-flip', x > dom.w - 70);
  }

  function draw() {
    raf = 0;
    if (!visible()) return;
    const WBk = WB();
    if (!WBk || !WBk.buildView || !headTrackEl) return;
    // The rows scroll, the head does not; reserve the same gutter so ruler,
    // band, bars and the now line share one x scale.
    const sbw = bodyEl ? Math.max(0, bodyEl.offsetWidth - bodyEl.clientWidth) : 0;
    headEl.style.paddingRight = sbw ? `${sbw}px` : '';
    const w = headTrackEl.clientWidth;
    if (!w) return;
    const now = nowMs();
    const sessions = Array.isArray(state.data.sessions) ? state.data.sessions : [];
    const view = WBk.buildView(sessions, now);
    dom = computeDomain(now, sessions);
    dom.w = w;
    dom.scale = w / Math.max(1, dom.t1 - dom.t0);
    const hr = headTrackEl.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    dom.labelX = hr.left - sr.left;
    lastByKey = new Map(sessions.map((s) => [s.key, s]));

    for (const b of rangeSegEl.querySelectorAll('button')) {
      const on = b.dataset.range === rangeKey;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    resetEl.hidden = !zoom;

    const desiredGroups = [];
    const intervals = [];
    selectableKeys = [];
    for (const g of view.viewGroups) {
      const rows = (g.kind === 'master' ? g.visibleKids : g.rows).filter((s) => overlaps(s, now));
      if (!rows.length) continue;
      const collapsed = view.collapsedByG.get(g.key) === true;
      desiredGroups.push({ g, rows, collapsed });
      for (const s of rows) {
        intervals.push([startOf(s), endOf(s, now)]);
        if (!collapsed) selectableKeys.push(s.key);
      }
    }

    const desiredEls = [];
    for (const { g, rows, collapsed } of desiredGroups) {
      let entry = groupCache.get(g.key);
      if (!entry) {
        entry = makeGroup(g.key, g.kind);
        groupCache.set(g.key, entry);
      }
      updateGroup(entry, g, rows, now, collapsed);
      const desiredRows = [];
      for (const s of rows) {
        let re = rowCache.get(s.key);
        if (!re) {
          re = makeRow();
          rowCache.set(s.key, re);
        }
        updateRow(re, s, now, view.getTitle(s));
        desiredRows.push(re.el);
      }
      const keep = new Set(desiredRows);
      for (const child of [...entry.rowsEl.children]) {
        if (!keep.has(child)) {
          rowCache.delete(child.dataset.key);
          child.remove();
        }
      }
      orderInto(entry.rowsEl, desiredRows);
      desiredEls.push(entry.el);
    }

    const keepGroups = new Set(desiredEls);
    for (const [gkey, entry] of [...groupCache]) {
      if (keepGroups.has(entry.el)) continue;
      for (const child of [...entry.rowsEl.children]) rowCache.delete(child.dataset.key);
      entry.el.remove();
      groupCache.delete(gkey);
    }
    orderInto(groupsEl, desiredEls);

    renderEmpty(desiredGroups.length === 0, sessions.length);
    renderBand(intervals);
    renderRuler();
    updateNow(now);
  }

  // ---------- per-second clock ----------

  function tick() {
    if (!visible()) {
      hideTip();
      return;
    }
    if (!dom) return;
    const now = nowMs();
    updateNow(now);
    for (const entry of rowCache.values()) {
      const s = lastByKey.get(entry.key);
      if (!s || !LIVE.has(s.status || '')) continue;
      const geom = barGeom(s, now);
      entry.barEl.style.width = geom.width.toFixed(1) + 'px';
      const dur = WB()?.fmtDur ? WB().fmtDur(geom.en - geom.st) : '';
      const show = !!dur && geom.width >= durTextWidth(dur) + DUR_PAD;
      if (show !== entry.showDur) {
        // The bar grew past (or shrank below) the label: redraw ticks too.
        schedule();
        continue;
      }
      if (show && dur && entry.dur !== dur) {
        entry.durEl.textContent = dur;
        entry.dur = dur;
      }
    }
    // The window ends just past "now"; once the marker reaches the edge, slide.
    const x = (now - dom.t0) * dom.scale;
    if (!zoom && x > dom.w + 0.5) schedule();
  }

  // ---------- tooltip ----------

  function hideTip() {
    if (tipEl) tipEl.hidden = true;
    tipKey = null;
  }

  function placeTip(x, y) {
    if (!tipEl || tipEl.hidden) return;
    const r = tipEl.getBoundingClientRect();
    let left = x + 14;
    let top = y + 16;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }

  function fillTip(key) {
    const s = lastByKey.get(key) || (state.data.sessions || []).find((x) => x.key === key);
    if (!s) {
      hideTip();
      return;
    }
    const ti = WB().titleOf(s);
    const now = nowMs();
    const st = s.status || 'idle';
    const start = startOf(s);
    const end = endOf(s, now);
    const second = WB().secondLine(s, ti);
    const dur = WB().fmtDur(Math.max(0, end - start));
    tipEl.innerHTML = `
      <div class="tl-tip-title">${esc(ti.title || key)}</div>
      <div class="tl-tip-meta"><span class="ui-dot ${dotClass(st)}"></span><span>${esc(statusLabel(st))}</span><span class="tl-tip-sep">·</span><span>${esc(t('tlEffort'))} ${esc(s.effort || '—')}</span></div>
      <div class="tl-tip-kv"><span>${esc(t('tlStart'))} <b class="ui-num">${start ? fmtClock(start, true) : '—'}</b></span><span>${esc(t('tlDuration'))} <b class="ui-num">${dur}</b></span></div>
      <div class="tl-tip-act"><span class="tl-tip-cap">${esc(t('tlRecentAction'))}</span>${esc(clip(second.text, 110) || '—')}</div>`;
    tipEl.hidden = false;
  }

  // ---------- interactions ----------

  function openTask(key) {
    if (!key) return;
    cursorKey = key;
    state.wbSel = key;
    if (typeof setView === 'function') setView('workbench');
    // select() also moves the workbench cursor, so the tree highlight follows.
    if (WB()?.select) WB().select(key);
    else window.dispatchEvent(new CustomEvent('wb:select', { detail: { key } }));
  }

  function toggleGroup(gkey) {
    const entry = groupCache.get(gkey);
    if (!entry) return;
    WB()?.setCollapsed?.(gkey, !(entry.collapsed === true));
    schedule();
  }

  function setRange(key) {
    if (!RANGE_KEYS.has(key)) return;
    rangeKey = key;
    storeSet('tlRange', key);
    zoom = null;
    schedule();
  }

  function allSpan() {
    const now = nowMs();
    let min = Infinity;
    for (const s of state.data.sessions || []) {
      const st = startOf(s);
      if (st > 0 && st < min) min = st;
    }
    return Number.isFinite(min) ? Math.max(60e3, now - min) : 3 * 3600e3;
  }

  function moveCursor(delta) {
    if (!selectableKeys.length) return;
    let idx = selectableKeys.indexOf(cursorKey);
    if (idx < 0) idx = delta > 0 ? -1 : selectableKeys.length;
    cursorKey = selectableKeys[clamp(idx + delta, 0, selectableKeys.length - 1)];
    for (const [key, entry] of rowCache) {
      const on = key === cursorKey;
      if (entry.cur !== on) {
        entry.el.classList.toggle('is-cur', on);
        entry.cur = on;
      }
    }
    const entry = rowCache.get(cursorKey);
    if (entry) {
      try { entry.el.scrollIntoView({ block: 'nearest' }); } catch { /* detached */ }
    }
  }

  function onKey(e) {
    if (!visible() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement;
    const editable = (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) ||
      (ae && ae.closest && ae.closest('input, textarea, select, [contenteditable]'));
    if (editable) return;
    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(1);
      return;
    }
    if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(-1);
      return;
    }
    if (e.key === 'Enter') {
      const interactive = ae && /^(BUTTON|A|SUMMARY|INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '');
      if (interactive) return;
      if (cursorKey) {
        e.preventDefault();
        openTask(cursorKey);
      }
    }
  }

  function bindInteractions() {
    rangeSegEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (b) setRange(b.dataset.range);
    });
    resetEl.addEventListener('click', () => {
      zoom = null;
      schedule();
    });
    emptyEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-tl-12]')) setRange('12h');
    });

    groupsEl.addEventListener('click', (e) => {
      if (suppressClick) return;
      const head = e.target.closest('.tl-ghead');
      if (head) {
        const grp = head.closest('.tl-group');
        if (grp) toggleGroup(grp.dataset.gkey);
        return;
      }
      const row = e.target.closest('.tl-row');
      if (row && row.dataset.key) openTask(row.dataset.key);
    });

    groupsEl.addEventListener('pointermove', (e) => {
      if (drag.moved) {
        hideTip();
        return;
      }
      const row = e.target.closest('.tl-row');
      if (!row || !row.dataset.key) {
        hideTip();
        return;
      }
      if (tipKey !== row.dataset.key) {
        tipKey = row.dataset.key;
        fillTip(tipKey);
      }
      placeTip(e.clientX, e.clientY);
    });
    groupsEl.addEventListener('pointerleave', hideTip);

    // Ctrl+wheel zooms around the pointer; a plain wheel still scrolls the rows.
    stageEl.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || !dom) return;
      e.preventDefault();
      const rect = headTrackEl.getBoundingClientRect();
      const mx = clamp(e.clientX - rect.left, 0, dom.w);
      const span = spanNow();
      const factor = Math.exp(clamp(e.deltaY, -120, 120) * 0.0022);
      const next = clamp(span * factor, 2 * 60e3, Math.max(allSpan() * 2, 3600e3));
      const anchor = dom.t0 + (mx / dom.w) * span;
      const ratio = mx / dom.w;
      zoom = { t0: anchor - ratio * next, t1: anchor + (1 - ratio) * next };
      hideTip();
      schedule();
    }, { passive: false });

    stageEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !dom) return;
      if (e.target.closest('.tl-ghead')) return;
      drag.active = true;
      drag.moved = false;
      drag.x = e.clientX;
      drag.t0 = dom.t0;
      drag.t1 = dom.t1;
      drag.scale = dom.scale;
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag.active) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      stageEl.classList.add('dragging');
      hideTip();
      const dt = -dx / drag.scale;
      zoom = { t0: drag.t0 + dt, t1: drag.t1 + dt };
      schedule();
    });
    const endDrag = () => {
      if (!drag.active) return;
      drag.active = false;
      stageEl.classList.remove('dragging');
      if (drag.moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', schedule);
    window.addEventListener('wb:filter', schedule);
    window.addEventListener('wb:query', schedule);
    window.addEventListener('wb:select', schedule);
    setInterval(tick, 1000);
  }

  // ---------- boot ----------

  function init() {
    const tl = document.getElementById('tl');
    if (!tl) return;
    buildSkeleton(tl);
    bindInteractions();
    schedule();
  }

  function syncLabels() {
    const tl = document.getElementById('tl');
    if (!tl) return;
    const keys = ['tlTools', 'tlReplies', 'tlFinal', 'tlErrors'];
    tl.querySelectorAll('.tl-legend > span').forEach((el, i) => {
      const icon = el.querySelector('i');
      el.textContent = '';
      if (icon) el.appendChild(icon);
      el.appendChild(document.createTextNode(t(keys[i])));
    });
    tl.querySelectorAll('#tlRange button').forEach((b) => {
      const r = RANGES.find((x) => x.key === b.dataset.range);
      if (r) b.textContent = t(r.i18n);
    });
    const range = tl.querySelector('#tlRange');
    if (range) range.setAttribute('aria-label', t('tlRangeAria'));
    const reset = tl.querySelector('#tlReset');
    if (reset) reset.textContent = t('tlReset');
    const cap = tl.querySelector('.tl-cap');
    if (cap) cap.textContent = t('tlConcurrency');
    const empty = tl.querySelector('.tl-empty-text');
    if (empty) empty.textContent = t('tlNoTasks');
    const sw = tl.querySelector('[data-tl-12]');
    if (sw) sw.textContent = t('tlSwitch12');
    const now = tl.querySelector('.tl-now-lab');
    if (now) now.textContent = t('tlNow');
  }

  window.Timeline = { init, render: schedule, onLang: () => { syncLabels(); schedule(); } };
  init();
})();
