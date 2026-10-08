# ADR-0011 首期切片：后端 / shared / preload 实现结果（KSCC 侧）

> 日期：2026-09-16（含两轮评审修复）
> 范围：main + packages/shared + preload。renderer 由另一路实现，本文件不含渲染层改动。
> 状态：**代码完成；聚焦自动化测试 + typecheck 通过；未做真实账号 / 实机 UI 验收**（见 §6）。

## 1. 交付的接口（与 renderer 约定一致，无偏差）

```ts
window.electronAPI.switchSessionRuntime(input: {
  sessionId: string; channelId: string; modelId: string;
  runtime: 'pi' | 'codex' | 'kscc';
}): Promise<AgentSessionMeta>
```

- 共享类型 `SessionRuntimeSwitchInput`（另有 `AgentRuntimeKind`）从 `@tagent/shared` 导出。
- IPC 常量 `AGENT_IPC_CHANNELS.SWITCH_SESSION_RUNTIME = "agent:switch-session-runtime"`。
- preload `switchSessionRuntime` 直接 `ipcRenderer.invoke`，失败即 reject（renderer 保持原选择）。
- 返回 `AgentSessionMeta`：含 `channelId / modelId / internalBackend / runtimeBindings /
  runtimeHandoff / runtimeSwitchRevision`。

