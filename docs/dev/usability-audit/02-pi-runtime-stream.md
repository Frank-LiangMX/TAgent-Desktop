# 02 · Pi 核流式 / 会话运行时可用性审计

> 对照基准：`F:\Proma`（成熟实现）vs `F:\TAgent-Desktop`（2.0 双核之一）。
> 范围：Pi 核消息发送 / 停止 / 恢复、流式事件、`turn_end` / `result`、工具循环、错误分类、Windows 兼容。
> 仅审计，不改代码。所有行号基于当前工作区文件。

---

## 结论摘要

TAgent 的 Pi 核**能跑通「单轮一问一答」的黄金路径**，但围绕这条路径的**错误处理、终态收束、停止/恢复、重试、Windows 子进程**存在多处与 Proma 成熟实现的关键差距，叠加后会表现为「模型一报错就状态错乱 / 停不掉 / 第二轮卡 running / kscc 核在 Windows 起不来」等基础不可用症状。

底层根因一条：**TAgent 用的是 `@earendil-works/pi-agent-core` 的裸 `Agent`，Proma 用的是 `@earendil-works/pi-coding-agent` 的 `AgentSession`**。后者在裸 Agent 之上补了 native turn 级重试、overflow 同 transcript 压缩恢复、compaction 生命周期事件、retry/error 延迟终态等一整套运行时语义；前者只产出原始 `AgentEvent`。TAgent 既没有接线这些语义，也没有在自研层补齐，于是 Proma 里「由 SDK 兜住」的一批场景，到 TAgent 全部裸露给用户。

最致命的 4 件事（按修复顺序）：

1. **错误 turn 双 `result`**：`message_end` 推 `error_during_execution` result，`agent_end` 又无条件推 `success` result → `SessionRuntime` 触发两次 `onTurnEnd`，UI 收两个 `turn_end`；且 `message_end` 的 error result **不带 `errors`**，`session-runtime` 不识别、不当错误，模型错误被当正常结束（`pi-agent-adapter.ts:1060-1084` + `:996-1029`）。
2. **无 turn 级 native retry**：裸 Agent 只有 `pi-ai` 连接级 `maxRetries=2`。模型 5xx / 瞬时错误一次失败即整轮失败 + 上报 `session_error`，无同 transcript 恢复（Proma 有 8 次退避重试 + overflow 压缩续跑）。`http-direct-stream-fn.ts:39`、`session-runtime.ts:419-442`。
3. **kscc bare 在 Windows 直接 `spawn(kscc.cmd)` 不带 `shell:true`**：Node 在 Windows 不经 shell 无法执行 `.cmd` 批处理，存在 ENOENT / 非有效可执行风险；`kscc-internal` 是默认渠道，一旦 spawn 失败 = 内网核在 Windows 基础不可用。`kscc-spawn.ts:110-115`。
4. **停止 / steer / 排队消息在 Pi 核近乎死代码**：每轮 `result` 后 `SessionRuntime.runLoop` 退出、`state='closed'`，下一轮 `sendMessage` 判定 `isFirst=true` 重建 `SessionRuntime` 并重走 `query()`；`sendQueuedMessage` / `steer` / `interruptQuery` 的「长驻复用」路径几乎永不触发，软中断后是否补 `turn_end` 依赖 `agent.prompt` 抛错的副作用，不健壮。`session-runtime.ts:269-338`、`pi-agent-adapter.ts:546-581`。

---

## 对照表（P0–P2）

### P0 · 基础不可用 / 必须先修

