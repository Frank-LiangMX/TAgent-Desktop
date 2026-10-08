# 停止语义评审：跨内核切换能否保证「无工具仍在写」

范围（只读评审，未改任何源码）：
`agent/runtime/session-runtime.ts`、`adapters/pi/pi-agent-adapter.ts`、
`adapters/codex/codex-app-server-adapter.ts`、`adapters/codex/codex-app-server-session-manager.ts`、
`adapters/claude/claude-agent-adapter.ts`、`ipc/session-service.ts` 的 `STOP_AGENT`。
评审对象是 ADR-0011 §5「先停止再切换」的静默前提。

## 结论（直接回答）

**都不保证。** `isTurnInFlight() === false` 与 `interrupt()` resolve（等价地 `isInterrupting() === false`）
只表示**宿主侧记账标志已翻转** + **adapter 已接受中断请求**，不表示任何工具/子进程已停止写盘。
三内核在这一点上语义一致——中断都是 best-effort、非阻塞、不等待终态。

跨内核切换若以这两个信号作为「旧内核已静默」的判据，存在**旧内核工具在新内核已开跑之后继续写同一 workspace** 的窗口。
按当前代码该窗口不是理论风险，而是每次「运行中停止→立刻切换」都会经过的路径。

## 证据

### 1. `turnInFlight` 的翻转点与真实停止解耦

`SessionRuntime.interrupt()`（`session-runtime.ts:553-568`）：

```ts
const operation = Promise.resolve()
  .then(() => this.adapter.interruptQuery?.(this.sessionId))
  .then(() => undefined)
  .finally(() => { this.turnInFlight = false; this.interruptInFlight = undefined })
this.interruptInFlight = operation
await operation
```

- `turnInFlight = false` 与 `interruptInFlight = undefined` 在**同一个 `finally`** 里翻转，二者恒同时清除。
- 该 `finally` 只等 `adapter.interruptQuery()` 这一个 promise，**不**等 `runLoop` 的 `for await` 收到 `result`（`:338-377`），
  更不等子进程退出或工具执行结束。
- 重复调用走 `:554-557` 的 `await this.interruptInFlight; return` ——后来者拿到的是同一个「适配器已受理」的 promise。

因此「`interrupt()` resolved」= 「适配器受理了中断」，两者之间隔着整段工具收尾时间。

### 2. 三个适配器的中断/中止实现都是非阻塞的

| 内核 | 方法 | 实际语义 |
| --- | --- | --- |
| Claude/KSCC | `claude-agent-adapter.ts:338-350` `interruptQuery` | `await sess.query.interrupt()`，异常吞掉。SDK 的 interrupt 是**控制请求受理**；已在跑的工具（Bash/Write 等）是协作式响应 abort，可能继续写到自身观察到取消为止。没有任何 `result` 等待。 |
| Pi | `pi-agent-adapter.ts:1104-1108` `interruptQuery` | `entry.agent.abort()` 同步置标志即返回；prompt 循环稍后才 unwind。工具侧只有 `subagent-task-tool.ts:448/784` 监听信号，**未监听信号的长工具不受控**。 |
| Codex | `codex-app-server-adapter.ts:206-208` → `codex-app-server-session-manager.ts:309-319` `interruptTurn` | 发 `turn/interrupt` JSON-RPC，**收到该请求的应答**即 `return true` 并清 `activeTurnId`；**不**等 `turn/completed` 通知。App Server 侧仍可能在执行 shell 命令。 |

三条路径的共同点：resolve 时刻与实际停止时刻之间没有任何同步点。

### 3. 硬路径同样不等

- `claude-agent-adapter.ts:379-389` `abort()`：`channel.close()` + `controller.abort()` + `scheduleForceKill(sessionId, pid)`
  —— force-kill 是**排程**的（`:577-591`），方法本身同步返回，进程可能仍在。
- `codex-app-server-adapter.ts:210-213` `abort()`：`void this.manager?.interruptTurn(...)` 显式 fire-and-forget + `closeSession`。
- `pi-agent-adapter.ts:1111-1124` `abort()` / `:1127-1137` `dispose()`：`agent.abort()` + `controller.abort()` + `sessions.clear()`，
  **不 await** 任何在途 prompt / 工具 promise。
- `session-runtime.ts:607-615` `destroy()`：同步方法，`adapter.abort()` 返回值被丢弃，随后直接置 `state='closed'` 并返回。

即：切换拿到的唯一「销毁」入口本身就不提供完成信号。

### 4. 静默守卫无法表达这种状态

`validateRuntimeSwitchQuiescence`（`runtime-switch.ts:209-241`）依赖 `RuntimeSwitchQuiescence`（`:193-202`）
的 `turnInFlight` / `interrupting` / `sendInFlight` / `approvalActive`。其中 `interrupting` 由
`isInterrupting()`（`session-runtime.ts:629-631`，读 `interruptInFlight !== undefined`）供给。

