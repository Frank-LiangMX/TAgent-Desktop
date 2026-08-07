# REGRESS-H 实现规格 — 移植 General AskUserQuestion 到 Desktop

> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> 上游摸底：`docs/dev/core-loop/REGRESS-H-GENERAL-PORT-FINDINGS.md`（对照表 + 推荐 + SDK 机制推断）  
> 既有断点：`docs/dev/core-loop/REGRESS-H-FINDINGS.md`  
> 日期：2026-08-07

## 路线（一句话）

**搬 General 的 `agent-ask-user-service.ts` 状态机 + `canUseTool` 拦截 + `updatedInput.answers` 注入**（同 SDK 0.3.185 已证可用），套 Desktop `PermissionBanner` 视觉皮。**不接控制帧、不碰 `request_user_dialog`/`control_response`、不动传输层。**

工作量 **M**。新增 4 文件 + 编辑 ~6 处。Banner 组件是最大头。

---

## 前置确认（动手前 5 分钟查 2 项）

1. `apps/electron/package.json` 是否已装 `react-markdown` + `remark-gfm`（General `AskUserBanner.tsx:12-13` 用）。未装 → 预览降级为纯文本（`option.preview` 直接 `<pre>`），或补装。
2. Desktop 渲染层是否已有「中心监听分派 `tagent_event`」的 hook（类似 General `useGlobalAgentListeners`）。本规格采用**专用通道**方案，不强依赖它；但若已有，可省 `useAskUserSync` 改为扩展现有监听。

---

## 切片 1 — 主进程：服务 + canUseTool 拦截（核心，最小可点选）

### 1.1 新建 `apps/electron/src/main/lib/agent/agent-ask-user-service.ts`

**整文件搬** `F:\TAgent_General\apps\electron\src\main\lib\agent-ask-user-service.ts`（159 行）。改动：
- import 来源 `@tagent/shared`（Desktop 已有同形类型 `AskUserRequest/AskUserQuestion/AskUserQuestionOption`，见 `packages/shared/src/types/agent.ts:1634-1673`，零改动复用）。
- 其余原样：`handleAskUserQuestion`（解析 questions→`sendToRenderer(request)`→pending Map→abort deny）、`respondToAskUser`（`updatedInput={...toolInput, answers}`→resolve `{behavior:'allow', updatedInput}`）、`getPendingRequests`、`clearSessionPending`、单例 `askUserService`。

### 1.2 编辑 `apps/electron/src/main/lib/permission/permission-service.ts`

在 `createCanUseTool`（`:331-364`）**返回的回调顶部**、调用 `checkPermission` **之前**，加 AskUserQuestion 拦截（仿 General `agent-permission-service.ts:115-119`）：

```ts
// 在 createCanUseTool 返回的 (toolName, input, options) => { ... } 最前面
if (toolName === 'AskUserQuestion') {
  return askUserService.handleAskUserQuestion(
    sessionId, input, options.signal,
    (request) => {
      win()?.webContents.send(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, request)
    }
  )
}
```

要点：
- `win()` / `askUserService` 需在该文件 import 或注入。Desktop `permission-service.ts` 已有 `askRenderer(win(), req)` 用 `win()` helper（`:124-151`），复用同一拿窗口方式。
- `options.signal` 即 SDK `CanUseToolOptions.signal`，传给 service 做 abort。
- 拦截在 `checkPermission` 之前 → AskUserQuestion **不再进 `askRenderer` 弹通用横幅**（消除 FINDINGS Q1 的「误当普通写工具」反例）。
- `permission-rules.ts:618` `isChatModeBlockedTool('AskUserQuestion')===false` **保持不动**（不硬拦；拦截在 canUseTool 顶层做）。

> 若 `createCanUseTool` 当前签名 `(sessionId, getMode, cwd, getExecutionMode)` 不便拿 `win()`，可改在调用点 `session-service.ts:1073` 注入 `sendAskUser` 回调（仿 General `agent-orchestrator.ts:2312-2329` 给 `createCanUseTool` 多传 `askUserHandler + sendAskUserToRenderer`）。**二选一，优先在 `permission-service.ts` 内闭包解决，少改签名。**

### 1.3 编辑 `packages/shared/src/types/agent.ts`

`AGENT_IPC_CHANNELS`（`:2063-2095` 段）AskUser 区块（`:2089-2091` 现仅有 `ASK_USER_RESPOND`）加 2 项：

