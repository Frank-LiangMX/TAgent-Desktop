# MoA 汇总席不得既当裁判又当运动员

> 起草：2026-08-18
> 状态：调研结论 + 修复方案（建议采纳后提炼为 ADR-0008）
> 范围：会诊（consultation / `moa_roundtable`）、圆桌（roundtable / `moa_discussion`）、协作室共享摘要（collaboration-room-summary）

## 一句话结论

**汇总席 / 收口人 / 纪要模型的 `modelId`，不得等于任一参考席 / 参与者的 `modelId`。** 同一个模型实例既产答案又评答案，是 MoA 文献里最经典的 self-preference 翻车点——多样性被一个偏心的记分员抹平，三个臭皮匠反而不如一个诸葛亮。

## TL;DR

- 现状默认预置里，汇总模型就是参考席之一（`default`：glm-5.2 既是「架构师」席又是汇总席；`cheap`：deepseek-v4-flash 同理）。
- 汇总 prompt 只说「分析各模型优缺点、综合判断」，无任何自偏好抑制指令；预置校验也不拦「汇总席 ∈ 参考席」。
- 一个微妙点：参考输出标的是角色卡名（「架构师」）不是家族名（「glm」），汇总模型其实**看不到**哪个参考席跟它同族——这让「prompt 抑制自偏好」难落点，真正能堵住的是**结构上禁止同模型**。
- 修复主轴：在 `isValidMoAPreset` 加硬校验 `aggregatorModelId ∉ references[].modelId`，并改 seed 预置；prompt 抑制作为软兜底。
- 圆桌同构（收口 + 纪要都用 `aggregatorModelId`），同样适用；协作室复用协调者 channel 做总结，待评估。

## 现状证据

### 1. 会诊：默认预置汇总席 = 参考席

`packages/shared/src/types/moa-preset.ts:132-156` —— `MOA_DEFAULT_PRESETS`：

```ts
{
  id: 'default',
  references: [
    { name: '架构师', modelId: 'glm-5.2' },
    { name: '实战派', modelId: 'kimi-k2.6' },
    { name: '评审官', modelId: 'mimo-v2.5-pro' },
  ],
  aggregatorModelId: 'glm-5.2',   // ← 与「架构师」席同模型
}
{
  id: 'cheap',
  references: [
    { name: '快速拆解', modelId: 'deepseek-v4-flash' },
    { name: '省并发·乙', modelId: 'kimi-k2.5' },
  ],
  aggregatorModelId: 'deepseek-v4-flash',  // ← 与「快速拆解」席同模型
}
```

`packages/shared/src/types/moa-preset.ts:162-179` —— `isValidMoAPreset` 只校验字段齐全、`references.length >= 2`、`aggregatorModelId` 非空，**没有任何「汇总席不能等于任一参考席」的校验**。

### 2. 会诊：汇总 prompt 无自偏好抑制

`packages/pi-core/src/moa-orchestrator.ts:376-406` —— `buildAggregatorPrompt`：

```ts
const refSections = refOutputs.map((r) => {
  const status = r.ok ? "" : " [该参考模型运行失败]"
  return `\n[参考模型 ${r.name}${status}]\n<参考输出>\n${r.text}\n</参考输出>`
}).join("\n")
// ...
"1. 分析各参考模型的优缺点",
"2. 综合判断给出最佳答案",
```

两点：
- 指令只有「分析优缺点、综合判断」，没有「不要偏爱与你是同一家族的参考输出」之类。
- 参考输出用 `[参考模型 ${r.name}]` 标注，`r.name` 是**角色卡名**（「架构师」「实战派」），不是模型家族名。汇总模型看不到「这条是 glm 写的、那条是 kimi 写的」。

### 3. 圆桌：收口 + 纪要都用 aggregatorModelId，同构

`apps/electron/src/main/lib/agent/run-moa-discussion.ts`：
- `buildModeratorPrompt`（`:314-330`）——收口人 prompt。
- `buildDiscussionSummaryPrompt`（`:341-379`）——共享纪要，注释明确「隔离的纪要模型（用 `aggregatorModelId`）」。
- 参与者来自 `preset.references`，user 席与 moderator 席由状态机自动追加。

即：圆桌的裁判（收口人）和记分员（纪要模型）都用 `aggregatorModelId`，参与者来自 `references`。若 `aggregatorModelId` 等于某参与者 `modelId`，该模型既参与讨论又主持收口——与会诊同一个坑。

### 4. 协作室：复用协调者 channel，待评估

`apps/electron/src/main/lib/collaboration/collaboration-room-summary.ts:142-168, 214-235` —— 六段摘要总结者复用「协调者 channel/model」。协调者本身是否是协作室成员、是否会出现「既当裁判又当运动员」，需在落地时单独确认（本文件不展开）。

## 为什么这是坑

**Self-preference 机理**：MoA（Mixture of Agents）文献的稳定结论是——汇总模型对「同家族模型产出的答案」有系统性偏好。来源有二：
1. 风格亲近：同家族模型的输出在措辞、结构、用词分布上接近汇总模型的「舒适区」，汇总时更顺眼、更少被挑刺。
2. 训练同源：同家族模型共享预训练分布与对齐方式，倾向互相认可。

