# 多运行时协作模块 — 文档索引

> **模块代号**：multi-runtime  
> **状态**：Implementing（A 完成；B 基础；C 完成；D 主路径可演示；E/F 未开）  
> **日期**：2026-08-03  
> **用途**：协作层（Chat/Work、角色库、看板、SubAgent、MoA、@ 讨论）的**唯一入口文档族**。回溯时先读本页。  
> **续作交接**：[09-handoff-2026-08-03.md](./09-handoff-2026-08-03.md)（含当日对话决策记忆）

> **新增一级容器（2026-08-11）**：持久多 Agent 聊天与 A2A 不属于普通会话内机制，采用独立 Rail 入口。见 [Agent 协作室总纲](../agent-collaboration-room/00-MASTER.md) 与 [ADR-0007](../../decisions/ADR-0007-agent-collaboration-room.md)。

---

## 0. 这个模块解决什么

TAgent-Desktop 2.0 不只是「单会话 Agent」，还要：

1. **Chat**：只读讨论、可 `@` 多角色、用户在场  
2. **Work**：真干活；权限档（Plan/自动/完全自动）只在此轴上生效  
3. **角色库**：统一岗位契约，不统一生命周期  
4. **SubAgent / 看板 / MoA**：三种调度语法，边界清晰  
5. **模式切换**：仅用户可切；Agent 只能建议  

与「记忆 L5 / 双核 / 压缩」等模块正交：那些管上下文与核，本模块管**协作形态与派工**。

---

## 1. 阅读顺序（建议）

| 顺序 | 文档 | 何时读 |
| --- | --- | --- |
| ① | **本 README** | 永远第一页 |
| ② | [01 名词与真值模型](./01-glossary-and-truth-model.md) | 实现/评审前统一语言 |
| ③ | [02 Chat·Work 与权限双轴](./02-chat-work-and-permissions.md) | 模式、切换主权、工具白名单 |
| ④ | [03 三种机制边界](./03-mechanisms-subagent-kanban-moa.md) | 何时用 SubAgent/看板/MoA/@ |
| ⑤ | [04 角色库](./04-role-library.md) | Role vs SOUL、供应关系、存储 |
| ⑥ | [05 MoA 与 kscc](./05-moa-and-kscc.md) | 并行会诊、模型池、班底 |
| ⑦ | [06 UX 可见性与布局](./06-ux-visibility-and-layout.md) | 进度展示、右栏、mosaic |
| ⑧ | [07 实现阶段与验收](./07-implementation-phases.md) | 排期、DoD、回归点 |
| ⑨ | [08 FAQ 与反模式](./08-faq-and-anti-patterns.md) | 扯皮/回溯速查 |
| ⑩ | [09 交接 2026-08-03](./09-handoff-2026-08-03.md) | **公司电脑续作必读**：现状/坑/下一步/对话记忆 |
| ⑪ | [10 会话内 Agent 行为编排](./10-session-agent-behavior-orchestration.md) | 普通会话内“说/议/干”；不含协作室 |
| ⑫ | [Agent 协作室文档族](../agent-collaboration-room/00-MASTER.md) | 独立房间、多成员运行时与 A2A |

**入口摘要（一页版）**仍保留：  
[`../2026-08-02-multi-runtime-chat-work-design.md`](../2026-08-02-multi-runtime-chat-work-design.md)  
→ 指向本目录；细节以 `multi-runtime/*` 为准。

---

## 2. ADR（为什么这么定）

| ADR | 标题 | 一句话 |
| --- | --- | --- |
| [ADR-0003](../../decisions/ADR-0003-execution-mode-chat-work.md) | Chat/Work 与 permission 分层 | 讨论 vs 干活是大模式；Plan/自动不是并列第五项 |
| [ADR-0004](../../decisions/ADR-0004-multi-runtime-mechanism-boundaries.md) | SubAgent / 看板 / MoA / @ 边界 | 四种调度语法，禁止混用语义 |
| [ADR-0005](../../decisions/ADR-0005-user-owned-mode-switch.md) | 模式切换用户主权 | Agent 只建议，确认后系统切换 |
| [ADR-0006](../../decisions/ADR-0006-role-vs-soul.md) | 角色库 vs SOUL | 岗位契约 vs 全局身份；主会话默认不绑岗 |
| [ADR-0007](../../decisions/ADR-0007-agent-collaboration-room.md) | Agent 协作室独立入口 | 独立 Rail、房间真值与结构化 A2A；不伪装成会话模式 |

相关但不属于本模块：

- [ADR-0001](../../decisions/ADR-0001-dual-core.md) 双核  
- [ADR-0002](../../decisions/ADR-0002-longlived-process.md) 长驻进程  

---

## 3. 决策地图（拍板速查 D1–D15）

