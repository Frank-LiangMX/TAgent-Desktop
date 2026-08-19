# 无效试探收敛与主动澄清

## 背景

TAgent 在目标不清、假设连续失败、或已经没有新证据时，可能继续自行试探，造成过长的工具调用链，并最终撞到 `maxTurns=50`。本任务治理的是“是否还有有效进展”，不是限制用户选择的思考强度。

## 不变约束

- 不根据任务复杂度预先分档或设置不同的默认工具预算。
- 不修改用户选择的 reasoning/thinking 强度。
- 不把已经解决的思考过程展示问题重新做一遍；过程区继续由完成态自动折叠。
- `maxTurns=50` 保留为最后保险，不把它当作主要控制策略。
- 本轮优先改现有 guard 与适配层，避免重写 agent 循环。

## 目标行为

### 1. 重复成功也视为无效进展

同一动作、同一目标、同一有效结果连续重复（例如把相同内容反复写回同一文件）时，应进入无进展状态；不能因为工具返回成功就继续放行。

### 2. 只有策略发生实质变化才允许继续

连续失败后，下一轮必须有新的假设、目标或验证方式。仅更换相近参数、路径或命令不算策略变化。无法证明策略变化时，应暂停。

### 3. 无进展暂停必须主动询问用户

`paused_no_progress` 不应只等待用户重新发一条普通消息。暂停时应接入现有 AskUserQuestion 管线，生成结构化澄清：

- 已确认的事实
- 重复失败/无进展摘要
- 可选的下一步方向（补充信息、换方案、继续当前方向）

用户未选择前不得自动继续试探。

### 4. 修改后应有验证证据

本轮发生 `Write`/`Edit` 后，如果没有测试、构建、读取结果或其他明确验证证据，不应直接声明完成；应触发一次验证提示或进入澄清流程。提示必须防重复，并且不污染持久化会话历史。

## 参考实现

- DeepSeek-Reasonix：`internal/agent/repeat_failure_guard.go`、`internal/agent/recovery_gate.go`、`internal/agent/ask.go`
- hermes-agent：`agent/tool_guardrails.py`、`verification_stop.py`
- Kun：`src/agent/tool-storm-breaker.ts`、`src/agent/round-outcome-coordinator.ts`

## TAgent 落点建议

1. 扩展 `apps/electron/src/main/lib/agent/no-progress-guard.ts`：增加重复成功签名、实质策略变化判定和对应 reason code；保持现有噪声裁剪与重复失败逻辑。
2. 在 Claude/Pi 适配层的无进展暂停分支接入 `agent-ask-user-service.ts`，复用现有 `AskUserQuestion` 事件/UI，不新增第二套问答协议。
3. 新增轻量 verify-on-stop 判定器，挂在终态收束前；仅对本轮发生写操作且缺少验证证据的情况生效。

## 验收标准

- 同一成功 Edit/Write 达到阈值后不会继续产生同类工具调用。
- 重复失败但策略未变化时会暂停；策略确实变化时不会被误判为重复。
- 无进展暂停会出现可回答的 AskUserQuestion，用户不回答时保持暂停。
- 写操作后无验证不会直接显示“已完成”；验证后可正常收束。
- 既有 no-progress guard、50 次兜底、AskUserQuestion 和会话持久化测试继续通过。
- 不改变 reasoning/thinking 设置和完成态过程区折叠行为。

## 本轮不做

- 不新增任务复杂度分类、工具调用预算或 token/cost 预算 UI。
- 不改变自动恢复/暂停的总体产品语义。
- 不引入新的模型或重新设计整个 agent loop。
