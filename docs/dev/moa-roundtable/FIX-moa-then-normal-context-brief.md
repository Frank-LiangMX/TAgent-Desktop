# Brief · 修「会诊后普通续聊丢上文」+ 会诊落盘 role

> 对照：`AUDIT-fresh-session-consult-FINDINGS.md`  
> `kscc -p --model glm-5.2 --dangerously-skip-permissions`

## P0 必做

1. **续聊注入**：`session-service` 普通路径 `isFirst` spawn 时，若 `!meta?.sdkSessionId` 且面板已有先验 user/assistant（含 `moa-agg-*`），则把近期历史拼进本轮发给模型的上下文（优先复用 `buildMoAHistoryFromMessages` / 同等纯函数），避免 L5「没有上文」。  
   - kscc 与 pi 都要覆盖（pi 若不读 resume，更依赖注入或读面板进 Agent 上下文——按现核最小改）。  
   - 单测：纯函数「面板有 MoA 轮 → 拼出含会诊结论的历史块」。

2. **落盘 shape**：`run-moa-turn.ts` `persistAndPushFinalAssistant` 补 `message.role: 'assistant'`（及与普通 assistant 对齐的必要字段）。单测或断言 shape。

## P1（可同 PR 小改）

- `ConsultMenu` 副文案一行：会诊席位无工具；查本地仓库请用左侧 ↑。

## 不做

本期不上汇总只读工具大改；不 commit。

## 验收

- 新会话 ▾ 会诊一条（任意短问）→ 再 ↑ 普通追问「刚才结论里第 1 点是什么」→ 模型应能引用会诊结论。  
- 相关 vitest 绿；写 FIX-NOTES 短节 §10。
