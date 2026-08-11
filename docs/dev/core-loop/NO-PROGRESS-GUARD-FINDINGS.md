# No-Progress Guard 实现验收与发现（FINDINGS）

> 日期：2026-08-11
> 规格真源：`docs/dev/core-loop/NO-PROGRESS-GUARD-SPEC.md`
> 执行：本地 `kscc / glm-5.2`（Claude Agent SDK 0.3.185 / pi-agent-core 0.82.0）
> 状态：**实现完成，默认 `enforce`（可用 env 回退 shadow/off）；本轮已入库待打包**

---

## 1. 改动文件列表

| 文件 | 性质 | 责任 |
| --- | --- | --- |
| `packages/shared/src/types/no-progress.ts` | 新增 | 公共契约：`NoProgressGuardMode` / `NoProgressReasonCode` / `ToolBatchObservation` / `NoProgressDecision` / `ToolAttemptAdvice` / `NoProgressEvent` / `resolveNoProgressGuardMode` |
| `packages/shared/src/types/index.ts` | 修改 | barrel 导出 `./no-progress` |
| `packages/shared/src/types/agent.ts` | 修改 | `SDKResultMessage.subtype` 增加 `paused_no_progress`；`TAgentEvent` 联合增加 `NoProgressEvent` |
| `apps/electron/src/main/lib/agent/no-progress-guard.ts` | 新增 | 纯判定器：签名归一化、状态机、有效进展、阈值、`buildNoProgressEventFromDecision` |
| `apps/electron/src/main/lib/agent/no-progress-guard.test.ts` | 新增 | §14.1 纯函数单测（27 例） |
| `apps/electron/src/main/lib/agent/no-progress-replay.test.ts` | 新增 | §14.4 UnrealTagManager 脱敏回放（5 例，含双核一致性） |
| `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts` | 修改 | `KsccQueryOptions` 加 `noProgressGuardMode` / `onNoProgressEvent`；per-session `NoProgressCtx`；`PostToolBatch`→observe 注入、`PreToolUse`→final_response_only 拦截、pause→`interrupt` + 终态归一化；导出 `ksccPostToolBatchToObservation` / `normalizeResultToPausedNoProgress` |
| `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.test.ts` | 修改 | 新增 KSCC 接线单测（hook 驱动链路、终态归一化、事件构造） |
| `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts` | 修改 | `PiQueryOptions` 加守卫字段；`SessionEntry` 加 `np` / `pausedNoProgressHit`；`afterToolCall`→observe、`beforeToolCall` 复合守卫拦截、pause→`abort` + `remapTerminal`（paused 优先于 maxTurns）；导出 `piAfterToolCallToObservation` |
| `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts` | 修改 | 新增 Pi 接线单测（观察翻译 + 双核同序列同语义） |
| `apps/electron/src/main/lib/agent/runtime/session-runtime.ts` | 修改 | 单真源终态闸口：result 仅在 `turnInFlight` 为真时 `onTurnEnd`（§20.5 防双终态） |
| `apps/electron/src/main/lib/ipc/session-service.ts` | 修改 | `buildQueryOptions` 注入 `noProgressGuardMode`（环境变量归一）+ `onNoProgressEvent`→`sendPayload` 转发 renderer（kscc / Pi 双路） |
| `apps/electron/src/renderer/components/chat/Chat.tsx` | 修改 | 消费 `no_progress` 事件：shadow 忽略；`paused`→`stopRun` 清运行态、**不抬错误条**（§11.3） |
| `packages/shared/src/utils/session-error-classify.ts` | 修改 | `classifyUserFacingError` 把 `error_max_turns` / `paused_no_progress` 文案归为「保护性停止」，不当崩溃「运行出错」（§11.3） |
| `packages/shared/src/utils/session-error-classify.test.ts` | 修改 | 上述分类单测 |

未触碰（§范围控制）：流式 delta 管线、消息持久化真值、权限系统、安装器、现有 UI 时间线、`maxTurns=50`（保留作兜底，未调大）。

---

## 2. 测试结果

```text
命令：node ./node_modules/vitest/vitest.mjs run   （全量）
结果：Test Files 124 passed (124) | Tests 1491 passed (1491)

新增/受影响单测（单独跑）：
  no-progress-guard.test.ts        27 passed
  no-progress-replay.test.ts        5 passed
  claude-agent-adapter.test.ts       8 passed（含新增 4 例 KSCC 接线）
  pi-agent-adapter.event-ir.test.ts 27 passed（含新增 3 例 Pi 接线）
  session-error-classify.test.ts   25 passed（含新增 2 例保护性停止）

类型检查：
  tsc --noEmit -p packages/shared/tsconfig.json   → 0 error
  tsc --noEmit -p apps/electron/tsconfig.json      → 0 error
git diff --check                                  → exit 0（仅 CRLF 提示，非空白错误）
```