**在本项目的放大效应**：默认预置里汇总席与某一参考席是**同一个模型实例**（不只是同家族，是同一个 modelId）。此时汇总模型看到的参考输出里，有一条就是它自己刚生成的文本——这不是「偏好同族」，是「自己评自己刚写的」。多样性配置（glm + kimi + mimo 四家族）在这一步被直接抵消。

**微妙点**：因为参考输出只标角色名不标家族名，汇总模型在「意识层面」不知道哪条是自己的。但这不消除偏好——同模型产出的文本风格天然亲近，且若模型有任何同族偏好也无从抑制。所以：
- 「在 prompt 里加一句『不要偏爱你自己家族的答案』」**作用有限**——你连家族标识都没给汇总模型，抑制指令难落点。
- 真正能堵住的是**结构层**：让汇总席与所有参考席不同模型，从根上消除「自己评自己」。

## 修复方案

主轴是结构层硬约束，prompt 抑制只做软兜底。

### 方案 A（主）：预置结构层禁止同模型【推荐】

在 `packages/shared/src/types/moa-preset.ts` 两处加约束：

1. `isValidMoAPreset`（`:162-179`）加一条：`aggregatorModelId` 不得等于任一 `references[].modelId`，否则判非法。运行时 `validateMoAPresetForChannel` 同步拦截。
2. `MOA_DEFAULT_PRESETS`（`:132-156`）改 seed：把两个预置的 `aggregatorModelId` 换成不在参考席里的模型。
   - `default`：参考席 glm-5.2 / kimi-k2.6 / mimo-v2.5-pro，汇总席换 kimi-k2.6 之外的第四个（或保留三家族、汇总席取三者之一但**移除它对应的参考席**，凑够 3 个不同家族——见下方取舍）。
   - `cheap`：参考席 deepseek-v4-flash / kimi-k2.5，汇总席换第三个不同家族。

代价：用户预置里若习惯「汇总席就设成自己最信任的模型」，会被硬拦。缓解：UI 上在汇总席下拉里禁选已在参考席出现的 modelId，并提示原因，而非等保存时才报错。

### 方案 B（辅）：prompt 软抑制

在 `buildAggregatorPrompt`（`moa-orchestrator.ts:376`）与 `buildModeratorPrompt`（`run-moa-discussion.ts:314`）加一句：

> 不要因为某条参考输出与你同家族而偏向它；以内容本身权衡。

注意：因参考输出未标家族名，这条抑制是「让汇总模型自省」而非「给它判据」，效果弱于方案 A，仅作兜底，不能单独依赖。

### 方案 C（备）：参考输出标家族名 + 抑制

把 `[参考模型 ${r.name}]` 改成 `[参考模型 架构师 (glm-5.2)]`，同时加方案 B 的抑制指令，让汇总模型明确知道哪条同族并主动抑制。

代价：暴露家族名给汇总模型，理论上反而可能**诱发**而非抑制偏好（模型知道哪条是自己人）。MoA 文献对此褒贬不一，**不推荐**作为主方案，仅在需要可解释性时考虑。

### 建议组合

**方案 A 为主 + 方案 B 软兜底**。方案 A 从结构上消灭「自己评自己」，方案 B 应对「同家族但不同实例」的残余偏好。方案 C 暂缓。

## 落地清单

| 改动 | 文件 | 行 | 内容 |
|---|---|---|---|
| 加预置校验 | `packages/shared/src/types/moa-preset.ts` | `:162-179` | `isValidMoAPreset` 增 `aggregatorModelId ∉ references[].modelId` |
| 同步运行时校验 | `moa-dispatch.ts`（`validateMoAPresetForChannel`） | `:33-49` | 拦截同模型，给出可读错误 |
| 改 seed 预置 | `packages/shared/src/types/moa-preset.ts` | `:132-156` | `default` / `cheap` 的 `aggregatorModelId` 换成不在参考席的模型 |
| 汇总 prompt 软抑制 | `packages/pi-core/src/moa-orchestrator.ts` | `:376-406` | `buildAggregatorPrompt` 加自偏好抑制句 |
| 收口 prompt 软抑制 | `apps/electron/src/main/lib/agent/run-moa-discussion.ts` | `:314-330` | `buildModeratorPrompt` 加自偏好抑制句 |
| UI 下拉禁选 | 会诊/圆桌预置编辑 UI | — | 汇总席下拉禁选已在参考席的 modelId，配提示 |
| 补测试 | `packages/shared/src/types/moa-preset*.test.ts` | — | 断言「汇总席 = 参考席之一」被判非法；`default`/`cheap` seed 满足新约束 |
| 协作室评估 | `collaboration-room-summary.ts` | `:142-168, 214-235` | 确认协调者是否成员、是否同模型，补一条结论到此文件 |

## 取舍备注

- 「3 个不同家族参考席 + 汇总席取其中之一、删掉对应参考席」是另一种合法形态——它保证汇总席与**留下的**参考席都不同模型，但仍只有 2 个家族参与对比。相比「凑第 4 个家族当汇总席」，它少一个对比视角。除非额度受限，优先凑够汇总席用第四家族。
- 用户的 MoA 出发点是「公司额度大但无顶级模型，用数量换质量」。本约束保护的就是这个出发点——若汇总席与参考席同模型，「数量换质量」退化为「一个模型多投几票」，恰恰背离初衷。

## 后续

采纳后建议提炼为 `docs/decisions/ADR-0008-moa-aggregator-independence.md`，作为与 ADR-0004（四种调度语法边界）并列的 MoA 设计约束。
