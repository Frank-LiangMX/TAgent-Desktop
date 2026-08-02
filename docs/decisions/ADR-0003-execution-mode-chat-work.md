# ADR-0003：Chat / Work 执行模式与 permission 分层

> **状态**：已拍板（2026-08-02）  
> **模块**：multi-runtime  
> **详设**：[docs/plans/multi-runtime/02-chat-work-and-permissions.md](../plans/multi-runtime/02-chat-work-and-permissions.md)  
> **相关**：ADR-0005（切换主权）、Frakio `executionMode`

---

## 决策

引入会话级 **`executionMode: 'chat' | 'work'`**，与 **`permissionMode`（Plan / 确认 / 自动 / 完全自动等）** 分层：

| 轴 | 含义 |
| --- | --- |
| executionMode | 在讨论还是在执行 |
| permissionMode | 执行时写操作/派工有多自动（**主要在 work 生效**） |

- **Chat**：硬只读协作（可读、可搜、可讨论、可 @、可选 MoA）；禁止改本地、禁止派看板工人。  
- **Work**：真干活；SubAgent / MoA / 看板；@ 群聊默认关闭。  
- **Plan/自动/完全自动不得与 Chat 并列**成同一组平等单选项。

---

## 背景

1. Frakio 证明：mention 讨论与看板编排混在同一默认路径会预期错乱。  
2. TAgent 已有权限档；若再平行塞「Chat」会变成五选一认知灾难。  
3. 用户需要「对齐需求时绝不误写文件」的硬保证。

---

## 否决方案

| 方案 | 否决原因 |
| --- | --- |
| 仅靠 prompt 区分讨论/执行 | 不可靠，必须工具策略 |
| Chat 作为 permission 的第五档 | 维度错误 |
| 只有 Work，讨论也在可写会话 | 误改风险高 |
| Chat 允许「建板但不执行」当日常 | 与 Work 边界糊；草稿可另议但不替代 Chat |

---

## 后果

- 会话 meta、IPC、工具 beforeToolCall、system 注入均需感知 executionMode。  
- UI：协作开关与权限开关分层展示。  
- 实现清单见 multi-runtime Phase A/B。

---

## 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 采纳 |
