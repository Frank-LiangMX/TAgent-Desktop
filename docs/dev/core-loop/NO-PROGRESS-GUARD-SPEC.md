# 主会话无进展防循环机制规格

> 日期：2026-08-11  
> 状态：设计草案 + 开发执行手册，尚未实现  
> 范围：TAgent 主会话工具循环（KSCC 与 Pi 双核）  
> 关联：`apps/electron/src/main/lib/agent/runtime/session-runtime.ts`、`apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts`、`apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts`

---

## 1. 产品结论

主会话不能只是发起工具调用。它还必须持续判断：当前策略是否产生了新证据，失败是否正在重复，以及是否应该停止局部试错、重新分析问题。

TAgent 需要在现有 `maxTurns=50` 之前增加一层“无进展守卫”（No-Progress Guard）：

```text
模型提出假设 → 调用工具 → 获得结果 → 判断是否有新证据
                                      ├─ 有：继续执行
                                      ├─ 无：累计无进展状态
                                      ├─ 重复：强制策略复盘
                                      └─ 仍重复：暂停本轮，等待用户
```

`maxTurns` 继续保留，但只作为最终保险丝，不再承担识别重复撞墙的职责。

---

## 2. 背景案例

2026-08-11，打包版在 `UnrealTagManager` 工作区的会话 `session-1786349874458` 中触发：

> 运行出错，已达最大工具循环轮次

该轮围绕 `tools/a0-kscc-resume-crash.js` 展开，约九分钟内出现：

- 同一文件约 20 次编辑；
- 同一复现命令至少 4 次重复执行；
- 多个 spawn、stderr、Promise/waiter 探针；
- 关键复现结果持续为 `Exit code 3 / TIMEOUT`，且 stdout/stderr 为空；
- 最终达到 SDK `maxTurns=50`，返回 `error_max_turns`。

日志已排除工具结果丢失、重复投递和 delta IPC 信息缺失。问题不是传输层把模型弄乱，而是主会话始终停留在局部修改策略中，没有把“结果持续相同”提升为需要重新建模的问题。

可用以下比喻描述：

> 模型面对一堵墙，退后后不断换位置继续撞；系统直到第 50 次才把它拉走，却没有在第 3、5、10 次提醒它分析墙是什么、为什么存在，以及当前路线是否根本不可行。

---

## 3. 当前机制的缺口

当前 KSCC 主链是：

```text
session-service
  └─ maxTurns: 50
       └─ Claude Agent SDK
            └─ 达到上限后返回 error_max_turns
```

现状能力：

- `session-service.ts` 为 KSCC 查询固定注入 `maxTurns: 50`；
- `session-runtime.ts` 能观察 assistant 中的工具名称；
- SDK 能返回每次 `tool_use`、`tool_result` 与最终 `result`；
- Pi 适配器也有独立的 `turnCount` 和 `afterToolCall` 上限。

现状缺失：

- 不比较本次工具结果与前几次是否实质相同；
- 不区分“文件写成功”和“任务取得进展”；
- 不识别连续空输出超时；
- 不要求主会话在重复失败后进行策略复盘；
- 除最终轮次上限外，没有中间介入状态；
- `error_max_turns` 被显示成笼统的“运行出错”。

---

## 4. 设计目标

1. 在达到 50 轮之前识别明显的无进展循环。
2. 让主会话先复盘策略，而不是立即强制终止。
3. 复盘后仍重复时，暂停工具调用并保留可继续的会话。
4. 不因工具数量多而误伤正常长任务。
5. KSCC 与 Pi 使用同一套判定语义，适配层只负责接入事件。
6. 所有触发原因可解释、可落日志、可回放测试。

## 5. 非目标

- 不尝试判断模型的思考内容“是否聪明”。
- 不以思考链长度作为循环依据。
- 不把所有失败都自动升级为用户确认。
- 不取消 `maxTurns`。
- 不通过无限增加轮次解决问题。
- 不依赖提示词作为唯一保护。

---

## 6. 核心概念

### 6.1 工具批次

