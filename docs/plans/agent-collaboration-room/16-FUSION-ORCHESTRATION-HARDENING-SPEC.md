# 融合会话与协作编排加固规格

> 日期：2026-08-31
> 状态：下一阶段开发真源
> 上位决策：[ADR-0009](../../decisions/ADR-0009-fusion-session-bridge-and-orchestration.md)
> 相关实现：[14-SESSION-COLLAB-BRIDGE-SPEC](./14-SESSION-COLLAB-BRIDGE-SPEC.md)
> Hermes 机制参考：[04-HERMES-BORROW-SPEC](./04-HERMES-BORROW-SPEC.md)

## 1. 产品定位

TAgent 的核心竞争力不是“给 kscc 套一个 UI”，而是：

> **在一个会话里融合 Claude Code/kscc、Codex、Pi 等异构 Agent Runtime，
> 由宿主负责协作、编排、工作区、恢复和交付。**

因此，融合会话不是普通会话的替代品，也不是第三种孤立聊天模式，而是普通
会话的可升级协作层：

```text
单 Agent 对话
  → 显式加入成员
  → 显式开启融合
  → 多 Agent 协作与编排
  → 显式结束
  → 结论回写单 Agent 对话
```

## 2. 对 Hermes Studio 的判断

Hermes Studio 的编排能力实际分为四层：

| 层 | Hermes 的做法 | TAgent 应吸收的机制 |
| --- | --- | --- |
| Runtime | Hermes/Ekko、Claude Code、Codex、Pi 由不同 adapter/bridge 执行 | 统一 `MemberBackendAdapter`，保留后端能力差异 |
| Group Chat | 成员独立逻辑 session，mention 路由，按成员投影上下文 | 稳定 member ID、结构化路由、上下文投影、摘要 |
| Workflow | 节点/边图、success/failure/always、join、循环和执行证据 | 条件路由和证据模型；默认不把自由 DAG 暴露为聊天主路径 |
| Recovery | run 状态、审批、队列、重试、停止、重启恢复 | `runId/attemptId/causationId`、continuation、outbox、幂等 |

Hermes 最值得借鉴的是状态和证据的拆分，不是页面数量。它的 Workflow 页面
适合编排模板和批量运行；它的 Group Chat 适合多成员房间；TAgent 应把两者的
机制收敛到现有融合壳中，避免用户在 Chat、融合会话、协作室、Workflow 之间
来回切换。

## 3. 当前 TAgent 已有底座

以下能力已经存在，不应再另起平行模型：

- `SessionCollabBridgeService`：进房摘要、退出 handoff、来源会话摘录；
- `FusionRoomAuthority/Host/Gateway`：房间快照、事件、ACL、幂等和恢复；
- `RoomScheduler`：房间并发、成员内串行和 FIFO；
- `CollaborationRun`：queued/running/awaiting/done/failed/cancelled/blocked；
- `attemptId`、`causationId`、mailbox delivery 和 continuation；
- `groupCollaborationTimelineItems`：成员消息按 `runId` 收成一张 run 卡；
- room task、artifact、workspace lease 和右侧工作面板；
- `fusionRoomId` 驱动的普通 Chat → 融合协作壳切换。

下一阶段的重点是把这些能力变成连贯的用户闭环，而不是继续增加实体。

## 4. 目标交互模型

### 4.1 同一会话壳

普通会话和融合协作共用会话标签、输入区、工作区和附件能力。进入融合后：

- 原普通会话不再单独可写；
- 顶部显示当前成员与协调者；
- 时间线显示用户消息、安静 run 卡、关键 A2A/审批/恢复事件；
- 工具洪水、原始协议事件和成员内部思考进入 run 详情；
- 右侧工作面板按需展开，承载任务、产物和可定位链接。

### 4.2 三个默认路由

1. **无点名**：交给协调者。
2. **结构化点名**：只唤醒指定成员，按房间并发规则并行扇出。
3. **协调者分派任务**：创建或更新 room task，明确负责人、验收标准和关联 run。

Agent 输出中的 `@名称` 不直接触发路由；成员之间必须通过宿主提供的结构化
mailbox/A2A 工具通信。

### 4.3 三种编排动作

融合壳第一阶段只暴露三种容易理解的动作：