```ts
// 主进程 → 渲染进程
ASK_USER_REQUEST: 'agent:ask-user:request',
ASK_USER_RESOLVED: 'agent:ask-user:resolved',
// 渲染进程 → 主进程（已存在）
ASK_USER_RESPOND: 'agent:ask-user:respond',
```

类型 `AskUserRequest/AskUserResponse/AskUserQuestion/AskUserQuestionOption`（`:1634-1673`）**已存在同形，不动**。`AgentEvent`/`TAgentEvent` 的 `ask_user_request/ask_user_resolved`（`:774-775,796-797`）**已存在，不动**（专用通道方案下渲染层不依赖这俩 event 类型，但留着无害）。

### 1.4 编辑主进程 IPC 注册（`session-service.ts` 或等价 ipc 注册处）

加 `ASK_USER_RESPOND` handler（仿 General `main/ipc.ts:2248-2260`）：

```ts
ipcMain.handle(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, async (event, response: AskUserResponse) => {
  const { requestId, answers } = response
  const sessionId = askUserService.respondToAskUser(requestId, answers)
  if (sessionId) {
    winForSession(sessionId)?.webContents.send(AGENT_IPC_CHANNELS.ASK_USER_RESOLVED, { requestId })
  }
})
```

可选（重载恢复）：在 `GET_PENDING_REQUESTS` handler（`agent.ts:2109` enum）填 `askUsers: askUserService.getPendingRequests()`（仿 General `main/ipc.ts:2312-2321`）。最小轮可跳过。

### 1.5 编辑 session stop/delete 清理

在 Desktop 会话 stop / delete 处（`session-service.ts`，与现有 `permissionService.clearSessionPending` 同位置）加：

```ts
askUserService.clearSessionPending(sessionId)
```

仿 General `main/ipc.ts:1647-1649`。

**切片 1 完成后手测**：跑起来让模型调 AskUserQuestion → 主进程应 emit `ASK_USER_REQUEST` → 渲染层暂无组件，但 IPC 已通（可在 preload `onAskUserRequest` 临时 `console.log` 验证帧到达）。**关键验证点**：模型点 allow 后是否还卡（若卡说明 SDK 仍发 `request_user_dialog`——此时本规格假设不成立，退 FINDINGS 选项 1；预期不卡）。

---

## 切片 2 — preload + 渲染 atoms + 监听

### 2.1 编辑 `apps/electron/src/preload/index.ts`

仿权限桥 `:206-218`，在 `ElectronAPI` 接口与实现各加：

```ts
// 接口
onAskUserRequest: (cb: (request: AskUserRequest) => void) => () => void
onAskUserResolved: (cb: (e: { requestId: string }) => void) => () => void  // 可选
askUserRespond: (response: AskUserResponse) => Promise<void>
// 实现
onAskUserRequest: (cb) => {
  const l = (_: unknown, r: AskUserRequest) => cb(r)
  ipcRenderer.on(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, l)
  return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.ASK_USER_REQUEST, l)
},
onAskUserResolved: (cb) => { /* 同上，监听 ASK_USER_RESOLVED */ },
askUserRespond: (response) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, response),
```

`AskUserRequest/AskUserResponse` 已从 `@tagent/shared` 导出（preload 已有大量 `@tagent/shared` 类型导入，照加）。

### 2.2 新建 `apps/electron/src/renderer/atoms/ask-user-atoms.ts`

抄 General `agent-atoms.ts:769-803` 的 ask-user 段：

- `allPendingAskUserRequestsAtom = atom<Map<string, readonly AskUserRequest[]>>(new Map())`
- `AskUserQuestionDraft`（`{ selected: string[]; customText: string; showCustom: boolean }`）
- `AskUserRequestDraft`（`{ activeTab: number; focusedOptIdx: number; answers: Map<number, AskUserQuestionDraft> }`）
- `askUserDraftsAtom = atom<Map<string, AskUserRequestDraft>>(new Map())`
- `pendingAskUserRequestsAtom`（派生读写，按 currentSessionId 取队列）——若 Desktop 已有 `currentSessionId` atom 机制则接，否则 Banner 直接读 `allPendingAskUserRequestsAtom.get(sessionId)`（General `AskUserBanner.tsx:44` 即如此，**可省派生 atom**）。