一次模型响应可能并行或串行发起一个或多个工具。守卫以“工具批次”作为主要观察单位，而不是以流式 token 或 UI 消息作为单位。

### 6.2 动作签名

动作签名用于判断模型是否在重复做同一件事：

```text
toolName + normalizedTarget + normalizedSemanticInput
```

示例：

- Bash：命令主干、工作目录、关键参数；忽略无意义的空格和输出重定向差异。
- Edit/Write：规范化后的文件路径和编辑区域；不把替换文本全文直接作为签名。
- Read/Grep：目标路径、查询模式和范围。
- MCP 工具：服务器名、工具名和稳定输入字段。

### 6.3 结果签名

结果签名用于判断反馈是否实质相同：

```text
status + exitCode + timeoutKind + normalizedError + meaningfulOutputDigest
```

应去除时间戳、临时路径、随机 ID、耗时数字等噪声，避免相同错误因动态字段不同而被误判为新结果。

### 6.4 有效进展

以下情况可以视为有效进展：

- 验证命令从失败变为成功；
- 错误类型或失败位置发生有意义的变化；
- 获得此前缺失的诊断输出；
- 某项假设被证实或排除，并产生新的可验证方向；
- 目标产物通过约定的测试、类型检查或复现标准。

以下情况不能单独视为有效进展：

- Edit/Write 返回“已成功更新”；
- 重复读取相同文件；
- 创建更多探针，但结果没有新增信息；
- 仅改变命令格式，最终仍得到相同错误；
- 相同超时或空输出再次出现；
- 模型输出更长的思考，但验证状态没有变化。

关键原则：

> 修改成功是动作完成，不是目标进展；只有验证结果才能证明修改有效。

---

## 7. 触发条件

守卫在每个工具批次完成后运行。初始阈值如下，后续可根据影子模式数据调整。

### 7.1 一级：软提醒

满足任一条件时进入 `reflection_required`：

1. 同一动作签名得到相同失败结果签名 3 次；
2. 同一文件累计编辑 5 次，而最近的验证结果没有发生变化；
3. 连续 8 个工具批次没有有效进展；
4. 同一命令出现 2 次“超时且 stdout/stderr 均为空”；
5. 工具持续成功执行，但任务级验证连续失败，形成“动作成功、目标不变”的信号错位。

软提醒不立即终止。系统向主会话注入不可忽略的上下文：

```text
检测到连续工具调用未产生新证据。暂停原有局部试错，先比较最近几次
尝试的假设、预期与实际结果；判断问题是否在验证方法、环境或问题定义。
没有实质不同的新策略时，不要继续调用工具，应向用户汇报当前卡点。
```

### 7.2 二级：强制复盘

进入 `reflection_required` 后，继续执行 3 个工具批次仍无有效进展，则进入 `final_response_only`：

- 主会话获得一次不调用工具的收束机会；
- 必须说明已确认事实、重复失败模式、尚未验证的假设和无法继续的原因；
- 下一次模型响应若再次尝试调用工具，`PreToolUse` 拦截并返回复盘要求。

### 7.3 三级：暂停本轮

满足任一条件时进入 `paused_no_progress`：

1. 强制复盘后仍尝试重复工具调用 2 次；
2. 累计 12 个工具批次没有有效进展；
3. 相同空输出超时达到 4 次；
4. 无进展状态持续超过 10 分钟，且期间没有用户输入或新证据。

暂停不是崩溃，也不是失败恢复。会话、已完成编辑和历史结果全部保留，等待用户继续指示。

### 7.4 最终保险

`maxTurns=50` 保留。只有前述守卫未能识别的循环才应到达该上限。

---

## 8. 状态机

```text
observing
   │
   ├─ 有效进展 ─────────────────────────────┐
   │                                        │
   └─ 命中一级条件 → reflection_required   │
                          │                 │
                          ├─ 新证据 ────────┘
                          │
                          └─ 3 批仍无进展 → final_response_only
                                                   │
                                                   ├─ 正常总结 → completed
                                                   │
                                                   └─ 继续重复工具 → paused_no_progress
```

