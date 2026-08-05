# CONCISE-UX Brief（纠偏）— 轻量逐步过程 + 回答区流式

> 交付正文不进思考/过程灰字区再「升级」。不 commit / 不 push（除非用户要求）。

## 拆分契约（`areToolsBeforeIndexCompleted`）

| 情况 | 行为 |
|------|------|
| 仍有未完成 tool | 尾部 text / streamingText 可留过程区（防回跳） |
| 无未完成 tool（含纯 thinking→text） | **立刻外置到回答壳** Markdown 流式 |

旧策略「无 tool → 不外置」会把最终输出摁在过程区到 idle，观感像「当思考」。

## 简洁过程

步骤仍逐步出现（思考紧凑预览、工具短句）；不是整块藏干净。