| # | 问题 | Proma 做法 | TAgent 现状 | 影响 |
|---|------|-----------|------------|------|
| P0-1 | **错误 turn 双 `result` + 错误被当成功** | `pi-agent-adapter.ts` 只在 `agent_end` 产**一个** `result`（`convertResultMessage` 从最后一条 assistant 的 `stopReason` + `runtimeGuard.getResultOverride()` 推导 `subtype`）；`message_end` 只 push assistant，不产 result。 | `pi-agent-adapter.ts:1060-1084` `message_end` 命中 `stopReason==='error'` 即推 `{kind:'result',subtype:'error_during_execution'}`；`:996-1029` `agent_end` **无条件**推 `{kind:'result',subtype:'success'}`。两 result 先后到达 `SessionRuntime`。 | `session-runtime.ts:269-303` 收第一条 result 即 `turnInFlight=false` + `onTurnEnd`；第二条 result 再次 `onTurnEnd` → UI 收两个 `turn_end`、`recordSessionToMemory` 重复。且 `message_end` 的 error result **无 `errors` 数组**（`:1078-1081`），`session-runtime` 过长检测 `isPromptTooLongMessage(...(m.errors??[]))` 取空 → 模型错误被当**正常结束**，会话状态 `idle`，用户只看到一条 error 文本气泡、无错误态。 |
| P0-2 | **kscc bare 在 Windows `spawn` 不经 shell** | —（Proma 无 kscc bare 模型泵路径） | `kscc-spawn.ts:110-115` 故意 `spawn(ksccPath, args, { stdio })` 不带 `shell:true`，注释称「shell 会把 8.3 短名路径解析坏」。但 Node 在 Windows **不经 shell 不会用 PATHEXT、无法执行 `.cmd` 批处理**；`ksccPath` 若指向 `kscc.cmd` 会 ENOENT 或「not a valid Win32 application」。 | `kscc-internal` 是默认渠道。Windows 下若 spawn 失败，kscc bare 核**完全起不来**——表现为发消息后空响应 / 进程立刻退出，`session-runtime` 走崩溃恢复（Pi 核无 resumeId → 直接 `session_error`）。需在真实 Windows 实测确认；若已踩到即为 P0。 |
| P0-3 | **`message_end` 错误兜底破坏 `turn_end` 语义** | Proma 流式错误由 `retryTerminalGate` 延迟，待 `agent_end.willRetry` 判定后再决定是否向上游透传；retry 中不消耗 turn/budget 配额，UUID 复用让 renderer 原地替换 partial。 | `pi-agent-adapter.ts:1064-1082` 一旦 `stopReason==='error'` 立刻向 UI 暴露 error assistant + error result，**无延迟、无 willRetry 判定**。裸 Agent 虽无 turn 级 retry，但 `pi-ai` 连接级重试期间也会发 `message_start/end`，TAgent 可能在 retry 中途就过早暴露错误。 | retry/瞬态错误被过早定性为终态；用户看到错误但底层可能本可恢复。叠加 P0-1 双 result，状态错乱。 |

### P1 · 严重影响可用、需尽快修

