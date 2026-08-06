# REGRESS-A 摸底结论 — Chat 下 Write 仍走英文「用户拒工具」并打断会话

> 规格：`docs/dev/core-loop/REGRESS-2026-08-07-SPEC.md` §A
> Brief：`docs/dev/core-loop/REGRESS-A-chat-write-interrupt-brief.md`
> 日期：2026-08-07 / 只读摸底 + 最小修复

## 现象回顾

Chat 模式会话里模型执行 `Write`，会话中断，用户看到英文控制文：

```
The user doesn't want to proceed with this tool use. The tool use was rejected
(eg. if it was a file edit, the new_string was NOT written to the file).
STOP what you are doing and wait for the user to tell you how to proceed.
```

这是 kscc（claude-code 二进制）「用户拒工具」标准控制文，**不是**产品期望的中文 `CHAT_MODE_BLOCK_*` / `chat_mode_blocked` Banner。

---

## 必须回答（带行号证据）

### Q1. Write 在 Chat 下实际走了哪条路径？

**走了硬拦路径（path 1），不是 askRenderer 拒工具，也不是 canUseTool 未挂上。**

- `permissionService` 已注入主进程，`chatModeBlockHandler` 已注册：
  `apps/electron/src/main/index.ts:274-275`（`PermissionService.create` + `SessionService.create(... permissionService)`）→
  `apps/electron/src/main/lib/ipc/session-service.ts:225`（`setOnChatModeBlock((sessionId, toolName) => svc.handleChatModeBlock(...))`）。
- Chat 硬拦判定在 `permissionMode`/`bypass`/白名单/只读放行**之前**：
  `apps/electron/src/main/lib/permission/permission-service.ts:235`
  `if (executionMode === 'chat' && isChatModeBlockedTool(toolName, input, cwd))`。
- 对 `Write`：`isChatModeBlockedTool('Write')` 命中 `WRITE_TOOLS` 分支（`packages/shared/src/constants/permission-rules.ts:634`）→ `true`；
  `isChatModeHardStopTool('Write')` 命中 `WRITE_TOOLS` 硬停分支（`permission-rules.ts:665`）→ `true`。
- 故 `permission-service.ts:238-242`：调 `chatModeBlockHandler` → `emitWorkSwitchSuggestion` →
  `return { allow: false, reason: CHAT_MODE_BLOCK_REASON }`（`permission-rules.ts:680-681`）。
- `getExecutionMode` 对真正的 Chat 会话返回 `'chat'`（`session-service.ts:1190-1197`，读 `meta.executionMode`），
  渲染层首条也已带 `executionMode`（`apps/electron/src/renderer/components/chat/Chat.tsx:1494`）。
  正常 Chat 会话不会把 `executionMode` 误读成 work；`Write` 不会进 `askRenderer`（`permission-service.ts:268-277`）那一路。

结论：硬拦路径本身是对的，`Write` 不会进「用户点允许/拒绝」弹框路径。问题在 deny 的**发出方式**。

### Q2. deny 后 SDK 为何吐英文「doesn't want to proceed」而不是 `CHAT_MODE_BLOCK_REASON`？

`createCanUseTool` 的 `behavior:'deny'` **带上了**中文 `message`，但**没带** SDK 的 `interrupt` 字段。

- `permission-service.ts:350`：`return { behavior: 'deny', message: reason ?? '权限拒绝' }` ——
  `reason` 即 `CHAT_MODE_BLOCK_REASON`（中文），message 确有值。
- 但 SDK 的 `PermissionResult` 在 deny 形态上还有一个 `interrupt?: boolean` 字段
  （`node_modules/.../claude-agent-sdk/sdk.d.ts:2024-2029`）。我们不设它 → 缺省 `false`/软 deny。
- SDK 把 canUseTool 结果整块透传给 kscc 子进程
  （`sdk.mjs:3788-3789`：`return{...await this.canUseTool(...),toolUseID:...}`）。
- kscc（claude-code 二进制，`claude.exe`）对「不带 interrupt 的软 deny」按**用户拒工具**处理：
  注入它自己**硬编码的**英文 `The user doesn't want to proceed with this tool use... STOP what you are doing`
  作为拒绝控制文进流。我们的中文 `message` 只喂给模型，**可见转录文**被二进制覆盖成英文
  （grep 整个 SDK JS 无该串，串在 `claude.exe` 内）。
