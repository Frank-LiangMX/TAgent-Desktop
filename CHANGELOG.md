# Changelog

本项目变更记录，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.0-dev.2] - 2026-07-26

从 dev.1 的"能对话骨架"推进到"可配置多渠道、按项目组织工作区、kscc 核与 Pi 核均可跑"。本版含 dev.1 之后已提交的渲染层/持久化工作 + 本次渠道管理/工作区/Pi 核接入。

### 新增
- **渠道管理** — 渠道 CRUD（`~/.tagent[-dev]/channels.json`）+ API Key 加密（Electron safeStorage，OS 级）+ 启动 seed `kscc-internal` 内置渠道（OAuth，不可删，按 provider 识别）+ 渠道管理 UI。见 `main/lib/channel/`、`renderer/components/ChannelManager.tsx`。
- **工作区** — 项目目录=工作区，数据对齐 kscc 模式 `~/.tagent[-dev]/projects/{sanitizedPath}/`；打开项目目录创建/切换工作区，会话 JSONL 按项目分目录存储。见 `main/lib/workspace/`、`renderer/components/WorkspaceSelector.tsx`。
- **Pi 核接入（@tagent/pi-core）** — 可复用 Pi 内核库：kscc bare / HTTP 直连 streamFn、antml 协议、工具(Read/Write/Edit/Bash)、权限、Xfast 竞争调度、MoA 多模型、MCP 桥（Xfast/MoA/MCP 库就绪，尚未接入 agent 循环）。`pi-agent-adapter` 重写为单例 `Map<sessionId, Agent>`，AgentEvent→SDKMessage 转译，Pi Agent 天然常驻无需长驻改造。见 `packages/pi-core/`、`main/lib/adapters/pi/`。
- **双核会话服务** — `session-service` 按 channelId 选核（`kscc-internal`→kscc 核，其余→Pi 核）+ 会话绑核（首条绑定，kscc↔external 互斥，核内换模型自由）+ workspace-aware JSONL 持久化 + cwd 解析为 workspace 项目目录。
- **会话持久化** — JSONL 落盘 + resume 续历史（kscc 核首条 spawn 带 `resumeSessionId`，SDK 读 JSONL 一次，之后靠子进程内存）。见 `main/lib/agent/session-store.ts`。
- **TAgentMessage IR 渲染层（重写，双核统一）** — `sdkMessageToIR` 统一转译，renderer 拆 `ContentBlockView`/`ToolResultView`/`ChatInput` 组件。
- **会话列表侧栏** — 按工作区分组的会话列表 + 切回会话读 JSONL 加载历史。

### 修复
- **SessionSidebar 防御** — `listSessions` 返回非数组时防御 + 主进程日志。

### 变更
- **构建** — 新增 `build:pi-core`（ESM 单独打包，外部化 pi-ai/pi-agent-core/MCP SDK）；main bundle 外部化 `@tagent/pi-core`/`pi-agent-core`/`pi-ai`。
- **依赖** — 新增 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@tagent/pi-core`（workspace）。
- **工程** — pi-core 补 `typecheck` 脚本 + `typescript` devDep，纳入工作区 `bun run typecheck`（5 包全绿）；`.gitignore` 增 `*.bak`/`*.tsbuildinfo`/嵌套 pi-core 重复目录。

### 已知缺口（后续版本补）
- 工具循环（canUseTool/MCP/Skill 注入）未接
- Xfast/MoA/MCP 已封装未接入 agent 循环
- 记忆系统（Nudge/L0-L5）未接
- 错误恢复（进程崩溃 fallback / prompt_too_long compaction）未接
- 渠道连接测试/拉模型（外部渠道真实 HTTP）占位
- 知识库体系（设计已定，未实现）

## [2.0.0-dev.1] - 2026-07-25

2.0 新架构骨架首版（TAgent-Desktop，从骨架重构，不继承 TAgent_General 旧"一圈一结"骨架）。

### 新增
- **双核可拔插适配层** — kscc 核（Claude Agent SDK + kscc 渠道，长驻）+ Pi 核（外部渠道，占位）。按渠道选核，kscc 可拔插（对外版排除）。见 `docs/decisions/ADR-0001-dual-core.md`。
- **长驻会话运行时** — 会话=进程，常驻直到退出。首条消息 spawn kscc 一次，后续复用同进程，靠子进程内存累积上下文，不每轮重放历史。见 `docs/decisions/ADR-0002-longlived-process.md`。
- **模块化骨架** — adapters/{shared,claude,pi} + agent/runtime + ipc 分层，不巨脚本（对照 TAgent_General 的 3997 行 orchestrator + 1279 行 adapter）。
- **最小会话 UI** — 发消息 + 流式回复 + 停止，验证长驻闭环（体感快，多轮不重放）。
- **项目管理规范** — docs/{plans,decisions,dev} 分离，release-notes + CHANGELOG + 版本号规矩。见 `docs/PROJECT_MANAGEMENT.md`。

### 架构决策（实测驱动）
- 全切 Pi 否决：kscc 网关 OAuth 锁死 + bare 咬不住长会话 cache + antml↔tool_use 死结。
- 双核模式：kscc 可插拔（内网增强包）+ Pi 主核（对外版单核）。
- 渠道绑核终身不切，kscc↔外部互斥，核内换模型自由。
- 长驻只 kscc 核（Pi 自带循环无长驻问题）。

### 已知缺口（后续版本补）
- 工具循环（canUseTool/MCP/Skill 注入）未接
- 会话持久化（JSONL + resume）未接
- 记忆系统（Nudge/L0-L5）未接
- 渠道管理（多渠道/API Key 加密）未接
- 完整渲染层（SDKMessageRenderer/标签页/会话列表）未接
- 知识库体系（设计已定，未实现）
- 错误恢复（进程崩溃 fallback / prompt_too_long compaction）未接
```