| # | 问题 | Proma 做法 | TAgent 现状 | 影响 |
|---|------|-----------|------------|------|
| P1-1 | **无 turn 级 native retry** | `pi-agent-adapter.ts:1462-1469` 配置 Pi SDK `retry.maxRetries=8 / maxTotalRetries=8`，baseDelay 1s、累计 backoff 5min、±20% jitter；通过 `agent.continue()` 在**同一 transcript** 恢复，保留已完成 `tool_result`，不重放副作用工具。 | `http-direct-stream-fn.ts:39` 仅 `DEFAULT_HTTP_STREAM_MAX_RETRIES=2`（连接级，`pi-ai` 内部）；裸 Agent 无 turn 级重试。`session-runtime.ts:419-442` `attemptRecovery` 仅对**子进程崩溃**重 spawn，且 `resumeId = lastSdkSessionId ?? resumeSessionId`，Pi 核两者皆无 → 恢复恒 `undefined` → 直接 `onError`。 | 模型 / 网关 5xx、瞬时超时一次失败即整轮 `session_error`；无退避、无续跑。用户只能手动重发，且重发是**新 prompt**（裸 Agent 不保留本轮已执行的副作用工具结果，重放可能重复执行写操作）。 |
| P1-2 | **工具调用卡片重复** | Proma 流式 partial 只 coalesce 文本 delta，`toolCall` 在 `message_end` 终态才完整透传；不在流式中间单独发 `tool_use` 卡片。 | `pi-agent-adapter.ts:967-975` `toolcall_end` 在流式中途即 push `{kind:'sdk_message', message:{assistant, content:[tool_use]}}`；`:1032-1043` `turn_end` 又 push `piAssistantToIR(turnMsg)`（同 tool_use 再来一遍）。两条 `sdk_message` 无共享 id。 | UI 若按消息追加，同一工具调用显示**两张卡片**；流式那张无 `stop_reason`，终态那张有，状态也不一致。 |
| P1-3 | **停止后 UI 可能卡 running / 依赖抛错副作用** | `pi-agent-adapter.ts:1944-1952` `abort()` 显式 `rejectPendingInterruptPrompts` + `abortCompaction` + `session.abort()`；`agent_end` 分支识别 `active.abortRequested` 清理终态、`dropTrailingAbortedAssistant` 剥离 aborted assistant。 | `session-service.ts:244-248` STOP_AGENT 只 `await rt.interrupt()`；`session-runtime.ts:445-450` `interrupt` 设 `userStopping=true` + `turnInFlight=false`，**不调 `onTurnEnd`**。是否补 `turn_end` 全靠 `agent.prompt` 被 abort 后是否抛错触发 `pi-agent-adapter.ts:417-422` 的 error result。 | 若 abort 令 `agent.prompt` 抛错 → catch 推 error result → `session-runtime` 走 `onTurnEnd`（UI 收 turn_end，但附带一条空 error）；若不抛错 → 无 result → `turnInFlight` 仍 true → `runLoop` 判定崩溃 → Pi 核恢复失败 → `session_error`。停止语义不收敛，UI 大概率卡 running 或弹错误。 |
| P1-4 | **steer / 排队消息 / 软中断在 Pi 核近乎死代码** | `pi-agent-adapter.ts:1954-2005` `sendQueuedMessage` 区分 `interrupt` / `priority:'now'`(steer) / `followUp`；`active.interrupting` + `pendingInterruptPrompts` + `session.abort()` 协作实现「软中断后注入新 prompt」。 | `session-runtime.ts:269-338` 每轮 `result` 后 `loopRunning=false`、`state='closed'`、`runLoop` 退出；`hasLiveProcess()` 恒 false → `session-service.ts:738` `isFirst` 恒 true → 每轮重建 `SessionRuntime` 重走 `query()`。`pi-agent-adapter.ts:546-573` `sendQueuedMessage` 的「isStreaming 时 steer」分支只在 `hasLiveProcess=true` 时才可达，几乎永不触发。 | 「不中断当前轮、下一轮边界注入」的 steer 体验在 Pi 核不可用；`STEER_AGENT` IPC（`session-service.ts:250-255`）调 `rt.steerMessage` → `sendQueuedMessage`，但 rt 刚结束就重建，steer 无的放矢。每轮新 `query()` 虽能跑通多轮（复用 entry、Pi 自管 `state.messages`），但长驻设计名存实亡。 |
| P1-5 | **无 maxTurns / maxBudget 兜底** | `agent-runtime-guards.ts` `createAgentRuntimeGuard`：`maxTurns` / `maxBudgetUsd` 在 `afterToolCall` / `prepareNextTurnWithContext` 截断，`clearAllQueues` 防止队列消息绕过，产出定向 `error_max_turns` / `error_max_budget_usd` result。 | `pi-agent-adapter.ts` 无任何运行时守卫；`session-service.ts` kscc 核有 `maxTurns:50`，**Pi 核无 maxTurns**。 | 模型陷入工具死循环时 Pi 核无上限，持续消耗 token / 时间直到模型自己停或上下文爆。 |
| P1-6 | **流式 partial 无 UUID 去重，retry 时文本重复** | `pi-agent-adapter.ts:194-208` `createPiAssistantUuidTracker`：同一 assistant 流在 native retry 前后**复用 UUID**，renderer 据此原地替换断流 partial，而非并排追加。 | `pi-agent-adapter.ts:924-938` `piAssistantToIR` 不带 UUID；`TAgentMessage` 类型无 uuid 字段；流式 `stream_text_delta` 与 `turn_end` 终态 assistant 无共享标识。 | `pi-ai` 连接级重试若在已出 token 后重发 `message_start`，UI 累积 delta 会**重复文本**（旧 partial + 新 partial）；UI 只能靠"终态替换"猜测去重，契约脆弱。 |
| P1-7 | **abort 后残留 aborted assistant 污染下一轮** | `pi-agent-adapter.ts:1900` `dropTrailingAbortedAssistant` 在 interrupting 后剥离 aborted assistant；`isAbortedAssistantMessage` 识别。 | `pi-agent-adapter.ts` 无对应清理；abort 后 Pi 的 `state.messages` 保留 aborted assistant，下一轮 `prompt` 带历史时把它喂回模型。 | 下一轮上下文含一段截断的 aborted 输出，模型可能续写残片或困惑。 |
| P1-8 | **手动压缩 / 续跑限制缺失** | `pi-agent-adapter.ts:827-969` `CompactContext` 工具 + `compactCurrentSessionAfterTurn` + `planPiCompactionContinuation`（最多 20 次自动续跑）+ noop 友好提示 + `compact_boundary` 带 summary/estimatedTokensAfter。 | `pi-agent-adapter.ts:471-543` `compactSession` 走 `maybeCompactMessages`，**只对外部渠道**（`entry.compaction` 存在），kscc bare 无压缩；`:877-892` `makeCompactBoundaryEvent` 丢弃 `summary`/`noop`/`estimatedTokensAfter`；过长重试只 `compactSession(force)` 后 `runPrompt` **一次**，失败即推 error result。 | 手动压缩无摘要预览；过长重试一次失败即死，无 Proma 的 20 次续跑链；kscc bare 长会话无压缩出路。 |