---

## 3. 与 SPEC 验收对照（§16）

| § | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 已知 UnrealTagManager 序列不再运行到第 50 轮才结束 | ✅ | `no-progress-replay.test.ts`：第 2 次空输出超时 warn，第 6 批 + 2 次 PreToolUse 违规即 paused（≤10 批 ≪ 50） |
| 2 | 重复失败时主会话至少一次策略复盘 | ✅ | 一级 `warn` 经 `PostToolBatch additionalContext`（KSCC）/ `beforeToolCall reason`（Pi）注入复盘文案；二级 `require_reflection` 强制收束 |
| 3 | 暂停不显示「运行出错」且可在原会话继续 | ✅ | `paused_no_progress` result subtype 不以 `error_` 开头 → renderer `completeRun`（非错误条）；`no_progress` paused 事件只 `stopRun` 不 `setSessionError`；`classifyUserFacingError` 归为「已暂停」；会话/历史保留，发新消息触发 `resetForNewTurn` 续跑 |
| 4 | 正常多文件实现/测试/构建不被工具数量多而暂停 | ✅ | `no-progress-guard.test.ts`「多文件编辑不触发」「连续读取不同文件不触发」「有进展不误杀」；Edit/Read 为 neutral 不计入 np |
| 5 | KSCC 与 Pi 无进展判定规则一致 | ✅ | 同一 `NoProgressGuard` 实例与阈值；`no-progress-replay.test.ts` 双核同序列同 decision；`pi-agent-adapter.event-ir.test.ts` 双核 parity |
| 6 | 所有触发可从结构化日志解释 | ✅ | `NoProgressDecision.reasonCodes`（稳定枚举）+ `getState()` 快照（phase/各计数/签名）；适配层 emit `NoProgressEvent`（warning/reflection/paused/cleared） |
| 7 | `maxTurns=50` 仍生效作兜底 | ✅ | 未改 `maxTurns:50`（session-service）/ `DEFAULT_PI_MAX_TURNS=50`（Pi）；Pi `remapTerminal` 中 `pausedNoProgressHit` 优先于 `maxTurnsHit`，二者不共存 |

---

## 4. 关键设计决策（偏离/细化 SPEC）

1. **默认 `enforce`**：产品默认真正防死循环（提醒→复盘→暂停）。紧急回退：`TAGENT_NO_PROGRESS_GUARD_MODE=shadow|off`。守卫 `observe` 判定与 mode 无关；mode 由适配层施加——仅 `enforce` 注入/拦截/暂停，`shadow` 只发诊断事件，`off` 不注册 hooks。
2. **首条失败计入 §7.1.1 重复计数**：`actionOutcomeCounts` 在 per-call 计数（含首次 neutral），故「同一动作 + 同失败结果 3 次」在第 3 次触发 warn（含首观测），更贴合「3 次」语义；但首次失败对 `noProgressBatchCount` 仍为 neutral（不即扣分），避免首条失败即推进。
3. **Edit/Read 为 neutral**（§12.3 / §16.4 误判防护）：多文件编辑、纯调查不进 `noProgressBatchCount`；同文件 5 次编辑靠 `perFileEditCount`（§7.1.2）独立捕获；Bash 重复失败靠 `actionOutcomeCounts`（§7.1.1）/ 空输出超时（§7.1.4）。
4. **Pi 无 `additionalContext` 机制**：Pi `afterToolCall` 不能像 KSCC `PostToolBatch` 那样注入模型上下文。故 Pi 的一级 `warn` 仅发 IPC 事件（无模型注入）；二级 `final_response_only` 通过 `beforeToolCall` 拦截 + 回灌复盘 `reason`（模型可见）补足；文案与 KSCC 一致。
5. **暂停用软中断保进程**（§22 Step 0 门禁）：KSCC 用 `query.interrupt()`、Pi 用 `agent.abort()`，**不**用 Hook `continue:false`（避免杀长驻进程）；终态在 `query()`/`agent_end` 归一化为唯一 `paused_no_progress`。
6. **`paused_no_progress` 优先于 `error_max_turns`**（§20.5）：Pi `remapTerminal` 先判 `pausedNoProgressHit`；SessionRuntime result 仅在 `turnInFlight` 为真时 `onTurnEnd`，防双终态。

