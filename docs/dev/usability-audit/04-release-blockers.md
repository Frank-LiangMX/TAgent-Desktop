# 04 — 发版阻断清单（TAgent-Desktop vs Proma）

> 审计视角：**「能不能发版给用户做基本使用」**。对照 F:\Proma（已可用的同类 Electron Agent 桌面）作为基线。
> 方法：只读。4 路并行审计覆盖 双核/模型渠道 · Chat/Work/权限 · 子代理/kanban/MoA · 会话持久化/Windows，关键 P0 人工复核（读 electron-builder.yml / build-main.mjs / release.yml / 实查 out/win-unpacked 产物）。
> 日期：2026-08-05。基线版本：TAgent v2.0.0-dev.9，Proma v0.16.9。

## 总体结论

核心会话链路（Pi 核对话、Chat/Work 双轴、权限分层、看板派工、JSONL 双写重载）**已真落地可基本使用**，非骨架。真正的发版阻断集中在**产物层**：对外版安装包仍含 kscc 核 + `claude.exe` 内网二进制（ADR-0001「对外版不装」无构建开关）。其余为体验缺口（MoA 未接线、子代理进度/嵌套、@ 多角色、Google 渠道假通）与本地出包链路补齐。

---

## 发版阻断 P0（没修就不能让用户基本用）

