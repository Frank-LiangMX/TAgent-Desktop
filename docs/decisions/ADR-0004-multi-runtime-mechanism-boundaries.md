# ADR-0004：SubAgent / 看板 / MoA / @ 机制边界

> **状态**：已拍板（2026-08-02）  
> **模块**：multi-runtime  
> **详设**：[docs/plans/multi-runtime/03-mechanisms-subagent-kanban-moa.md](../plans/multi-runtime/03-mechanisms-subagent-kanban-moa.md)、[05-moa-and-kscc.md](../plans/multi-runtime/05-moa-and-kscc.md)

---

## 决策

TAgent-Desktop 协作层采用 **四种调度语法**，共享角色库契约，**不共享生命周期与真值源**：

| 语法 | 用途 | 真值 |
| --- | --- | --- |
| **@ 讨论** | Chat 内用户参与的多角色对话 | 消息时间线 + activeSpeaker |
| **SubAgent** | 会话内短命委派 | tool_result / runId |
| **MoA 会诊** | 同题并行多席 → 汇总 | moa run + 结论 |
| **看板** | 长任务、依赖、可离开 | kanban DB + worker session |

**经典 MoA** 定义为并行独立作答 + 聚合；默认第一轮席位不互聊。  
**用户参与的圆桌** 走 @ 讨论，不走 MoA。

硬禁止（摘要）：

- Chat 下看板派工  
- @ 自动建 task  
- Worker / MoA seat 递归建 board  
- 用聊天记录替代看板状态  

---

## 背景

- General 1.0 已区分 SubAgent ≠ Worker；看板借 Hermes。  
- General 曾缓做完整 MoA（与看板/SubAgent 重叠、成本高）。  
- Frakio Chat @ 与 Work 看板分离。  
- 产品上易把「员工」「圆桌」「多模型」混成一词。

---

## 否决方案

| 方案 | 否决原因 |
| --- | --- |
| 一切皆常驻员工 Agent | 冲看板 task 真值；Office 幽灵员工教训 |
| 只用看板表达所有并行 | 小事过重 |
| 只用 SubAgent 表达长任务 | 无跨重启/依赖 |
| @ 即 MoA | 群聊 vs 并行会诊预期不同 |
| MoA 替代看板交付 | 会诊不出工单状态机 |

Desktop **重开 MoA** 但收窄为会诊层（+ kscc 池），不恢复无边界大 runtime 为 P0。

---

## 后果

- 工具与 prompt 必须写清「何时用哪种语法」。  
- UI 用 ChildRun 统一展示 subagent/moa-seat；worker 走右栏。  
- 组合键：讨论/会诊 → 用户切 Work → 看板。

---

## 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 采纳 |
