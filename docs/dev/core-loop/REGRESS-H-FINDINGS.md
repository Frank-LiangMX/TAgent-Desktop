# REGRESS-H 摸底结论 — Chat 下「请选择」但无选项 UI，随后当未选

> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-RESIDUAL-SPEC.md` §H
> Brief：`docs/dev/core-loop/REGRESS-H-ask-user-no-options-brief.md`
> 日期：2026-08-07 / 只读摸底，不改代码

## 现象回顾

Chat 模式会话里模型走交互问答（`AskUserQuestion`），提示用户选择。
**实际没有弹出选项 UI**；随后模型/系统当「用户未选择」处理 → 子代理/本轮失败体感。

---

## 根因（一句话）

**`AskUserQuestion` 在权限层被正确放行（不硬拦、不 deny、不进 askRenderer），但整条「问答 → 选项 UI → 回灌答案」链路从未实现**：
主进程不识别 SDK 的 `request_user_dialog` 控制帧（`sdkMessageToIR` 直接 `return {}` 丢弃），渲染层没有 AskUserQuestion 选项组件，
IPC 通道 `ASK_USER_REQUEST`（主→渲染）连 enum 都没建（只有反向 `ASK_USER_RESPOND`），preload 也没暴露。
模型让用户选 → SDK 发出 `request_user_dialog` 控制帧 → 我们丢帧不答 → SDK 拿不到答案 → 本轮卡死/超时 → 模型当「用户没选」。

**断点不在权限层（H1 不成立），在「事件发出后无人消费 + UI 未挂载」（H2 成立，且更彻底：连主进程 emit 都没有）。**

---

## 必答（带 path:line）

### Q1. Chat 下 AskUserQuestion 实际走哪条 canUseTool 路径？是否被误拦、软 deny、或走了 askRenderer？

**走 `allow` 直通路径，未被拦、未被 deny、未走 askRenderer。**

- `checkPermission` Chat 硬拦判定：`permission-service.ts:235`
  `if (executionMode === 'chat' && isChatModeBlockedTool(toolName, input, cwd))`。
- 对 `AskUserQuestion`：`isChatModeBlockedTool` 第 618 行 `if (toolName === 'AskUserQuestion') return false`
  （`packages/shared/src/constants/permission-rules.ts:618`）→ **不硬拦**。
- bypass / 白名单 / 只读放行都不命中 AskUserQuestion（它不在 `SAFE_TOOLS`，`permission-rules.ts:23` 注释明说「不在此列表 — 由 canUseTool 拦截并展示交互式 UI」）；
  `isAutoModeAutoAllowTool` 对它返回 `false`（无 SAFE_TOOLS/AUTO_MODE_READ_ONLY_TOOLS 命中）。
- plan 模式分支不命中（AskUserQuestion 非写操作）。
- 落到 auto 模式弹框分支：`permission-service.ts:268-283`，构造 `PermissionRequest` → `askRenderer(win(), req)`
  （`permission-service.ts:282`）→ **会进 askRenderer**？

  **关键反例**：`requiresAutoModeConfirmation('AskUserQuestion')` 在 `permission-rules.ts:599` 显式 `return false`，
  但 `checkPermission` **没调用** `requiresAutoModeConfirmation`——它直接走 `isAutoModeAutoAllowTool` → 未命中 → 进 askRenderer 分支。
  即：**auto 模式下 AskUserQuestion 会被送进 `askRenderer` 弹通用权限横幅**（允许/拒绝二选一），**不是选项卡**。
  通用横幅只有 allow/deny，没有 options；用户点 allow → `checkPermission` 返回 `allow:true` → SDK 执行 AskUserQuestion → 发 `request_user_dialog`（见 Q2/Q3）→ 丢帧。
  若用户点 deny 或横幅超时（`PERMISSION_TIMEOUT_MS=120_000`，`permission-rules.ts:11`；`askRenderer` 超时 deny，`permission-service.ts:137-141`）→ 当「用户拒绝工具」，模型当未选。

  **Chat 模式**走的是 `executionMode==='chat'` 分支前的同一 `checkPermission`：AskUserQuestion 不硬拦 → 一样落到 auto 弹框分支 → askRenderer 弹通用横幅（非选项）。
  （注：`getExecutionMode` 对真 Chat 会话返回 `'chat'`，`session-service.ts:1190-1197`；但 Chat 不改变 AskUserQuestion 的走向——它本就不在 chat 硬拦集。）

  **结论**：AskUserQuestion 没有被「误拦/软 deny」，但**被错误地当成普通写工具送进 askRenderer 弹通用权限横幅**，而非专属选项 UI。H1（进了 deny/interrupt）**不成立**。

### Q2. 主进程如何把问答变成 `ask_user_request` 事件？渲染层哪个组件消费并渲染选项？

**主进程根本不产生 `ask_user_request` 事件；渲染层没有任何组件消费/渲染选项。**

- 事件类型 `ask_user_request` / `ask_user_resolved` **只在类型定义里**：`packages/shared/src/types/agent.ts:774-775`（`TAgentControlEvent`）、`:796-797`（`TAgentEvent`）。全仓 grep `ask_user_request|ask_user_resolved` 仅命中 `agent.ts` + 文档，**主进程/渲染层零使用**。
- `AskUserRequest` 接口存在（`agent.ts:1656-1665`，含 `requestId/sessionId/questions/toolInput`），`AskUserResponse`（`:1668-1673`，`answers: Record<string,string>`）——**全仓仅 `agent.ts` 引用**。
- IPC 通道：`AGENT_IPC_CHANNELS.ASK_USER_RESPOND = 'agent:ask-user:respond'`（`agent.ts:2091`，渲染→主）**存在**，
  但**反向 `ASK_USER_REQUEST`（主→渲染）在 enum 里根本没定义**（`agent.ts:2065-2095` 段无此项）。
  `EXIT_PLAN_MODE_RESPOND`（`:2095`）同样只有反向、无正向 `EXIT_PLAN_MODE_REQUEST` —— 同款未实现的 stub。
- preload bridge（`apps/electron/src/preload/index.ts:208-218`）只暴露 `PERMISSION_REQUEST/PERMISSION_RESOLVED/PERMISSION_RESPOND`，
  **没有 `ASK_USER_REQUEST` 监听、没有 `ASK_USER_RESPOND` send**（grep 全 preload 无 `askUser|ASK_USER`）。
- `PendingRequestsSnapshot.askUsers: AskUserRequest[]`（`agent.ts:2239`）字段也**无任何代码读写**。
- 对照：`ExitPlanMode` 同款未实现（grep `exit_plan_mode_request|exitPlanMode|ExitPlanModeRequest` 仅命中 `agent.ts`）；
  `PermissionBanner`/`permission_request` 则**全链实现**（9 文件：`PermissionBanner.tsx`、`useGlobalPermissionSync.ts`、`permission-atoms.ts`、`permission-service.ts`、`preload/index.ts`、`Chat.tsx`、`MessageQueue.tsx`、`kanban-worker-runner.ts`、`permission-service.test.ts`）。

**结论**：`ask_user_request` 是**只写了类型、未写实现**的 stub。SDK 真正的问答控制帧是 `control_request` 里的 `request_user_dialog` 子类型（见 Q3），不是 `ask_user_request`——类型设计偏离了 SDK 实际协议。H2「事件发出但 Chat.tsx 未订阅」**成立，且更彻底：主进程从没 emit 过这个事件**。

### Q3. 何种条件导致 request 已发出但 UI 不挂载？

**断链有三处，任一处都足以让选项 UI 不挂载：**

1. **SDK 控制帧 `request_user_dialog` 被主进程静默丢弃**（最上游断点）。
   - SDK 把 `AskUserQuestion` 当作「tool-driven blocking dialog」（`sdk.d.ts:3379-3382`：
     `Requests the SDK consumer to render a tool-driven blocking dialog and return the user choice. Used by tools that previously rendered Ink JSX via setToolJSX with an onDone callback`）。
   - 该帧是 `SDKControlRequest`（`type:'control_request'`，`sdk.d.ts:3371-3375`），子类型 `request_user_dialog`（`:3382-3393`，带 `dialog_kind`/`payload`/`tool_use_id`）。
   - 我们的 SDK 消息流转：`claude-agent-adapter.ts:125-133` `yield msg` 透传所有帧 → `session-runtime.ts:255-275` `for await` 全转给 `onMessage` → `session-service.ts:905` `handleSdkStreamMessage` → `sdkMessageToIR(msg)`（`kscc-message-adapter.ts:60`）。
   - `sdkMessageToIR` 只识别 `user/assistant/result/stream_event/system` 五类（`kscc-message-adapter.ts:66,85,124,136,164`），`control_request` 落到末尾 `return {}`（`:241`）——**既不产 `message` 也不产 `event`**，`handleSdkStreamMessage` 因 `message`/`event` 都 falsy 而**不发任何 IPC**（`session-service.ts:1242-1262`）。
   - 全仓 grep `control_request|control_response|request_user_dialog|controlRequest` **零命中**（不含 SDK node_modules）。我们既不识别、不渲染、也**不回 `control_response`**。
   - SDK 在 `request_user_dialog` 上**阻塞等答案**（它是 blocking dialog）；拿不到 `control_response` → 本轮不进 result → 用户侧表现为「卡住 / 没反应 / 随后当未选」。
   - （旁证：`pending_user_dialog_requests` 在 initialize 响应里被 SDK 单列，`sdk.d.ts:252-254,265-268`——SDK 视其为与权限请求并列的一等公民 in-flight 对话；我们完全没接。）

2. **渲染层无 AskUserQuestion 选项组件**（下游断点）。
   - grep 渲染层 `AskUserQuestion|AskUserRequest|ask_user|askUser` **零命中**。
   - `tool_use` 块渲染器 `ContentBlockView.tsx:90-139`（`ToolUseBlockView`）是**通用只读 JSON dump**：Badge 显示工具名 + 可折叠 `<pre>{JSON.stringify(input)}</pre>`，**无 `options.map`、无 chip/card、无 answer 回调**。
   - 即便 `assistant` 帧把 AskUserQuestion 的 `tool_use`（含 question/options）送进渲染层，用户看到的也只是「AskUserQuestion」徽章 + 折叠 JSON，**没有任何可点选项**。这与现象「模型让选、实际没弹选项」完全吻合。
   - `PermissionBanner.tsx` grep `AskUser|ask_user|options|question` **零命中**——通用权限横幅不渲染选项。

3. **IPC 通道 + preload 缺失**（中游断点）。
   - `ASK_USER_REQUEST`（主→渲染）enum 项不存在；`ASK_USER_RESPOND`（渲染→主）enum 项存在但 preload 未暴露、主进程未 `ipcMain.on` 监听。
   - 即使前两处补上，也没有通道把选项答案回灌主进程。

**executionMode/displayMode 不背锅**：Chat 与 Work 对 AskUserQuestion 走同一 `checkPermission` 路径，都放行；问题不在模式判定，在于「放行之后无人接管」。也**不是 Banner 盖住 / z-index / 仅 Work 挂载**——是压根没有这个组件。

### Q4. 「未选择」文案从哪来？超时自动 deny？空 answers 回灌？interrupt 竞态？

**不是单一来源，按发生顺序有三个候选，按概率从高到低：**

1. **SDK `request_user_dialog` 无人应答 → SDK 侧阻塞/超时 → 当用户未答 → 回灌空/取消给模型**（最可能）。
   - SDK 类型注释（`sdk.d.ts:3385`）明示：`hosts must answer unrecognized kinds with {behavior: "cancelled"}`——SDK 期望宿主应答；宿主不应答时 SDK 有自己的超时/取消语义（`sdk.mjs` 多处 `cancelled`）。
   - 我们从不应答 → SDK 最终以 cancelled/空答案结束本轮 → 模型收到「用户没选」语义。
2. **askRenderer 通用横幅超时自动 deny**（`permission-service.ts:137-141`，`PERMISSION_TIMEOUT_MS=120_000`，`permission-rules.ts:11`）。
   - auto 模式下 AskUserQuestion 被送进 askRenderer 弹通用横幅（Q1）；用户若没看到/没点（横幅是通用 allow/deny，不是选项），120s 超时 → `askRenderer` resolve `'deny'` → `checkPermission` 返回 `{allow:false, reason:'用户拒绝'}`（`permission-service.ts:283`）→ `createCanUseTool` 返回 `{behavior:'deny', message:'用户拒绝'}`（`permission-service.ts:358-362`，**不带 interrupt**，因 AskUserQuestion 不在 hardStop 集）→ SDK 软 deny → 模型当「用户拒工具/未选」。
   - Chat 模式同样走此分支（AskUserQuestion 不在 chat 硬拦集 → 落 auto 弹框分支）。
3. **interrupt 竞态**（与 REGRESS-A 同源，但对 AskUserQuestion 不直接适用）。
   - AskUserQuestion 既不在 `isChatModeBlockedTool` 也不在 `isChatModeHardStopTool`，`handleChatModeBlock` 不会被调用、`rt.interrupt()` 不会为它触发。故 REGRESS-A 的「第二套 interrupt 竞态」**不直接误伤 AskUserQuestion**（见 Q5）。

**「未选择」不是空 answers 回灌**——我们从未构造 `AskUserResponse.answers` 回灌（该类型全仓只有 `agent.ts` 定义）。是 SDK 在拿不到 `control_response` 后用自己的取消语义产出「未答」结果，或 askRenderer 超时 deny 产出「用户拒绝」。

### Q5. 与 REGRESS-A（Chat Write + interrupt）是否互相踩：硬拦/interrupt 误伤 AskUserQuestion？

**否。AskUserQuestion 与 REGRESS-A 的硬拦/interrupt 路径互不重叠。**

- REGRESS-A 的硬拦只对 `isChatModeBlockedTool===true` 的工具触发（Write/Bash/kanban…），AskUserQuestion 在该函数第 618 行**显式 return false**，**不进硬拦**。
- `handleChatModeBlock`（`session-service.ts:198-217`）只对 `isChatModeHardStopTool===true` 的工具调 `rt.interrupt()`；AskUserQuestion 不会被 `chatModeBlockHandler` 调用（`permission-service.ts:239-241` 仅在 `hardStop` 时调）。
- REGRESS-A 修复加的 `interrupt:true` 只加在 hardStop 的 deny 上（`permission-service.ts:248,361`）；AskUserQuestion 走 allow/软 deny，**不带 interrupt**，不触发 SDK 原子停本轮。
- 反向也不踩：AskUserQuestion 的失败**不**来自 A 的 interrupt 竞态，而来自「无 UI + 丢控制帧」（Q3）。

**结论**：H 与 A 正交。A 修的是「Write 硬拦 deny 的发出方式 + interrupt 竞态」；H 缺的是「AskUserQuestion 放行后的整条交互 UI 链路」。修 H 不会动 A 的硬拦/interrupt 逻辑。

---

## 假设对照

| 假设 | 结论 | 证据 |
|----|------|------|
| H1 AskUserQuestion 进了 deny/interrupt | **否** | `permission-rules.ts:618` 不硬拦；`requiresAutoModeConfirmation:599` false；不进 `handleChatModeBlock`/`rt.interrupt()` |
| H2 事件发出但 Chat.tsx/某面板未订阅或条件渲染 false | **是（更彻底：主进程从没 emit）** | `sdkMessageToIR` 丢 `control_request`（`kscc-message-adapter.ts:241`）；`ASK_USER_REQUEST` enum 无定义；渲染层零订阅；`ToolUseBlockView` 只 JSON dump |
| H3 options 解析失败（空数组/schema 变了）→ UI 空壳超时当未选 | **否（不是根因）** | options schema 没变（`agent.ts:1633-1653` 与 SDK `sdk-tools.d.ts:712+` 一致）；UI 空壳是因为**根本没有渲染 options 的组件**，不是解析失败 |
| H4 子代理（Task）路径另套权限，主会话不弹卡 | **旁证成立但非主因** | `kanban-worker-runner.ts:52-67` 子代理/worker 显式 auto-deny AskUserQuestion（「无人值守：自动拒绝交互式审批/提问」）；但**主会话**也一样无 UI，主因是 Q3 |

---

## 复现路径（精确条件序列）

1. 任意会话（Chat 或 Work），`permissionMode` 非 `bypassPermissions`，模型调用 `AskUserQuestion`。
2. `checkPermission`（`permission-service.ts:235`）：`isChatModeBlockedTool('AskUserQuestion')===false`（`:618`）→ 跳过硬拦。
3. `isAutoModeAutoAllowTool('AskUserQuestion')===false`（不在 SAFE_TOOLS）→ 跳过只读放行。
4. 非 plan 模式 → 落 auto 弹框分支（`permission-service.ts:268-283`）→ `askRenderer` 发 `PERMISSION_REQUEST` 弹**通用权限横幅**（allow/deny，无 options）。
5. 分支 A：用户点 allow → `checkPermission` 返回 `allow:true` → `createCanUseTool` 返回 `{behavior:'allow', updatedInput:input}`（`permission-service.ts:353-354`）→ SDK 执行 AskUserQuestion → SDK 发 `control_request` 子类型 `request_user_dialog` →
   `sdkMessageToIR` `return {}` 丢帧（`kscc-message-adapter.ts:241`）→ 不发 IPC → 渲染层无 UI → SDK 阻塞等 `control_response` → 超时/取消 → 模型当「用户未选」。
6. 分支 B：用户没点 / 没看到横幅 → 120s 超时 `askRenderer` deny（`permission-service.ts:137-141`）→ `createCanUseTool` 返回软 deny（不带 interrupt）→ 模型当「用户拒工具/未选」。
7. 分支 C：`permissionMode==='bypassPermissions'` → `checkPermission` 第 252 行直接 `allow:true` → 同分支 A 后段（SDK 发 `request_user_dialog` → 丢帧）。

任一分支都到不了「选项 UI 挂载 → 用户点选 → 答案回灌」。

---

## 最小修建议（本轮不实施）

**核心：补全 AskUserQuestion 的「控制帧 → 选项 UI → 答案回灌」链路。优先按 SDK 实际协议（`request_user_dialog` 控制帧 + `control_response`）实现，而非仓内未对齐的 `ask_user_request` stub。**

> 工作量提示：这是**补功能**不是修 bug——缺主进程 emit、缺 IPC 通道、缺 preload、缺渲染组件、缺答案回灌。最小可落地的端到端切片如下；总监定优先级。

### 选项 1（推荐，对齐 SDK 协议）：接 `request_user_dialog` 控制帧

1. **主进程识别控制帧**：`kscc-message-adapter.ts:sdkMessageToIR` 新增 `type==='control_request'` 分支，对 `subtype==='request_user_dialog'` 产出一个 TAgent 事件（如 `{kind:'tagent_event', event:{type:'ask_user_request', request:{requestId: request_id, sessionId, questions: parse(payload), toolInput}}}`），复用已有 `AskUserRequest` 类型。
   - 需在 `session-runtime.ts`/`session-service.ts` 持有 `request_id` → `resolve` 的 Promise（仿 `askRenderer` 的 `pending` Map，`permission-service.ts:124-145`）。
2. **新增 IPC 通道**：`agent.ts` `AGENT_IPC_CHANNELS` 加 `ASK_USER_REQUEST: 'agent:ask-user:request'`（主→渲染）；保留已有 `ASK_USER_RESPOND`（渲染→主）。
3. **preload 暴露**：`preload/index.ts` 仿 `PERMISSION_REQUEST`（`:208-218`）加 `onAskUserRequest` 监听 + `askUserRespond` send。
4. **渲染层组件**：新增 `AskUserQuestionBanner.tsx`（仿 `PermissionBanner.tsx`），消费 `ask_user_request`，按 `questions[].options[]` 渲染可点 chip/card（含 `label/description/preview`），用户点选后 `askUserRespond({requestId, answers})`。
   - `useGlobalPermissionSync.ts` 同款加 `useAskUserSync`（切 tab 不丢 pending）。
5. **答案回灌 SDK**：主进程收到 `ASK_USER_RESPOND` → 构造 `control_response`（`{type:'control_response', response:{subtype:'success', request_id, response: answers}}`，对齐 `sdk.d.ts:257-269,3395-3398`）→ 写回 SDK stdin（`claude-agent-adapter.ts` 的 channel/transport）。
   - `request_user_dialog` 的 `response` 形状需实测 SDK（`dialog_kind` 不同 payload 不同）；先按 AskUserQuestion 的 `{answers: Record<string,string>}` 起步。
6. **renderer 兜底**：`ToolUseBlockView`（`ContentBlockView.tsx:90`）对 `name==='AskUserQuestion'` 在 pending 期间不渲染纯 JSON dump，避免「JSON 假 UI」误导。
7. **旁路**：`checkPermission` 对 AskUserQuestion 不应进 askRenderer 弹通用横幅（Q1 反例）——在 `permission-service.ts:260` 只读放行后、`268` 弹框前，加 `if (toolName === 'AskUserQuestion') return { allow: true }`（AskUserQuestion 的「弹」由 SDK 控制帧驱动，不走 permission 横幅），避免双弹/超时 deny 误伤。

### 选项 2（止损，最小改动）：Chat/Work 下 AskUserQuestion 软拒绝 + 中文引导

若本轮不补 UI：`permission-rules.ts:618` 把 `AskUserQuestion` 从「放行」改为「软拒绝」（返回中文「讨论模式暂不支持交互式问答选项，请用文字描述选项让用户回复」），`isChatModeHardStopTool` 仍返回 false（不整轮中断，模型改口用文字问）。
- 代价：丧失 AskUserQuestion 选项卡能力（与设计文档 `02-chat-work-and-permissions.md:44`「Chat ✅ 交互问答」相悖），但消除「假装弹选项实则没弹 → 当未选」的失败体感。
- auto 模式同款：`checkPermission` 对 AskUserQuestion 直接 deny + 中文 reason，不进 askRenderer 超时。

### 测试命令（修复后）

- `bun run test`（或仓内 vitest）：新增 `kscc-message-adapter.test.ts` 用例——`control_request` + `request_user_dialog` 帧 → 产出 `ask_user_request` 事件（不复读 `return {}`）。
- 新增 `permission-service.test.ts` 用例——`AskUserQuestion` 在 chat/auto 下 `allow:true` 且**不进 askRenderer**（不发 `PERMISSION_REQUEST`）。
- 手动：Chat 会话让模型调 AskUserQuestion → 选项卡挂载 → 点选 → 模型收到答案继续；切 tab 回来 pending 不丢；超时/拒绝走中文文案。

---

## 相关文件（绝对路径）

- 权限放行（不背锅，但 Q1 反例在此）：`F:\TAgent-Desktop\packages\shared\src\constants\permission-rules.ts:599,618`
- canUseTool 主路径：`F:\TAgent-Desktop\apps\electron\src\main\lib\permission\permission-service.ts:235,260,268-283,353-362`
- SDK 控制帧丢弃点（**主断点**）：`F:\TAgent-Desktop\packages\shared\src\utils\kscc-message-adapter.ts:60-242`（末尾 `return {}` 在 `:241`）
- SDK 帧透传链：`F:\TAgent-Desktop\apps\electron\src\main\lib\adapters\claude\claude-agent-adapter.ts:120-142`；`F:\TAgent-Desktop\apps\electron\src\main\lib\agent\runtime\session-runtime.ts:255-312`；`F:\TAgent-Desktop\apps\electron\src\main\lib\ipc\session-service.ts:902-909,1238-1262`
- 类型 stub（未实现）：`F:\TAgent-Desktop\packages\shared\src\types\agent.ts:774-775,796-797,1631-1673,2091,2239`
- preload（缺 ask-user）：`F:\TAgent-Desktop\apps\electron\src\preload\index.ts:208-218`
- 渲染层通用 tool_use JSON dump（无选项 UI）：`F:\TAgent-Desktop\apps\electron\src\renderer\components\chat\ContentBlockView.tsx:90-139`
- 权限横幅（对照已实现链路）：`F:\TAgent-Desktop\apps\electron\src\renderer\components\permission\PermissionBanner.tsx`；`F:\TAgent-Desktop\apps\electron\src\renderer\hooks\useGlobalPermissionSync.ts`
- 子代理 auto-deny（旁证）：`F:\TAgent-Desktop\apps\electron\src\main\lib\kanban\kanban-worker-runner.ts:40-67`
- SDK 协议定义：`node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.185+4b8d4561844a275b/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2017-2029`（PermissionResult 无 ask）、`:3268-3275`（can_use_tool）、`:3371-3393`（control_request / request_user_dialog）、`:252-268`（pending_user_dialog_requests）
- 设计口径（期望 Chat 支持 AskUserQuestion）：`F:\TAgent-Desktop\docs\plans\multi-runtime\02-chat-work-and-permissions.md:44`