每条新的用户消息开始新一轮时，守卫状态重置为 `observing`；会话历史仍保留，但上一轮的计数不直接延续。

---

## 9. 主会话的复盘职责

守卫负责发现“又撞墙了”，主会话负责回答“墙是什么”。复盘至少包含：

1. 当前采用的核心假设是什么；
2. 最近几次工具调用分别预期看到什么；
3. 实际结果有哪些相同点；
4. 哪些假设已被证伪；
5. 当前验证方式是否能观察到真正的问题；
6. 下一步是否属于实质不同的策略；
7. 若没有新策略，为什么应停止并请求用户输入。

复盘的目标不是让思考更长，而是检查当前策略是否还值得继续。

---

## 10. 技术接入设计

### 10.1 共享判定器

建议新增纯逻辑模块：

```text
apps/electron/src/main/lib/agent/no-progress-guard.ts
```

职责：

- 规范化动作与结果签名；
- 保存单轮工具批次历史；
- 判定有效进展；
- 推进状态机；
- 生成结构化触发原因；
- 不直接操作 UI、IPC 或具体 SDK。

建议状态结构：

```ts
interface NoProgressState {
  phase: 'observing' | 'reflection_required' | 'final_response_only' | 'paused'
  batchCount: number
  noProgressBatchCount: number
  repeatedFailureCount: number
  emptyTimeoutCount: number
  batchesSinceReflection: number
  lastProgressAt: number
  lastActionSignature?: string
  lastOutcomeSignature?: string
  triggerReasons: string[]
}
```

### 10.2 KSCC 接入

Claude Agent SDK 当前版本提供：

- `PostToolBatch`：一批工具全部完成、下一次模型请求之前触发，并携带输入与结果；
- `PostToolUseFailure`：工具失败后触发；
- `PreToolUse`：下一次工具执行前拦截；
- Hook 返回 `additionalContext`、`continue` 与 `stopReason`。

因此 KSCC 最合适的接入点是 `ClaudeAgentAdapter.buildSdkOptions()`：

1. `PostToolBatch` 把批次交给共享判定器；
2. 一级触发时通过 `additionalContext` 注入复盘要求；
3. 二级触发后由 `PreToolUse` 禁止继续工具调用，给模型一次文本收束机会；
4. 模型继续违反时使用 Hook 停止本轮，并产生 TAgent 自有的暂停事件。

不要在 renderer 根据展示消息推断循环；renderer 可能折叠、限频或丢弃 partial，它不是行为真值源。

### 10.3 Pi 接入

Pi 已有 `turn_start` 计数和 `afterToolCall`。共享判定器应接在工具结果完成后的同等位置：

- 继续保留 Pi 的 `maxTurns`；
- 在 `afterToolCall` 前后更新无进展状态；
- 使用与 KSCC 相同的阶段和触发文案；
- 不为两个内核维护两套阈值语义。

### 10.4 SessionRuntime 与 IPC

`SessionRuntime` 负责把守卫结果转换为会话生命周期事件：

```text
tagent_no_progress_warning
tagent_no_progress_reflection
tagent_no_progress_paused
```

建议新增用户可见状态，而不是复用 `session_error`：

```text
paused_no_progress
```

该状态表示本轮被安全暂停，会话仍可继续，不触发崩溃恢复或进程重建。

---

## 11. 用户体验

### 11.1 一级提醒

默认不弹错误横幅，只在简洁过程区显示阶段摘要：

> 检测到重复失败，正在重新评估策略

### 11.2 暂停状态

主时间线显示非错误提示：

> 已暂停：连续多次操作未获得新进展

展开后包含：

- 重复的工具或目标；
- 最近一次有效进展；
- 重复失败摘要；
- 主会话的复盘结论。

用户继续发送消息即可开始新一轮。不得要求用户新建会话，也不得把已有编辑标记为回滚。

### 11.3 与 `error_max_turns` 的区别