- 软 deny 的另一后果：**本轮不停**——SDK 不停模型，模型看到中文拒绝后可继续/可重试 `Write`。

### Q3. `chatModeBlockHandler` 注册点在哪？interrupt 是否把「正常 Chat 硬拦」渲染成「用户拒工具」？

注册点：`session-service.ts:225`；回调实现：`session-service.ts:198-217`（`handleChatModeBlock`）。

`handleChatModeBlock` 用**第二套** interrupt 机制去停本轮：

```ts
// session-service.ts:198-217
this.clearPendingSteer(sessionId)
const rt = this.runtimes.get(sessionId)
if (rt) {
  void rt.interrupt().catch(() => {})          // session-service.ts:203 —— 另发一次 sdk_interrupt
}
this.sendPayload(sessionId, { kind: 'tagent_event', event: { type: 'turn_end' } })
const userError = buildChatModeBlockUserError(toolName)
this.sendPayload(sessionId, { ..., event: { type: 'session_error', message: userError.message, error: userError } })
```

因为 Q2 的软 deny **不会**让 SDK 停本轮，`handleChatModeBlock` 只能再发一次
`rt.interrupt()`（→ `session-runtime.ts:462-466` → `adapter.interruptQuery` → `sdk_interrupt`）。
`rt.interrupt()` 在 `permission-service.ts:239`（return deny 之前）就被 fire-and-forget 触发，
与紧随其后的 deny 控制响应**竞态**：

- 若 deny 先到：软 deny → 英文控制文 + 模型续跑/重试，随后 `sdk_interrupt` 才中止 → 中断不干净，
  英文控制文成为「会话被打断」的显眼来源；
- 若 `sdk_interrupt` 先到：本轮被中止，英文控制文/中断文混入转录。

无论谁先，**「正常 Chat 硬拦」都被渲染成了「用户拒工具」**（英文控制文 + 中断），而非产品期望的
中文 `chat_mode_blocked` Banner。

### Q4. 渲染层：该英文控制文是否被当成普通错误打断 UX？`SessionErrorBanner` / `chat_mode_blocked` 是否没触发？

- **哨兵存在且能识别该英文文**：`apps/electron/src/renderer/components/chat/session-turn-model.ts:258-270`
  `isSdkControlUserMessage`，第 266 行 `if (/^The user doesn't want to proceed with this tool use/i.test(t)) return true`。
  `groupItemsIntoTurns`（`session-turn-model.ts:334-349`）把这类控制文 user 折进当前 assistant-turn，不当用户气泡。
  → 哨兵对「user 文本消息」形态的英文控制文是生效的。
- **但中断竞态会把英文控制文抬成可见错误条**：竞态中的 `sdk_interrupt` 中止本轮后，kscc 产出 `result`
  可能带 `error_*` 子类/`errors`（含拒绝文案）。渲染层 `Chat.tsx:1222-1247` 的 result 分支：
  `if (isErrorResult || errorTexts.length > 0) { ... setSessionError({ ..., message: userError.message || raw }) }`
  会用 `classifyUserFacingError(raw)` 覆盖错误条。
- `classifyUserFacingError`（`packages/shared/src/utils/session-error-classify.ts:238-269`）对纯英文
  「doesn't want to proceed…」：`isChatModeBlockMessage`（`:148-158`）不命中（无中文 Chat/Work 短语），
  分类表 `permission_denied` 正则 `:229` `/用户拒绝|权限拒绝|permission denied|deny/i` 也不命中
  （英文文无 `deny`/`permission denied`）→ 落到 `unknown`（`:268`，title `运行出错`，message=英文原文）。
  → **中文 `chat_mode_blocked` Banner 被「运行出错：英文控制文」覆盖**，与现象一致。
- `handleChatModeBlock` 本身确实发了中文 `session_error`（`session-service.ts:208-216`，
  `buildChatModeBlockUserError` → `session-error-classify.ts:161-170`，`code:'chat_mode_blocked'`），
  但被随后竞态产生的 error result 覆盖，用户最终看到英文。

---

## 根因（1–3 条 + 证据 path:line）