### P2 · 体验 / 健壮性 / 性能

| # | 问题 | Proma 做法 | TAgent 现状 | 影响 |
|---|------|-----------|------------|------|
| P2-1 | **流式 partial 无 coalescer** | `pi-agent-adapter.ts:225` `PI_PARTIAL_UPDATE_INTERVAL_MS=50`（20fps）+ `createPartialMessageCoalescer`，避免每 token 在 main→IPC→renderer 重复复制整段消息。 | `pi-agent-adapter.ts:341-373` 每个 `message_update` → `piEventToIR` → `pushMessage` 立即推 IPC，每 token 一条。 | 高频流式时 IPC / React 事件风暴，长输出 UI 卡顿（文件内已留 delta 间隔诊断日志佐证）。 |
| P2-2 | **错误分类无 TypedError / 无恢复动作** | `pi-agent-adapter.ts:528-602` `mapSDKErrorToTypedError`：分 11 个 `ErrorCode`、`canRetry`、`retryDelayMs`、`actions`（重试/设置/压缩/新会话）；`agent_runtime_not_found` 专门引导重装。 | `pi-agent-adapter.ts:1100-1147` `formatStreamErrorForUser` 仅文案友好化（超时/401/429/网络/未知）；`classifyUserFacingError`（shared）只给 `session_error` 分类，无 actions/canRetry。 | 用户看到错误无「重试」「压缩」按钮，只能手动重发；`agent_runtime_not_found` 缺失，打包缺依赖时泛化 `unknown_error`。 |
| P2-3 | **bashTool `shell:true` 在 Windows 用 cmd.exe** | Proma `pi-agent-adapter.ts:1224-1309` 支持 WSL bash operations + `spawnHook` 注入 env + `shellPath`。 | `tools.ts:219-225` `spawn(command, { shell:true, cwd })` 默认 cmd.exe；虽有 `normalizeCommandForWindows`（去 `\| more`）、`decodeOutput`（UTF-8→GBK 回退）、`killProcessTree`（taskkill /T /F），但复杂命令 / 引号 / 多命令在 cmd 下仍易踩坑，无 WSL 选项。 | Pi 核 Bash 工具在 Windows 跑复杂 shell 命令时失败率高于 kscc 核（后者经 kscc 子进程，命令由 kscc 执行）。 |
| P2-4 | **contextWindow 口径不一致** | Proma `buildModel` 用真实 contextWindow；compaction reserveTokens 据此计算。 | `http-direct-stream-fn.ts:227` `buildModel` 硬编码 `contextWindow:128_000`；`pi-agent-adapter.ts:1171` `buildPlaceholderModel` 用注入的真实窗口。两者并存：压缩阈值用真实窗口，实际请求用 128k 占位。 | 压缩触发时机与模型真实窗口可能错位（大窗口模型会延迟压缩、小窗口模型会过早压缩）。 |
| P2-5 | **kscc bare 每轮重喂全部历史 stdin** | —（Proma 无 bare 模型泵） | `kscc-spawn.ts:174-194` `serializeContextToStdin` 把 `context.messages` 全量拼文本喂 stdin；bare 不 resume、每轮独立。 | 长会话每轮 stdin 线性增长，重传开销大；超长 stdin 可能触发 kscc 端 prompt 过长（此时靠 kscc 自身处理，TAgent 不识别）。 |
| P2-6 | **`agent_end` usage 口径与 stopReason 忽略** | Proma `convertResultMessage` 据 `stopReason` 推 `subtype`（`stop`→success、`length`→max_tokens、`error`→error…）+ `runtimeGuard.getResultOverride`。 | `pi-agent-adapter.ts:996-1029` `agent_end` 恒 `subtype:'success'`；`max_tokens`（`length`）turn 也报 success。 | 超长输出被截断（`stopReason:'length'`）时 UI 仍显示成功，无「输出被截断」提示。 |
| P2-7 | **压缩 UI 事件信息量不足** | `pi-agent-adapter.ts:1733-1778` `compaction_start`→`compacting`、`compaction_end`→`compact_boundary` 带 `summary` + `estimatedTokensAfter`（手动压缩展示预估）。 | `pi-agent-adapter.ts:873-892` `makeCompactingEvent` / `makeCompactBoundaryEvent` 只带 `trigger` + `tokensBefore`，丢弃 `summary`/`noop`/`reason`/`estimatedTokensAfter`。 | 压缩后 UI 无摘要预览、无「已压缩过/noop」友好提示。 |
| P2-8 | **自动压缩阻塞下一轮开头** | Proma overflow 压缩在 `agent_end` 后、`continue` 前，且 `shouldDeferPiOverflowTerminalError` 延迟终态避免与 compaction 竞争。 | `pi-agent-adapter.ts:700-819` `transformContext` 在每轮 turn 请求前同步调 `coordinator.reconcile`（含 `generateSummary` 一次模型调用），阻塞当前 turn 开头。 | 自动压缩触发时本轮首字延迟一个摘要请求的耗时；`asyncAuto` 缓解但仍有阻塞。 |