| 状态 | 含义 | 会话是否可继续 | 是否属于错误 |
| --- | --- | --- | --- |
| `paused_no_progress` | 系统主动识别无进展并安全暂停 | 是 | 否 |
| `error_max_turns` | 最终保险上限被触发 | 是 | 保护性终止，不应显示为崩溃 |
| `crash` | 进程或渠道异常退出 | 视恢复结果 | 是 |

---

## 12. 降低误判的规则

1. 不能因为工具数量多就触发；正常长任务可能持续产生不同的有效结果。
2. 同一测试重复运行不必然是循环；如果中间代码发生变化且测试输出变化，应视为新证据。
3. Read/Grep 的重复权重低于 Bash/Edit；调查任务可能合理地回看文件。
4. 空输出超时权重高于普通非零退出，因为它几乎不提供诊断信息。
5. 子代理和后台任务应分别计数，不把子代理内部工具全部算到主会话头上。
6. 用户明确要求持续监控、重试或等待时，应进入专门的监控语义，而不是按普通调试循环判断。
7. 看板 worker 应按 worker 会话独立维护守卫状态。

---

## 13. 可观测性

每次状态变化记录结构化日志：

```json
{
  "sessionId": "session-...",
  "phase": "reflection_required",
  "batchCount": 8,
  "noProgressBatchCount": 8,
  "actionSignature": "Bash:node tools/a0-kscc-resume-crash.js",
  "outcomeSignature": "timeout:exit3:empty-output",
  "reason": "same_empty_timeout_twice"
}
```

日志不得写入完整文件内容、密钥或未经裁剪的命令输出。

---

## 14. 测试要求

### 14.1 纯函数单测

- 相同 Bash 命令与相同错误可稳定归一化；
- 时间戳、随机 ID 不导致结果签名变化；
- Edit 成功不重置无进展计数；
- 验证从失败变成功会重置无进展计数；
- 两次空输出超时触发一级提醒；
- 复盘后仍重复会进入暂停；
- 新用户回合重置状态。

### 14.2 KSCC 集成测试

- `PostToolBatch` 能收到工具结果并推进守卫；
- 一级提醒只注入上下文，不终止工具；
- 二级状态会拦截新的工具调用并允许模型输出总结；
- 暂停后长驻进程仍可接受下一条用户消息；
- 不改变最终消息持久化和 delta IPC 行为。

### 14.3 Pi 集成测试

- 与 KSCC 使用相同的输入序列得到相同状态；
- `afterToolCall` 与现有 `maxTurns` 不双重产生终态；
- 暂停不会被错误映射为 crash retry。

### 14.4 回放测试

使用 UnrealTagManager 已有会话的脱敏工具序列进行回放，预期：

- 第二次空输出超时时进入一级提醒；
- 不会继续运行到 `maxTurns=50`；
- 最终状态为 `paused_no_progress`，不是 `error_max_turns`。

---

## 15. 分阶段上线

### Phase 0：影子模式

只计算和记录，不影响模型行为。用真实会话统计误报率和典型签名。

### Phase 1：软提醒

启用 `reflection_required`，但不拦截工具。验证模型是否会主动换策略或收束。

### Phase 2：强制复盘与暂停

启用 `final_response_only` 和 `paused_no_progress`，补齐 UI 状态与回放测试。

### Phase 3：双核统一

KSCC 稳定后接入 Pi，并确保主会话、子代理和 worker 的计数边界一致。

---

## 16. 验收标准

1. 已知 UnrealTagManager 工具序列不会再运行到第 50 轮才结束。
2. 重复失败时，主会话至少执行一次明确的策略复盘。
3. 暂停状态不显示“运行出错”，且用户可在原会话继续。
4. 正常的多文件实现、测试和构建任务不会因工具数量多而被暂停。
5. KSCC 与 Pi 的无进展判定规则一致。
6. 所有触发均能从结构化日志解释原因。
7. `maxTurns=50` 仍然生效，作为无法识别场景的最终兜底。

---

## 17. 明确不采用的方案

