#!/usr/bin/env node
'use strict';

// Builds a throwaway home directory full of demo agent logs, for screenshots
// or for trying the dashboard without exposing a real machine's sessions.
// Only writes inside --out. Usage:
//   node scripts/make-demo-data.js --out <dir>
//   node scripts/make-demo-data.js --out <dir> --heartbeat
// --heartbeat keeps the two running demo runs "alive" by appending stream
// status lines, so live states stay live while screenshots are taken.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const outArg = opt('--out');
const heartbeat = argv.includes('--heartbeat');
if (!outArg) {
  console.error('usage: node scripts/make-demo-data.js --out <dir> [--heartbeat]');
  process.exit(1);
}
const out = path.resolve(outArg);
if (out === path.parse(out).root || out === path.resolve(os.homedir())) {
  console.error('refusing to use that directory as the demo home');
  process.exit(1);
}

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');
const uid = () => crypto.randomUUID();
const SESSION = {
  m1: '3f1c2a9e-7b64-4d21-9a0e-5c8d1e2f4a10',
  m2: '8b2d4c6f-1a35-4e70-b9d2-6f7a3c5e8d21',
  s1: '5c7e9a1b-3d52-4f86-8a0c-2e4b6d8f0a31',
  s2: '9d4f6b8c-2e71-4a95-b3d7-8c1e5a7f9b42',
};
const SHOP = 'D:/demo/demo-shop';
const BLOG = 'D:/demo/blog-engine';
const CLAUDE_DIR = path.join(out, '.claude');
const PROJECT_SHOP = path.join(CLAUDE_DIR, 'projects', 'D--demo-demo-shop');
const PROJECT_BLOG = path.join(CLAUDE_DIR, 'projects', 'D--demo-blog-engine');
const RUNS = path.join(CLAUDE_DIR, 'deepseek-runs');
// The desktop app's per-conversation records, read (never written) by
// src/claude-titles.js. Their title wins over the ai-title line in the log.
const CLIENT_ROOT = path.join(out, 'AppData', 'Local', 'Claude-Data', 'claude_demo', 'claude-code-sessions', 'demo', 'demo');

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function touch(file, ms) {
  try { fs.utimesSync(file, new Date(ms), new Date(ms)); } catch {}
}
function runBase(ms) {
  const d = new Date(ms);
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function usage(inTok, outTok) {
  return {
    input_tokens: inTok,
    cache_creation_input_tokens: 640,
    cache_read_input_tokens: 18000 + (inTok % 5000),
    output_tokens: outTok,
  };
}

// ---------------------------------------------------------------- heartbeat

if (heartbeat) {
  const manifest = path.join(out, '.demo-live.json');
  let live = [];
  try { live = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch {}
  if (!live.length) {
    console.error(`no live runs listed in ${manifest}; run without --heartbeat first`);
    process.exit(1);
  }
  for (const file of live) {
    const metaFile = file.replace(/\.jsonl$/, '.meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      meta.pid = process.pid;
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    } catch {}
  }
  const beat = () => {
    for (const file of live) {
      try {
        fs.appendFileSync(file, JSON.stringify({
          type: 'system', subtype: 'status', status: 'requesting', timestamp: new Date().toISOString(),
        }) + '\n');
      } catch {}
    }
  };
  beat();
  setInterval(beat, 8000);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.log(`heartbeat: ${live.length} live run(s) under ${out}`);
  return;
}

// ------------------------------------------------------------- demo content

for (const dir of [PROJECT_SHOP, PROJECT_BLOG, RUNS]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ------------------------------------------------------- Claude Code writer

function claudeWriter(sid, cwd, firstAt) {
  const rows = [];
  let prev = null;
  let seq = 0;
  const base = () => ({
    sessionId: sid, cwd, version: '2.0.31', gitBranch: 'main',
    uuid: uid(), parentUuid: prev,
  });
  const push = (line) => { rows.push(line); prev = line.uuid; return line; };
  const user = (at, text) => push({
    ...base(), type: 'user', timestamp: iso(at), isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const toolResult = (at, toolUseId, text) => push({
    ...base(), type: 'user', timestamp: iso(at), isSidechain: false, userType: 'external',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
  });
  const assistant = (at, blocks, stopReason = null, tokIn = 900, tokOut = 220) => {
    const line = push({
      ...base(), type: 'assistant', timestamp: iso(at),
      message: {
        id: `msg_demo_${++seq}`, type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-5-20250929', content: blocks,
        stop_reason: stopReason, usage: usage(tokIn, tokOut),
      },
    });
    return line;
  };
  const toolUse = (at, id, name, input, tokOut = 180) => assistant(at, [{ type: 'tool_use', id, name, input }], null, 1400, tokOut);
  const title = (at, text) => push({
    sessionId: sid, type: 'ai-title', aiTitle: text, timestamp: iso(at), uuid: uid(), parentUuid: prev,
  });
  const save = (file) => {
    writeJsonl(file, rows);
    touch(file, firstAt);
    return rows;
  };
  return { user, toolResult, assistant, toolUse, title, save };
}

// ------------------------------------------------------ DeepSeek run writer

function dsWriter(sid, cwd, start) {
  const rows = [];
  let seq = 0;
  const init = () => rows.push({
    type: 'system', subtype: 'init', session_id: sid, cwd, model: 'claude-opus-4-5',
    permissionMode: 'bypassPermissions', apiKeySource: 'none', output_style: 'default',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], timestamp: iso(start),
  });
  const thinkingTokens = (at, n) => rows.push({
    type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, session_id: sid, timestamp: iso(at),
  });
  const thinking = (at, text) => rows.push({
    type: 'assistant', session_id: sid, timestamp: iso(at),
    message: {
      id: `msg_ds_${++seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-5',
      content: [{ type: 'thinking', thinking: text }], stop_reason: null,
      usage: { input_tokens: 2200 + seq * 90, output_tokens: 260 },
    },
  });
  const tool = (at, id, name, input) => rows.push({
    type: 'assistant', session_id: sid, timestamp: iso(at),
    message: {
      id: `msg_ds_${++seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-5',
      content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use',
      usage: { input_tokens: 2600 + seq * 110, output_tokens: 180 },
    },
  });
  const result = (at, id, text) => rows.push({
    type: 'user', session_id: sid, timestamp: iso(at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
  });
  const say = (at, text) => rows.push({
    type: 'assistant', session_id: sid, timestamp: iso(at),
    message: {
      id: `msg_ds_${++seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-5',
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 4200, output_tokens: 520 },
    },
  });
  const finish = (at, { text, isError = false, turns = 8, cost = 0.12, outTokens = 2400, thinkTokens = 1600 }) => rows.push({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
    duration_ms: Math.max(1000, at - start), num_turns: turns, result: text,
    session_id: sid, total_cost_usd: cost,
    usage: { input_tokens: 42000, output_tokens: outTokens, output_tokens_details: { thinking_tokens: thinkTokens } },
    timestamp: iso(at),
  });
  return { rows, init, thinkingTokens, thinking, tool, result, say, finish };
}

const liveRuns = [];
const usedBases = new Set();
function saveRun(base, prompt, cwd, parent, start, lastAt, rows) {
  // Two runs can start in the same second; the real script names files by the
  // second, so nudge a colliding demo run forward until its name is unique.
  let at = start;
  while (usedBases.has(base)) {
    at += 1000;
    base = runBase(at);
  }
  usedBases.add(base);
  const file = path.join(RUNS, base + '.jsonl');
  const metaFile = path.join(RUNS, base + '.meta.json');
  writeJsonl(file, rows);
  fs.writeFileSync(metaFile, JSON.stringify({
    prompt, cwd, effort: 'max', model: 'claude-opus-4-5', pid: null,
    started_ts: Math.floor(start / 1000), parent_session_id: parent,
  }, null, 2));
  touch(file, lastAt);
  touch(metaFile, lastAt);
  return base;
}

// ------------------------------------------------------------- master 1

{
  const start = now - 175 * MIN;
  const last = now - 12 * MIN;
  const w = claudeWriter(SESSION.m1, SHOP, start);
  w.user(start, '任务：demo-shop 上线前收尾。请按 T1–T5 分派给 DeepSeek 子代理，完成后汇总。工作目录 D:/demo/demo-shop。');
  w.title(start + 4000, 'demo-shop 上线前整理');
  const delegations = [
    ['T1', '重构登录表单校验', start + 3 * MIN],
    ['T4', '给订单模块写单元测试', start + 5 * MIN],
    ['T5', '整理 README 与 API 文档', start + 7 * MIN],
    ['T2', '给订单接口加分页', last - 14 * MIN],
    ['T3', '修复图片懒加载闪烁', last - 10 * MIN],
  ];
  for (const [tag, title, at] of delegations) {
    const id = `toolu_demo_m1_${tag}`;
    w.toolUse(at, id, 'Bash', {
      command: `python ask_deepseek.py "任务 ${tag}：${title}" --cwd D:/demo/demo-shop --effort max`,
      description: `派发子代理 ${tag}`,
    });
    if (tag === 'T1' || tag === 'T4' || tag === 'T5') {
      w.toolResult(at + 9 * MIN, id, `子代理已完成。\n完整记录 ~/.claude/deepseek-runs/${tag === 'T1' ? 'run-20261116-141820' : tag === 'T4' ? 'run-20261116-142035' : 'run-20261116-142250'}.jsonl`);
    }
  }
  w.assistant(last, [{
    type: 'text',
    text: '本轮分派完成：T1、T4、T5 已验收通过；T2、T3 仍在运行，回报后我会统一汇总。\n\n- T1 登录表单校验重构（3 个文件）\n- T4 订单模块单元测试（12 个用例）\n- T5 README 与 API 文档整理\n\n详细记录见各子代理的 run 文件。',
  }], 'end_turn', 2600, 460);
  w.save(path.join(PROJECT_SHOP, SESSION.m1 + '.jsonl'));
}

// ------------------------------------------------------------- master 2

{
  const start = now - 140 * MIN;
  const last = now - 25 * MIN;
  const w = claudeWriter(SESSION.m2, BLOG, start);
  w.user(start, '任务：blog-engine 发布前检查，按 T6–T11 分派给子代理。工作目录 D:/demo/blog-engine。');
  w.title(start + 5000, 'blog-engine 发布前检查');
  const delegations = [
    ['T6', '修复构建脚本', start + 4 * MIN, 'error'],
    ['T7', '给文章页加目录锚点', start + 6 * MIN],
    ['T8', '生成站点地图', start + 9 * MIN],
    ['T9', '给搜索接口加限流', start + 12 * MIN],
    ['T10', '迁移到 ESLint 9', start + 15 * MIN],
    ['T11', '写发布说明', start + 18 * MIN],
  ];
  for (const [tag, title, at, kind] of delegations) {
    const id = `toolu_demo_m2_${tag}`;
    w.toolUse(at, id, 'Bash', {
      command: `python ask_deepseek.py "任务 ${tag}：${title}" --cwd D:/demo/blog-engine --effort max`,
      description: `派发子代理 ${tag}`,
    });
    w.toolResult(at + 7 * MIN, id, kind === 'error'
      ? `子代理以错误结束。\n完整记录 ~/.claude/deepseek-runs/run-20261116-144505.jsonl`
      : `子代理已完成。\n完整记录 ~/.claude/deepseek-runs/run-20261116-144820.jsonl`);
  }
  w.assistant(last, [{
    type: 'tool_use', id: 'toolu_demo_ask_1', name: 'AskUserQuestion',
    input: {
      questions: [{
        question: '首页文章摘要的截断长度用 120 字还是 160 字？',
        header: '摘要长度',
        multiSelect: false,
        options: [
          { label: '120 字', description: '列表更紧凑，移动端一屏能多看一条' },
          { label: '160 字', description: '信息量更大，卡片高度会增加' },
        ],
      }],
    },
  }], 'tool_use', 3200, 240);
  w.save(path.join(PROJECT_BLOG, SESSION.m2 + '.jsonl'));
}

// --------------------------------------------------------- standalone 1

{
  const start = now - 120 * MIN;
  const last = now - 100 * MIN;
  const w = claudeWriter(SESSION.s1, SHOP, start);
  w.user(start, '给购物车加优惠券校验，覆盖过期券和最低消费门槛。');
  w.title(start + 3000, '购物车优惠券校验');
  w.toolUse(start + 20_000, 'toolu_demo_s1_1', 'Read', { file_path: `${SHOP}/src/cart/cart.js` });
  w.toolResult(start + 24_000, 'toolu_demo_s1_1', 'export function addToCart(cart, item) { ... }');
  w.toolUse(start + 2 * MIN, 'toolu_demo_s1_2', 'Write', {
    file_path: `${SHOP}/src/cart/coupon.js`,
    content: 'export function validateCoupon(coupon, cart, now = Date.now()) { ... }',
  });
  w.toolResult(start + 2 * MIN + 8000, 'toolu_demo_s1_2', 'File created successfully.');
  w.toolUse(start + 4 * MIN, 'toolu_demo_s1_3', 'Edit', {
    file_path: `${SHOP}/src/cart/cart.js`,
    old_string: 'const total = items.reduce(sum, 0);',
    new_string: 'const total = applyCoupon(items, coupon);',
  });
  w.toolResult(start + 4 * MIN + 6000, 'toolu_demo_s1_3', 'Applied 1 edit.');
  w.assistant(last, [{
    type: 'text',
    text: '优惠券校验已完成：过期券、未达门槛、重复叠加三种情况都会返回明确的错误码；购物车总额改为统一走 applyCoupon。改动文件：src/cart/coupon.js（新增）、src/cart/cart.js。',
  }], 'end_turn', 1800, 340);
  w.save(path.join(PROJECT_SHOP, SESSION.s1 + '.jsonl'));
}

// --------------------------------------------------------- standalone 2

{
  const start = now - 35 * MIN;
  const last = now - 6 * MIN;
  const w = claudeWriter(SESSION.s2, BLOG, start);
  w.user(start, '清理 package.json 里没用的依赖，先跑一遍检查。');
  w.title(start + 3000, '清理无用依赖');
  w.toolUse(start + 30_000, 'toolu_demo_s2_1', 'Read', { file_path: `${BLOG}/package.json` });
  w.toolResult(start + 35_000, 'toolu_demo_s2_1', '{ "dependencies": { ... } }');
  w.toolUse(start + 2 * MIN, 'toolu_demo_s2_2', 'Grep', { pattern: 'lodash|moment', path: `${BLOG}/src` });
  w.toolResult(start + 2 * MIN + 7000, 'toolu_demo_s2_2', 'src/lib/format.js:3:import debounce from "lodash/debounce";');
  w.toolUse(last, 'toolu_demo_s2_3', 'Bash', {
    command: 'npm run lint',
    description: '检查未使用依赖',
  });
  w.save(path.join(PROJECT_BLOG, SESSION.s2 + '.jsonl'));
  liveRuns.push(path.join(PROJECT_BLOG, SESSION.s2 + '.jsonl'));
}

// -------------------------------------------------------- DeepSeek children

// T1 — done, with a Markdown table in the final answer.
{
  const start = now - 160 * MIN;
  const end = now - 140 * MIN;
  const sid = uid();
  const d = dsWriter(sid, SHOP, start);
  d.init();
  d.thinkingTokens(start + 5000, 480);
  d.thinking(start + 8000, '先读现有的登录表单和校验工具，确认规则写在哪一层。');
  d.tool(start + 20_000, 'toolu_ds_t1_1', 'Read', { file_path: `${SHOP}/src/components/LoginForm.jsx` });
  d.result(start + 24_000, 'toolu_ds_t1_1', 'export function LoginForm() { /* 内联正则校验 */ }');
  d.tool(start + 40_000, 'toolu_ds_t1_2', 'Read', { file_path: `${SHOP}/src/lib/validate.js` });
  d.result(start + 44_000, 'toolu_ds_t1_2', 'export const isEmail = (v) => /.../.test(v);');
  d.say(start + 70_000, '现有校验把邮箱、密码和确认密码的规则都写在组件里，我先抽到 validate.js，再让表单调用共享校验。');
  d.tool(start + 2 * MIN, 'toolu_ds_t1_3', 'Edit', {
    file_path: `${SHOP}/src/lib/validate.js`,
    old_string: 'export const isEmail = ...',
    new_string: 'export function validateLogin({ email, password, confirm }) { ... }',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t1_3', 'Applied 1 edit.');
  d.tool(start + 4 * MIN, 'toolu_ds_t1_4', 'Write', {
    file_path: `${SHOP}/src/components/LoginForm.jsx`,
    content: 'import { validateLogin } from "../lib/validate";',
  });
  d.result(start + 4 * MIN + 5000, 'toolu_ds_t1_4', 'File written successfully.');
  d.tool(start + 6 * MIN, 'toolu_ds_t1_5', 'Write', {
    file_path: `${SHOP}/tests/loginForm.test.js`,
    content: 'describe("validateLogin", () => { ... });',
  });
  d.result(start + 6 * MIN + 5000, 'toolu_ds_t1_5', 'File written successfully.');
  d.say(start + 9 * MIN, '重构完成，补充了 8 个边界用例，本地全部通过。');
  d.finish(end, {
    turns: 9, cost: 0.1834, outTokens: 5400, thinkTokens: 3200,
    text: '已完成登录表单校验重构。\n\n| 文件 | 改动 |\n|---|---|\n| src/lib/validate.js | 抽出 validateLogin，统一邮箱、密码、确认密码规则 |\n| src/components/LoginForm.jsx | 改为调用共享校验，移除内联正则 |\n| tests/loginForm.test.js | 新增 8 个边界用例（空值、超长、Unicode 邮箱） |\n\n验证：npm test -- loginForm 全部通过（8 passed）。',
  });
  saveRun(runBase(start), '任务 T1：重构登录表单校验', SHOP, SESSION.m1, start, end, d.rows);
}

// T4 — done.
{
  const start = now - 130 * MIN;
  const end = now - 118 * MIN;
  const sid = uid();
  const d = dsWriter(sid, SHOP, start);
  d.init();
  d.thinkingTokens(start + 4000, 260);
  d.thinking(start + 6000, '先看订单服务的导出结构，再决定测试边界。');
  d.tool(start + 15_000, 'toolu_ds_t4_1', 'Read', { file_path: `${SHOP}/src/server/services/orders.js` });
  d.result(start + 19_000, 'toolu_ds_t4_1', 'export async function listOrders(userId, page) { ... }');
  d.tool(start + 60_000, 'toolu_ds_t4_2', 'Write', {
    file_path: `${SHOP}/tests/orders.test.js`,
    content: 'describe("orders service", () => { ... });',
  });
  d.result(start + 65_000, 'toolu_ds_t4_2', 'File written successfully.');
  d.tool(start + 3 * MIN, 'toolu_ds_t4_3', 'Write', {
    file_path: `${SHOP}/tests/fixtures/orders.json`,
    content: '[{ "id": "o_1001", "total": 129.9 }]',
  });
  d.result(start + 3 * MIN + 4000, 'toolu_ds_t4_3', 'File written successfully.');
  d.tool(start + 5 * MIN, 'toolu_ds_t4_4', 'Bash', { command: 'npm test -- orders', description: '运行订单测试' });
  d.result(start + 5 * MIN + 20_000, 'toolu_ds_t4_4', 'Test Suites: 1 passed\nTests: 12 passed');
  d.finish(end, {
    turns: 7, cost: 0.0962, outTokens: 3100, thinkTokens: 1400,
    text: '订单模块单元测试已补齐。\n\n| 文件 | 改动 |\n|---|---|\n| tests/orders.test.js | 新增 12 个用例，覆盖分页、空结果、金额边界 |\n| tests/fixtures/orders.json | 新增订单测试夹具 |\n\n验证：npm test -- orders 12 passed。',
  });
  saveRun(runBase(start), '任务 T4：给订单模块写单元测试', SHOP, SESSION.m1, start, end, d.rows);
}

// T5 — done.
{
  const start = now - 110 * MIN;
  const end = now - 100 * MIN;
  const sid = uid();
  const d = dsWriter(sid, SHOP, start);
  d.init();
  d.thinking(start + 7000, 'README 里还留着旧的启动步骤，先对照 package.json 和现有接口。');
  d.tool(start + 20_000, 'toolu_ds_t5_1', 'Read', { file_path: `${SHOP}/README.md` });
  d.result(start + 24_000, 'toolu_ds_t5_1', '# demo-shop\n\n旧版启动说明……');
  d.tool(start + 40_000, 'toolu_ds_t5_2', 'Read', { file_path: `${SHOP}/src/server/routes/orders.js` });
  d.result(start + 44_000, 'toolu_ds_t5_2', 'router.get("/orders", listOrders);');
  d.tool(start + 2 * MIN, 'toolu_ds_t5_3', 'Write', {
    file_path: `${SHOP}/README.md`,
    content: '# demo-shop\n\n## 启动\n\nnpm install\nnpm run dev',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t5_3', 'File written successfully.');
  d.tool(start + 4 * MIN, 'toolu_ds_t5_4', 'Write', {
    file_path: `${SHOP}/docs/api.md`,
    content: '# API\n\n## GET /api/orders?page=1&size=20',
  });
  d.result(start + 4 * MIN + 5000, 'toolu_ds_t5_4', 'File written successfully.');
  d.finish(end, {
    turns: 6, cost: 0.0715, outTokens: 2600, thinkTokens: 900,
    text: '文档整理完成。\n\n| 文件 | 改动 |\n|---|---|\n| README.md | 更新安装、启动、测试命令 |\n| docs/api.md | 补齐订单与商品接口的参数和返回示例 |\n\n所有命令已在本地跑通。',
  });
  saveRun(runBase(start), '任务 T5：整理 README 与 API 文档', SHOP, SESSION.m1, start, end, d.rows);
}

// T2 — running: writing the orders route right now.
{
  const start = now - 25 * MIN;
  const sid = uid();
  const d = dsWriter(sid, SHOP, start);
  d.init();
  d.thinkingTokens(start + 5000, 620);
  d.thinking(start + 9000, '分页参数要兼容旧的 page/size，同时补一个 cursor 入口。');
  d.tool(start + 25_000, 'toolu_ds_t2_1', 'Read', { file_path: `${SHOP}/src/server/routes/orders.js` });
  d.result(start + 30_000, 'toolu_ds_t2_1', 'router.get("/orders", async (req, res) => { const rows = await listOrders(req.user.id); res.json(rows); });');
  d.tool(start + 3 * MIN, 'toolu_ds_t2_2', 'Read', { file_path: `${SHOP}/src/server/services/orders.js` });
  d.result(start + 3 * MIN + 5000, 'toolu_ds_t2_2', 'export async function listOrders(userId, page = 1, size = 20) { ... }');
  d.say(start + 6 * MIN, '服务层已经支持 page/size，我补上参数校验和响应里的分页元信息。');
  d.tool(start + 9 * MIN, 'toolu_ds_t2_3', 'Edit', {
    file_path: `${SHOP}/src/server/services/orders.js`,
    old_string: 'return { rows, total };',
    new_string: 'return { rows, total, page, size, pages: Math.ceil(total / size) };',
  });
  d.result(start + 9 * MIN + 5000, 'toolu_ds_t2_3', 'Applied 1 edit.');
  d.tool(now - 8000, 'toolu_ds_t2_4', 'Write', {
    file_path: `${SHOP}/src/server/routes/orders.js`,
    content: 'router.get("/orders", async (req, res) => { const { page, size } = parsePaging(req.query); ... });',
  });
  liveRuns.push(path.join(RUNS, saveRun(runBase(start), '任务 T2：给订单接口加分页', SHOP, SESSION.m1, start, now - 8000, d.rows) + '.jsonl'));
}

// T3 — running: thinking about the lazy-image flicker.
{
  const start = now - 18 * MIN;
  const sid = uid();
  const d = dsWriter(sid, SHOP, start);
  d.init();
  d.thinkingTokens(start + 4000, 540);
  d.thinking(start + 8000, '闪烁通常来自占位高度为 0，图片加载完成后触发布局跳动。');
  d.tool(start + 20_000, 'toolu_ds_t3_1', 'Read', { file_path: `${SHOP}/src/components/ProductImage.jsx` });
  d.result(start + 24_000, 'toolu_ds_t3_1', 'export function ProductImage({ src, alt }) { return <img src={src} alt={alt} />; }');
  d.tool(start + 2 * MIN, 'toolu_ds_t3_2', 'Edit', {
    file_path: `${SHOP}/src/components/ProductImage.jsx`,
    old_string: 'return <img src={src} alt={alt} />;',
    new_string: 'return <img src={src} alt={alt} width={width} height={height} loading="lazy" />;',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t3_2', 'Applied 1 edit.');
  d.thinking(now - 7000, '还要确认列表容器有没有固定宽高比，否则图片解码后仍会撑开行高。下一步检查 ProductGrid 的 CSS。');
  liveRuns.push(path.join(RUNS, saveRun(runBase(start), '任务 T3：修复图片懒加载闪烁', SHOP, SESSION.m1, start, now - 7000, d.rows) + '.jsonl'));
}

// T6 — finished with an error.
{
  const start = now - 90 * MIN;
  const end = now - 70 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 8000, '构建脚本最近改过输出目录，先复现一次失败。');
  d.tool(start + 25_000, 'toolu_ds_t6_1', 'Read', { file_path: `${BLOG}/scripts/build.js` });
  d.result(start + 30_000, 'toolu_ds_t6_1', 'import { build } from "vite";');
  d.tool(start + 2 * MIN, 'toolu_ds_t6_2', 'Bash', { command: 'npm run build', description: '复现构建失败' });
  d.result(start + 3 * MIN, 'toolu_ds_t6_2', 'Error: Cannot find module "sharp" native binding\n    at ...\nexit code 1');
  d.say(start + 5 * MIN, '失败发生在 rollup 解析 sharp 的原生依赖时，先试一次清理缓存重装。');
  d.tool(start + 7 * MIN, 'toolu_ds_t6_3', 'Bash', { command: 'npm rebuild sharp', description: '重建原生依赖' });
  d.result(start + 8 * MIN, 'toolu_ds_t6_3', 'gyp ERR! build error\nexit code 1');
  d.finish(end, {
    isError: true, turns: 6, cost: 0.0887, outTokens: 2800, thinkTokens: 1800,
    text: '构建失败：vite build 退出码 1。\n\n原因：rollup 无法解析 optional dependency sharp 的 native binding，npm rebuild 同样失败。\n建议：锁定 sharp 到 0.33.x 的预编译包，或在 CI 里跳过图片压缩插件。',
  });
  saveRun(runBase(start), '任务 T6：修复构建脚本', BLOG, SESSION.m2, start, end, d.rows);
}

// T7 — done.
{
  const start = now - 80 * MIN;
  const end = now - 68 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 6000, '目录锚点要跟着标题生成，还要处理重复标题。');
  d.tool(start + 18_000, 'toolu_ds_t7_1', 'Read', { file_path: `${BLOG}/src/pages/Post.jsx` });
  d.result(start + 22_000, 'toolu_ds_t7_1', 'export default function Post({ article }) { ... }');
  d.tool(start + 2 * MIN, 'toolu_ds_t7_2', 'Write', {
    file_path: `${BLOG}/src/lib/toc.js`,
    content: 'export function buildToc(markdown) { ... }',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t7_2', 'File written successfully.');
  d.tool(start + 4 * MIN, 'toolu_ds_t7_3', 'Edit', {
    file_path: `${BLOG}/src/pages/Post.jsx`,
    old_string: '<article dangerouslySetInnerHTML={{ __html: html }} />',
    new_string: '<aside><Toc items={toc} /></aside>\n<article ... />',
  });
  d.result(start + 4 * MIN + 5000, 'toolu_ds_t7_3', 'Applied 1 edit.');
  d.finish(end, {
    turns: 7, cost: 0.0791, outTokens: 2900, thinkTokens: 1100,
    text: '文章页目录已完成。\n\n| 文件 | 改动 |\n|---|---|\n| src/lib/toc.js | 从 Markdown 标题生成锚点，重复标题自动加序号 |\n| src/pages/Post.jsx | 桌面端显示右侧目录，移动端折叠 |\n\n已用三篇长文验证锚点跳转。',
  });
  saveRun(runBase(start), '任务 T7：给文章页加目录锚点', BLOG, SESSION.m2, start, end, d.rows);
}

// T8 — done.
{
  const start = now - 65 * MIN;
  const end = now - 55 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 5000, '站点地图要从构建产物里读文章列表，避免和路由重复维护。');
  d.tool(start + 20_000, 'toolu_ds_t8_1', 'Read', { file_path: `${BLOG}/src/lib/posts.js` });
  d.result(start + 24_000, 'toolu_ds_t8_1', 'export async function allPosts() { ... }');
  d.tool(start + 2 * MIN, 'toolu_ds_t8_2', 'Write', {
    file_path: `${BLOG}/scripts/sitemap.js`,
    content: 'import { allPosts } from "../src/lib/posts.js";',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t8_2', 'File written successfully.');
  d.tool(start + 4 * MIN, 'toolu_ds_t8_3', 'Bash', { command: 'node scripts/sitemap.js', description: '生成 sitemap' });
  d.result(start + 4 * MIN + 4000, 'toolu_ds_t8_3', 'wrote public/sitemap.xml (48 urls)');
  d.finish(end, {
    turns: 5, cost: 0.0523, outTokens: 1900, thinkTokens: 700,
    text: '站点地图生成脚本已就绪。\n\n| 文件 | 改动 |\n|---|---|\n| scripts/sitemap.js | 读取文章列表，输出 sitemap.xml |\n| public/sitemap.xml | 48 条 URL，含更新时间和优先级 |\n\n已加入 npm run build 的收尾步骤。',
  });
  saveRun(runBase(start), '任务 T8：生成站点地图', BLOG, SESSION.m2, start, end, d.rows);
}

// T9 — done.
{
  const start = now - 50 * MIN;
  const end = now - 42 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 6000, '搜索接口没有限流，先按 IP 做令牌桶，阈值放到配置里。');
  d.tool(start + 18_000, 'toolu_ds_t9_1', 'Read', { file_path: `${BLOG}/src/server/search.js` });
  d.result(start + 22_000, 'toolu_ds_t9_1', 'router.get("/api/search", async (req, res) => { ... });');
  d.tool(start + 2 * MIN, 'toolu_ds_t9_2', 'Write', {
    file_path: `${BLOG}/src/server/rateLimit.js`,
    content: 'export function tokenBucket({ capacity, refillPerSec }) { ... }',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t9_2', 'File written successfully.');
  d.tool(start + 4 * MIN, 'toolu_ds_t9_3', 'Edit', {
    file_path: `${BLOG}/src/server/search.js`,
    old_string: 'router.get("/api/search", async (req, res) => {',
    new_string: 'router.get("/api/search", limit(searchLimiter), async (req, res) => {',
  });
  d.result(start + 4 * MIN + 5000, 'toolu_ds_t9_3', 'Applied 1 edit.');
  d.finish(end, {
    turns: 6, cost: 0.0617, outTokens: 2200, thinkTokens: 950,
    text: '搜索接口限流已完成。\n\n| 文件 | 改动 |\n|---|---|\n| src/server/rateLimit.js | 新增按 IP 的令牌桶实现 |\n| src/server/search.js | 搜索路由接入限流中间件，超限返回 429 |\n\n默认 30 次/分钟，可用 SEARCH_RATE_LIMIT 覆盖。',
  });
  saveRun(runBase(start), '任务 T9：给搜索接口加限流', BLOG, SESSION.m2, start, end, d.rows);
}

// T10 — done.
{
  const start = now - 38 * MIN;
  const end = now - 28 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 5000, 'ESLint 9 默认用 flat config，旧的 .eslintrc 要整体迁过去。');
  d.tool(start + 15_000, 'toolu_ds_t10_1', 'Read', { file_path: `${BLOG}/.eslintrc.json` });
  d.result(start + 19_000, 'toolu_ds_t10_1', '{ "extends": ["eslint:recommended", "plugin:react/recommended"] }');
  d.tool(start + 2 * MIN, 'toolu_ds_t10_2', 'Write', {
    file_path: `${BLOG}/eslint.config.js`,
    content: 'import js from "@eslint/js";\nexport default [js.configs.recommended, ...];',
  });
  d.result(start + 2 * MIN + 5000, 'toolu_ds_t10_2', 'File written successfully.');
  d.tool(start + 4 * MIN, 'toolu_ds_t10_3', 'Bash', { command: 'npm run lint', description: '验证 ESLint 9 配置' });
  d.result(start + 4 * MIN + 15_000, 'toolu_ds_t10_3', '✖ 3 problems (0 errors, 3 warnings)');
  d.finish(end, {
    turns: 6, cost: 0.0702, outTokens: 2500, thinkTokens: 1000,
    text: 'ESLint 9 迁移完成。\n\n| 文件 | 改动 |\n|---|---|\n| eslint.config.js | 新增 flat config，合并推荐规则与 React 规则 |\n| package.json | eslint 升到 ^9.17.0，移除旧插件 |\n\nnpm run lint 通过，仅剩 3 条 no-console 警告。',
  });
  saveRun(runBase(start), '任务 T10：迁移到 ESLint 9', BLOG, SESSION.m2, start, end, d.rows);
}

// T11 — done.
{
  const start = now - 25 * MIN;
  const end = now - 20 * MIN;
  const sid = uid();
  const d = dsWriter(sid, BLOG, start);
  d.init();
  d.thinking(start + 4000, '发布说明按新增、修复、升级三类整理，链接到对应提交。');
  d.tool(start + 12_000, 'toolu_ds_t11_1', 'Bash', { command: 'git log --oneline v1.3.0..HEAD', description: '收集本次提交' });
  d.result(start + 16_000, 'toolu_ds_t11_1', 'a1b2c3d 目录锚点\nb2c3d4e 站点地图\nc3d4e5f 搜索限流');
  d.tool(start + 60_000, 'toolu_ds_t11_2', 'Write', {
    file_path: `${BLOG}/CHANGELOG.md`,
    content: '# 1.4.0\n\n## 新增\n- 文章页目录锚点\n- 站点地图',
  });
  d.result(start + 65_000, 'toolu_ds_t11_2', 'File written successfully.');
  d.finish(end, {
    turns: 4, cost: 0.0388, outTokens: 1500, thinkTokens: 500,
    text: '发布说明已整理。\n\n| 文件 | 改动 |\n|---|---|\n| CHANGELOG.md | 新增 1.4.0 段落：目录锚点、站点地图、搜索限流 |\n\n已按新增 / 修复 / 升级分组，并链接到对应提交。',
  });
  saveRun(runBase(start), '任务 T11：写发布说明', BLOG, SESSION.m2, start, end, d.rows);
}

fs.writeFileSync(path.join(out, '.demo-live.json'), JSON.stringify(liveRuns, null, 2));

// Demo client titles. Different from the ai-title lines on purpose: the
// screenshots should show the desktop app's name winning, like a rename.
fs.rmSync(CLIENT_ROOT, { recursive: true, force: true });
fs.mkdirSync(CLIENT_ROOT, { recursive: true });
function writeClientTitle(cliSessionId, cwd, title, at) {
  const local = `local_${uid()}`;
  fs.writeFileSync(path.join(CLIENT_ROOT, `${local}.json`), JSON.stringify({
    sessionId: local, cliSessionId, cwd, title, titleSource: 'user',
    isArchived: false, createdAt: at - 60_000, lastActivityAt: at,
  }, null, 2));
}
writeClientTitle(SESSION.m1, SHOP, '演示商店上线收尾', now - 12 * MIN);
writeClientTitle(SESSION.m2, BLOG, '演示博客发布检查', now - 25 * MIN);
writeClientTitle(SESSION.s1, SHOP, '演示购物车优惠券', now - 100 * MIN);
writeClientTitle(SESSION.s2, BLOG, '演示依赖清理', now - 6 * MIN);

console.log(`demo home ready: ${out}`);
console.log(`  ${PROJECT_SHOP}`);
console.log(`  ${PROJECT_BLOG}`);
console.log(`  ${RUNS} (${fs.readdirSync(RUNS).filter((f) => f.endsWith('.jsonl')).length} runs)`);
if (liveRuns.length) console.log(`  live runs: ${liveRuns.map((f) => path.basename(f)).join(', ')}`);