可加 `enqueueAskUserAtom` / `resolveAskUserAtom` 写原子（仿 `permission-atoms.ts:74-120`），或直接在 hook 里 `store.set(allPendingAskUserRequestsAtom, ...)`（General `useGlobalAgentListeners.ts:1159-1164` 即直接 set）。**推荐直接 set，少一层抽象**。

### 2.3 新建 `apps/electron/src/renderer/hooks/useAskUserSync.ts`

仿 `useGlobalPermissionSync.ts:28-47`，App 根挂一次：

```ts
useEffect(() => {
  const c1 = window.electronAPI.onAskUserRequest((request) => {
    store.set(allPendingAskUserRequestsAtom, (prev) => {
      const map = new Map(prev)
      const cur = map.get(request.sessionId) ?? []
      map.set(request.sessionId, [...cur, request])
      return map
    })
    // 可选：桌面通知（仿 General :1166-1171）
  })
  const c2 = window.electronAPI.onAskUserResolved(({ requestId }) => {
    // 清所有会话中该 requestId + drafts（仿 General :1172-1190）
    store.set(allPendingAskUserRequestsAtom, (prev) => { /* 过滤 requestId */ })
    store.set(askUserDraftsAtom, (prev) => { const m = new Map(prev); m.delete(requestId); return m })
  })
  return () => { c1(); c2() }
}, [store])
```

在 App 根（与 `useGlobalPermissionSync` 同处）调用 `useAskUserSync()`。

---

## 切片 3 — 渲染组件 + 挂载（最大头）

### 3.1 新建 `apps/electron/src/renderer/components/chat/AskUserQuestionBanner.tsx`

**逻辑搬** General `AskUserBanner.tsx`（533 行），**换皮**（见 `REGRESS-H-GENERAL-PORT-FINDINGS.md`「UI 换皮清单」）。保留：
- props `{ sessionId }`，pending = `allPendingAskUserRequestsAtom.get(sessionId) ?? []`，`request = requests[0]`，`+N` 队列徽标。
- 多题 Tab（`:305-333`）、`QuestionCard`（`:408-532`）、单选/多选 `toggleOptionByState`（`:204-216`）、自定义文本、`option.preview` markdown 预览（`:523-528`）。
- 键盘 ↑↓/Enter（`:88-135`）、auto-advance 150ms（`:345-351`）、`askUserDraftsAtom` 切 tab/会话持久。
- `handleSubmit`→`window.electronAPI.askUserRespond({requestId, answers})` + 乐观出队（`:231-265`）。
- `handleDismiss`→`window.electronAPI.stopAgent(sessionId)`（`:137-156`）。

**换皮要点**：
- 外壳：General `session-glass-modal mx-4 mb-3 animate-in slide-in-from-bottom-2` → Desktop `PermissionBanner` 的 `<motion.div className="session-permission-banner pointer-events-auto overflow-hidden ...">` + `rounded-2xl border shadow-lg backdrop-blur-xl bg-background/80`（实测 `PermissionBanner.tsx:87-92`）。
- 选项/Tab 圆角：General `rounded-glass-popover` → Desktop `rounded-2xl`（与 PermissionBanner 一致；`rounded-glass-popover` Desktop 也有，二选一，**建议 `rounded-2xl` 保一致**）。
- 选中 `bg-primary text-primary-foreground shadow-sm`、未选 `bg-foreground/[0.04] ... hover:bg-foreground/[0.08]`：与 Desktop 一致，保留。
- 删危险色（问答无危险级）。
- `Button`/`Tooltip` 用 `@tagent/ui`（Desktop 同），图标 `lucide-react` `Send`/`X` 保留。

### 3.2 编辑 `apps/electron/src/renderer/components/chat/Chat.tsx`

`:104` import 区加 `import { AskUserQuestionBanner } from './AskUserQuestionBanner'`；`:2043` `<PermissionBanner sessionId={sessionId}/>` 紧邻处加：

```tsx
<AskUserQuestionBanner sessionId={sessionId} />
```

挂载顺序：与 `PermissionBanner` 同一栈（composer 上方，`Chat.tsx:1979-1980` 注释说明的位置）。

### 3.3（可选打磨）编辑 `ContentBlockView.tsx:90-139`

`ToolUseBlockView` 对 `name === 'AskUserQuestion'`：pending 期间不渲染 `<pre>{JSON.stringify(input)}</pre>`（避免「JSON 假 UI」误导）。优先级低，Banner 已是真正的交互 UI。

---

