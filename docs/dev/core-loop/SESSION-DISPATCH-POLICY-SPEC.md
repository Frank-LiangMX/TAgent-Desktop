# Work 调度策略规格（「接着开发」与 Plan 触发）

> 日期：2026-08-18  
> 证据：`session-1786959659981` 用户 @85「可以了，接着开发吧」→ 21s 后 EnterPlanMode → 2 Explore + 1 Plan Agent + 多次 AskUser → 次日才 ExitPlanMode。

## 1. 问题

用户意图：**认方向 → 短确认 → 开写**。  
模型行为：SDK Plan Mode 脚本——「彻底探索 → 多方案 → AskUser → ExitPlanMode 交计划」，与 Work prompt 里的 **短答、少旁白** 冲突。

这不是纯 UI bug，是 **prompt + 工具可用性** 共同塑造的行为。

## 2. 原则

| 场景 | 期望 |
|------|------|
| 用户说「接着开发 / 开干 / 继续」且上下文 **已有** 方向 | **禁止** 自动 `EnterPlanMode`；直接 Todo + 改代码 |
| 新的大议题（跨 S5+S6、多模块、合 main 门槛） | 可文字简述步骤；**仅当** 用户确认或范围 ≥3 模块时才 EnterPlanMode |
| 已在 Plan Mode | 探索 **读** 为主；**Write 仍被 plan 权限拦** |
| Plan Mode 内 Explore | 主会话先 1–2 次 Glob 摸骨架；**最多 1** 个 Explore 子代理；禁止同质并行 2+ |
| 第一刀选择 | **最多 1 次** AskUser；用户关窗或未选 → 按 HANDOFF 推荐顺序默认开干，**不** 再问 |

## 3. prompt 改动点（`execution-mode-prompt.ts` Work 段）

新增段落 **「接着干 / Plan 边界」**（要点，implementation 时写全文）：

1. **默认执行**：用户明确「接着开发/可以了/开干」= 已有共识，**直接实现**，不要 EnterPlanMode。  
2. **EnterPlanMode 门槛**：同时满足才可用——(a) 用户要的是大范围规划或显式「先做个计划」；(b) 涉及 ≥3 独立模块或合 main 级交付；(c) 当前无已批准计划.pending。  
3. **ExitPlanMode 前**：必须用 TAgent 审批 UI（见 PLAN-MODE-CLOSURE）；**禁止**在聊天里贴完计划就当批准。  
4. **Plan 内 Explore 预算**：Plan 态下 Task/Agent Explore **≤1 次/用户回合**；更多目录自己 Read/Grep。  
5. **AskUser 在 Plan 内**：仅 **阻塞性** 分叉（二选一架构）；选项必须白话（见 SESSION-UX-RESIDUAL §2）。

## 4. 与 permissionMode 的关系

- 用户 **手动** 切到「计划模式」pill：等价「我要先规划」，允许 EnterPlanMode 语义，但仍需 ExitPlanMode 审批才写。  
- 用户 **完全自动** + 说「接着开发」：**不应** EnterPlanMode（prompt 约束；PM 闭环后 Exit 仍等人）。

## 5. 不做

- 主进程硬编码禁止 EnterPlanMode 工具（会误伤真规划场景）。  
- 改 SDK 工具定义。

## 6. 验收

- [ ] 回放 prompt 单测：Work 段含「接着开发」→ 不含「应 EnterPlanMode」类相反指引。  
- [ ] 手测：对 collab 会话说「接着开发权限 enforce 那一刀」→ 模型 **10 分钟内** 出现 Write/Edit（或明确 block 原因），而非 EnterPlanMode + 双 Explore。  
- [ ] 手测：用户说「先帮我做个合 main 的全计划」→ 可 EnterPlanMode，且 Exit 弹 Banner。

## 7. 实现 brief

派工前写 `SESSION-DISPATCH-POLICY-brief.md`（仅改 `execution-mode-prompt.ts` + 单测，1 commit）。
