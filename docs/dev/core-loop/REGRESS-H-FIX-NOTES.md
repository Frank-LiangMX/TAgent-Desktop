# REGRESS-H 实现落地 — AskUserQuestion 全链路（canUseTool 拦截 + updatedInput.answers）

> 规格：`docs/dev/core-loop/REGRESS-H-implement-brief.md`（切片 1+2+3）
> 摸底：`docs/dev/core-loop/REGRESS-H-GENERAL-PORT-FINDINGS.md`（移植 General，非控制帧）
> 既有断点：`docs/dev/core-loop/REGRESS-H-FINDINGS.md`
> 日期：2026-08-07 / 不 commit / 不 push（按 kscc prompt 指令）

## 一句话

按 brief 实现了 AskUserQuestion 全链路（主进程服务 + canUseTool 拦截 + 专用 IPC + preload + 渲染 atoms + 同步 hook + 选项卡 Banner + 挂载 + 会话清理），**不接控制帧、不动传输层**。单测全绿，全量 vitest 803/803 绿，apps/electron + packages/shared tsc 通过。**未手测**（见末节手测要点，验 SDK 机制假设）。

## 机制（同 TAgent_General / 同 SDK 0.3.185）

模型调 `AskUserQuestion` → `createCanUseTool` 回调**顶部**拦截（早于 `checkPermission` / `askRenderer`）→ `askUserService.handleAskUserQuestion` 解析 questions、emit `ASK_USER_REQUEST`、pending Map 阻塞 → 渲染层 `AskUserQuestionBanner` 弹选项卡 → 用户作答 → `askUserRespond` IPC → `respondToAskUser` 把 answers 注入 `updatedInput = {...toolInput, answers}` → resolve `{behavior:'allow', updatedInput}` → SDK 拿带 answers 的 input 执行，**不发 `request_user_dialog` 控制帧**（canUseTool 已接管）。

对照 Desktop 旧 bug：`permission-service.ts` 对 AskUserQuestion 返回 `{behavior:'allow', updatedInput: input}`（**无 answers**）且落进 `askRenderer` 弹通用横幅 → 用户点 allow → 工具以无 answers 的 input 执行 → SDK 发 `request_user_dialog` → `kscc-message-adapter.ts:241 return {}` 丢帧 → SDK 阻塞 → 当「未选」。修法是像 General 一样在 canUseTool 拦截 + 注入 answers，让 SDK 压根不发控制帧。

## 改了哪些文件

### 新建（4）
- `apps/electron/src/main/lib/agent/agent-ask-user-service.ts` — 整搬 General 服务（`handleAskUserQuestion` / `respondToAskUser` / `getPendingRequests` / `clearSessionPending`），import 来源 `@tagent/shared`，单例 `askUserService`。
- `apps/electron/src/renderer/atoms/ask-user-atoms.ts` — `allPendingAskUserRequestsAtom`（Map<sessionId, AskUserRequest[]>）+ `askUserDraftsAtom` + `AskUserQuestionDraft` / `AskUserRequestDraft`（移植 General `agent-atoms.ts:769-787`，省派生原子，Banner 直接读 map）。
- `apps/electron/src/renderer/hooks/useAskUserSync.ts` — App 根挂一次：`ASK_USER_REQUEST` 入队 / `ASK_USER_RESOLVED` 按 requestId 出队 + 清 drafts（仿 `useGlobalPermissionSync`）。
- `apps/electron/src/renderer/components/chat/AskUserQuestionBanner.tsx` — 搬 General `AskUserBanner` 逻辑（多题 Tab / 单选多选 / 自定义文本 / ↑↓Enter / auto-advance 150ms / drafts 持久 / dismiss=stopAgent），**换 PermissionBanner 皮**（`motion.div session-permission-banner` + `rounded-2xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl`）。

### 编辑（6）
- `apps/electron/src/main/lib/permission/permission-service.ts` — import `askUserService`；`createCanUseTool` 回调签名扩第三参 `options?`（见下方 gotcha），顶部加 `if (toolName === 'AskUserQuestion') return askUserService.handleAskUserQuestion(sessionId, input, signal, req => this.getWindow()?.webContents.send(ASK_USER_REQUEST, req))`。
- `apps/electron/src/main/lib/ipc/session-service.ts` — import `askUserService` + `AskUserResponse`；`registerIpc` 加 `ASK_USER_RESPOND` handler（`respondToAskUser` → emit `ASK_USER_RESOLVED`）；`STOP_AGENT` / `DELETE_SESSION` 加 `askUserService.clearSessionPending(sessionId)`。
- `packages/shared/src/types/agent.ts` — `AGENT_IPC_CHANNELS` AskUser 区块加 `ASK_USER_REQUEST: 'agent:ask-user:request'`、`ASK_USER_RESOLVED: 'agent:ask-user:resolved'`（`ASK_USER_RESPOND` 已存在）。`AskUserRequest/AskUserResponse/AskUserQuestion/AskUserQuestionOption` 已同形，零改动。
- `apps/electron/src/preload/index.ts` — `electronAPI` 加 `onAskUserRequest` / `onAskUserResolved` / `askUserRespond`（仿权限桥 `:206-218`）+ 类型 import。
- `apps/electron/src/renderer/App.tsx` — `Window.electronAPI` 接口加 ask-user 三方法 + import/调用 `useAskUserSync()`（紧邻 `useGlobalPermissionSync()`）。
- `apps/electron/src/renderer/components/chat/Chat.tsx` — import `AskUserQuestionBanner` + 紧邻 `<PermissionBanner>` 挂 `<AskUserQuestionBanner sessionId={sessionId} />`（composer 上方）。