由证据 1，`turnInFlight` 与 `interrupting` **同时**清空，所以守卫观察不到「中断已受理但工具仍在写」这一中间态：
`stopping` 拒绝码（`:219-225`）在实际时序上几乎不可能命中，守卫实际退化为「只要 `interrupt()` 返回就算静默」。
这是本次评审要指出的核心缺陷。

### 5. 既有相近路径已经踩到同一竞态

`dropLiveProcessForConfigChange`（`session-runtime.ts:137-161`）在 `adapter.abort()` 后**立即**置
`loopRunning=false; turnInFlight=false; state='idle'`，并用
`queueMicrotask(() => { if (!this.loopRunning) this.userStopping = false })` 复位停止标记
——而旧 `runLoop` 此刻还在 unwind。executionMode 切换路径（`session-service.ts:2030-2047`）
正是 `await interrupt()` 之后紧接着调用它，中间无任何屏障。
跨内核切换若照抄这两行，等于把已知竞态复制到「两个不同 adapter 同时持有同一 workspace」的更危险场景。

### 6. 现状缺口

`session-service.ts:56-55` 已 import `validateRuntimeSwitchQuiescence`，但全文件**没有调用点**
（未匹配到 `validateRuntimeSwitchQuiescence(` / `RUNTIME_SWITCH` handler）。
即切换 handler 尚不存在，本评审的结论对即将落地的实现是**前置约束**而非事后修正。

## 必需阻塞项（Required blockers）

- **B1 · 缺「工具静默屏障」**。`interrupt()` / `isInterrupting()` 必须改为等待适配器真静默，否则 `runtime-switch.ts` 的守卫无意义。
  最小方案：在 `AgentProviderAdapter` 增可选 `waitForIdle?(sessionId, opts?: {timeoutMs?: number}): Promise<void>`，
  并在 `SessionRuntime.interrupt()` 的 `finally` 之前 `await` 它：
  - claude：等被中断 turn 的 `result`（或进程 `exit`）；
  - pi：等该轮 prompt promise settle（适配器已持有 `entry`，需确认是否已保存 prompt promise；未保存则补）；
  - codex：等匹配 `activeTurnId` 的 `turn/completed` / `turn/failed` 通知（manager 需为每个 turn 暴露完成 promise）。
  超时必须 fail-closed（返回「未能确认静默」，拒绝切换），不能默认放行。

- **B2 · `interruptInFlight` 提前清除**。`session-runtime.ts:562-565` 把 `interruptInFlight = undefined` 与 `turnInFlight = false` 绑在一起，
  使 `isInterrupting()` 失去「仍在收尾」的含义。最小修复：`interruptInFlight` 只在 B1 的静默确认之后清除，
  使 `runtime-switch.ts:219` 的 `stopping` 分支真正可用。

- **B3 · `destroy()` / `abort()` 不可等待**。`session-runtime.ts:607-615` 必须有可 await 的变体
  （如 `destroyAndWait(): Promise<void>`，内部调用新的 `adapter.abortSessionAsync?.()`），
  并由 codex `:210-213`（去掉 `void`）、claude `:379-389`（force-kill 需确认完成）、pi `:1111-1124`（await 在途 promise）配套提供。
  切换事务在新旧内核之间必须以此为屏障；仅 `closeSession` / `sessions.delete` 不足以代表进程已死。

- **B4 · `userStopping` 的 microtask 复位**（`session-runtime.ts:158-160`）。它让旧 loop 在 unwind 期间失去「用户主动停止」标记，
  可能触发 `attemptRecovery`（`:508-542`）重注入在飞消息——在跨内核场景下会给**正在交接的旧内核**重新起一轮。
  最小修复：改为在 `loopEpoch` 不匹配的退出分支（`:309` / `:380`）中复位，而非固定 microtask。

## 可选后续（Optional future）

- O1：workspace 级写锁 / 产物目录 CAS，兜底「掉队工具」在切换后的一次写入（与既有 artifacts 真值层方向一致）。
- O2：为三内核各加契约测试——`interrupt()` 返回后断言子进程树已消亡、目标文件无新写入。
- O3：把「未能确认静默」作为可观测事件上报（UI 侧注释 `session-runtime.ts:74-77` 已说明渲染层早于主进程切 stopped，
  用户可见的 stopped 不构成静默证据）。
- O4：`isRunning()` 返回 `loopRunning`，对 kscc 长驻恒 true（`session-service.ts:2550-2558` 注释已记录此坑）。
  切内核的守卫应只认静默屏障，不要退回 `isRunning()`。

## 给实现方的单句约束

> 跨内核切换的前置条件不是「`interrupt()` 已返回」，而是「旧内核适配器已确认本轮工具与子进程静默」。
> 在此之前不得创建目标内核的运行时。