- **只调高 `maxTurns`**：延后撞墙，增加时间和 token 消耗，不改变模型策略。
- **只调低 `maxTurns`**：会误伤正常复杂任务。
- **只写系统提示词**：模型可能忽略，且无法基于真实工具结果稳定计数。
- **把 Edit 成功当进展**：会重复本次事故中的信号错位。
- **按思考链长度终止**：思考长短与是否取得证据没有稳定关系。
- **检测到重复后立即崩溃式终止**：不给主会话复盘和总结机会，用户仍不知道卡点。

---

## 18. 待实现决策

实现前仍需通过影子模式确认：

1. 一级阈值采用固定次数还是按工具类型加权；
2. “验证命令”的识别采用命令规则表还是结果语义分类；
3. 暂停事件由 SDK Hook 终止还是由 SessionRuntime 软中断；
4. 子代理内部循环是否先只记录、暂不自动暂停；
5. 设置页是否需要提供守卫开关与严格程度，或先保持产品默认不可配置。

在这些问题确定前，不应直接把 `maxTurns` 改成另一个数字冒充解决方案。

---

## 19. 开发执行总则

本节把前述设计转换为可直接执行的开发流程。实现时必须遵守：

1. **先观测、后干预**：第一版先以 shadow 模式计算，禁止直接上线强制暂停。
2. **纯判定、薄适配**：签名、阈值和状态机只实现一次；KSCC/Pi 只负责把各自事件翻译成统一观察值。
3. **终态单一所有者**：一次暂停只能产生一个终态和一个 `turn_end`，禁止 Hook、适配器、Runtime、SessionService 各自补终态。
4. **暂停不是错误**：不得走 crash retry、进程恢复或 `session_error`。
5. **不碰持久化消息真值**：partial/delta、最终 assistant、tool result 的落盘规则保持不变。
6. **每阶段可关闭**：任何阶段出现误判，都能退回 shadow/off，而不修改会话数据。
7. **保留现有兜底**：整个开发期间 `maxTurns=50` 不删除、不调大。
8. **保护脏工作树**：开工前记录 `git status --short`，只修改本规格列出的文件，不 reset/clean 其它改动。

---

## 20. 类型与事件契约

### 20.1 运行模式

```ts
export type NoProgressGuardMode = 'off' | 'shadow' | 'enforce'
```

- `off`：完全不计算，紧急回滚使用；
- `shadow`：计算、记录、发送诊断事件，但不改变模型行为；
- `enforce`：启用提醒、强制复盘和暂停。

首个可发布版本默认必须是 `shadow`。确认回放和实机会话无明显误报后，才允许把默认改为 `enforce`。

### 20.2 统一观察输入

```ts
export interface ToolBatchObservation {
  sessionId: string
  turnId: string
  provider: 'kscc' | 'pi'
  observedAt: number
  calls: Array<{
    toolUseId: string
    toolName: string
    input: unknown
    output?: unknown
    error?: string
    durationMs?: number
  }>
}
```

守卫不直接接收 SDK 或 Pi 私有事件，防止核心逻辑与某个内核绑定。

### 20.3 判定输出

```ts
export type NoProgressDecisionKind =
  | 'continue'
  | 'warn'
  | 'require_reflection'
  | 'pause'

export interface NoProgressDecision {
  kind: NoProgressDecisionKind
  reasonCodes: NoProgressReasonCode[]
  batchCount: number
  noProgressBatchCount: number
  repeatedFailureCount: number
  emptyTimeoutCount: number
  userMessage?: string
  modelContext?: string
}
```

`NoProgressReasonCode` 使用稳定枚举，初始至少包含：

```text
same_failure_repeated
same_target_edited_without_verification_change
no_new_evidence
empty_timeout_repeated
action_success_goal_unchanged
reflection_ignored
time_without_progress
```

### 20.4 IPC 事件

在 `TAgentEvent` 中新增一个统一事件，而不是创建三个相互独立的临时事件：

```ts
type NoProgressEvent = {
  type: 'no_progress'
  phase: 'warning' | 'reflection' | 'paused' | 'cleared'
  reasonCodes: NoProgressReasonCode[]
  batchCount: number
  noProgressBatchCount: number
  summary?: string
}
```