### 新增单测（2）
- `apps/electron/src/main/lib/agent/agent-ask-user-service.test.ts`（5 例）：解析 questions + respond 注入 `updatedInput.answers` + resolve allow / 未找到返回 null / abort deny / clearSessionPending deny / preview 截断 10_000 + 缺字段兜底。
- 扩 `apps/electron/src/main/lib/permission/permission-service.test.ts`（+2 例，共 6）：`AskUserQuestion` 走拦截分支发 `ASK_USER_REQUEST`、**不发 `PERMISSION_REQUEST`**（不进 askRenderer）；respond 注入 answers；abort deny。

## 关键 gotcha（写进记忆）

- **`createCanUseTool` 第三参 `options` 的类型**：本地 `KsccQueryOptions.canUseTool` 把 `options` 标成 `{ mcpServers?: unknown }`（无 `signal`），而 SDK `CanUseTool` 是 `options: { signal: AbortSignal; ... }`。两者都要满足 → 用 `options?: { signal?: AbortSignal; mcpServers?: unknown }`：`options?` 可选（兼容旧 2 参调用与本地类型）；`signal?` 可选（弱类型对 `{mcpServers?}` 有共同属性 `mcpServers`，过 weak-type 检查）；分支内 `const signal = options?.signal ?? new AbortController().signal` 兜底。SDK 运行时恒传 signal。
- **预览降级纯文本**：Desktop `apps/electron/package.json` 未装 `react-markdown` / `remark-gfm`（仅 root devDeps 有，渲染层 Vite 不直接可用）→ `option.preview` 渲染为 `<pre className="...whitespace-pre-wrap break-words">`，不补装依赖。
- **`handleDismiss` 简化**：General 版用 `agentStreamingStatesAtom` + `finalizeStreamingActivities` 乐观停流；Desktop 改为只清队列 + drafts + `stopAgent`（停流由主进程 STOP_AGENT 推 `turn_end`，`useGlobalSessionRunSync` 收口），不依赖 Desktop 没有的那俩 atom。
- **专用通道**：与 Desktop 权限架构一致（`ASK_USER_REQUEST` / `ASK_USER_RESOLVED` 专用 enum + preload + hook），不复用 General 的 `STREAM_EVENT` + `tagent_event`。
- **`respondAskUser` → `askUserRespond`**：preload 方法名按 brief 用 `askUserRespond`（General Banner 用 `respondAskUser`，移植时已改名对齐）。

## 验证结果

- `agent-ask-user-service.test.ts`：5/5 ✓
- `permission-service.test.ts`：6/6 ✓（4 旧 REGRESS-A + 2 新 REGRESS-H）
- 全量 `vitest run`：**82 文件 / 803 测试全绿**，无回归
- `tsc -p apps/electron/tsconfig.json --noEmit`：通过
- `tsc -p packages/shared/tsconfig.json --noEmit`：通过
- 跑法（本机 Git-bash 沙箱 fork 失败，改 node 直跑）：
  - `node "node_modules/.bun/vitest@2.1.9+178e511e62867ab4/node_modules/vitest/vitest.mjs" run`
  - `node "node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc" -p <tsconfig> --noEmit`

## 手测要点（关键，验 SDK 机制假设 — 未跑）

1. Chat 会话，让模型调 AskUserQuestion（多题 + 多选 + 带 preview）。
2. 选项卡挂载在 composer 上方（紧邻 PermissionBanner）→ Tab 切题、点选、自定义文本、preview 纯文本渲染、↑↓/Enter、auto-advance。
3. **点确认 → 模型收到 answers 继续本轮**（不卡、不超时、不当「未选」）。**这是 SDK 机制假设的实证**：canUseTool 拦截 + updatedInput.answers 后 SDK 不发 `request_user_dialog`。
4. 切 tab 离开再回 → pending 不丢（atom 跨会话保留）+ drafts 持久。
5. dismiss（X）→ `stopAgent` 终止本轮。
6. 多会话同时弹 → 各自独立队列、`+N` 徽标正确。
7. 子代理/worker 调 AskUserQuestion → 仍 auto-deny（`kanban-worker-runner.ts` 未动）。

## 回退条件

若手测 3 失败（模型仍卡 / SDK 仍发 `request_user_dialog`）：本规格「canUseTool 拦截 + updatedInput.answers」假设不成立（与 General 同 SDK 同机制，预期不需退）。退 FINDINGS「选项 1」：`kscc-message-adapter.ts` 加 `control_request` / `request_user_dialog` 分支 + `control_response` 回灌 + 主进程 stdin 写。

## 不做

- 不接 `request_user_dialog` / `control_response`（除非手测 3 失败）。
- 不动 `permission-rules.ts:599,618`（AskUserQuestion 不硬拦保持）。
- 不动 `kanban-worker-runner.ts`（worker auto-deny 保持）。
- 不动 REGRESS-A 硬拦/interrupt 路径（H 与 A 正交）。
- 不 commit / 不 push（按 kscc prompt 指令）。
- GET_PENDING_REQUESTS 未填 `askUsers`（brief 标可选，最小轮跳过；重载恢复留待后续）。