| ID | 决策 | 详见 |
| --- | --- | --- |
| D1 | 角色是契约不是进程；SOUL≠Role | 01, 04, ADR-0006 |
| D2 | 主会话默认不强制岗位角色 | 01, 04, ADR-0006 |
| D3 | SubAgent/看板/MoA 共享角色库、分生命周期 | 03, 04, ADR-0004 |
| D4 | 经典 MoA=并行独立+汇总；多轮辩论可选 | 05, ADR-0004 |
| D5 | 用户参与圆桌 = Chat @，≠ MoA | 03, 05, ADR-0004 |
| D6 | executionMode: chat \| work | 02, ADR-0003 |
| D7 | Plan/自动/完全自动挂 Work；不与 Chat 并列 | 02, ADR-0003 |
| D8 | **仅用户**可切 Chat/Work；Agent 建议+确认 | 02, ADR-0005 |
| D9 | 任意轮可切换；Work→Chat 不默认杀 worker | 02, ADR-0005 |
| D10 | Chat 硬只读：不改本地、不派看板工人 | 02, ADR-0003 |
| D11 | Work 默认不做多角色乱 @ | 02, 03 |
| D12 | 过程可见：主会话简报 + 点进子运行详情 | 06 |
| D13 | 看板主路径=会话右栏；独立大页非必须 | 06 |
| D14 | kscc 一渠多模=默认会诊池 | 05 |
| D15 | 布局先可拖分栏；mosaic 仅可选工作台 | 06 |
| D16 | 持久多 Agent 协作是独立 Rail/房间容器；普通会话只可显式创建或打开 | ADR-0007 + Agent 协作室文档族 |

---

## 4. 与代码/外部参考的对应

### 4.1 本仓库（现状）

| 区域 | 路径 | 备注 |
| --- | --- | --- |
| 角色类型 | `packages/shared/src/types/agent-role.ts` | Profile / 商店 / DEFAULT_ROLES |
| 角色商店数据 | `packages/shared/src/role-store-catalog*.ts` | 250+ agency-agents-zh |
| 看板类型 | `packages/shared/src/types/kanban.ts` | `roleId`、状态机 |
| MoA 库 | `packages/pi-core/src/moa-orchestrator.ts` | 并行参考+聚合，未接 UI |
| SubAgent 定义 | `apps/electron/.../agent/subagent-definitions.ts` | 内置 3 类 |
| Pi task 工具 | `apps/electron/.../pi/subagent-task-tool.ts` | |
| kscc 模型 | `apps/electron/.../channel/default-models.ts` | KSCC_DEFAULT_MODELS |
| AppShell | `apps/electron/.../shell/AppShell.tsx` | 浮岛壳，布局改进勿推翻 |

### 4.2 外部参考

| 来源 | 路径/说明 | 借鉴点 |
| --- | --- | --- |
| TAgent_General | `docs/plans/2026-06-30-task-kanban-orchestration-design.md` | 看板三层、SubAgent≠Worker |
| TAgent_General | `docs/plans/2026-07-16-kanban-digital-crew-ux.md` | 右栏班组、少独立大页 |
| TAgent_General | `docs/plans/2026-07-03-hermes-borrow-plan.md` | goal/judge；当时缓做完整 MoA |
| Frakio | `docs/multi-agent-collaboration.md` | chat 不碰看板；work 才编排 |
| Hermes Studio | `F:\hermes-studio` group-chat | room/member/message、独立逻辑 session、mention depth、并行扇出；不照搬服务端架构 |

---

## 5. 回溯时怎么查

| 你想知道 | 去哪 |
| --- | --- |
| 「当时为什么要 Chat/Work？」 | ADR-0003 + 02 |
| 「为什么 Agent 不能自己切模式？」 | ADR-0005 + 02 §切换 |
| 「@ 和 MoA 有啥区别？」 | 03 + 05 + 08 FAQ |
| 「主会话要不要角色？」 | ADR-0006 + 04 |
| 「kscc 怎么组圆桌？」 | 05 |
| 「看板还要不要单独一页？」 | 06 + D13 |
| 「多个独立 Agent 怎么在同一聊天室协作？」 | Agent 协作室总纲 + ADR-0007 |
| 「实现做到哪了？」 | 07 阶段勾选 + CHANGELOG |
| 「这个算不算违规组合？」 | 03 合法/禁止表 + 08 反模式 |

**修改本模块行为时：**

1. 先改/补对应 `0x-*.md` 或 ADR  
2. 更新本 README 决策表（若增删 D 编号）  
3. 实现 PR 描述里链到文档章节  
4. 禁止只改代码不改宪章（避免 1.0 文档漂移）  

---

## 6. 修订记录

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-08-02 | v1.0 | 单文件宪章 `2026-08-02-multi-runtime-chat-work-design.md` |
| 2026-08-02 | v1.1 | 拆成 multi-runtime 文档族 + ADR-0003～0006，便于回溯 |
| 2026-08-11 | v1.2 | 增补协作室独立一级容器与 ADR-0007，明确不属于普通会话模式 |