---

## 修复顺序

> 原则：先让「单轮一问一答 + 报错」收敛，再补停止 / 恢复 / 重试，最后磨体验。

### 第 1 步 · 终态收束（解 P0-1 / P0-3，连带 P1-2）
- **统一 result 产出口**：删掉 `message_end` 里的 error result（`pi-agent-adapter.ts:1077-1081`），只保留 error assistant 文本；`result` 一律由 `agent_end` 产出，`subtype` 从 `event.messages` 最后一条 assistant 的 `stopReason` 推导（`error`→`error_during_execution` 且带 `errors:[errorMessage]`、`length`→`max_tokens`、`stop`→`success`）。
- **error result 必须带 `errors`**，让 `session-runtime` 的过长检测与错误态识别可用。
- **流式 `toolcall_end` 不再单独发 `tool_use` `sdk_message`**，工具卡片统一由 `turn_end` 的 `piAssistantToIR` 产出，避免 P1-2 重复卡片。

### 第 2 步 · Windows kscc spawn 实测与修正（解 P0-2）
- 在真实 Windows 机器验证 `spawn(kscc.cmd, args)` 不带 `shell:true` 是否 ENOENT。
- 若失败：对 `.cmd` 路径走 `spawn('cmd', ['/d','/s','/c', ksccPath, ...args])` 或 `shell:true`，但把 `--system-prompt-file` 的临时路径改用**不含 8.3 短名 / 无反斜杠歧义**的形式（如 `\\?\` 长路径前缀或先 `realpath`），规避原注释所述 shell 解析问题。
- 确认 stderr 累积（`kscc-spawn.ts:122-135`）能命中过长上下文文案。

### 第 3 步 · 停止与长驻语义（解 P1-3 / P1-4 / P1-7）
- **`SessionRuntime.interrupt` 显式补 `onTurnEnd`**（或发一条合成 `turn_end`），不依赖 `agent.prompt` 抛错副作用；停止后保证 UI 清 running。
- **Pi 核长驻重设计**：要么让 `runLoop` 在 `result` 后不退出、改走 `sendQueuedMessage` 续跑（真正长驻），要么显式承认「Pi 核每轮重建」并删掉 steer/interrupt/queue 的死代码路径，把 `STEER_AGENT` 在 Pi 核降级为「下一轮 prompt 注入」。
- abort 后 `dropTrailingAbortedAssistant` 等价清理：剥离 `state.messages` 末尾的 aborted assistant 再进下一轮。

### 第 4 步 · 重试与错误分类（解 P1-1 / P1-8 / P2-2）
- **接 turn 级 retry**：在 `pi-agent-adapter.ts` 包一层 retry（对 `agent.prompt` 抛错按错误分类退避重试 N 次，保留 `state.messages` 不重放工具）；或评估升级到 `pi-coding-agent` 的 `AgentSession` 直接拿 native retry / overflow compaction。
- **`mapSDKErrorToTypedError` 等价层**：把 `formatStreamErrorForUser` 升级为带 `code`/`canRetry`/`actions` 的 TypedError，UI 据此显示「重试 / 压缩 / 新会话」按钮；补 `agent_runtime_not_found`（打包缺依赖引导重装）。
- **过长重试续跑**：`compactSession(force)` 后允许多次重试（而非一次），对齐 Proma 20 次续跑上限。

### 第 5 步 · 守卫与流式体验（解 P1-5 / P1-6 / P2-1 / P2-7）
- **Pi 核加 maxTurns 兜底**：`createSession` 时注入 `maxTurns`，工具循环超限时产 `error_max_turns` result 终止。
- **assistant UUID**：给 `TAgentMessage` 加 `uuid`，同 turn 的 stream delta 与 `turn_end` 终态共享 UUID，UI 可原地替换 partial（顺带为未来 retry 复用铺路）。
- **partial coalescer**：`message_update` 的 `text_delta`/`thinking_delta` 攒批 20fps 再推 IPC。
- **压缩事件补全**：`makeCompactBoundaryEvent` 带回 `summary` / `noop` / `estimatedTokensAfter`。

### 第 6 步 · 收尾（P2-3 ~ P2-6 / P2-8）
- bashTool 评估支持 WSL 或显式 `shellPath`，降低 Windows 复杂命令失败率。
- 统一 contextWindow 口径（`http-direct-stream-fn` 的 `buildModel` 用注入窗口而非 128k 硬编码）。
- `agent_end` `subtype` 据 `stopReason` 区分 `max_tokens`，UI 提示输出被截断。
- 自动压缩尽量移到 turn 间（非 turn 开头）或确认 `asyncAuto` 不阻塞首字。

---

## 附：架构层建议

TAgent Pi 核与 Proma 的差距本质是**裸 `Agent` vs `AgentSession`**。若不升级到 `pi-coding-agent`，则需在 `pi-agent-adapter.ts` 自研层补齐：turn 级 retry、overflow 同 transcript 压缩恢复、终态延迟（retry gate）、assistant UUID 复用、runtime guard。这些在 Proma 里是「SDK 兜住」，在 TAgent 里是「必须自己写」。建议在第 4 步评估：**短期自研补丁 vs 切换到 `AgentSession`** 的 ROI——前者快但易漏，后者一次到位但引入 `pi-coding-agent` 依赖面。
