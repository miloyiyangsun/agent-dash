// topo.js — 关系图（T10）: main controllers on the left, their delegated
// subagents in the next columns, grandchildren further right. SVG was chosen
// over canvas: 150 nodes stay cheap, text is real text (crisp, selectable,
// theme-aware), hover/selection are plain CSS, and the live dash flow is a
// CSS animation that can be switched off wholesale when the view is hidden.
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
  const DONE = new Set(['done', 'interrupted', 'idle']);
  const nowMs = () => Date.now() - (typeof state !== 'undefined' ? (state.skew || 0) : 0);

  const NODE_W = 240;
  const NODE_H = 54;
  const SUMMARY_W = 160;
  const SUMMARY_H = 34;
  const COL_GAP = 72;
  const ROW_GAP = 12;
  const GROUP_GAP = 24;
  const GRID_GAP = 12;
  const PAD = 32;
  const SMALL_MAX = 4;     // above this a group switches to the bus + grid layout
  const DONE_LIMIT = 12;   // more completed children than this fold into one node

  const SANS = '600 12.5px "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif';
  const MONO = '11px "Cascadia Mono","JetBrains Mono",ui-monospace,Consolas,monospace';
  const CHIP = '10px "Cascadia Mono","JetBrains Mono",ui-monospace,Consolas,monospace';
  const measure = (() => {
    let ctx = null;
    const cache = new Map();
    return (text, font) => {
      const key = font + '|' + text;
      const hit = cache.get(key);
      if (hit != null) return hit;
      try {
        ctx = ctx || document.createElement('canvas').getContext('2d');
        ctx.font = font;
        const w = ctx.measureText(text).width;
        cache.set(key, w);
        return w;
      } catch {
        return String(text).length * 6.5;
      }
    };
  })();

  function truncate(text, maxW, font) {
    const src = String(text || '');
    if (measure(src, font) <= maxW) return src;
    let lo = 0;
    let hi = src.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(src.slice(0, mid) + '…', font) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return src.slice(0, lo) + '…';
  }

  const root = document.getElementById('topoWrap');
  if (!root) return;
  root.innerHTML = `
    <div class="topo-view" id="topoView">
      <div class="topo-stage" id="topoStage">
        <svg class="topo-svg" id="topoSvg" aria-hidden="true">
          <g id="topoViewport">
            <g class="topo-edges" id="topoEdges"></g>
            <g class="topo-nodes" id="topoNodes"></g>
            <g class="topo-extra" id="topoExtra"></g>
          </g>
        </svg>
        <div class="topo-tools">
          <button type="button" class="ui-btn" data-topo="fit" id="topoFit"></button>
          <button type="button" class="ui-btn" data-topo="reset" id="topoReset"></button>
        </div>
        <div class="topo-empty" id="topoEmpty" hidden></div>
      </div>
      <p class="topo-caption" id="topoCaption"></p>
    </div>`;

  const viewEl = document.getElementById('topoView');
  const stage = document.getElementById('topoStage');
  const svg = document.getElementById('topoSvg');
  const viewport = document.getElementById('topoViewport');
  const edgesG = document.getElementById('topoEdges');
  const nodesG = document.getElementById('topoNodes');
  const extraG = document.getElementById('topoExtra');
  const emptyEl = document.getElementById('topoEmpty');
  const fitBtn = document.getElementById('topoFit');
  const resetBtn = document.getElementById('topoReset');
  const captionEl = document.getElementById('topoCaption');

  let active = false;
  let raf = 0;
  let hoverKey = null;
  let selKey = null;
  let world = { x: 0, y: 0, w: 1, h: 1 };
  let autoFit = true;
  let fitAll = false;
  let k = 1;
  let tx = 0;
  let ty = 0;
  const expandedMasters = new Set();
  const drag = { active: false, moved: false, x: 0, y: 0, tx: 0, ty: 0 };
  let suppressClick = false;

  function sessionsForGraph() {
    const all = Array.isArray(state?.data?.sessions) ? state.data.sessions : [];
    // The graph exists to show delegation, so subagents stay in even when the
    // office's "show subagents" switch is off. The agent chips and the idle
    // switch still apply, like everywhere else.
    const agentOk = typeof matchAgent === 'function' ? matchAgent : () => true;
    return all.filter((s) => agentOk(s) && (state.showIdle || s.status !== 'idle'));
  }

  function statusOf(s) {
    const st = s.status || 'idle';
    if (st === 'error') return 'error';
    if (ACTIVE.has(st)) return 'live';
    if (st === 'waiting') return 'wait';
    return 'done';
  }

  // There is no --st-idle token; idle is drawn with the interrupted colour.
  const stToken = (st) => (st === 'idle' || !st ? 'interrupted' : st);

  function forest(list) {
    const byRef = new Map();
    for (const s of list) {
      if (s.id) byRef.set(String(s.id), s);
      if (s.sessionId) byRef.set(String(s.sessionId), s);
    }
    const kids = new Map();
    const parentOf = new Map();
    const roots = [];
    const order = (a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || String(a.key).localeCompare(String(b.key));
    for (const s of list) {
      const p = s.parentId ? byRef.get(String(s.parentId)) : null;
      let ok = !!p && p.key !== s.key;
      if (ok) {
        let cur = p;
        for (let guard = 0; cur && guard < 64; guard++) {
          if (cur.key === s.key) { ok = false; break; }
          cur = parentOf.get(cur.key);
        }
      }
      if (!ok) {
        roots.push(s);
        continue;
      }
      parentOf.set(s.key, p);
      if (!kids.has(p.key)) kids.set(p.key, []);
      kids.get(p.key).push(s);
    }
    for (const arr of kids.values()) arr.sort(order);
    roots.sort((a, b) => (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0) || String(a.key).localeCompare(String(b.key)));
    const groups = [];
    const independent = [];
    for (const r of roots) {
      if ((kids.get(r.key) || []).length) groups.push(r);
      else independent.push(r);
    }
    // Groups with live (or waiting/error) work come first, so the flowing
    // edges are on screen without hunting; completed groups follow by recency.
    const infoCache = new Map();
    const info = (s) => {
      if (infoCache.has(s.key)) return infoCache.get(s.key);
      let live = ACTIVE.has(s.status);
      let need = s.status === 'waiting' || s.status === 'error';
      let last = Number(s.lastEventAt) || 0;
      for (const kid of kids.get(s.key) || []) {
        const k = info(kid);
        live = live || k.live;
        need = need || k.need;
        last = Math.max(last, k.last);
      }
      const out = { live, need, last };
      infoCache.set(s.key, out);
      return out;
    };
    groups.sort((a, b) => {
      const ia = info(a);
      const ib = info(b);
      const ra = ia.live ? 0 : ia.need ? 1 : 2;
      const rb = ib.live ? 0 : ib.need ? 1 : 2;
      return ra - rb || ib.last - ia.last || String(a.key).localeCompare(String(b.key));
    });
    return { kids, parentOf, groups, independent };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function treeHeight(s, kids, cache) {
    if (cache.has(s.key)) return cache.get(s.key);
    const ks = kids.get(s.key) || [];
    let h = NODE_H;
    if (ks.length) {
      let total = 0;
      for (const kid of ks) total += treeHeight(kid, kids, cache) + ROW_GAP;
      total -= ROW_GAP;
      h = Math.max(NODE_H, total);
    }
    cache.set(s.key, h);
    return h;
  }

  function placeTree(s, x, y, kids, cache, pos) {
    const h = treeHeight(s, kids, cache);
    pos.set(s.key, { s, x, y: y + (h - NODE_H) / 2 });
    const ks = kids.get(s.key) || [];
    if (!ks.length) return;
    let total = 0;
    for (const kid of ks) total += treeHeight(kid, kids, cache) + ROW_GAP;
    total -= ROW_GAP;
    let cy = y + (h - total) / 2;
    for (const kid of ks) {
      placeTree(kid, x + NODE_W + COL_GAP, cy, kids, cache, pos);
      cy += treeHeight(kid, kids, cache) + ROW_GAP;
    }
  }

  // Live and waiting/error children lead; completed ones follow by recency.
  // More than DONE_LIMIT completed children fold into one “+N done” node.
  function rankOf(s) {
    const st = s.status || 'idle';
    if (ACTIVE.has(st)) return 0;
    if (st === 'waiting') return 1;
    if (st === 'error') return 2;
    return 3;
  }
  const byStartDesc = (a, b) =>
    (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) || String(a.key).localeCompare(String(b.key));

  function foldedKids(parentKey, kids) {
    const sorted = [...kids].sort((a, b) => rankOf(a) - rankOf(b) || byStartDesc(a, b));
    const done = sorted.filter((s) => rankOf(s) === 3);
    if (done.length > DONE_LIMIT && !expandedMasters.has(parentKey)) {
      return { items: [...sorted.filter((s) => rankOf(s) !== 3), { summary: true, count: done.length }] };
    }
    return { items: sorted };
  }

  // 2–4 columns, chosen from the stage width the drawer leaves us.
  function gridCols(n, availW) {
    const usable = Math.max(NODE_W, (availW || 1200) - PAD * 2 - NODE_W - COL_GAP);
    const fit = Math.floor((usable + GRID_GAP) / (NODE_W + GRID_GAP));
    return Math.max(2, Math.min(4, fit, Math.max(2, n)));
  }

  // A master with many children: a grid to its right and one bus instead of
  // dozens of crossing curves.
  function placeGrid(rootS, kids, f, availW, y, pos, busList) {
    const { items } = foldedKids(rootS.key, kids);
    const cols = gridCols(items.length, availW);
    const rows = Math.ceil(items.length / cols);
    const gridH = rows * NODE_H + (rows - 1) * GRID_GAP;
    const groupH = Math.max(NODE_H, gridH);
    const masterY = y + (groupH - NODE_H) / 2;
    pos.set(rootS.key, { s: rootS, x: PAD, y: masterY });
    const gridX = PAD + NODE_W + COL_GAP;
    const gridTop = y + (groupH - gridH) / 2;
    const colsData = Array.from({ length: cols }, () => []);
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridX + col * (NODE_W + GRID_GAP);
      const cy = gridTop + row * (NODE_H + GRID_GAP);
      if (item.summary) {
        const sx = x + (NODE_W - SUMMARY_W) / 2;
        const p = { s: rootS, x: sx, y: cy + (NODE_H - SUMMARY_H) / 2, summary: true, count: item.count, masterKey: rootS.key };
        pos.set(`summary:${rootS.key}`, p);
        colsData[col].push({ p, x: sx, y: p.y, h: SUMMARY_H, summary: true });
      } else {
        const p = { s: item, x, y: cy };
        pos.set(item.key, p);
        colsData[col].push({ p, x, y: cy, h: NODE_H });
      }
    });
    // Descendants of a grid child are rare; park them in a tail column.
    const gridRight = gridX + cols * (NODE_W + GRID_GAP) - GRID_GAP;
    let tailY = gridTop;
    let tailRight = gridRight;
    let tailBottom = gridTop;
    const tcache = new Map();
    for (const item of items) {
      if (item.summary) continue;
      const ks = f.kids.get(item.key) || [];
      if (!ks.length) continue;
      const subPos = new Map();
      placeTree(item, gridRight + COL_GAP, tailY, f.kids, tcache, subPos);
      for (const [key, p] of subPos) {
        if (key === item.key) continue;
        pos.set(key, p);
        tailRight = Math.max(tailRight, p.x + NODE_W);
      }
      tailY += treeHeight(item, f.kids, tcache) + ROW_GAP;
      tailBottom = Math.max(tailBottom, tailY - ROW_GAP);
    }
    const busX = gridX - COL_GAP / 2;
    const feedY = gridTop - GRID_GAP / 2;
    const bottom = gridTop + gridH;
    const mx = PAD + NODE_W;
    const my = masterY + NODE_H / 2;
    busList.push({ rootKey: rootS.key, d: `M${mx.toFixed(1)} ${my.toFixed(1)}H${busX.toFixed(1)}M${busX.toFixed(1)} ${feedY.toFixed(1)}V${bottom.toFixed(1)}` });
    colsData.forEach((nodes, col) => {
      if (!nodes.length) return;
      const colBusX = gridX + col * (NODE_W + GRID_GAP) - GRID_GAP / 2;
      const colBottom = Math.max(...nodes.map((n) => n.y + n.h / 2));
      busList.push({ rootKey: rootS.key, d: `M${busX.toFixed(1)} ${feedY.toFixed(1)}H${colBusX.toFixed(1)}M${colBusX.toFixed(1)} ${feedY.toFixed(1)}V${colBottom.toFixed(1)}` });
      for (const n of nodes) {
        const cy = n.y + n.h / 2;
        busList.push({
          rootKey: rootS.key,
          d: `M${colBusX.toFixed(1)} ${cy.toFixed(1)}H${n.x.toFixed(1)}`,
          to: n.summary ? `summary:${rootS.key}` : n.p.s.key,
          status: n.summary ? 'done' : (n.p.s.status || 'idle'),
          summary: !!n.summary,
        });
      }
    });
    return { h: Math.max(groupH, tailBottom - y), right: Math.max(gridRight, tailRight) };
  }

  function layout(list, availW) {
    const f = forest(list);
    const cache = new Map();
    const pos = new Map();
    const bus = [];
    const busMasters = new Set();
    let y = PAD;
    let maxRight = PAD + NODE_W;
    for (const rootS of f.groups) {
      const kids = f.kids.get(rootS.key) || [];
      if (kids.length > SMALL_MAX) {
        const g = placeGrid(rootS, kids, f, availW, y, pos, bus);
        busMasters.add(rootS.key);
        maxRight = Math.max(maxRight, g.right);
        y += g.h + GROUP_GAP;
      } else {
        const groupPos = new Map();
        placeTree(rootS, PAD, y, f.kids, cache, groupPos);
        for (const [key, p] of groupPos) {
          pos.set(key, p);
          maxRight = Math.max(maxRight, p.x + NODE_W);
        }
        y += treeHeight(rootS, f.kids, cache) + GROUP_GAP;
      }
    }
    const groupsH = Math.max(NODE_H + PAD, y - GROUP_GAP + 8);
    let indepLabel = null;
    if (f.independent.length) {
      indepLabel = { x: PAD, y };
      y += 26;
      const cols = f.independent.length <= 2 ? Math.max(1, f.independent.length) : 4;
      f.independent.forEach((s, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const p = { s, x: PAD + c * (NODE_W + GRID_GAP), y: y + r * (NODE_H + GRID_GAP) };
        pos.set(s.key, p);
        maxRight = Math.max(maxRight, p.x + NODE_W);
      });
      const rows = Math.ceil(f.independent.length / cols);
      y += rows * (NODE_H + GRID_GAP) - GRID_GAP;
    }
    const edges = [];
    let liveAnchor = null;
    for (const p of pos.values()) {
      if (p.summary) continue;
      const parent = f.parentOf.get(p.s.key);
      const pp = parent ? pos.get(parent.key) : null;
      if (pp && !busMasters.has(parent.key)) edges.push({ from: pp, to: p });
      if (ACTIVE.has(p.s.status) && (!liveAnchor || p.y < liveAnchor.y)) liveAnchor = p;
    }
    return { pos, edges, bus, liveAnchor, indepLabel, indepCount: f.independent.length, world: { x: 0, y: 0, w: maxRight + PAD, h: y + PAD, groupsH } };
  }

  function subText(s, ti) {
    const st = s.status || 'idle';
    const word = (typeof L !== 'undefined' && L[st]) || st;
    let act = s.stuck ? t('stuck')(s.stuck) : (s.activity || '');
    if (!act) {
      const second = window.Workbench?.secondLine ? window.Workbench.secondLine(s, ti) : { text: '' };
      act = second.text || '';
    }
    if (act === word || act === t('secondDone') || act === t('secondIdle')) act = '';
    return { word, act };
  }

  function nodeMarkup(p, selected) {
    const s = p.s;
    const ti = window.Workbench?.titleOf ? window.Workbench.titleOf(s) : { tag: '', title: s.title || s.project || s.agent || '' };
    const st = s.status || 'idle';
    const kind = statusOf(s);
    const tag = ti.tag || '';
    const tagW = tag ? Math.min(64, measure(tag, CHIP) + 14) : 0;
    const tagText = tag ? truncate(tag, Math.max(20, tagW - 12), CHIP) : '';
    const titleX = 10 + (tagW ? tagW + 6 : 0);
    const title = truncate(ti.title || s.project || s.agent || '', NODE_W - titleX - 10, SANS);
    const { word, act } = subText(s, ti);
    const stW = measure(word, MONO);
    const actText = act && NODE_W - 20 - stW - 10 > 16 ? truncate(act, NODE_W - 20 - stW - 10, MONO) : '';
    const cls = ['topo-node', `is-${kind}`];
    if (selKey === s.key || selected) cls.push('is-sel');
    if (hoverKey === s.key) cls.push('is-hi');
    const tip = [ti.tag, ti.title].filter(Boolean).join(' · ') || s.project || s.agent || '';
    return `<g class="${cls.join(' ')}" data-key="${esc(s.key)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" style="--s:var(--st-${stToken(st)})">
      <title>${esc(tip)}</title>
      <rect class="topo-node-bg" width="${NODE_W}" height="${NODE_H}" rx="6"/>
      <rect class="topo-spine" x="0.5" y="1" width="3" height="${NODE_H - 2}" rx="1.5"/>
      ${tagW ? `<rect class="topo-chip" x="10" y="10" width="${tagW.toFixed(1)}" height="18" rx="9"/><text class="topo-chip-t" x="${(10 + tagW / 2).toFixed(1)}" y="23" text-anchor="middle">${esc(tagText)}</text>` : ''}
      <text class="topo-title" x="${titleX.toFixed(1)}" y="23">${esc(title)}</text>
      <text class="topo-sub" x="10" y="42"><tspan class="topo-st">${esc(word)}</tspan>${actText ? `<tspan class="topo-act"> · ${esc(actText)}</tspan>` : ''}</text>
    </g>`;
  }

  function edgeMarkup(e) {
    const st = e.to.s.status || 'idle';
    const kind = statusOf(e.to.s);
    const cls = ['topo-edge', `is-${kind}`];
    if (kind === 'live') cls.push('is-flow');
    if (hoverKey && (e.from.s.key === hoverKey || e.to.s.key === hoverKey)) cls.push('is-hi');
    const x1 = e.from.x + NODE_W;
    const y1 = e.from.y + NODE_H / 2;
    const x2 = e.to.x;
    const y2 = e.to.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="${cls.join(' ')}" data-from="${esc(e.from.s.key)}" data-to="${esc(e.to.s.key)}" style="--edge:var(--st-${stToken(st)})" d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  }

  function summaryMarkup(p) {
    const label = t('topoMoreDone')(p.count);
    return `<g class="topo-node topo-summary" data-summary="${esc(p.masterKey)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
      <title>${esc(label)}</title>
      <rect class="topo-node-bg" width="${SUMMARY_W}" height="${SUMMARY_H}" rx="6"/>
      <text class="topo-sum-title" x="${(SUMMARY_W / 2).toFixed(1)}" y="21" text-anchor="middle">${esc(label)}</text>
    </g>`;
  }

  function busMarkup(b) {
    if (!b.to) {
      const hi = hoverKey && hoverKey === b.rootKey;
      return `<path class="topo-bus${hi ? ' is-hi' : ''}" data-from="${esc(b.rootKey)}" d="${b.d}"/>`;
    }
    const kind = statusOf({ status: b.status });
    const cls = ['topo-edge', 'is-bus', `is-${kind}`];
    if (kind === 'live') cls.push('is-flow');
    if (b.summary) cls.push('is-summary');
    if (hoverKey && (b.rootKey === hoverKey || b.to === hoverKey)) cls.push('is-hi');
    return `<path class="${cls.join(' ')}" data-from="${esc(b.rootKey)}" data-to="${esc(b.to)}" style="--edge:var(--st-${stToken(b.status)})" d="${b.d}"/>`;
  }

  function draw() {
    raf = 0;
    if (!active) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const list = sessionsForGraph();
    const has = list.length > 0;
    emptyEl.hidden = has;
    if (!has) {
      edgesG.innerHTML = '';
      nodesG.innerHTML = '';
      extraG.innerHTML = '';
      viewport.setAttribute('transform', 'translate(0 0) scale(1)');
      return;
    }
    const lay = layout(list, rect.width);
    world = lay.world;
    world.liveAnchor = lay.liveAnchor ? { x: lay.liveAnchor.x, y: lay.liveAnchor.y } : null;
    if (hoverKey && !lay.pos.has(hoverKey)) {
      hoverKey = null;
      viewEl.classList.remove('is-hovering');
    }
    edgesG.innerHTML = lay.edges.map(edgeMarkup).join('') + lay.bus.map(busMarkup).join('');
    nodesG.innerHTML = [...lay.pos.values()].map((p) => (p.summary ? summaryMarkup(p) : nodeMarkup(p))).join('');
    extraG.innerHTML = lay.indepLabel
      ? `<text class="topo-sec-label" x="${PAD}" y="${lay.indepLabel.y + 16}">${esc(t('topoIndependent'))} · ${lay.indepCount}</text>`
      : '';
    if (autoFit) fit(false);
    else if (fitAll) fit(true);
    else applyTransform();
  }

  function applyTransform() {
    viewport.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})`);
  }

  function fit(enable = true) {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(1, world.w);
    // The default view frames only the master groups (the standalone section
    // may sit below the fold); the toolbar's fit button frames everything.
    const h = Math.max(1, enable ? world.h : (world.groupsH || world.h));
    const pad = 28;
    const scale = Math.max(0.15, Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h, 1.15));
    k = scale;
    tx = (rect.width - w * k) / 2;
    ty = (rect.height - h * k) / 2;
    if (enable) {
      fitAll = true;
      autoFit = false;
    } else {
      autoFit = true;
      fitAll = false;
    }
    applyTransform();
  }

  function reset() {
    autoFit = false;
    fitAll = false;
    k = 1;
    tx = PAD - world.x;
    ty = PAD - world.y;
    applyTransform();
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const wx = (px - tx) / k;
    const wy = (py - ty) / k;
    const next = Math.max(0.2, Math.min(2.5, k * factor));
    if (next === k) return;
    k = next;
    tx = px - wx * k;
    ty = py - wy * k;
    autoFit = false;
    fitAll = false;
    applyTransform();
  }

  function updateHover() {
    viewEl.classList.toggle('is-hovering', !!hoverKey);
    for (const g of nodesG.children) g.classList.toggle('is-hi', !!hoverKey && g.dataset.key === hoverKey);
    for (const p of edgesG.children) {
      if (!hoverKey) { p.classList.remove('is-hi'); continue; }
      p.classList.toggle('is-hi', p.dataset.from === hoverKey || p.dataset.to === hoverKey);
    }
  }

  function updateSelection() {
    for (const g of nodesG.children) g.classList.toggle('is-sel', !!selKey && g.dataset.key === selKey);
  }

  function schedule() {
    if (!active || raf) return;
    raf = requestAnimationFrame(draw);
  }

  function render() {
    if (!active) return;
    schedule();
  }

  function setActive(on) {
    active = !!on;
    viewEl.classList.toggle('is-live', active);
    if (!active) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      hoverKey = null;
      viewEl.classList.remove('is-hovering');
      return;
    }
    schedule();
  }

  function setSelection(key) {
    selKey = key || null;
    updateSelection();
  }

  function applyLabels() {
    fitBtn.textContent = t('topoFit');
    resetBtn.textContent = t('topoReset');
    captionEl.textContent = t('topoCaption');
    emptyEl.textContent = t('topoEmpty');
    fitBtn.title = t('topoFit');
    resetBtn.title = t('topoReset');
  }

  // ---------- interactions ----------

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.topo-tools')) return;
    drag.active = true;
    drag.moved = false;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.tx = tx;
    drag.ty = ty;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    stage.classList.add('dragging');
    autoFit = false;
    fitAll = false;
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    applyTransform();
  });
  const endDrag = () => {
    if (!drag.active) return;
    drag.active = false;
    stage.classList.remove('dragging');
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  stage.addEventListener('pointermove', (e) => {
    if (drag.active) return;
    const g = e.target.closest?.('.topo-node');
    const key = g?.dataset.key || null;
    if (key !== hoverKey) {
      hoverKey = key;
      updateHover();
    }
  });
  stage.addEventListener('pointerleave', () => {
    if (!hoverKey) return;
    hoverKey = null;
    updateHover();
  });

  stage.addEventListener('click', (e) => {
    if (suppressClick) return;
    const sum = e.target.closest?.('.topo-summary');
    if (sum) {
      expandedMasters.add(sum.dataset.summary);
      schedule();
      return;
    }
    const g = e.target.closest?.('.topo-node');
    if (!g) return;
    window.AgentDrawer?.openTask?.(g.dataset.key);
  });

  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0016);
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  fitBtn.addEventListener('click', () => fit(true));
  resetBtn.addEventListener('click', reset);

  window.addEventListener('drawer:select', (e) => setSelection(e.detail?.key || null));
  window.addEventListener('wb:filter', schedule);
  window.addEventListener('wb:query', schedule);
  window.addEventListener('wmad:theme', schedule);
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (active) schedule(); }).observe(stage);
  }

  applyLabels();
  window.Topo = {
    render,
    setActive,
    onLang: () => { applyLabels(); schedule(); },
    fit: () => fit(true),
    reset,
    debug: () => ({ active, hoverKey, selKey, world, k, tx, ty, autoFit }),
  };
})();