- **并行执行**：让多个成员分别完成独立子任务；
- **协作审阅**：一个成员产出，另一个成员审阅或验证；
- **继续处理**：用户在失败、阻塞、等待回复或未知副作用状态上选择重试、
  换成员、补充信息或确认继续。

自由 DAG、循环和复杂条件先保留为内部运行时能力，等运行证据和恢复体验稳定
后，再考虑是否需要可视化模板。

## 5. 运行证据模型

每次用户可感知的编排动作都必须能回答：

| 问题 | 最小字段 |
| --- | --- |
| 谁在做 | `memberId`、backend、logicalSessionId |
| 这次是哪一轮 | `runId`、`attempt`、`fence` |
| 为什么发生 | `triggerMessageId`、`taskId`、`causationId` |
| 当前状态 | run status、mailbox delivery、continuation kind |
| 结果是什么 | 成员消息、task 状态、artifact、usage |
| 如何继续 | cancel、retry、resume、reply、换成员、结束协作 |

消息、任务、产物和 A2A 信封只能引用真实存在的 ID；renderer 不自行推导或
伪造运行状态。

## 6. 下一阶段开发切片

### P0：融合闭环验收

- 真机验收普通会话进房、协作期间切壳、退出回写；
- 覆盖重复点击、快速进退、刷新、应用重启、取消和失败；
- 保证 `sessionId` 不变、room 保留、原会话入口不双写；
- 明确断线时显示最后权威状态和可用恢复动作。

验收结果应形成一份可重复的 E2E 测试，而不是只依赖组件单测。

### P1：协调者编排体验

- 融合壳中显示当前协调者和成员后端；
- 用户可在一次输入中结构化点名一个或多个成员；
- 协调者分派任务时自动绑定 `taskId`、`runId` 和验收标准；
- 并行结果以 run 卡汇总，协调者只向主时间线输出结论；
- 用户可以从结论定位到 run、任务、产物和文件。

### P1：恢复与错误闭环

- run 卡统一显示 queued/running/waiting/blocked/failed/cancelled/done；
- 失败时提供重试、换成员、补充输入和结束协作等动作；
- `pending_approval`、`mailbox_outbox`、`blocked_run` 和 `depth_stop` 分开解释；
- 对未知副作用不自动重放，确认后使用新 `runId/fence`；
- 应用重启后恢复可观察状态，不把旧进程假装成仍在运行。

### P1：共享摘要与上下文投影稳定化

- 房间摘要只维护当前事实、决策、待办和未决问题；
- 成员看到的自己/他人消息保持 `assistant/user` 角色差异；
- 摘要失败不能阻塞主运行；
- 摘要和 handoff 保留路径、分支、commit、run/task/artifact 等精确标识；
- 原始工具日志和协议事件不进入默认主时间线。

### P2：工作区与交付质量

- Git 仓库优先支持 worktree/branch 隔离；
- 非 Git 工作区继续使用路径租约和冲突检测；
- 任务、产物、diff、验收标准形成可追溯交付链；
- 长时间线和大量 run 支持分页或虚拟化；
- 预算、并发、等待和未读状态在融合壳中可解释呈现。

## 7. 明确不做

- 不把融合会话拆成新的一级聊天入口；
- 不把普通会话所有消息复制进 room；
- 不让多个角色通过一个模型伪装成多个独立 Agent；
- 不把 `@文本` 直接当作 Agent-to-Agent 协议；
- 不以新增 Workflow 画布解决当前的融合体验问题；
- 不为了“实时感”永久驻留每个 CLI 进程；
- 不在后端能力不支持时伪造 resume、tool bridge 或结构化事件。

## 8. 阶段完成标准

用户在一个融合会话里完成以下闭环，即可进入下一轮能力扩展：

```text
用户提出目标
  → 协调者拆出两个并行任务
  → 两个不同 Runtime 分别执行
  → 结果以 run 卡回流
  → 一个成员请求另一个成员审阅
  → 用户看到等待/完成/失败状态并可操作
  → 协调者汇总结论
  → 用户能定位到任务、产物、文件和运行证据
```

不要求用户离开当前会话去打开第二个聊天产品，也不要求用户理解底层
`app-server`、CLI、HTTP、mailbox 或 adapter 的差异。
