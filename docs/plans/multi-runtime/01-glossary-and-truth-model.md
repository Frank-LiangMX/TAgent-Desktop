# 01 — 名词表与真值模型

> 所属：[multi-runtime](./README.md)  
> 关联：ADR-0004、ADR-0006  

---

## 1. 为什么先定名词

1.0 与跨项目借鉴里，同一词被不同含义使用：

- 「Agent」= 主会话 / 子代理 / 工人 / 渠道 profile  
- 「圆桌」= MoA 并行 / @ 群聊 / 看板多角色  
- 「员工」= UI 隐喻 / 真子会话 / 角色定义  

本文件是**唯一正名**。实现与 UI 文案应对齐此表；冲突时以本文件 + ADR 为准。

---

## 2. 正名表

| 中文 | 英文/字段建议 | 定义 | 反例（不要当成…） |
| --- | --- | --- | --- |
| SOUL / 默认人格 | soul, global identity | 主会话身份、语气、红线；模式级、宜稳定（利于 cache） | 某个工种的长 prompt |
| 角色 | Role / `AgentRoleProfile` | 岗位能力契约：prompt、modelPool、权限倾向、工具倾向 | 正在跑的进程 |
| 主会话 | main session | 用户打开的对话；调度长/总助 | 默认的 coder |
| 执行模式 | `executionMode` | `chat` \| `work` | permission 的某一档 |
| 权限模式 | `permissionMode` | Plan / 确认 / 自动 / 完全自动等 | Chat/Work 本身 |
| SubAgent | subagent / task tool | 会话内短命委派；结果回父 | 看板工人 |
| 看板 | kanban board | 长任务容器；SQLite 状态机 | 聊天分组 |
| 任务 | `KanbanTask` | 工单行；可有 `roleId`、依赖、状态 | 一次 @ |
| Worker | kanban worker | 执行任务的 headless 子会话载体 | 角色定义 |
| MoA / 会诊 | MoA / roundtable(deliberate) | 同题多席并行作答 → 汇总 | 用户插话的群聊 |
| @ 讨论 | mention / multi-speaker chat | 同时间线点名角色发言；用户在场 | 自动派工 |
| 子运行 | ChildRun / `runId` | 可展示进度的一次附属执行 | 必须等于侧栏会话 |
| 班底 | Crew / template | 预置角色+模型组合（看板链或 MoA seats） | 单个 Role |
| 对话跟随 | followMode | @ 后下一条是否仍由该角色接 | 切换 executionMode |

---

## 3. 真值四元组（禁止合并）

协作系统里任何「谁在干什么」必须能拆成：

```
roleId          身份：会什么（角色库）
taskId?         工单：要交付什么（仅看板）
sessionId?      演员：哪个会话在跑（worker / 物化续聊）
runId?          短命运行：subagent / moa-seat 的一次执行
activeSpeaker?  对话路由：Chat 里当前默认谁回（总助或 follow 角色）
```

### 3.1 映射示例

| 场景 | roleId | taskId | sessionId | runId | activeSpeaker |
| --- | --- | --- | --- | --- | --- |
| 普通 Chat 闲聊 | — | — | 主会话 | — | 总助 |
| `@架构师` 一轮 | architect | — | 主会话 | 可选 | 架构师（本轮/follow） |
| SubAgent 探索 | explorer | — | 主或 ephemeral | R1 | 主会话 |
| MoA 三席 | 各席 role | — | — | R2,R3,R4 | 主会话展示卡 |
| 看板工人 | coder | t_01 | worker 子会话 | — | — |
| AI Office 形象 | roleId | task.id | assigneeSessionId | — | — |

General 1.0 AI Office 后期结论：**task=assignment，session=actor，role=identity**。Desktop 直接采用，禁止再引入「幽灵花名册员工」作为状态真值。

---

## 4. 分层架构（逻辑，非包结构）

```
┌──────────────────────────────────────────────────────────┐
│  L0  SOUL + 全局记忆注入（主会话身份与事实）                 │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  L1  executionMode = chat | work                          │
│      +（work 时）permissionMode                           │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  L2  角色库 Role Registry（契约）                          │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  L3  调度语法                                              │
│      @mention | SubAgent | MoA | Kanban                   │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  L4  运行时绑定 AgentRunRequest                            │
│      purpose + role + model + tools + approval + session  │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│  L5  双核适配（kscc / Pi）— 见 ADR-0001                     │
└──────────────────────────────────────────────────────────┘
```

L3 不得跳过 L1（例如 Chat 下 L4 不得打开写工具）。  
L4 是三种机制的共享内核；L3 是编排差异。

---

## 5. 与「员工」隐喻

| 隐喻用法 | 允许 | 真值落在 |
| --- | --- | --- |
| UI：班组墙、工牌、在岗 | ✅ | task + role + session |
| Chat：@ 某同事发言 | ✅ | activeSpeaker + role |
| 认为角色库条目=常驻进程 | ❌ | — |
| 认为 @ 即创建 worker | ❌ | — |

Frakio「每个 Agent 是员工」在 **Chat 路由** 层可借鉴；**Work 状态机** 仍以看板 task 为准。

---

## 6. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版，从总讨论抽出 |