1. **deny 缺 `interrupt:true` → kscc 当「软 deny / 用户拒工具」处理并吐英文控制文，且本轮不停**
   - `permission-service.ts:350` `return { behavior: 'deny', message: reason ?? '权限拒绝' }` 未带 `interrupt`；
   - SDK 类型 `PermissionResult` deny 有 `interrupt?: boolean`（`sdk.d.ts:2024-2029`），SDK 透传给二进制（`sdk.mjs:3788-3789`）；
   - 不带 `interrupt` → kscc 注入硬编码英文「doesn't want to proceed… STOP what you are doing」控制文，且模型可继续/重试 `Write`。

2. **`chatModeBlockHandler` 用第二套 `rt.interrupt()` 停本轮，与软 deny 竞态**
   - 注册：`session-service.ts:225`；实现 `handleChatModeBlock` `session-service.ts:198-217`；
   - 在 `permission-service.ts:239`（return deny 之前）fire-and-forget `rt.interrupt()`（`session-service.ts:203`），
     与 deny 控制响应竞态 → 中断不干净，英文控制文 + 模型续跑混入转录。

3. **英文控制文经中断竞态被抬成可见错误条，覆盖中文 `chat_mode_blocked` Banner**
   - 哨兵 `isSdkControlUserMessage`（`session-turn-model.ts:266`）只折叠 user 文本消息形态的英文控制文，
     折不掉 error result 形态；
   - 渲染层 result 分支 `Chat.tsx:1227-1247` 用 `classifyUserFacingError` 覆盖错误条；
   - `classifyUserFacingError` 对英文控制文落到 `unknown`（`session-error-classify.ts:268`），
     覆盖掉 `handleChatModeBlock` 已发的中文 `chat_mode_blocked`（`session-service.ts:208-216`）。

---

## 修复方案（最小）

**核心：让 Chat 硬拦的 deny 自带 `interrupt:true`，由 SDK 原子「拒工具 + 停本轮」，消除软 deny 续跑与第二套 interrupt 竞态。**

1. `permission-service.ts` `checkPermission`：返回类型加 `interrupt?: boolean`；Chat 硬停工具
   `return { allow:false, reason: CHAT_MODE_BLOCK_REASON, interrupt: isChatModeHardStopTool(...) }`
   （软拒绝如 `EnterPlanMode` 仍不带 interrupt，模型可改口）。
2. `permission-service.ts` `createCanUseTool`（kscc 核）：deny 形态加 `interrupt?: boolean`，
   `return { behavior:'deny', message, ...(interrupt ? { interrupt:true } : {}) }`。
3. `claude-agent-adapter.ts:336`（`KsccQueryOptions.canUseTool` 类型）deny 形态对齐 SDK 加 `interrupt?: boolean`。
4. `createBeforeToolCall`（Pi 核）：不改 —— pi-agent-core `beforeToolCall` 无 `interrupt` 字段，
   Pi 仍靠 `chatModeBlockHandler` 的 `rt.interrupt()` 停本轮（`session-service.ts:203`）。
5. `handleChatModeBlock`：**不改** —— 保留 `rt.interrupt()`（兼管主进程 `turnInFlight` 状态、作 fallback）
   与中文 Banner。`interrupt:true` 让 kscc 的停本轮成为原子操作，竞态窗口消除，英文控制文回落为
   哨兵可折叠的形态，中文 Banner 不再被 error result 覆盖。

不改默认 Work、不删硬拦、不自动切 Work；不碰 concise 时间线（Agent B）。

## vitest（新增 `permission-service.test.ts`）

- `executionMode=chat` + `Write` → `deny` + `interrupt:true` + `message===CHAT_MODE_BLOCK_REASON` +
  `chatModeBlockHandler` 被调用 + **未发 `PERMISSION_REQUEST`（不走 askRenderer）**。
- `executionMode=chat` + `EnterPlanMode`（软拒绝）→ `deny` + 无 `interrupt` + 不触发 `chatModeBlockHandler` + 不走 askRenderer。
- `executionMode=chat` + `Read` → `allow`（只读不拦）。
- `executionMode=work` + `Write` → 走 askRenderer（发 `PERMISSION_REQUEST`）；renderer deny → `deny` 无 `interrupt`（反例对照）。
