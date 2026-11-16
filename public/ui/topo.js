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
  const ACTIVE = new Set(['thinking', 'tool', 'typing', 'directing']);
  const DONE = new Set(['done', 'interrupted', 'idle']);
  // What stays on the graph: work that is still moving, plus the ancestor
  // chain that anchors it. Finished branches live in the workbench.
  const LIVE_NODE = new Set(['thinking', 'tool', 'typing', 'waiting', 'error', 'directing']);
  const nowMs = () => Date.now() - (typeof state !== 'undefined' ? (state.skew || 0) : 0);

  const NODE_W = 240;
  const NODE_H = 54;
  const COL_GAP = 72;
  const ROW_GAP = 12;
  const GROUP_GAP = 24;
  const GRID_GAP = 12;
  const PAD = 32;
  const SMALL_MAX = 8;      // above this a group switches to the 2–3 column grid

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
        <div class="topo-empty" id="topoEmpty" hidden>
          <p class="topo-empty-t"></p>
          <button type="button" class="ui-btn" id="topoEmptyGo"></button>
        </div>
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
  const emptyGo = document.getElementById('topoEmptyGo');
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
  let hiddenDoneByKey = new Map();
  const drag = { active: false, moved: false, x: 0, y: 0, tx: 0, ty: 0 };
  let suppressClick = false;

  function sessionsForGraph() {
    const all = Array.isArray(state?.data?.sessions) ? state.data.sessions : [];
    // The graph exists to show delegation, so subagents stay in even when the
    // office's "show subagents" switch is off. The agent chips still apply.
    const agentOk = typeof matchAgent === 'function' ? matchAgent : () => true;
    const base = all.filter((s) => agentOk(s));
    const byRef = new Map();
    for (const s of base) {
      if (s.id) byRef.set(String(s.id), s);
      if (s.sessionId) byRef.set(String(s.sessionId), s);
    }
    const keep = new Set();
    for (const s of base) {
      if (!LIVE_NODE.has(s.status || 'idle')) continue;
      keep.add(s.key);
      let p = s.parentId ? byRef.get(String(s.parentId)) : null;
      for (let guard = 0; p && guard < 64; guard++) {
        if (p.key === s.key) break;
        keep.add(p.key);
        p = p.parentId ? byRef.get(String(p.parentId)) : null;
      }
    }
    // Completed children that are no longer drawn, counted per controller for
    // the “N more done → workbench” corner link.
    hiddenDoneByKey = new Map();
    for (const s of base) {
      const p = s.parentId ? byRef.get(String(s.parentId)) : null;
      if (!p || p.key === s.key || keep.has(s.key)) continue;
      if (!DONE.has(s.status || 'idle')) continue;
      hiddenDoneByKey.set(p.key, (hiddenDoneByKey.get(p.key) || 0) + 1);
    }
    return base.filter((s) => keep.has(s.key));
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

  const itemKey = (item) => item.key;

  function nodePos(item, x, y, h) {
    return { s: item, key: item.key, x, y: y + (h - NODE_H) / 2 };
  }

  function treeHeight(item, kids, cache, itemsOverride) {
    const key = itemKey(item);
    if (cache.has(key)) return cache.get(key);
    const ks = itemsOverride || kids.get(item.key) || [];
    let h = NODE_H;
    if (ks.length) {
      let total = 0;
      for (const kid of ks) total += treeHeight(kid, kids, cache) + ROW_GAP;
      total -= ROW_GAP;
      h = Math.max(NODE_H, total);
    }
    cache.set(key, h);
    return h;
  }

  // ---------- edges ----------

  function edgeFor(from, to, item, d) {
    return {
      from, to, d,
      status: item.status || 'idle',
      internal: !!item.internal,
    };
  }

  function curvePath(from, to) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  // A smooth path through waypoints. Consecutive points at the same y become a
  // flat stretch, so a route can slide through the gap between two nodes in a
  // column without touching either of them.
  function splinePath(points) {
    let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const mx = ((x0 + x1) / 2).toFixed(1);
      d += ` C${mx} ${y0.toFixed(1)}, ${mx} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
  }

  function nearestGap(nodes, desired) {
    if (!nodes.length) return desired;
    const gaps = [nodes[0].y - GRID_GAP / 2];
    for (let i = 0; i < nodes.length - 1; i++) gaps.push(nodes[i].y + nodes[i].h + GRID_GAP / 2);
    const last = nodes[nodes.length - 1];
    gaps.push(last.y + last.h + GRID_GAP / 2);
    let best = gaps[0];
    for (const g of gaps) if (Math.abs(g - desired) < Math.abs(best - desired)) best = g;
    return best;
  }

  // Master (or grid node) right edge → target left edge, through the gaps of
  // every column in between.
  function routePath(from, to, columns, colNodes) {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const points = [[x1, y1]];
    for (const c of columns) {
      const nodes = colNodes[c];
      if (!nodes || !nodes.length) continue;
      const colX = nodes[0].x;
      const t = clamp((colX + NODE_W / 2 - x1) / Math.max(1, x2 - x1), 0, 1);
      const gapY = nearestGap(nodes, y1 + (y2 - y1) * t);
      points.push([colX - GRID_GAP / 3, gapY], [colX + NODE_W + GRID_GAP / 3, gapY]);
    }
    points.push([x2, y2]);
    return splinePath(points);
  }

  // ---------- ordering ----------

  // Same reading order as the workbench: needs you → error → running → idle.
  // Only these four can appear on the graph.
  const RANK = { waiting: 0, error: 1, thinking: 2, tool: 2, typing: 2, directing: 2, idle: 3, interrupted: 4, done: 5 };
  const rankOf = (s) => RANK[s.status || 'idle'] ?? 3;
  const byStartDesc = (a, b) =>
    (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) || String(a.key).localeCompare(String(b.key));
  const byRank = (a, b) =>
    rankOf(a) - rankOf(b) ||
    (rankOf(a) === 2 ? byStartDesc(a, b) : (Number(b.lastEventAt) || 0) - (Number(a.lastEventAt) || 0) || byStartDesc(a, b));

  function graphKids(kids) {
    return [...kids].sort(byRank);
  }

  // ---------- placement ----------

  // Places the children of `parent` in one column, then recurses.
  function placeChildList(parentItem, parentPos, x, startY, kids, cache, pos, edges, edgeFn, itemsOverride) {
    const ks = itemsOverride || kids.get(parentItem.key) || [];
    let cy = startY;
    for (const kid of ks) {
      const h = treeHeight(kid, kids, cache);
      const p = nodePos(kid, x, cy, h);
      pos.set(itemKey(kid), p);
      edges.push(edgeFor(parentPos, p, kid, edgeFn ? edgeFn(parentPos, p, kid) : null));
      const gks = kids.get(kid.key) || [];
      if (gks.length) {
        let total = 0;
        for (const g of gks) total += treeHeight(g, kids, cache) + ROW_GAP;
        total -= ROW_GAP;
        placeChildList(kid, p, x + NODE_W + COL_GAP, p.y + (h - total) / 2, kids, cache, pos, edges, null, null);
      }
      cy += h + ROW_GAP;
    }
    return cy - ROW_GAP;
  }

  function placeGroup(rootS, items, kids, cache, y, pos, edges) {
    const h = treeHeight(rootS, kids, cache, items);
    const rootPos = { s: rootS, key: rootS.key, x: PAD, y: y + (h - NODE_H) / 2 };
    pos.set(rootS.key, rootPos);
    let total = 0;
    for (const item of items) total += treeHeight(item, kids, cache) + ROW_GAP;
    total -= ROW_GAP;
    placeChildList(rootS, rootPos, PAD + NODE_W + COL_GAP, y + (h - total) / 2, kids, cache, pos, edges, null, items);
    return h;
  }

  // 2–3 columns, chosen from the stage width the drawer leaves us.
  function gridCols(n, availW) {
    const usable = Math.max(NODE_W, (availW || 1200) - PAD * 2 - NODE_W - COL_GAP);
    const fit = Math.floor((usable + GRID_GAP) / (NODE_W + GRID_GAP));
    return Math.max(2, Math.min(3, fit, Math.max(2, n)));
  }

  // A master with many children: a 2–3 column grid, but every child still gets
  // its own curve from the master. Curves for columns 2 and 3 slide through the
  // gaps between the nodes of the columns before them.
  function placeGrid(rootS, items, f, availW, y, pos, edges) {
    const cols = gridCols(items.length, availW);
    const rows = Math.ceil(items.length / cols);
    const gridH = rows * NODE_H + (rows - 1) * GRID_GAP;
    const rootPos = { s: rootS, key: rootS.key, x: PAD, y: y + (gridH - NODE_H) / 2 };
    pos.set(rootS.key, rootPos);
    const gridX = PAD + NODE_W + COL_GAP;
    const colNodes = Array.from({ length: cols }, () => []);
    const placed = [];
    items.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridX + col * (NODE_W + GRID_GAP);
      const rowY = y + row * (NODE_H + GRID_GAP);
      const p = nodePos(item, x, rowY, NODE_H);
      pos.set(itemKey(item), p);
      colNodes[col].push({ x, y: p.y, h: NODE_H });
      placed.push({ item, p, col });
    });
    for (const { item, p, col } of placed) {
      const columns = Array.from({ length: col }, (_, i) => i);
      edges.push(edgeFor(rootPos, p, item, col === 0 ? null : routePath(rootPos, p, columns, colNodes)));
    }
    // Descendants of a grid child are rare; park them in a tail column and let
    // the first edge cross the remaining grid columns through their gaps.
    const gridRight = gridX + cols * (NODE_W + GRID_GAP) - GRID_GAP;
    let tailRight = gridRight;
    let tailBottom = y + gridH;
    const tcache = new Map();
    for (const { item, p, col } of placed) {
      const ks = f.kids.get(item.key) || [];
      if (!ks.length) continue;
      let total = 0;
      for (const kid of ks) total += treeHeight(kid, f.kids, tcache) + ROW_GAP;
      total -= ROW_GAP;
      const startY = Math.max(y, p.y + NODE_H / 2 - total / 2);
      const columns = Array.from({ length: cols - col - 1 }, (_, i) => col + 1 + i);
      const edgeFn = (from, to) => routePath(from, to, columns, colNodes);
      placeChildList(item, p, gridRight + COL_GAP, startY, f.kids, tcache, pos, edges, edgeFn, null);
      tailBottom = Math.max(tailBottom, startY + total);
      tailRight = Math.max(tailRight, gridRight + COL_GAP + NODE_W);
    }
    return { h: Math.max(NODE_H, tailBottom - y), right: tailRight };
  }

  function layout(list, availW) {
    const f = forest(list);
    const cache = new Map();
    const pos = new Map();
    const edges = [];
    let y = PAD;
    let maxRight = PAD + NODE_W;
    const addRight = (p) => {
      maxRight = Math.max(maxRight, p.x + NODE_W);
    };
    for (const rootS of f.groups) {
      const kids = f.kids.get(rootS.key) || [];
      const items = graphKids(kids);
      if (kids.length > SMALL_MAX) {
        const g = placeGrid(rootS, items, f, availW, y, pos, edges);
        maxRight = Math.max(maxRight, g.right);
        y += g.h + GROUP_GAP;
      } else {
        const groupPos = new Map();
        const groupEdges = [];
        const h = placeGroup(rootS, items, f.kids, cache, y, groupPos, groupEdges);
        for (const [key, p] of groupPos) {
          pos.set(key, p);
          addRight(p);
        }
        edges.push(...groupEdges);
        y += h + GROUP_GAP;
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
        const p = { s, key: s.key, x: PAD + c * (NODE_W + GRID_GAP), y: y + r * (NODE_H + GRID_GAP) };
        pos.set(s.key, p);
        addRight(p);
      });
      const rows = Math.ceil(f.independent.length / cols);
      y += rows * (NODE_H + GRID_GAP) - GRID_GAP;
    }
    let liveAnchor = null;
    for (const p of pos.values()) {
      if (p.s && ACTIVE.has(p.s.status) && (!liveAnchor || p.y < liveAnchor.y)) liveAnchor = p;
    }
    return { pos, edges, liveAnchor, indepLabel, indepCount: f.independent.length, world: { x: 0, y: 0, w: maxRight + PAD, h: y + PAD, groupsH } };
  }

  function subText(s, ti) {
    const st = s.status || 'idle';
    const word = (typeof L !== 'undefined' && L[st]) || st;
    if (st === 'directing') return { word, act: t('directingCount')(Number(s.runningChildren) || 0) };
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
    const internal = !!s.internal;
    const badgeW = internal ? 60 : 0;
    const title = truncate(ti.title || s.project || s.agent || '', NODE_W - titleX - 10 - (internal ? badgeW + 6 : 0), SANS);
    const { word, act } = subText(s, ti);
    const stW = measure(word, MONO);
    const actText = act && NODE_W - 20 - stW - 10 > 16 ? truncate(act, NODE_W - 20 - stW - 10, MONO) : '';
    const cls = ['topo-node', `is-${kind}`];
    if (internal) cls.push('is-internal');
    if (selKey === s.key || selected) cls.push('is-sel');
    if (hoverKey === s.key) cls.push('is-hi');
    const tip = [ti.tag, ti.title].filter(Boolean).join(' · ') || s.project || s.agent || '';
    const hiddenDone = hiddenDoneByKey.get(s.key) || 0;
    return `<g class="${cls.join(' ')}" data-key="${esc(s.key)}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})" style="--s:var(--st-${stToken(st)})">
      <title>${esc(tip)}</title>
      <rect class="topo-node-bg" width="${NODE_W}" height="${NODE_H}" rx="6"/>
      <rect class="topo-spine" x="0.5" y="1" width="3" height="${NODE_H - 2}" rx="1.5"/>
      ${tagW ? `<rect class="topo-chip" x="10" y="10" width="${tagW.toFixed(1)}" height="18" rx="9"/><text class="topo-chip-t" x="${(10 + tagW / 2).toFixed(1)}" y="23" text-anchor="middle">${esc(tagText)}</text>` : ''}
      <text class="topo-title" x="${titleX.toFixed(1)}" y="23">${esc(title)}</text>
      ${internal ? `<rect class="topo-internal-bg" x="${(NODE_W - badgeW - 8).toFixed(1)}" y="9" width="${badgeW}" height="18" rx="9"/><text class="topo-internal-t" x="${(NODE_W - badgeW / 2 - 8).toFixed(1)}" y="22" text-anchor="middle">${esc(t('topoInternal'))}</text>` : ''}
      <text class="topo-sub" x="10" y="42"><tspan class="topo-st">${esc(word)}</tspan>${actText ? `<tspan class="topo-act"> · ${esc(actText)}</tspan>` : ''}</text>
      ${hiddenDone ? `<text class="topo-more" data-more="${esc(s.key)}" x="${NODE_W - 2}" y="-6" text-anchor="end">${esc(t('topoHiddenDone')(hiddenDone))}</text>` : ''}
    </g>`;
  }

  function edgeMarkup(e) {
    const st = e.status || 'idle';
    const kind = statusOf({ status: st });
    const cls = ['topo-edge', `is-${kind}`];
    if (kind === 'live') cls.push('is-flow');
    if (e.internal) cls.push('is-internal');
    const fromKey = e.from.s ? e.from.s.key : e.from.key;
    const toKey = e.to.s ? e.to.s.key : e.to.key;
    if (hoverKey && (fromKey === hoverKey || toKey === hoverKey)) cls.push('is-hi');
    return `<path class="${cls.join(' ')}" data-from="${esc(fromKey)}" data-to="${esc(toKey)}" style="--edge:var(--st-${stToken(st)})" d="${e.d || curvePath(e.from, e.to)}"/>`;
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
    edgesG.innerHTML = lay.edges.map(edgeMarkup).join('');
    nodesG.innerHTML = [...lay.pos.values()].map((p) => nodeMarkup(p)).join('');
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
    emptyEl.querySelector('.topo-empty-t').textContent = t('topoNoLive');
    emptyGo.textContent = t('topoGoWorkbench');
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
    const more = e.target.closest?.('.topo-more');
    if (more) {
      // The corner link leads to the workbench, filtered to this controller's
      // group; it must not also open the node's drawer.
      window.Workbench?.focusGroup?.(more.dataset.more);
      return;
    }
    const g = e.target.closest?.('.topo-node');
    if (!g) return;
    window.AgentDrawer?.openTask?.(g.dataset.key);
  });

  emptyGo.addEventListener('click', () => {
    window.Workbench?.clearFocus?.();
    if (typeof goToScreen === 'function') goToScreen('workbench');
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
    debug: () => ({
      active, hoverKey, selKey, world, k, tx, ty, autoFit,
      nodes: nodesG.children.length,
      keys: [...nodesG.children].map((g) => g.dataset.key),
      hiddenDone: [...hiddenDoneByKey],
    }),
  };
})();
