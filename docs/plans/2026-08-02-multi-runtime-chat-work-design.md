# 多运行时协作框架 — 入口摘要

> **状态**：Draft v1.1  
> **日期**：2026-08-02  
> **完整文档族（回溯请用这个）**：  
> **[`docs/plans/multi-runtime/README.md`](./multi-runtime/README.md)**

本文件保留为**带日期的入口**；细则、FAQ、阶段与 ADR 均在 `multi-runtime/` 与 `docs/decisions/ADR-0003`～`0006`。  
**改行为先改文档族，再改代码。**

---

## 1. 一句话

**Chat 只读讨论（可 @）；Work 真干活（SubAgent / MoA / 看板）；权限档挂在 Work；模式只由用户切换。**

---

## 2. 文档地图

| 文档 | 内容 |
| --- | --- |
| [multi-runtime/README.md](./multi-runtime/README.md) | **总索引**、D1–D15、代码锚点、回溯指南 |
| [01 名词与真值](./multi-runtime/01-glossary-and-truth-model.md) | 正名、四元组、分层 |
| [02 Chat·Work·权限](./multi-runtime/02-chat-work-and-permissions.md) | 双轴、切换、工具硬拦 |
| [03 机制边界](./multi-runtime/03-mechanisms-subagent-kanban-moa.md) | SubAgent/看板/MoA/@ |
| [04 角色库](./multi-runtime/04-role-library.md) | SOUL vs Role、解析、商店 |
| [05 MoA·kscc](./multi-runtime/05-moa-and-kscc.md) | 并行会诊、模型池、班底 |
| [06 UX·布局](./multi-runtime/06-ux-visibility-and-layout.md) | 可见性、右栏、mosaic |
| [07 实现阶段](./multi-runtime/07-implementation-phases.md) | Phase A–F、验收、风险 |
| [08 FAQ·反模式](./multi-runtime/08-faq-and-anti-patterns.md) | 速查、AP1–AP15 |

### ADR

| ADR | 标题 |
| --- | --- |
| [ADR-0003](../decisions/ADR-0003-execution-mode-chat-work.md) | Chat/Work 与 permission 分层 |
| [ADR-0004](../decisions/ADR-0004-multi-runtime-mechanism-boundaries.md) | 四种调度语法边界 |
| [ADR-0005](../decisions/ADR-0005-user-owned-mode-switch.md) | 模式切换用户主权 |
| [ADR-0006](../decisions/ADR-0006-role-vs-soul.md) | 角色 vs SOUL；主会话默认不绑岗 |

---

## 3. 已拍板决策（D1–D15）

| ID | 决策 |
| --- | --- |
| D1 | 角色是契约不是进程；SOUL≠Role |
| D2 | 主会话默认不强制岗位角色 |
| D3 | SubAgent/看板/MoA 共享角色库、分生命周期 |
| D4 | 经典 MoA=并行独立+汇总；多轮辩论可选 |
| D5 | 用户参与圆桌=Chat @，≠MoA |
| D6 | executionMode: chat \| work |
| D7 | Plan/自动/完全自动挂 Work；不与 Chat 并列 |
| D8 | **仅用户**可切 Chat/Work；Agent 建议+确认 |
| D9 | 任意轮可切换；Work→Chat 不默认杀 worker |
| D10 | Chat 硬只读：不改本地、不派看板工人 |
| D11 | Work 默认不做多角色乱 @ |
| D12 | 过程可见：主会话简报 + 点进子运行详情 |
| D13 | 看板主路径=会话右栏；独立大页非必须 |
| D14 | kscc 一渠多模=默认会诊池 |
| D15 | 布局先可拖分栏；mosaic 仅可选工作台 |

---

## 4. 双轴速记

```
executionMode     chat = 讨论/只读/@     work = 干活/派工
permissionMode    仅 work 主生效：Plan | 确认 | 自动 | 完全自动
切换              仅用户（含确认 Agent 建议）
```

---

## 5. 机制速记

```
小事     → SubAgent / 自办
群聊插话 → Chat @
同题会诊 → MoA（并行→汇总）
长交付   → Work + 看板
先议后干 → Chat → 用户切 Work → 执行
```

---

## 6. 参考项目

| 来源 | 借鉴 |
| --- | --- |
| TAgent_General 1.0 | 看板、角色库、SubAgent≠Worker、右栏班组 |
| Hermes（经 General borrow 文档） | dispatcher、防死锁、MoA 定义、goal/judge |
| Frakio Work | Chat 不碰看板；Work 才编排；@ mention |

---

## 7. 修订记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-08-02 | v1.0 | 单文件宪章 |
| 2026-08-02 | v1.1 | 拆分 multi-runtime 文档族 + ADR-0003～0006；本文件改为入口摘要 |