### P0-1 对外版产物仍含 kscc 核 + `claude.exe` 内网二进制，ADR「对外版不装」无构建开关
- **现象**：对外版安装包里打包了内网 kscc 核代码路径 + Anthropic Claude Agent SDK 原生二进制 `claude.exe`。`out/win-unpacked/resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 实测存在，`better-sqlite3` 也在内。ADR-0001 明定「kscc 可插拔：内网增强包，对外版不装（无拖累）」「adapters/claude/ = kscc 核（对外版编译排除）」——当前**无任何构建开关**落实：esbuild 全量 bundle，electron-builder `files` 只排 `chaos-openai-proxy`。对外用户安装包里塞了用不到的内网二进制（体积可观）+ 内网渠道代码，违背发版前提。运行上 Pi 核为默认主核、kscc 休眠不致崩，但产物/合规层面阻断对外发版。
- **根因线索**：`apps/electron/scripts/build-main.mjs:27-33`（external 含 `@anthropic-ai/claude-agent-sdk`，无条件排除 claude/）；`apps/electron/electron-builder.yml:8-11`（`files` 仅 `dist/**/*`+`package.json`，未排除 claude/SDK）；`apps/electron/package.json:48`（optionalDependencies 仍带 `claude-agent-sdk-win32-x64`）；`adapters/index.ts`（静态 import 切核，esbuild 无法 tree-shake 掉）。
- **Proma 参考**：Proma 双适配器常驻、无「对外排除」概念，不适用（Proma 本就单版双核常驻）。Proma 用 `RuntimeRoutingAgentAdapter` 按请求路由，不做编译期排除。
- **估时**：M（加对外/内网双产物配置：构建开关 + 条件 external + 分离 optionalDependencies + 可能改 adapters/index 为动态 import）。

---

## 体验严重 P1

### P1-1 Windows 本地 `package:win` 未串 `rebuild:native`，better-sqlite3 ABI 链路存疑
- **现象**：本地 `bun run package:win` = `build && electron-builder --win`，**未串 `rebuild:native`**；CI `release.yml:83-85` 串了 `rebuild:native`（`electron-builder install-app-deps`）。`out/win-unpacked` 实测带 `better_sqlite3.node`，但无法从产物确认是否 Electron ABI（electron 39）。若为 Node/Bun ABI，Electron 启动加载即崩（better-sqlite3 被 L4 记忆 + 看板用到，必崩）。dev.9 称「原生模块已验证」，但本地出包链路缺这步，未来手动出包易翻车。
- **根因线索**：`apps/electron/package.json:23`（`package:win` 无 rebuild）；`release.yml:83-85`（CI 串 rebuild:native）；`electron-builder.yml:14-15`（asarUnpack `node_modules/**/*.node`）；`out/win-unpacked/.../better_sqlite3.node`。
- **Proma 参考**：Proma `dist:win` = `build && sync:runtime-deps && electron-builder --win`，`npmRebuild:false` + `sync-runtime-deps` 把按 Electron ABI 重建的 `.node` 闭包拷进 `apps/electron/node_modules`，链路更稳。
- **估时**：S（`package:win` 串 `rebuild:native`）+ 干净 Windows 机实测启动。

### P1-2 Google 协议渠道连接测试「假通」
- **现象**：`channel-tester` 对 google 协议 `buildTestBody` 返回 `null`，只走 GET `/models?key=` 验 URL 可达 + 鉴权，**不验模型可用**；与 Anthropic/OpenAI（POST 真模型探测）语义不对齐。dev.9 release-notes 称「支持 Google 协议连接测试」属半接，用户配 Google 渠道可能测通但实跑不可用。
- **根因线索**：`apps/electron/src/main/lib/channel/channel-tester.ts:113`（google 返回 null body）、`:195`（GET /models）、`:263`（空 headers 覆盖）。
- **Proma 参考**：Proma 有独立 `pi-model-registry.ts` + `resolveAnthropicModelsUrl/resolveOpenAIModelsUrl`，Google 走真 catalog。
- **估时**：S。

### P1-3 MoA 会诊未接线，ADR-0004 四调度语法缺一
- **现象**：`packages/pi-core/src/moa-orchestrator.ts` 导出 `runReferenceModels`/`buildAggregatorPrompt`，但 `apps/electron/src/main` **零引用**（grep 确认），renderer **无 MoA 入口**（仅 `kscc.svg` 命中）。ADR-0004 定义的四种调度语法（@/SubAgent/MoA/看板）中 MoA 停在定义层，kscc 一渠多模默认会诊池（D14）未接。**无 UI 入口故不会误触无响应**，但属 ADR 承诺的核心语法缺失，发版 release-notes 必须标注「MoA 未上线」或 UI 不暴露。
- **根因线索**：`packages/pi-core/src/moa-orchestrator.ts`（无人 import）；`role-projection.ts` 有 `'moa-seat'` purpose 但无调用方。
- **Proma 参考**：Proma 无 MoA 概念。
- **估时**：M（接线）或 S（隐藏入口 + release-notes 声明，发版前临时方案）。

### P1-4 子代理进度无实时可视化（dev.9 已知）
- **现象**：子代理仅入口卡片（`SubagentEntryCard`，注释明说「完整过程不渲染在主会话」）+ 状态文本，**无实时工具流式进度条**。用户派子代理后看不到逐步工具执行。
- **根因线索**：`apps/electron/src/renderer/components/chat/SubagentEntryCard.tsx`、`SubagentDetailView.tsx`（仅 running/completed/failed 文本）。
- **Proma 参考**：Proma `delegate_agent` 子会话进侧栏可实时看流。
- **估时**：M。

### P1-5 父子消息嵌套无持久化（dev.9 已知「父子嵌套待完善」）
- **现象**：父子消息按 `parentToolUseId` 分组 OK，但子代理是**内存内 Pi Agent 实例**（`new Agent`），不创建独立 session 记录、无独立 JSONL，**刷新后子代理过程不可回看**。
- **根因线索**：`apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts:120`（`new Agent` 内存实例）；`session-turn-model.ts:77`（仅分组）。
- **Proma 参考**：Proma delegate 创建真实 child session 可回看。
- **估时**：L。

### P1-6 @ 讨论仅单角色轮答，非多角色群聊时间线
- **现象**：本轮 @ → 切 activeSpeaker，无 @ → follow 上一个；**无多角色同屏对话时间线、无多发言者交替渲染**。ADR-0003/0004 定义的「Chat 内多角色对话」实为单角色轮答。
- **根因线索**：`apps/electron/src/renderer/components/chat/Chat.tsx:1446`（@→切发言人）。
- **Proma 参考**：Proma 无此概念。
- **估时**：M。

---

## 可后置 P2

### P2-1 kscc 核 model fallback 硬编码 `claude-sonnet-4-6`
- **现象**：`claude-agent-adapter.ts:159` `options.model || 'claude-sonnet-4-6'`，若 session-service 传空 model 会走 Anthropic 默认而非 kscc 渠道模型（应为 GLM/Kimi/MiMo）。当前 session-service 确传了 model（latent）。
- **根因线索**：`adapters/claude/claude-agent-adapter.ts:159`。
- **Proma 参考**：无 kscc 概念。
- **估时**：S。

### P2-2 双核压缩算法分叉，维护成本高
- **现象**：pi 核走 8k coordinator（`transformContext`），kscc bare 模式 `compaction` 为 undefined，走另一套 `kscc-soft-reset.ts`。两套压缩/触发点分叉。
- **根因线索**：`adapters/pi/pi-agent-adapter.ts:489-491`（compaction undefined）；`agent/kscc-soft-reset.ts`。
- **Proma 参考**：无此分叉。
- **估时**：M。

### P2-3 子代理上下文预算硬编码 200k
- **现象**：`subagent-task-tool.ts` 硬编码 `contextWindow: 200_000`（:241/:255），未走 `resolveModelContextWindow`，子代理预算与主 Agent 不一致。
- **根因线索**：`adapters/pi/subagent-task-tool.ts:241,255`。
- **Proma 参考**：无双核子代理。
- **估时**：S。

### P2-4 Chat/Work 切回 Chat 无 Agent 建议触发点
- **现象**：`ExecutionModeSuggestionBanner` 双向渲染 + `pendingExecutionModeSuggestion` 持久化已做，但 `permission-service` 仅 emit Work 建议，**回 Chat 无人推**。
- **根因线索**：`permission-service.ts:157-182`（只 emit Work）；`Chat.tsx:1781`（banner 双向）。
- **Proma 参考**：无此概念。
- **估时**：M。

### P2-5 「@ 自动建 task」无代码护栏
- **现象**：Chat 下 kanban 写有 `assertKanbanWriteAllowed` 拦，但「@ 自动建 task」无 guard——靠 @ 不触发建板（设计而非护栏）。「Worker/MoA seat 递归建 board」仅 worker 有 `isBlockedWorkerTool`，MoA seat 未实现故无护栏。
- **根因线索**：`kanban/work-mode-guard.ts:24`；`kanban/kanban-worker-runner.ts:40`。
- **Proma 参考**：无。
- **估时**：S。

### P2-6 SOUL vs Role 角色商店未落地
- **现象**：投影层分离已落地（`role-projection.ts:57` 注释「主会话 SOUL 不在此叠入」），`RoleProjectionPurpose` 四态含 moa-seat/mention-turn；但 SOUL 实体/角色商店 UI 无（`RolesPage.tsx` 仅角色 CRUD）。
- **根因线索**：`role-projection.ts:57`；`RolesPage.tsx`。
- **Proma 参考**：无 SOUL。
- **估时**：L。

### P2-7 permission-service 调试日志残留生产路径
- **现象**：`permission-service.ts:240` 弹窗日志注释「定位后移除」，仍留在生产路径（每次写操作 console.warn）。
- **根因线索**：`permission-service.ts:240-242`。
- **Proma 参考**：无此调试日志。
- **估时**：S。

### P2-8 Chat 权限角标发现性弱
- **现象**：权限角标点击仅 `setComposerExpanded(true)` 展开功能栏，非直接切档；初次使用者需点开才见权限三档。
- **根因线索**：`Chat.tsx:1899-1918`。
- **Proma 参考**：Proma 输入框尾部直接 pill 可点切。
- **估时**：S。

### P2-9 爆点 onBurst 同步压缩致用户等待
- **现象**：`prompt_too_long` 命中调 `trySoftResetOnBurst`→`onBurst`，无 ready 影子时同步 compact，大上下文下用户干等 LLM 摘要数秒到十几秒，失败则 closed。非 General 的 `preparePromptTooLongRecovery` 兜底。
- **根因线索**：`session-runtime.ts:282,326,356`；`kscc-soft-reset.ts:214-253`。
- **Proma 参考**：无此概念。
- **估时**：S（加 ready 影子预热）/ M（接 General 兜底）。

### P2-10 本地 NSIS 出包缺 ELECTRON_MIRROR，裸拉 electron 易超时
- **现象**：dev.9 已知「本地 NSIS 受外部工具下载网络超时影响」。CI `release.yml` 已配 `ELECTRON_MIRROR=github`，本地出包无镜像配置则裸拉 electron 失败。
- **根因线索**：`release.yml:76-77`；本地无 mirror 配置。
- **Proma 参考**：Proma 同依赖网络，无镜像；建议 TAgent 本地出包前配 `ELECTRON_MIRROR` 或走 CI 产物。
- **估时**：S。

### P2-11 Windows 图标用 PNG 非 .ico
- **现象**：`electron-builder.yml` win.icon 指 `logo/appicon/light.png`（PNG），Win NSIS 需 builder 转 ico，缺 `.ico` 源可能降级默认图标。
- **根因线索**：`electron-builder.yml:18,21`。
- **Proma 参考**：Proma `win.icon` 显式 `resources/icon.ico`。
- **估时**：S。

### P2-12 缺 default-skills / tutorial / CLI 二进制捆绑（Proma 对照观察）
- **现象**：TAgent `electron-builder.yml` **无 extraResources**，不捆默认 skills / tutorial；无 `apps/cli`（Proma 有 CLI + 13 个默认 skills：agent-collaboration/pdf/pptx/xlsx/docx/skill-creator 等）。属产品内容缺口，非本次 7 个覆盖面核心，但影响「开箱基本使用」丰度。
- **根因线索**：`electron-builder.yml`（无 extraResources 段）；无 `apps/cli`、无 `default-skills/`。
- **Proma 参考**：Proma `electron-builder.yml:60-82` 捆 default-skills + tutorial.md + CLI 二进制（`PROMA_CLI` 注入）。
- **估时**：M（内容引入）— 视 TAgent 产品定位决定是否做。

---

## 附：已验证到位（非缺口，供发版信心）

- **双核选核**：`adapters/index.ts` + `session-service.ts:614` 按渠道绑核互斥，已落地；`ChannelModel.contextWindow/safeContextLimit` 字段已加（`channel.ts:117/123`），`default-models.ts` 窗口值真填，`model-window.ts` 存在且三处调用；`buildPlaceholderModel` 已读真实窗口（去 128k 硬编码，fallback 200k）。Pi 核可独立跑通，kscc 核 KsccQueryOptions 透传完整。
- **Chat 硬只读**：`permission-service.ts:208` 调 `isChatModeBlockedTool`（`permission-rules.ts:608` 拦 Write/Edit/写 Bash/kanban/Task），先于 bypass/白名单，防「完全自动」穿透 Chat；`chatModeBlockHandler` 终止 run。看板写双闸 `assertKanbanWriteAllowed`。
- **双轴 UI 分层**：`ExecutionModeToggle`（Chat/Work 两选一）与权限档分离，未混成五选一；Chat 下权限角标隐藏。
- **用户切换主权**：`session-service.ts:435` 拒绝非 user/user-confirm-suggestion source；Agent 仅建议（banner）无 IPC 自切。
- **会话持久化双写**：`session-service.ts:762/1156/1192` 先写面板（warn 兜底），`767/1161` 后写 SDK（error 兜底）；`GET_SDK_MESSAGES:529-533` 读面板份优先 fallback SDK；跨重启靠 `agent-sessions.json` + JSONL 落盘恢复。**无丢消息风险**。
- **看板主路径**：`kanban-bootstrap.ts:14` 注入真 `runKanbanWorkerHeadless`（非 stub），dispatcher 30s tick + 建任务即 kick + 依赖提升 + 回流全实现；右栏班组面板 `KanbanCrewPanel` 已接。
- **executionMode 全链路感知**：进 meta（`session-store.ts:116`）、IPC（`session-service.ts:409-502`）、创建路径、双核闭包（kscc `:926-932` / pi `:1031-1037`）。
- **软重置 summarize**：`kscc-soft-reset.ts:144-167` 真走外部渠道 `streamSSE`（非 handoff 所说占位），无渠道时 local 兜底。