约束：

- 事件中不传完整命令、文件正文或工具输出；
- renderer 只负责展示，不再次计算是否无进展；
- `paused` 与终态 result 配对，但不得额外产生 `session_error`；
- `cleared` 用于收到有效进展或新用户回合后清除过程提示。

### 20.5 暂停终态

统一使用：

```text
subtype = paused_no_progress
```

适配器停止当前 turn 后，应把 SDK/Pi 的原始停止结果归一化为一次 `paused_no_progress` result。`SessionRuntime` 按普通 result 清理 `turnInFlight` 并调用一次 `onTurnEnd`。

禁止同时输出：

```text
paused_no_progress + error_max_turns
paused_no_progress + error_during_execution
paused_no_progress + session_error
```

若底层在暂停后仍返回上述结果，适配器必须在单真源终态闸口中抑制或归一化，而不是让 renderer 去重。

---

## 21. 文件级改动清单

| 文件 | 责任 | 改动性质 |
| --- | --- | --- |
| `apps/electron/src/main/lib/agent/no-progress-guard.ts` | 纯判定器、签名归一化、状态机、默认阈值 | 新增 |
| `apps/electron/src/main/lib/agent/no-progress-guard.test.ts` | 核心状态机与误判单测 | 新增 |
| `packages/shared/src/types/agent.ts` | `NoProgressEvent`、reason code、运行阶段公共类型 | 修改 |
| `packages/shared/src/index.ts` 或对应 barrel | 导出新增公共类型 | 修改 |
| `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.ts` | SDK Hook 接入、per-turn guard、暂停终态归一化 | 修改 |
| `apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.test.ts` | Hook、长驻继续、单终态测试 | 修改或新增窄测试文件 |
| `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.ts` | Pi 工具批次翻译、共享 guard、终态归一化 | 修改 |
| `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts` | Pi 对等行为、与 maxTurns 互斥 | 修改 |
| `apps/electron/src/main/lib/agent/runtime/session-runtime.ts` | 识别暂停 result；保证只清一次 in-flight/onTurnEnd | 修改 |
| `apps/electron/src/main/lib/ipc/session-service.ts` | guard mode 注入、no_progress IPC 转发、meta idle 收口 | 修改 |
| `apps/electron/src/renderer/components/chat/Chat.tsx` | 消费 no_progress 事件、清理 running 状态 | 最小修改 |
| `apps/electron/src/renderer/components/chat/*NoProgress*.tsx` | 非错误暂停提示；仅内容复杂时拆组件 | 可选新增 |
| `packages/shared/src/utils/session-error-classify.ts` | 仅为 `error_max_turns` 改善分类；不得把 pause 当 error | 可选独立改动 |
| `apps/electron/src/main/lib/agent/no-progress-replay.test.ts` | UnrealTagManager 脱敏序列回放 | 新增 |

范围控制：不得顺手重构 `SessionRuntime`、流式 delta、消息持久化、权限系统或现有 UI 时间线。

---

## 22. 逐步开发流程

### Step 0：基线冻结与 SDK Hook 小实验

目标：在改主链前确认当前 SDK 版本的真实行为。

操作：

1. 记录工作树基线与已有测试状态；
2. 用最小测试验证 `PostToolBatch` 是否包含完整 input/output；
3. 验证 Hook 返回 `additionalContext` 后模型下一轮是否可见；
4. 验证 `continue:false`、`stopReason` 和 `PreToolUse` deny 分别结束 turn 还是结束长驻进程；
5. 验证停止后同一个 KSCC Query 能否接受下一条用户消息。

产物：仅测试或临时测试夹具。实验结论必须写进本文件或对应 FIX-NOTES 后再选择暂停实现方式。

门禁：若 Hook 会杀死长驻进程，禁止直接进入 enforce；改用 `query.interrupt()` 或“PreToolUse 拦截 + 文本收束”的组合，并重新验证。

### Step 1：实现纯判定器

目标：不接任何 SDK，先把行为语义固定。

顺序：