## 切片 4 — 验证

### 自动测试

- 新增 `agent-ask-user-service.test.ts`：`handleAskUserQuestion` 解析 questions 正确；`respondToAskUser` 注入 `updatedInput.answers` 且 resolve `{behavior:'allow', updatedInput}`；abort→deny；`clearSessionPending`→deny。
- 扩展 `permission-service.test.ts`：`AskUserQuestion` 在 chat/auto 下走拦截分支、**不进 `askRenderer`**（不发 `PERMISSION_REQUEST`）。

### 手测（关键，验 SDK 机制假设）

1. Chat 会话，让模型调 AskUserQuestion（多题 + 多选 + 带 preview）。
2. 选项卡挂载在 composer 上方 → Tab 切题、点选、自定义文本、preview 渲染、↑↓/Enter。
3. 点确认 → 模型**收到 answers 继续本轮**（不卡、不超时、不当「未选」）。**这是 SDK 机制假设的实证**。
4. 切 tab 离开再回 → pending 不丢（atom 跨会话保留）+ drafts 持久。
5. dismiss（X）→ `stopAgent` 终止本轮。
6. 多会话同时弹 → 各自独立队列、`+N` 徽标正确。
7. 子代理/worker 调 AskUserQuestion → 仍 auto-deny（`kanban-worker-runner.ts:52-67` 不动）。

### 回退条件

若手测 3 失败（模型仍卡 / SDK 仍发 `request_user_dialog`）：本规格「canUseTool 拦截 + updatedInput.answers」假设不成立。退 FINDINGS「选项 1」：`kscc-message-adapter.ts` 加 `control_request`/`request_user_dialog` 分支 + `control_response` 回灌 + 主进程 stdin 写。**同 SDK 同机制，预期不需退；但留此兜底。**

---

## 移植文件清单（stdout 摘要）

**从 General 搬（改 import/换皮）**：
- `agent-ask-user-service.ts`（主进程服务，整搬）
- `AskUserBanner.tsx` → `AskUserQuestionBanner.tsx`（渲染组件，搬逻辑换皮）
- `agent-atoms.ts` ask-user 段 → `ask-user-atoms.ts`（渲染 atoms，抽段新建）

**Desktop 新建**：
- `apps/electron/src/main/lib/agent/agent-ask-user-service.ts`
- `apps/electron/src/renderer/atoms/ask-user-atoms.ts`
- `apps/electron/src/renderer/hooks/useAskUserSync.ts`
- `apps/electron/src/renderer/components/chat/AskUserQuestionBanner.tsx`

**Desktop 编辑**：
- `apps/electron/src/main/lib/permission/permission-service.ts`（`createCanUseTool` 顶部加 AskUserQuestion 拦截，`:331`）
- `apps/electron/src/main/lib/ipc/session-service.ts`（`createCanUseTool` 调用注 sendAskUser `:1073`；加 `ASK_USER_RESPOND` handler；stop/delete 加 `clearSessionPending`）
- `packages/shared/src/types/agent.ts`（`AGENT_IPC_CHANNELS` 加 `ASK_USER_REQUEST`/`ASK_USER_RESOLVED`，`:2089-2091`）
- `apps/electron/src/preload/index.ts`（加 `onAskUserRequest`/`onAskUserResolved`/`askUserRespond`，仿 `:206-218`）
- `apps/electron/src/renderer/components/chat/Chat.tsx`（import + 挂载 `:104,:2043`）
- 可选 `apps/electron/src/renderer/components/chat/ContentBlockView.tsx`（`:90-139` AskUserQuestion 兜底）

**改皮**：`session-glass-modal`→`session-permission-banner`+motion、`rounded-glass-popover`→`rounded-2xl`、保留 `bg-primary` 选中态、删危险色、保留 react-markdown 预览。

**工作量**：**M**。无新 SDK 协议、无控制帧、无传输层改动；最大头是 Banner 组件 533 行搬 + 换皮。

## 不做

- 不接 `request_user_dialog`/`control_response`（除非手测 3 失败才退此路）。
- 不动 `permission-rules.ts:599,618`（AskUserQuestion 不硬拦保持）。
- 不动 `kanban-worker-runner.ts`（worker auto-deny 保持）。
- 不动 REGRESS-A 的硬拦/interrupt 路径（H 与 A 正交，见 FINDINGS Q5）。
- 本轮只读摸底已完；实现轮按本规格动手。