---

## 5. 未做项 / 留待后续（§18 待定 + 范围外）

- **NP-0 SDK Hook 长驻实机验证未做**：本机未跑真 SDK 会话验证 `PostToolBatch` additionalContext 是否真到模型、`PreToolUse deny` 是否真拦住、`interrupt()` 后长驻能否接下条消息（§22 Step 0）。已按 SPEC 安全路径实现（interrupt + PreToolUse 拦截，不用 `continue:false`），但**默认 shadow 不改行为**，故未触发实机风险；切 `enforce` 前须补 NP-0 实机矩阵（§22 Step 7）。
- **Pi warn 无模型注入**：见决策 4。如需 Pi 一级提醒也注入模型上下文，需给 pi-agent-core 加 `additionalContext`/append 点。
- **`error_max_turns` 横幅样式**：§11.3「不应显示为崩溃」仅改了**文案标题**（「已停止（达到工具循环上限）」非「运行出错」），未改红/琥珀色横幅样式（需 NoProgress 组件 / 主题改造，§21 标注「可选」）。
- **NoProgress 专用 UI 组件未新增**（§21 可选）：`no_progress` 的 `warning`/`reflection`/`cleared` 阶段在 renderer 仅做最小处理（paused 清 running）；阶段摘要条/展开详情（§11.1/§11.2）留作后续组件。`shadow` 模式下 renderer 完全忽略，故首发无 UI 影响。
- **§18 待定决策未全定型**：一级阈值采用固定次数（未按工具类型加权）；「验证命令」识别用结果签名变化（非命令规则表）；暂停事件用 `interrupt`/`abort`（非 SessionRuntime 软中断）；子代理内部循环按 Task 调用 neutral 不计入主会话（§12.5 已遵守，未单独暂停子代理）；设置页无守卫开关（§23.1 主进程内部配置 + 环境变量）。
- **未做实机矩阵**（§22 Step 7 表）：打包/切 `enforce` 默认前需跑 KSCC+Pi 双核 9 场景实机。

---

## 6. 风险

1. **KSCC `PostToolBatch` tool_response 形状假设**：守卫按 `{stdout,stderr,exitCode}` / 字符串 / `{content,is_error}` 解析 Bash 结果。若实际 SDK 形状不同，空输出超时（§7.1.4）可能识别不到——但 §7.1.1（同失败 3 次）/ §7.3.2（12 批无进展）仍兜底。**切 enforce 前用 NP-0 实机确认**。
2. **`PreToolUse` 与 `canUseTool` 并存**：守卫 `PreToolUse` deny 与既有 `canUseTool` 权限闸同时注册；二者任一 deny 即拒。final_response_only 拦截依赖 SDK 先跑 PreToolUse——若 SDK 顺序/优先级与预期不符，二级拦截可能失效（仍靠 afterToolCall 硬上限 pause 兜底）。NP-0 实机验证。
3. **shadow 误报率未知**：默认 shadow 仅诊断，不改行为，安全；但未用真实会话统计误报（§15 Phase 0）。切 enforce 前建议先收集 shadow 日志。
4. **Pi `beforeToolCall` 内 `agent.abort()`**：在工具派发同步路径调 abort，依赖 pi-agent-core 允许中途 abort（现有 `interruptQuery` 已用同法，风险等价）。
5. **时间判定**（§7.3.4）：`observe` 用 `observedAt`（适配层传 `Date.now()`），`resetForNewTurn` 用构造 `now()`。生产无注入，正常；回放测试用受控时间。

---

## 7. 阶段交付（§25 模板汇总）

- NP-1 纯判定器 + 单测：完成（27 例）
- NP-2 公共类型与 IPC 契约：完成
- NP-3/5 KSCC shadow+enforce：完成（默认 shadow，enforce 路径已实现并单测）
- NP-4 UI/runtime/IPC/classify：完成（最小修改）
- NP-6 脱敏回放：完成（5 例，含双核 parity + 有进展不误杀）
- NP-7 Pi 对等接入：完成
- NP-8 全量门禁：`tsc` 0 error / vitest 1491 passed；**双核实机矩阵未跑**（切 enforce 前必做）

是否修改默认 guard mode：**否**（保留 `shadow`，§20.1）。
是否构建或打包：**否**。
是否 commit / push：**否**（本轮只改代码 + 文档）。