1. 定义 observation、decision、reason code；
2. 实现安全的输入/输出规范化；
3. 实现 per-turn 状态与重置；
4. 实现一级、二级、三级阈值；
5. 实现有效进展重置规则；
6. 添加敏感信息裁剪。

必须先通过的测试：

```powershell
bun test apps/electron/src/main/lib/agent/no-progress-guard.test.ts
bun run --filter='@tagent/electron' typecheck
```

此阶段不得改 adapter、Runtime 或 renderer。

### Step 2：KSCC shadow 接入

目标：观察真实工具批次，但不改变模型行为。

顺序：

1. 在 `KsccQueryOptions` 增加 guard mode/观察回调；
2. 在 `buildSdkOptions()` 注册 `PostToolBatch` 与失败 Hook；
3. 每个用户 turn 开始时重置 guard；
4. 把 Hook 输入翻译成 `ToolBatchObservation`；
5. 仅记录结构化日志并推 `no_progress` warning 诊断事件；
6. 不返回阻断决定、不修改 SDK result。

专项测试：

```powershell
bun test apps/electron/src/main/lib/adapters/claude/claude-agent-adapter.test.ts
bun test apps/electron/src/main/lib/agent/no-progress-guard.test.ts
```

验收：正常工具调用结果与未接入前完全一致；只多出可关闭的 shadow 诊断。

### Step 3：IPC 与 UI 状态先行

目标：在真正暂停工具前，先保证 UI 能正确表达状态。

顺序：

1. 扩展公共 `TAgentEvent`；
2. SessionService 透传 `warning/reflection/paused/cleared`；
3. 简洁模式只显示一句阶段摘要；
4. 完整模式可显示计数和 reason 摘要；
5. `paused` 收敛 running/计时/停止按钮；
6. 不使用红色错误横幅，不调用 crash retry。

验收：用合成 IPC 事件即可验证 UI；此时工具仍不被真正暂停。

### Step 4：KSCC enforce 接入

目标：启用强制复盘和安全暂停。

顺序：

1. 一级决定通过 `additionalContext` 注入策略复盘；
2. 二级决定把当前 turn 标记为 `final_response_only`；
3. 后续 `PreToolUse` 拦截继续调用，并把原因返回模型；
4. 再次违反时停止当前 turn；
5. 把底层终态归一化为唯一的 `paused_no_progress`；
6. 验证 result 后 KSCC 长驻循环仍在等待下一条消息；
7. 新用户消息重置 guard 并正常继续。

必须覆盖的竞态：

- 用户恰好同时点击 STOP；
- Hook 暂停后 SDK 仍返回 error result；
- 暂停发生时仍有 partial thinking/text；
- 最后一个 tool result 尚在落盘闸口；
- steer 消息在暂停前后到达。

单真源规则：第一个确定的终态获胜，后续重复终态只做日志，不再次 `onTurnEnd`。

### Step 5：已知会话回放

目标：用真实事故证明机制有效，而不是只靠人造计数。

顺序：

1. 从 UnrealTagManager 会话提取脱敏后的工具批次序列；
2. 去除绝对用户路径、文件正文和无关历史；
3. 回放给纯判定器；
4. 断言第二次空输出超时进入 warning；
5. 断言达到 enforce 阈值后暂停；
6. 断言不会继续到 `maxTurns=50`。

命令：

```powershell
bun test apps/electron/src/main/lib/agent/no-progress-replay.test.ts
```

### Step 6：Pi 对等接入

目标：只替换事件来源，不复制判定逻辑。

顺序：

1. 把 Pi `afterToolCall`/工具结束事件翻译成统一 observation；
2. per-query 重置与现有 `turnCount` 同步；
3. 复用相同 guard 实例和阈值；
4. pause 与 `maxTurnsHit` 互斥；
5. Pi 原始 `agent_end` 只归一化一次终态；
6. 对同一测试序列，KSCC/Pi 必须得到相同 decision。

专项测试：

```powershell
bun test apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts
bun test apps/electron/src/main/lib/agent/no-progress-guard.test.ts
```

