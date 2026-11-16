# Agent 观测台（agent-dash）

> 本项目基于开源项目 **[whatsmyagentdoing v0.8.1](https://github.com/Charonyuu/whatsmyagentdoing)**（作者 cheoyu，MIT 许可）魔改，保留原项目的 MIT 许可证与版权声明。感谢原作者。

一个跑在本机的 AI Agent 只读观测台：把 Claude Code、Codex、Gemini CLI、DeepSeek 子代理等本机 agent 的会话日志，变成可以一眼看懂的实时看板。零运行时依赖，克隆下来就能跑，不需要 `npm install`，不需要配置 API key。

## 四个视图

| 视图 | 看什么 |
|---|---|
| **办公室** | 3D 等距办公室。正在工作的 agent 坐在工位上：思考时冒想法气泡，跑工具时屏幕滚动代码，需要你时站起来招手；最近完成的 agent 会下班闲逛（茶水间、沙发、书架、白板、街机、乒乓球……）。支持 2D / 3D 切换，可拖拽旋转、滚轮缩放。 |
| **关系图** | 主控 agent 在左，派出的子代理向右逐列展开，孙代理继续向右；连线表示委派关系，运行中的链路有流动效果。一眼看清「谁在替谁干活」。 |
| **工作台** | 三栏布局：左栏任务树（按需你 / 进行中 / 已完成分组），中栏是任务详情——事件条、对话记录、工具调用、最终答复，右栏是属性、改动文件和图片。 |
| **时间轴** | 每个任务一条泳道，按与工作台相同的分组和筛选排列；右侧是固定宽度的时间窗，滚轮/拖拽只缩放或平移时间范围，不横向滚动。 |

右上角的搜索框（`Ctrl K`）和状态筛选在三个列表视图之间共用；界面支持简体中文、繁體中文、English、日本語、한국어、Español、Français、Deutsch、Português。

## 启动

要求 Node.js 18+（OpenCode / Hermes 的 SQLite 读取需要 22.13+，低版本会自动跳过这两个 agent，其余功能不受影响）。

```bash
node bin/cli.js --port 4600
```

然后打开 <http://127.0.0.1:4600>。

常用参数：

```bash
node bin/cli.js --port 4600 --no-open   # 不自动打开浏览器
node bin/cli.js --port 4600 --hours 12  # 只看最近 12 小时
node bin/cli.js --demo                  # 用一套假数据体验界面
node bin/cli.js --private               # 隐藏提示词、回复和标题，只显示状态
```

默认端口是 4545，被占用时会自动顺延到下一个空闲端口。完整参数见 `node bin/cli.js --help`。

## 只读原则

- **只读日志**：只 tail / 读取本机 agent 的会话日志（如 Claude Code 的 `~/.claude/projects`、DeepSeek 子代理的 `~/.claude/deepseek-runs`、Codex、Gemini CLI 等），不写入、不修改、不删除任何会话文件。
- **只监听本机**：HTTP 服务绑定 `127.0.0.1`，并拒绝非 localhost 的 Host 请求。
- **无遥测**：本 fork 已关闭上游的版本检查，不会向 GitHub 或任何外部服务发请求。
- **不打扰 agent**：不注入 hook、不改配置、不要求 API key；看板挂了也不影响正在运行的会话。
- **唯一的可选写操作**是 `--install-hook`：在 Claude Code 设置里加一个「等待你确认」的提示 hook，并在 `~/.whatsmyagentdoing/` 写一个标记文件。不运行它就完全不写。
- **`--private`** 下，提示词、回复和标题不会发送到浏览器页面。

## DeepSeek 子代理适配

本 fork 在 `src/deepseek.js` 中增加了 DeepSeek 子代理适配层。

`ask_deepseek.py` 启动的每个 DeepSeek 子会话都是一个真实的 `claude.exe -p` 进程，并在 `~/.claude/deepseek-runs/` 留下两个文件：`run-YYYYmmdd-HHMMSS.jsonl`（完整事件流）和同名 `.meta.json`（提示词、目录、档位等元信息）。适配层把每次运行当作一个普通会话：

- 从 JSONL 里还原思考、工具调用、工具参数、工具结果和图片；
- 与 Claude Code 会话一起出现在办公室、关系图、工作台和时间轴中；
- 根据 `.meta.json` 里的提示词识别任务标签（如 `T8a`），区分同一个主控派出的并行子代理；
- 只读这些日志，不做任何写入。

主控与子代理的父子关系来自 Claude Code 的 subagent / 委派记录以及 run 元信息，因此 DeepSeek 子代理会自然出现在关系图的委派链里。

## 支持的 agent

Claude Code（CLI / 桌面 / IDE）、Codex、Gemini CLI、Antigravity CLI、Copilot CLI、OMP、Pi、Kimi Code、DeepSeek Harness（DSH）、Grok Build、OpenCode、Hermes，以及本 fork 额外接入的 DeepSeek 子代理。各客户端的日志位置与覆盖方式见 `node bin/cli.js --help`；上游的完整说明见 [whatsmyagentdoing](https://github.com/Charonyuu/whatsmyagentdoing)。

## 隐私

所有数据都留在本机。页面通过 Server-Sent Events 从本地服务获取状态；`--private` 可隐藏对话正文。日志格式不是公开 API，客户端升级后状态解析可能退化，欢迎提 issue。

## 许可

MIT。原始项目版权归 cheoyu 所有，见 [LICENSE](LICENSE)。`assets/kenney/` 下的 3D 模型来自 [Kenney](https://kenney.nl)，以 CC0 发布（许可证文件见该目录）。
