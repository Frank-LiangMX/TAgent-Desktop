# REGRESS-K 摸底 Brief

读 `docs/dev/core-loop/REGRESS-K-residual-detail-SPEC.md`，只读摸底，写 `docs/dev/core-loop/REGRESS-K-FINDINGS.md`。不改业务代码、不 commit。

## K1 — 思考落正文飞快消失 + 执行块无思考行

对照：
- `concise-timeline-model.ts`：thinking 何时进 stage.steps / ThinkingFold / 何时被当 text narrative / final
- `stream-persist-gate.ts`：thinking / text 落盘闸口是否把 thinking 当 assistant text
- `AssistantTurnView` / `buildTurnPresentation`：live 时 thinking 是否进 answerTexts
- REGRESS-F / J3 已修项是否被回退或漏场景（如「短思考当 text」「reasoning 块映射错」）

要证据：文件:行 + 复现路径（live vs idle、有无工具、glm 渠道）。

## K2 — 点进子代理「尚未产生消息」

对照：
- `SubagentDetailView.tsx`：`subagentItems` 从哪来；何时 length===0
- 子代理消息如何从 SDK/session 灌进 atom / store（搜 `subagentItems`、`parentToolUseId`、`task_notification`、subagent jsonl）
- 成功 completed 的子代理为何 UI 仍空——是没订阅流、没 hydrate、还是 key 对不上

要证据：成功案例落盘有消息但 UI 空的链路断点。

## K3 — 最新会话「子代理总失败」

1. 先找 **最新** GUI 会话：`~/.tagent-dev/projects/**/session-*.jsonl`（按 mtime），不要只看 ROUND2 的 `1786070710143`。
2. 是否有 `Agent`/`Task` tool_use？若无 → 红字是否 Bash Exit 5 fork（同 ROUND2）。
3. 若有子代理：`toolUseResult.status`、子代理 jsonl 是否有 assistant 内容；与 K2 是否同一根因。
4. haiku 修复 `831c941` 是否已进入**当前运行中的 App**（用户是否 rebuild+重启后派过子代理）。

输出 FINDINGS：结论先行 + 证据表 + 建议实现优先级（K1/K2）。