### Step 7：全量门禁与实机验证

自动门禁：

```powershell
bun run --filter='@tagent/shared' typecheck
bun run --filter='@tagent/electron' typecheck
bun test
```

实机矩阵：

| 场景 | KSCC | Pi | 预期 |
| --- | --- | --- | --- |
| 连续读取不同文件 | 必测 | 必测 | 不触发 |
| 多文件编辑后测试逐步改善 | 必测 | 必测 | 不触发 |
| 同一命令相同失败 3 次 | 必测 | 必测 | warning/reflection |
| 两次空输出超时 | 必测 | 必测 | warning/reflection |
| 复盘后继续重复 | 必测 | 必测 | paused_no_progress |
| 暂停后发送新消息 | 必测 | 必测 | 原会话继续 |
| 暂停同时点击 STOP | 必测 | 必测 | 一个 turn_end |
| 正常达到长任务 20+ 批次 | 必测 | 必测 | 有新证据则不暂停 |
| 子代理内部大量工具 | 必测 | 必测 | 不污染主会话计数 |

未通过双核实机矩阵前，不打包、不把默认模式切为 `enforce`。

---

## 23. 功能开关与回滚

### 23.1 开关位置

第一阶段使用主进程内部配置，不在设置页暴露：

```text
NO_PROGRESS_GUARD_DEFAULT_MODE = 'shadow'
```

开发环境允许通过专用环境变量覆盖：

```text
TAGENT_NO_PROGRESS_GUARD_MODE=off|shadow|enforce
```

读取后必须经过白名单归一化；非法值回落默认值。不得把该变量写进会话 meta，也不需要数据迁移。

### 23.2 回滚顺序

出现误判时：

1. 将模式切回 `shadow`；
2. 若 shadow 本身影响性能，再切 `off`；
3. 保留 `maxTurns=50`；
4. 不删除或改写已有会话 JSONL；
5. 不通过 renderer 隐藏事件冒充回滚。

回滚只改变后续 turn 的行为，不影响已经完成或暂停的历史 turn。

---

## 24. 可独立派工的任务切片

| 切片 | 内容 | 依赖 | 是否可并行 |
| --- | --- | --- | --- |
| NP-0 | SDK Hook 长驻行为实验 | 无 | 可先行 |
| NP-1 | 纯判定器 + 单测 | 无 | 可与 NP-0 并行 |
| NP-2 | 公共类型与 IPC 契约 | NP-1 类型定稿 | 不建议提前 |
| NP-3 | KSCC shadow | NP-0、NP-1 | 否 |
| NP-4 | UI warning/paused 状态 | NP-2 | 可与 NP-3 后半并行 |
| NP-5 | KSCC enforce + 单终态 | NP-3、NP-4 | 否，主链关键项 |
| NP-6 | UnrealTagManager 脱敏回放 | NP-1 | 可与 NP-3/4 并行 |
| NP-7 | Pi 对等接入 | NP-1、NP-5 | KSCC 语义稳定后 |
| NP-8 | 双核回归与阈值审计 | 全部 | 最后执行 |

依赖关系：

```text
NP-0 ─┐
      ├─ NP-3 ─┬─ NP-5 ── NP-7 ── NP-8
NP-1 ─┘        │
  ├─ NP-2 ── NP-4 ─┘
  └─ NP-6 ────────────────┘
```

NP-1、NP-5 和 NP-8 应由同一主负责人把控，避免判定语义、终态语义和最终验收彼此脱节。其它切片可以委派，但不得自行改变阈值或事件契约。

---

## 25. 阶段交付模板

每个切片完成时必须报告：

```text
切片：NP-X
状态：完成 / 阻塞
修改文件：
行为变化：
未变化的关键路径：
测试命令与结果：
新增风险：
下一切片入口条件：
是否修改默认 guard mode：否 / 是（理由）
是否构建或打包：否 / 是（产物路径）
```

在用户未明确要求时，不提交、不推送、不打包。开发过程以文件级 diff、测试结果和阶段报告作为检查点。