## 2. 改动文件

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/types/agent.ts` | 新增 `AgentRuntimeKind` / `RuntimeNativeBinding` / `RuntimeHandoff`（含 `attempts` / `lastAttemptAt` / `lastOutcome`）/ `SessionRuntimeSwitchInput`；`AgentSessionMeta` 增 `runtimeBindings` / `runtimeHandoff` / `runtimeSwitchRevision`；`AGENT_IPC_CHANNELS` 增 `SWITCH_SESSION_RUNTIME` |
| `apps/electron/src/preload/index.ts` | 新增 `switchSessionRuntime` 映射 |
| `apps/electron/src/main/lib/agent/runtime/runtime-switch.ts` | **新增**（纯逻辑）：内核↔渠道映射、目标校验、静默判定（含 `unsettledStop`）、切换 patch、交接资料生成/注入/尝试结算、按 key 串行化闸门 |
| `apps/electron/src/main/lib/agent/runtime/runtime-switch.test.ts` | **新增**：36 用例（纯逻辑） |
| `apps/electron/src/main/lib/ipc/session-service.runtime-switch.test.ts` | **新增**：28 用例（orchestration，真实 SessionService/IPC/落盘） |
| `apps/electron/src/main/lib/agent/runtime/session-runtime.ts` | 新增**原生终态闩锁**（`hasUnsettledStop` / `waitForTurnSettled` / `markTurnSettled(epoch)`，含 epoch 守卫）、`isInterrupting()`、`classifyTurnTerminal` + `onTurnEnd(info)` 终态性质、发送前静默闸门 |
| `apps/electron/src/main/lib/agent/runtime/session-runtime.test.ts` | 新增 16 个用例（闩锁 / 终态性质 / epoch 守卫 / 发送闸门 / 延迟原生终态 / 取消 / 超时 fail-closed） |
| `apps/electron/src/main/lib/permission/permission-service.ts` | 新增只读探针 `hasPendingPermissionRequest(sessionId)` |
| `apps/electron/src/main/lib/ipc/session-service.ts` | 切换事务 + IPC handler；发送期交接投递/终态消费；发送渠道解析优先级；UPDATE_SESSION_META 组合级拦截；旧实例迟到事件护栏 |

未改 renderer、未改其他 docs、未动用户配置与凭据、未新增依赖。

## 3. 评审修复（本轮重点）

### P0-1 交接消费时机：`sendMessage` 返回 ≠ 目标内核已受理

`SessionRuntime.startLoop` 用 `void this.runLoop(...)` 起循环，`sendMessage` 同步返回只表示「已交给事件循环」。
因此**已删除**「sendMessage resolve 后立即消费」的逻辑，改为：

1. 注入前落盘尝试标记 `runtimeHandoff.attempts += 1` / `lastOutcome='pending'`（进程中途死掉也可见「已尝试」）；
2. 结算只发生在**观察到目标内核状态**时（`finalizeHandoffAttempt`）：
   - `onTurnEnd` 且 `outcome === 'success'`（见 P0-3：onTurnEnd 非成功专属）→ **消费**：
     清 `runtimeHandoff` + 推进目标绑定同步游标；
   - `onError` → 若本轮**产出过任何原生输出** → 标记 `ambiguous` 并保留 `attempts`（不自动重投）；
     若从未产出 → `attempts` 归零 + `retryable`（用户下一次发送可重投，**不自动重发**）；
   - `STOP_AGENT` → 同上按「是否已产出输出」结算（停止没有终态）；
   - 构建 query / spawn 同步抛错 → `startup-failed` → 一律按「从未送达」处理；
3. `attempts > 0` 时**不再自动注入**（`shouldInjectHandoff`）→ 普通轮次不会反复吃整段上下文；
4. `runtimeSwitchRevision` 守卫：期间又切换过则旧尝试一律不动作；
5. Pi 重启/重开语义：`attempts===0` 的 pending 记录重开后仍可投递；已产出输出后的失败保留记录但不自动重投。

### P0-2 停止确认 ≠ 静默：原生终态闩锁

评审结论（已核对源码）成立：`interrupt()` 的 `finally` 里 `turnInFlight=false` 与 `interruptInFlight=undefined`
同时发生，只等 `adapter.interruptQuery()`（三内核都是「受理即返回」），与工具/子进程真正停止之间没有同步点。

最小实现（不改造适配器契约）：`SessionRuntime` 增**闩锁**

- `interrupt()` 在调用适配器**之前**置位（避免适配器同步推出终态时漏闩锁）；
- 只有 runLoop 真正观察到本轮终态才复位：收到 `result`（长驻内核不退出，故在 result 分支显式调用）
  + 外层 `try/finally` 覆盖所有退出路径（generator 结束 / 抛错 / 过长降级 / 用户停止）；
- `waitForTurnSettled(timeoutMs)` 有界等待：超时返回 `false`；
- 切换事务 `awaitQuiescenceForSwitch`：首轮校验若因 `unsettledStop` 拒绝 → 等待终态（15s 上限）后**重新**校验；
  仍不静默 → 拒绝切换（fail-closed，不默认放行）；
- 长驻但**空闲**的 KSCC（`isRunning()=true`、无在途回合、无未确认停止）照常允许切换——切换判定完全不使用
  `isRunning()`，不用「loopRunning=false」当安全证明。

### P0-3 终态性质：`onTurnEnd` **不是**成功专属

`SessionRuntime.onTurnEnd` 有 4 个触发点，其中只有一个是真成功：`result` 的
`error_max_turns` / `error_during_execution` / `paused_no_progress` / `max_tokens`，
以及上下文溢出软重置（`tryContextOverflowRecovery` 成功分支）后的收尾都会走到它。

修复：新增 `classifyTurnTerminal(msg) → 'success' | 'error' | 'unknown'`（只有
`subtype==='success'` 且无 `is_error` / 无 `errors` 才算 success），`onTurnEnd` 改为携带
`TurnTerminalInfo`；**既有 UI 终态行为完全不变**（仍照常推 `turn_end` / 走原回调），只是多带一个字段。
`session-service` 只在 `outcome === 'success'` 时消费交接，其余（含软重置路径显式标 `error`）
一律按非成功结算（产出过输出 → `ambiguous` 保留；从未产出 → `retryable`）。

### P0-4 闩锁 epoch 守卫 + 发送闸门

- `markTurnSettled(epoch)` 带 loop 代数：被 `startLoop` 接替的**旧圈**退出时不得清除闩锁
  （否则旧圈会把「新回合已受理停止但未收尾」误判为已静默）。
- `sendMessage` 在等完 interrupt 受理后，若闩锁仍置位 → `waitForTurnSettled(TURN_SETTLE_TIMEOUT_MS)`
  有界等待原生终态；超时抛「上一轮尚未确认停稳（可能仍有工具在收尾），请稍候再发送」。
  即：**停止受理后不再允许立刻开新回合**（避免旧回合未收尾时两轮并行写同一 workspace）。

### P0-5 发送渠道解析：会话绑定优先于默认内核

原 `input.channelId ?? 外部默认 ?? KSCC ?? Codex` 链在「渲染层没传 channelId」时会把已绑定 KSCC 的
会话解析成外部内核，然后撞上「已锁定…不能跨运行内核切换」。现优先级：
显式选择 → `meta.channelId`（**先于任何默认值**）→ 旧会话按 `meta.internalBackend` 补回本机渠道 →
仅新会话用默认（**默认是 Pi / 外部 API 渠道**）。没有可用 Pi 渠道时**明确报错**，
不再静默回落到 KSCC / Codex。

### P0-6 UPDATE_SESSION_META 组合级拦截

IPC patch 运行时是未类型化对象，只盯 typed `internalBackend` 有洞（如直接塞 `channelId`）。
现按「patch 生效后的实际 `channelId + internalBackend` 组合」算目标内核并与当前绑定比对：
跨内核一律拒绝并提示改用 `switchSessionRuntime`；渠道变了却查不到 → 直接拒绝（不允许用「查不到」绕过比对）；
同内核换渠道（Pi → Pi）× 与同值写入照常放行（内部路径如 `handleSend` 不受影响）。

### P1

- `disposeRuntimeForSwitch` 不再 `try/catch` 吞 `rt.destroy()` 异常：停不掉旧内核 → 切换失败（renderer 保持原选择），
  不会静默产生「两个内核同持一个 workspace」。
- 源历史读取失败不再静默放行：跨内核切换必须能读到源面板，读失败 → 直接失败，保留旧绑定（不假装交接完成）。
- `UPDATE_SESSION_META` 旁路拦截：已持久化会话的 `internalBackend` 变化**跨运行内核**时直接拒绝并提示改用
  `switchSessionRuntime`；同值写入与同内核字段更新照常放行（不误伤内部路径，如 `handleSend` 记录本轮后端）。
- 审批探针补齐 `PermissionService` 的真实 pending 工具权限请求（新增只读 `hasPendingPermissionRequest`），
  与 AskUserQuestion / ExitPlanMode / KB propose-save 三类一起参与 `approval_active` 判定。
- Orchestration 测试落到真实 `SessionService` + IPC handler + 会话落盘（详见 §4），不是只测纯 helper。
- `RuntimeSwitchGate`：代码库中**不存在**该符号；被怀疑的 `createKeyedSerialQueue` **已在生产路径使用**
  （`session-service.ts:632` 的 `runtimeSwitchChain`），非未使用代码，故未删除。

## 4. 行为要点（不变部分）

- 校验：持久化会话 + 渠道启用且 provider 与目标内核兼容（pi=非本机 API 渠道 / codex=codex-internal /
  kscc=kscc-internal）+ 模型属于渠道且启用 + 拒 `moa:*` + 目标本机运行时可用；任一不满足即拒绝并给出原因，
  **不静默换内核、不放宽权限**。
- 落盘：归档来源内核绑定 → 跨内核清空生效原生 id（`sdkSessionId` / `codexThreadId`，避免 resume 过期上下文）
  → 写 `runtimeHandoff` → `runtimeSwitchRevision + 1`；同内核只换渠道/模型并保留原生 id。
  `executionMode` / `permissionMode` / `workspaceId` 一字不动。
- 交接正文来自宿主**可见**记录（目标+最新要求、约束+「切换不会放宽权限」、成果路径线索、最近优先 12000 字符预算的
  可见对话、省略范围与预算声明），跳过 thinking 与纯工具结构，不含凭据。
- 注入到本轮模型 prompt（在用户气泡落盘之后），并在该轮**抑制**整段面板历史注入，避免同一段历史注入两次。
- 迟到事件：旧 runtime 的 `onMessage / onTurnEnd / onLoopIdle / onError` 一律以
  「`runtimes.get(sessionId) !== 本实例` → 丢弃」护栏拦截。

## 5. 测试与静态检查（本轮只跑聚焦集）

- `vitest run apps/electron/src/main/lib/agent/runtime apps/electron/src/main/lib/ipc/session-service.runtime-switch.test.ts`
  → **94 passed / 3 files**：
  - `runtime-switch.test.ts`（36）：内核↔渠道映射与反推、六类校验拒绝、未知内核/空参防御、
    静默五类拒绝（含 `unsettledStop` 专项回归）、跨内核归档与同内核保留、校验失败绑定原样、
    不静默改权限/形态/工作区、交接正文只见可见内容 + 预算声明、一次性投递与不重复注入、
    attempts/lastOutcome 四态、revision 守卫、重启语义、Pi→Codex→Pi、串行化/跨会话不互斥/失败可重试、
    切换在途拒发 + send 在途拒切。
  - `session-runtime.test.ts`（30，含 16 新）：停止受理后原生终态未到 → 闩锁保持 + 超时 fail-closed +
    终态到达才解除；取消后 generator 结束也算终态；中断受理期间 result 恰好到达不漏闩锁；
    未在跑的回合不产生闩锁；正常/出错回合不残留闩锁；
    **终态性质**：`classifyTurnTerminal` 六类 shape（success / error_max_turns / error_during_execution /
    paused_no_progress / max_tokens / is_error 覆盖 success / 形状不可判 → unknown），
    以及 onTurnEnd 携带的 outcome（成功 result → success；error_max_turns、error_during_execution → error）；
    **epoch 守卫**（旧圈不得结算新回合闩锁）；
    **发送闸门**（未确认停稳时开新回合被拒；终态到达后同一发送放行）；
    并在原「停止后立即发送」用例中补断言「中断已受理但终态未到 → 仍不发」。
  - `session-service.runtime-switch.test.ts`（28，orchestration）：成功切换落盘（归档原生 id + 交接 +
    revision + 权限/形态/工作区不变 + 重开一致）、busy 拒绝、停止未确认静默先等后拒、等待成功即切换、
    长驻空闲内核允许切换、审批在途拒绝、**abort 抛错不被吞**、校验失败不写绑定、
    **源历史读失败即失败**、草稿会话拒绝、并发双切换串行化、
    UPDATE_SESSION_META 跨内核拦截（含**组合级**：只改 channelId 也拦、channelId+internalBackend 一起改也拦、
    同内核换渠道放行、渠道不存在拒绝）、**发送期交接投递：终态成功→消费；spawn 失败→保留且可重投**、
    双历史注入防护（prompt 只含一份 `[会话上下文]`、无 `[本轮议题]`）、
    **终态性质集成用例**（error_max_turns / error_during_execution / paused_no_progress 三种真实 result
    形状 → 交接不消费且标 `ambiguous`、UI `turn_end` 照常推送；success 对照组照常消费）、
    **渠道解析**（已持久化会话未传 channelId → 用 meta 绑定且不报「已锁定」；显式选择保持；
    新会话无 Pi 渠道 → 明确拒绝不回落 KSCC/Codex；有 Pi 渠道 → 默认走 Pi）。
- `tsc --noEmit`：`apps/electron` 与 `packages/shared` 均 **0 error**。
- 未再跑全量套件（按指示）。更早一轮全量为 2033 passed / 1 failed（`no-progress-replay.test.ts`，
  与本切片无关，未修改），本轮改动未触碰该路径。
- `apps/electron` 全量 tsc 仅剩 `src/renderer/components/chat/runtime-switch-flow.test.ts` 的 5 个类型错误
  （renderer 侧在途改动，非本切片文件，未修改）。
- 未做：真实账号 / 实机 UI / 真实 kscc·Codex 进程端到端验证。

## 6. 已知限制（诚实口径）

1. **不是完整上下文迁移**：跨内核只带「目标+最新要求+约束+最近优先 12000 字符可见对话」的有界摘录；
   较早历史与中段约束可能省略，交接正文与 UI 都显式声明了省略范围与预算，并引导用户查会话历史。
2. **停止屏障是「观察到宿主侧原生终态」**，不是「子进程树已消亡」：若某内核在产出终态后仍有掉队工具在写
   workspace，本切片无法察觉（评审 O1/O2 的 workspace 写锁 / 进程树断言不在本轮范围）。超时未观察到终态时
   一律拒绝切换。
3. **原生上下文不迁移**：跨内核一律新开目标原生上下文（旧原生 id 归档在 `runtimeBindings`，不 resume），
   Pi 切回时同样全新开；「历史显示完整」不等于「内核拿到完整历史」。
4. **必须先停止**：不做自动取消编排；running/stopping/审批在途直接拒绝。
5. **审批探针**覆盖工具权限（PermissionService）+ AskUserQuestion + ExitPlanMode + KB propose-save；
   与回合同生命周期的原生审批由 `turnInFlight` 覆盖。
6. **重启后的模糊交接不会自动恢复**：
   - 若上一次尝试**在目标内核产出任何原生输出之前**就失败/被停（`attempts` 已归零、`retryable`），
     重开后用户下一次发送会**重新注入**交接资料——这是用户驱动的重投，不是系统自动重发；
   - 若上一次尝试**已产出原生输出但未确认成功终态**（`ambiguous`），记录会保留在 `runtimeHandoff` 里
     作为状态展示，但**不会**在后续任何轮次自动重新注入，也不会自动判断「是不是已经送达」；
     重开应用也不会改变这一点（重启不重置 `attempts`）。此时需要用户再发一次消息才会重投，
     或由用户自行在会话历史中补齐上下文；
   - 若上一次尝试**已成功终态**，`runtimeHandoff` 已被清除，重启后自然不存在交接；
   - 三种情况都不做「已送达」的推测性结论：`ambiguous` 只表示「投递发生过、结果未知」。
7. **没有自动恢复 / 对齐机制**：本切片不检测「目标内核是否真的用了交接资料」，不重放原生思考、
   运行中工具或全部历史 token，也不做迁移完整性的自动校验；「交接成功消费」只表示
   **目标内核就那一轮给出了成功终态**，不等于内容已被完整理解或使用。
8. **消息级内核归属**（ADR §3「消息保留产生它的 Agent 标识」）后端只提供 meta 级 provenance
   （`runtimeBindings` / `runtimeHandoff.from|to` / `runtimeSwitchRevision`），逐条消息标记由渲染层负责。
9. **跨 agent 协调点**：`renderer/components/chat/Chat.tsx:1306` 仍存在
   `updateSessionMeta(sessionId, { internalBackend })`（持久化会话路径会命中新的组合级拦截而 reject）。
   renderer 侧需确认该路径已全部改走 `switchSessionRuntime`；我未修改 renderer。
10. 旧入口 `UPDATE_SESSION_META` 只拦「跨内核」组合变化；同内核换渠道/模型仍走旧路径（不生成交接资料），
    本切片未收紧。
11. 发送渠道解析改动后，**新会话在没有可用 Pi（外部 API）渠道时会直接报错**：这是 ADR §3「不静默换核」
    的要求，但意味着仅配置了 KSCC/Codex 的用户新建会话必须显式选择内核——渲染层需给出对应引导
    （本切片只保证后端错误文案明确）。
