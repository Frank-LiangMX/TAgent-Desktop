# REGRESS-H 移植摸底结论 — 对照 TAgent_General，决定移植 vs 重写

> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-RESIDUAL-SPEC.md` §H  
> Brief：`docs/dev/core-loop/REGRESS-H-port-from-general-brief.md`  
> 既有摸底：`docs/dev/core-loop/REGRESS-H-FINDINGS.md`（Desktop 侧断点）  
> 日期：2026-08-07 / 只读摸底，不改代码、不 commit。可 `--add-dir F:\TAgent_General`。

## 一句话结论

**移植 General，不重头捏。** 而且比 FINDINGS 原先估的更省：General 在 **与 Desktop 完全相同的 SDK 0.3.185** 上，用 **`canUseTool` 拦截 + `updatedInput.answers` 注入** 实现了完整可用的 AskUserQuestion，**完全不碰 `request_user_dialog` / `control_response` / `onUserDialog` / `userDialogKinds`**。因此 FINDINGS 的「选项 1（接控制帧）」对 Desktop 是过度设计——直接搬 General 的状态机 + 协议适配，套 Desktop `PermissionBanner` 视觉皮即可。

**工作量档：M**（最大头是渲染层 Banner 组件移植 + 换皮；无新 SDK 协议、无传输层改动、无控制帧）。

---

## 关键发现：SDK 机制（推翻 FINDINGS 的控制帧假设）

### 事实链（均带 path:line）

1. **两边 SDK 同版本**：General `apps/electron/package.json:55` `@anthropic-ai/claude-agent-sdk: 0.3.185`；Desktop 同 0.3.185（Desktop Explore 实测 `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.185...`）。
2. **General 全仓 grep `control_response|control_request|request_user_dialog|controlResponse|requestUserDialog` 仅 1 命中**：`claude-agent-adapter.ts:1148` 一句注释（`cancel_async_message 是 control_request，暂时在 orchestrator 层管理`）——**不是实现**。
3. **General 全仓 grep `onUserDialog|userDialogKinds|UserDialog`：app 代码零命中**（仅 `docs/plans/2026-07-25-sdk-longlived-process-history-mechanism.md` 提到 `hasBidirectionalNeeds()` 含 onUserDialog，但 TAgent 适配器**没传** onUserDialog）。
4. **General 全仓 grep `AskUserQuestion|request_user_dialog` 在 `*.mjs`：零命中**——该工具实现在 kscc 原生 CLI 二进制里，不在 SDK 的 JS 壳里；无法静态读取其源码，但行为可由 General 的可用实现反推。
5. **General 的实际做法**：`agent-orchestrator.ts:2570-2582` 在动态 `canUseTool` 里对 `toolName === 'AskUserQuestion'` 直接 `return askUserService.handleAskUserQuestion(sessionId, input, options.signal, sendAskUser)`，**早于任何权限模式分派**；`:2312-2329` 又在 `permissionService.createCanUseTool(...)` 注入 `askUserHandler + sendAskUserToRenderer`。
6. **`agent-ask-user-service.ts:87-105`** `respondToAskUser` 把答案注入 `updatedInput = {...toolInput, answers}`，resolve `{behavior:'allow', updatedInput}`——**答案靠 `updatedInput` 回灌，不靠 `control_response`**。
7. **决定性旁证**：`agent-orchestrator.ts:2663-2669` 注释——「当提供 canUseTool 回调时必须为 false，否则 CLI 同时收到 `--allow-dangerously-skip-permissions` 和 `--permission-prompt-tool stdio` 两个矛盾的指令，**导致 ExitPlanMode/AskUserQuestion 等交互式工具失败**。canUseTool 已完整处理所有权限模式」+ `allowDangerouslySkipPermissions: !canUseTool`。

### 推断（写进实现规格，需一轮实测兜底）

当宿主 `canUseTool` 对 `AskUserQuestion` 返回 `{behavior:'allow', updatedInput:{...input, answers}}` 时，**SDK 不再发 `request_user_dialog` 控制帧**——`request_user_dialog` 是「宿主未在 canUseTool 拦截 / 未提供 onUserDialog」时的 fallback。General 在 0.3.185 上产品级可用即为经验证据。

> Desktop 当前 bug 正是反面：`permission-service.ts:353-354` 对 AskUserQuestion 返回 `{behavior:'allow', updatedInput: input}`（**原 input，无 answers**），且 AskUserQuestion 落进 `askRenderer` 弹通用横幅（`permission-service.ts:282`，见 FINDINGS Q1/Q3）→ 用户点 allow → 工具以无 answers 的 input 执行 → SDK 发 `request_user_dialog` → `kscc-message-adapter.ts:241` `return {}` 丢帧 → SDK 阻塞等 `control_response` → 超时/取消 → 模型当「用户未选」。
>
> 修法不是「补 control_response 回灌」，而是「像 General 一样在 canUseTool 拦截 + 注入 answers」，让 SDK 压根不发 `request_user_dialog`。

**风险兜底**：实现后必做一轮手测——Chat 会话让模型调 AskUserQuestion → 选项卡挂载 → 点选 → 模型收到 answers 继续本轮。若（极小概率）SDK 仍发 `request_user_dialog` 且卡住，再退到 FINDINGS「选项 1（控制帧）」。先按 General 路径做，因为同 SDK 同机制，几乎必然成立。

---

## 对照表（General → Desktop，逐层 path:line）

| 层 | General（可用实现） | Desktop（当前状态） | 移植动作 |
|----|----|----|----|
| **状态机/服务** | `apps/electron/src/main/lib/agent-ask-user-service.ts`（159 行）：`handleAskUserQuestion`（解析 questions→sendToRenderer→pending Map→abort deny）、`respondToAskUser`（`updatedInput={...toolInput, answers}`→resolve allow）、`getPendingRequests`、`clearSessionPending` | **无**。AskUser 全链未实现 | **新建** `apps/electron/src/main/lib/agent/agent-ask-user-service.ts`，整文件搬 General（仅 import 路径/类型来源改 `@tagent/shared`） |
| **canUseTool 拦截** | `agent-permission-service.ts:115-119` 返回回调顶部 `if (toolName==='AskUserQuestion' && askUserHandler && sendAskUserToRenderer) return askUserHandler(...)`；`:102-108` `createCanUseTool` 多带 `askUserHandler + sendAskUserToRenderer` 两参 | `permission-service.ts:331-364` `createCanUseTool(sessionId, getMode, cwd, getExecutionMode)` **无 askUser 参**；返回回调内走 `checkPermission`→`askRenderer`（`:282`），AskUserQuestion 落通用横幅 | 在 Desktop `createCanUseTool` 返回回调**顶部**加 `if (toolName==='AskUserQuestion') return askUserService.handleAskUserQuestion(...)`，早于 `checkPermission`；需把 `sendAskUser` 注入（见下） |
| **canUseTool 装配点** | `agent-orchestrator.ts:2312-2329`（autoCanUseTool 装配 askUserHandler+sendAskUser）、`:2570-2582`（动态 canUseTool 的 AskUserQuestion 分支）、`:2668-2669` `allowDangerouslySkipPermissions:!canUseTool, canUseTool` | `session-service.ts:1073-1080` `createCanUseTool` 调用、`:1145` 透传 SDK、`:1116` `allowDangerouslySkipPermissions:!canUseTool` | 在 `session-service.ts:1073` 调用 `createCanUseTool` 处把 `sendAskUser` 接到「`win().webContents.send(ASK_USER_REQUEST, request)`」（仿 `permission-service.ts:135` 的 `askRenderer` send） |
| **IPC：主→渲染（请求）** | **复用 `STREAM_EVENT`**：`agent-orchestrator.ts:2322-2327 / 2575-2580` `this.eventBus.emit(sessionId, {kind:'tagent_event', event:{type:'ask_user_request', request}})` | `ASK_USER_REQUEST` enum **不存在**（`agent.ts:2063-2095` 段无此项）；权限走**专用** `PERMISSION_REQUEST` 通道（`permission-service.ts:135`） | **建议专用通道**（与 Desktop 权限架构一致）：`agent.ts` `AGENT_IPC_CHANNELS` 加 `ASK_USER_REQUEST:'agent:ask-user:request'`；主进程 emit 用它（非 STREAM_EVENT）。理由见下「IPC 取舍」 |
| **IPC：渲染→主（应答）** | `AGENT_IPC_CHANNELS.ASK_USER_RESPOND`（`agent.ts:1898`）+ `main/ipc.ts:2248-2260` `ipcMain.handle`→`askUserService.respondToAskUser`→emit `ask_user_resolved` | `ASK_USER_RESPOND` enum **已存在**（`agent.ts:2091`）但**无 ipcMain handler、无 preload 暴露、无使用**（类型 stub） | 加 `ipcMain.handle(ASK_USER_RESPOND)`（放 `session-service.ts` 或 ipc 注册处）→ `askUserService.respondToAskUser`→emit `ASK_USER_RESOLVED`（或复用乐观出队，见下） |
| **IPC：已解决事件** | `STREAM_EVENT` + `tagent_event:{type:'ask_user_resolved', requestId}`（`main/ipc.ts:2254-2258`） | 权限有专用 `PERMISSION_RESOLVED`（`permission-service.ts:110-121` `emitPermissionResolved`） | 加 `ASK_USER_RESOLVED:'agent:ask-user:resolved'` 专用通道（仿 PERMISSION_RESOLVED），供切 tab/跨会话清理。**可 deferred**：最小轮先靠 Banner 乐观出队，不做 resolved |
| **IPC：重载恢复** | `main/ipc.ts:2312-2321` `GET_PENDING_REQUESTS` 返回 `{permissions, askUsers, exitPlans}`，`askUsers: askUserService.getPendingRequests()` | `GET_PENDING_REQUESTS` enum 存在（`agent.ts:2109`），`PendingRequestsSnapshot.askUsers`（`:2239`）**字段在但无人填** | 在 Desktop 的 `GET_PENDING_REQUESTS` handler 里填 `askUsers: askUserService.getPendingRequests()`（**可 deferred**） |
| **preload 桥** | `preload/index.ts:1019, 2617-2619` `respondAskUser`→`invoke(ASK_USER_RESPOND)`；ask_user_request/resolved **走 `onAgentStreamEvent`**（无专用监听） | `preload/index.ts:206-218` 仅 `onPermissionRequest/onPermissionResolved/respondToPermission`；**零 ask-user** | 加 `onAskUserRequest`（listen `ASK_USER_REQUEST`）、`onAskUserResolved`（listen `ASK_USER_RESOLVED`，可选）、`askUserRespond`（invoke `ASK_USER_RESPOND`）。仿 `:206-218` 写法 |
| **共享类型** | `packages/shared/src/types/agent.ts`：`AskUserQuestionOption:1486`、`AskUserQuestion:1496`、`AskUserRequest:1508`、`AskUserResponse:1520`、`AgentEvent` ask_user:743-744 | **同形**已存在（`agent.ts:1634-1673`，仅行号不同）：`AskUserQuestionOption:1634`、`AskUserQuestion:1644`、`AskUserRequest:1656`、`AskUserResponse:1668`、`AgentEvent`:774-775 | **零改动**，类型可直接复用。仅需加 IPC enum 项 |
| **渲染 atoms** | `apps/electron/src/renderer/atoms/agent-atoms.ts:769-803`：`allPendingAskUserRequestsAtom`（Map<sid, AskUserRequest[]>）、`AskUserQuestionDraft`、`AskUserRequestDraft`、`askUserDraftsAtom`、`pendingAskUserRequestsAtom`；`:1230-1235` `applyAgentEvent` 对 ask_user_request/resolved no-op（Banner 自管） | 无 ask-user atoms；权限 atoms 在 `apps/electron/src/renderer/atoms/permission-atoms.ts`（`pendingPermissionMapAtom:36` 等） | **新建** `apps/electron/src/renderer/atoms/ask-user-atoms.ts`，结构抄 General `agent-atoms.ts:769-803`（或并入 permission-atoms 同目录）。draft 类型原样搬 |
| **渲染监听** | `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts:1157-1190`：`onAgentStreamEvent` 分派 `ask_user_request`→入队 atom+桌面通知；`ask_user_resolved`→清 atom+drafts | `apps/electron/src/renderer/hooks/useGlobalPermissionSync.ts:28-47` 只管 permission；**无 ask-user 监听** | **新建** `apps/electron/src/renderer/hooks/useAskUserSync.ts`，仿 `useGlobalPermissionSync`：`onAskUserRequest`→enqueue、`onAskUserResolved`→resolve。App 根挂一次 |
| **渲染组件** | `apps/electron/src/renderer/components/agent/AskUserBanner.tsx`（533 行）：多题顶部 Tab、选项竖排、multiSelect、自定义文本、option.preview markdown 预览、↑↓/Enter 键盘、drafts 持久、dismiss=stopAgent | 无；`ContentBlockView.tsx:90-139` `ToolUseBlockView` 只 JSON dump | **新建** `apps/electron/src/renderer/components/chat/AskUserQuestionBanner.tsx`，逻辑搬 General `AskUserBanner.tsx`，**换皮**（见「UI 换皮清单」） |
| **挂载点** | General 在 AgentView 挂 `AskUserBanner` | `Chat.tsx:104`(import)、`:2043` `<PermissionBanner sessionId={sessionId}/>`（挂在 composer 上方，`:1979-1980` 注释说明位置） | `Chat.tsx:2043` 紧邻 `<PermissionBanner>` 加 `<AskUserQuestionBanner sessionId={sessionId}/>` |
| **会话清理** | `main/ipc.ts:1647-1649` `deleteSession` 调 `askUserService.clearSessionPending(id)`（也清 permission/exitPlan） | Desktop delete/stop session 在 `session-service.ts`（清理 permission pending） | 在 Desktop session stop/delete 处加 `askUserService.clearSessionPending(sessionId)`（仿 permission 清理） |
| **子代理/worker** | `agent-orchestrator.ts:2502-2503` worker 场景 `ExitPlanMode/AskUserQuestion` 总 deny（UI 不能交互） | `kanban-worker-runner.ts:52-67` 子代理 auto-deny AskUserQuestion（FINDINGS Q4 旁证） | **保持现状**，worker auto-deny 不动；主会话才走新交互链 |
| **ContentBlock 兜底** | General 靠 Banner 出现，tool_use 块照常渲染 | `ContentBlockView.tsx:90-139` 对 AskUserQuestion 仍 JSON dump | **可选打磨**：AskUserQuestion 的 tool_use 在 pending 期间不渲染纯 JSON dump（避免「JSON 假 UI」）。优先级低 |

---

## IPC 取舍：为什么 Desktop 用专用通道而非 General 的 STREAM_EVENT

- General 把 `permission_request` / `ask_user_request` / `exit_plan_mode_request` **全部塞进 `STREAM_EVENT` 的 `tagent_event`**，由单个 `useGlobalAgentListeners` 分派（统一总线）。
- Desktop 权限走**专用通道** `PERMISSION_REQUEST`（`permission-service.ts:135` `win.webContents.send(PERMISSION_REQUEST, req)`）+ 专用 preload `onPermissionRequest`（`preload:206`）+ 专用 `useGlobalPermissionSync`。这是 Desktop 既定架构。
- 为与 Desktop 权限架构**一致**（也是本 Brief C.2 点名的「`useGlobalPermissionSync.ts` 同款加 `useAskUserSync`」），推荐 ask-user 也走**专用 `ASK_USER_REQUEST` 通道**，而非 General 的 STREAM_EVENT 复用。
- 代价：多 1 个 enum 项 + 1 个 preload 监听 + 1 个专用 hook；换来与权限链完全对称、易维护、不挤占流式总线。
- **若想最小改动**：也可直接复用 `STREAM_EVENT`+`tagent_event`（General 原样），省掉专用通道，但需确认 Desktop 渲染层有分派 `tagent_event` 的中心监听并扩展之。**推荐专用通道**。

---

## UI 换皮清单（General `AskUserBanner` → Desktop 视觉）

General `AskUserBanner.tsx` 用的 token vs Desktop `PermissionBanner.tsx`（实测 Desktop Explore）：

| 元素 | General 类名 | Desktop 对应（PermissionBanner 实测） | 建议 |
|----|----|----|----|
| 外壳 | `session-glass-modal` + `animate-in slide-in-from-bottom-2` | `motion.div` spring + `session-permission-banner` + `pointer-events-auto overflow-hidden` | 用 Desktop `PermissionBanner` 的 motion 外壳 + `rounded-2xl border shadow-lg backdrop-blur-xl` |
| 卡片 | `rounded-glass-popover`（多次） | `rounded-2xl` + `bg-background/80` | 对齐 Desktop：`rounded-2xl`；或用 Desktop 也有的 `rounded-glass-popover`（`packages/ui/src/tokens/radius.ts:18`，sibling 组件在用）——二选一，**建议沿用 Desktop PermissionBanner 的 `rounded-2xl` 保持一致** |
| 选中态 | `bg-primary text-primary-foreground shadow-sm` | allow 按钮 `bg-primary text-primary-foreground hover:bg-primary/90` | 一致，直接保留 |
| 未选态 | `bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.08]` | `hover:bg-foreground/10 hover:text-foreground` | 对齐 Desktop |
| 危险/强调 | 无（问答无危险级） | `border-red-500/40 bg-red-500/10` | 问答不需要危险色，删 |
| 预览 | `prose prose-sm dark:prose-invert`（react-markdown） | Desktop 内联预览同样用 `prose` | 保留 react-markdown + remark-gfm（General `AskUserBanner.tsx:12-13,523-528`） |
| 按钮组件 | `@tagent/ui` 的 `Button` | Desktop 用 `@tagent/ui` 的 `Button` | 一致 |
| 图标 | `lucide-react` `Send`/`X` | `lucide-react` `ShieldWarning` 等 | 保留 Send/X |

**交互保留**：多题 Tab 切换、单选/多选、自定义文本、preview、↑↓/Enter 键盘、auto-advance 150ms、drafts 切 tab/会话持久、dismiss=stopAgent——逻辑原样搬，仅换 className token。

**Desktop 需确认的依赖**：`react-markdown` + `remark-gfm`（General 用了；Desktop 是否已装需查 `apps/electron/package.json`，未装则补，或预览降级为纯文本）。

---

## 必答对照（Brief A/B/C）

### A. General（`F:\TAgent_General`）

1. **AskUserQuestion 组件在哪/props/多题多选建模**：`apps/electron/src/renderer/components/agent/AskUserBanner.tsx:40` `AskUserBanner({sessionId})`；props 仅 `sessionId`，pending 来自 `allPendingAskUserRequestsAtom`。多题用顶部 Tab（`:305-333`），多选由 `AskUserQuestion.multiSelect`（`agent.ts:1496-1502`）决定 `toggleOptionByState`（`:204-216`）单选替换/多选追加。
2. **主进程如何收 SDK 问答并弹卡/回灌**：**不收 SDK 控制帧**。`agent-orchestrator.ts:2570` 在 `canUseTool` 拦截 `AskUserQuestion`→`askUserService.handleAskUserQuestion`（`agent-ask-user-service.ts:49`）解析 questions→`sendToRenderer`（eventBus emit `ask_user_request`）→pending Map。渲染层 `AskUserBanner` 收 atom→点选→`respondAskUser`→IPC `ASK_USER_RESPOND`→`respondToAskUser` 把 answers 注入 `updatedInput`→resolve `{allow, updatedInput}`→SDK 拿带 answers 的 input 执行，**不发 `request_user_dialog`**。
3. **超时/取消/未选**：abort signal→`{behavior:'deny', message:'操作已中止'}`（`:69-78`）；会话结束→`clearSessionPending` resolve deny `会话已结束`（`:117-124`）；dismiss→`stopAgent`（`AskUserBanner.tsx:155`）。**无 120s askRenderer 超时**（因为不进 askRenderer）。
4. **UI 依赖**：React DOM + jotai + `@tagent/ui` + `react-markdown`/`remark-gfm` + `lucide-react`。**可直接搬进 Electron renderer**（Desktop 同栈），非 Ink。

### B. Desktop（`F:\TAgent-Desktop`）

1. **断点是否仍是 `sdkMessageToIR` 丢 `control_request` + 无 IPC + 无组件**：**仍是**（Desktop Explore 实测确认）。`kscc-message-adapter.ts:241` `return {}` 丢 `control_request`；`ASK_USER_REQUEST` enum 无；渲染层零组件；`ToolUseBlockView` JSON dump。
2. **最近似可抄的 UI 壳**：`PermissionBanner` 链全实现——`PermissionBanner.tsx`、`useGlobalPermissionSync.ts`、`permission-atoms.ts`、`permission-service.ts`、`preload:206-218`、`Chat.tsx:2043`。**模式可复用**（专用通道 + atom + hook + banner）。
3. **类型 stub 对齐**：`AskUserRequest/AskUserResponse/AskUserQuestion/AskUserQuestionOption`（`agent.ts:1634-1673`）与 General `agent.ts:1486-1520` **同形**，与 SDK AskUserQuestion schema 一致。**直接复用，零改动**。

### C. 移植方案（推荐切片，见 `REGRESS-H-implement-brief.md`）

最小可点选一轮：①主进程 `agent-ask-user-service.ts`（搬 General）+ `createCanUseTool` 顶部拦截 + `ASK_USER_REQUEST`/`ASK_USER_RESPOND` IPC + preload 桥；②渲染 `ask-user-atoms.ts` + `useAskUserSync.ts` + `AskUserQuestionBanner.tsx`（搬逻辑换皮）+ `Chat.tsx` 挂载；③会话清理 `clearSessionPending`；④手测验证 SDK 不发 `request_user_dialog`。

**不建议**从零设计选项交互；**不建议**走控制帧（FINDINGS 选项 1）——General 同 SDK 已证 canUseTool 拦截可行且更简。

---

## 总监倾向确认

Brief「总监倾向」：默认参考/移植 General，不重头捏交互语义；UI 按 Desktop `PermissionBanner` 改造。**本次摸底完全支持**：General 的状态机/协议适配（canUseTool 拦截 + updatedInput.answers）成熟可用，Desktop 缺的正是接线 + 视觉。**且发现 General 路径比 FINDINGS 估的更省**（无控制帧），工作量从预估的「补功能 L」降到 **M**。

## 相关文件（绝对路径）

### General（移植源）
- 服务：`F:\TAgent_General\apps\electron\src\main\lib\agent-ask-user-service.ts`
- canUseTool 拦截：`F:\TAgent_General\apps\electron\src\main\lib\agent-permission-service.ts:102-108,115-119`
- 装配/emit：`F:\TAgent_General\apps\electron\src\main\lib\agent-orchestrator.ts:2312-2329,2570-2582,2663-2669`
- IPC handler：`F:\TAgent_General\apps\electron\src\main\ipc.ts:1647-1649,2248-2260,2312-2321`
- preload：`F:\TAgent_General\apps\electron\src\preload\index.ts:1019,2617-2619`
- 类型：`F:\TAgent_General\packages\shared\src\types\agent.ts:743-744,1486-1520,1898,2046`
- 渲染组件：`F:\TAgent_General\apps\electron\src\renderer\components\agent\AskUserBanner.tsx`
- 渲染 atoms：`F:\TAgent_General\apps\electron\src\renderer\atoms\agent-atoms.ts:769-803,1230-1235`
- 渲染监听：`F:\TAgent_General\apps\electron\src\renderer\hooks\useGlobalAgentListeners.ts:1157-1190`

### Desktop（移植目标 / 已实测断点）
- canUseTool：`F:\TAgent-Desktop\apps\electron\src\main\lib\permission\permission-service.ts:124-151,212-284,331-364`（`askRenderer:135/282`、`allow updatedInput:input:353-354`）
- 装配点：`F:\TAgent-Desktop\apps\electron\src\main\lib\ipc\session-service.ts:1073-1080,1116,1145`
- 控制帧丢弃：`F:\TAgent-Desktop\packages\shared\src\utils\kscc-message-adapter.ts:241`
- 类型 stub：`F:\TAgent-Desktop\packages\shared\src\types\agent.ts:774-775,1634-1673,2091,2239`
- preload：`F:\TAgent-Desktop\apps\electron\src\preload\index.ts:206-218`
- 权限壳（抄模式）：`F:\TAgent-Desktop\apps\electron\src\renderer\components\permission\PermissionBanner.tsx`、`hooks\useGlobalPermissionSync.ts`、`atoms\permission-atoms.ts`
- 挂载点：`F:\TAgent-Desktop\apps\electron\src\renderer\components\chat\Chat.tsx:104,2043`
- tool_use dump：`F:\TAgent-Desktop\apps\electron\src\renderer\components\chat\ContentBlockView.tsx:90-139`
- 权限规则（不硬拦 AskUserQuestion）：`F:\TAgent-Desktop\packages\shared\src\constants\permission-rules.ts:599,618`
- SDK 协议定义：`F:\TAgent-Desktop\node_modules\.bun\@anthropic-ai+claude-agent-sdk@0.3.185...\sdk.d.ts:3371-3398`（control_request/response）、`:1220-1228,1455-1489`（onUserDialog/userDialogKinds——General 未用）、`:2017-2029`（PermissionResult）
