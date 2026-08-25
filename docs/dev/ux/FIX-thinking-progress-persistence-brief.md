# 思考链路与阶段进度落盘规范

状态：待实现

日期：2026-08-25

## 背景

近期对思考块、阶段总结和消息落盘进行了多次调整，出现过以下回归：

- 完整思考块消失，或被移动到回合顶部；
- 思考块虽然恢复，但阶段总结把大量排查过程一并落盘；
- 同一阶段的思考内容重复显示；
- 运行过程被拆成一条一行，缺少阶段级合并；
- 旧会话和新会话的显示行为不一致。

本文件固定最终语义，后续实现和回归检查均以此为准。

## 最终用户体验

一次任务中的内容分为三类：

| 内容 | 用途 | 默认状态 | 落盘规则 |
| --- | --- | --- | --- |
| 完整 thinking | 用户需要时查看完整思考链路 | 折叠 | 保留原始内容，按原时间线归属 |
| 阶段进度摘要 | 用户快速了解任务推进到哪一步 | 直接显示 | 只保存压缩后的阶段摘要 |
| 最终回答 | 任务结果和交付说明 | 直接显示 | 保留原文 |

完整 thinking 与阶段进度摘要不是同一份文本，不能用原始 thinking 直接充当摘要。

## 已确认的根因

### 1. 提示词只有软约束

`packages/shared/src/utils/output-style-prompt.ts` 已经要求：思考草稿不能通过普通 `text` 输出，阶段进度应为偶发的一句短文，长度约为 30～80 字。

但提示词不能保证模型始终遵守这个格式，尤其是在连续搜索、读取文件和执行命令的过程中。

### 2. 落盘门控没有摘要能力

`apps/electron/src/main/lib/agent/stream-persist-gate.ts` 当前主要判断：

- 消息是否为 `_partial` 流式快照；
- assistant 消息是否存在非空内容；
- 同一个 uuid 是否已经产生最终版本。

一旦普通 `text` 消息非空且不是 partial，门控会把原消息原样保存。它不会判断这是不是阶段摘要，也不会限制长度、去除重复或删除废弃方案。

### 3. 时间线模型与落盘职责混在一起

`apps/electron/src/renderer/components/chat/concise-timeline-model.ts` 负责把消息组织成时间线和阶段，但它不是摘要生成器。

`ConciseTimelineView.tsx` 负责折叠和延迟渲染，也不应该承担落盘内容压缩。

因此，继续修改折叠、排序或 `formatThinkingSummary` 都不能解决阶段总结过长的问题。

## 实现方案

### A. 保留完整 thinking，不再把它当阶段摘要

完整 thinking 必须继续进入原来的时间线位置：

- 位于对应工具阶段或文本阶段的实际位置；
- 同一回合重复快照按 key/uuid 去重；
- 默认折叠；
- 折叠时不挂载完整正文；
- 用户展开时才渲染完整正文。

不得再次把中间 thinking `flush` 成独立的顶部段落，也不得因为压缩阶段摘要而删除完整 thinking。

### B. 增加独立的阶段摘要转换层

在进入持久化门控之前增加阶段摘要处理，建议提供纯函数：

```ts
compactStageProgress(input: {
  text: string
  stageKey: string
  isTerminal: boolean
}): string | null
```

处理规则：

1. 完整 thinking 不进入该函数；
2. 工具执行期间的普通 `text` 视为阶段进度候选；
3. 只保留已确认事实、当前动作和下一步；
4. 删除候选方案、否定过程、自言自语、命令细节和重复自检；
5. 输出最多 1～2 句，目标长度 30～80 个中文字符；
6. 空内容、纯工具旁白、和上一条归一化后相同的内容直接丢弃；
7. 同一工具阶段只保留一条摘要，后续更新应替换 pending，而不是追加多条；
8. 最终回答不经过该压缩函数。

第一版应使用确定性的本地规则，不为了摘要再发起一次模型调用，避免增加延迟、费用和重复内容。规则不足时再单独评估模型摘要，不在本次修复中引入。

### C. 明确落盘消息类型

落盘前应区分以下类型，而不是只看 assistant content 是否非空：

```text
thinking       完整思考，供折叠块展开
stage_summary  阶段摘要，短文本，供进度显示
final_text     最终回答，保留原文
tool_event     工具事件，按现有卡片规则保存
```

`stream-persist-gate` 继续负责 partial/final uuid 合并和边界 flush，但不负责从原始文本中猜测摘要，也不应把未经处理的长 thinking/text 当成阶段摘要保存。

### D. 显示层保持现有职责

`ConciseTimelineView.tsx` 只负责：

- 阶段顺序；
- 折叠状态；
- 展开时的延迟挂载；
- 流式中的滚动跟随。

不要通过 UI 截断来掩盖落盘层仍然保存长文本的问题。UI 截断只能作为最后的防御性保护，不能替代落盘前分类和摘要。

## 不允许的回归

- 不得把所有普通 text 都强制识别为 thinking；
- 不得把中间 thinking 从原阶段移到顶部；
- 不得为了减少摘要而删除完整 thinking；
- 不得每个工具调用后机械追加一条进度；
- 不得把同一段累计 thinking 快照重复保存；
- 不得把最终回答套用阶段摘要长度限制；
- 不得只改 `formatThinkingSummary` 或 CSS 来解决落盘问题；
- 不得让旧会话的历史消息在读取时被静默改写。

## 验收标准

### 新会话

- 执行中能看到阶段进度，但连续搜索/读文件/命令不会一条工具追加一条长旁白；
- 阶段进度单条不超过 1～2 句，通常不超过 80 个中文字符；
- 同一阶段重复内容只显示一次；
- 完整 thinking 位于正确的时间线位置；
- 完整 thinking 默认折叠，折叠状态下不渲染正文；
- 用户展开后可以看到完整 thinking；
- 最终回答内容不被压缩；
- 任务完成后重新打开会话，阶段摘要和完整 thinking 的语义保持一致。

### 自动化测试

至少覆盖：

1. 普通长思考文本不会直接成为 `stage_summary`；
2. 阶段摘要会被压缩到长度上限；
3. 候选方案和命令细节会被过滤；
4. 同阶段相同摘要会去重；
5. 连续工具事件不会机械生成多条摘要；
6. 最终回答保持原文；
7. thinking、stage summary、final text 在同一时间线中的顺序正确；
8. partial 消息只被最终 uuid 版本替换一次。

## 相关代码

- `packages/shared/src/utils/output-style-prompt.ts`
- `apps/electron/src/main/lib/agent/stream-persist-gate.ts`
- `apps/electron/src/main/lib/agent/stream-persist-gate.test.ts`
- `apps/electron/src/renderer/components/chat/concise-timeline-model.ts`
- `apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts`
- `apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx`

## 历史说明

此前一次改动把中间 thinking 从 `stageSteps` 移到了顶层 `segments`，导致思考块脱离原时间线并集中显示。该语义已经恢复。

当前遗留问题是阶段摘要仍可能直接复用模型输出的长普通文本。后续修复必须围绕“落盘前分类与压缩”进行，不能再次通过改变时间线模型来解决。
