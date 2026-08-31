# ADR-0009：融合会话采用普通会话内桥接，协作室保留独立运行时

> 状态：方向确认（2026-08-31）
> 相关决策：[ADR-0007](./ADR-0007-agent-collaboration-room.md)
> 实施规格：[16-FUSION-ORCHESTRATION-HARDENING-SPEC](../plans/agent-collaboration-room/16-FUSION-ORCHESTRATION-HARDENING-SPEC.md)

## 背景

TAgent 当前已经完成了单会话到协作室的桥接：普通会话可以显式添加多个 Bot，
用户确认后进入融合协作壳，退出时把结论写回原会话。这个体验比新增一套
独立聊天入口更连续，也避免普通会话、融合会话、协作室之间出现三套相似 UI。

另一方面，协作室确实拥有普通会话没有的运行时语义：

- 多成员独立逻辑会话；
- 多成员并行、成员内串行；
- A2A mailbox、因果链和深度限制；
- 任务、产物、工作区租约和恢复；
- run、attempt、continuation 和未知副作用状态。

因此，不能为了复用 UI 而把协作室退化成普通会话的一种 prompt 模式；
也不能为了运行时边界而强迫来源普通会话跳到一套割裂的新产品入口。

## 决策

### 1. 运行时独立，用户入口连续

协作室仍是独立的运行时和真值容器，沿用 ADR-0007 的 room/member/message/run/task
边界。但当协作室由普通会话显式创建时，用户入口采用同一 `sessionId` 的融合桥接：

```text
普通会话
  └─ 用户显式开启协作
      └─ 同一 sessionId 显示融合协作壳
          └─ 用户显式结束协作
              └─ 协作结论写回普通会话
```

`sessionId` 是用户连续性的身份；`roomId` 是协作运行时的身份。二者通过
`sourceSessionId` 显式关联，不能互相伪装。

### 2. 只有显式动作才升级或回退

- 添加多个 Bot 不自动开启协作。
- Agent 只能建议开启协作，不能替用户切换。
- 开启和结束均需要用户确认。
- 退出后房间保留为 `paused`，不删除历史。
- 成员减少不自动退出融合会话，只能给出可操作提示。

### 3. 融合壳复用普通会话的视觉和交互骨架

普通会话与融合协作共用：

- 会话标签和返回路径；
- 工作区/附件预览；
- 输入区和发送/停止位置；
- 消息渲染、Markdown、通知和错误反馈；
- 运行详情的渐进展开方式。

融合协作只增加必要的参与者、编排、任务和恢复状态，不增加新的一级聊天
入口，不复制一套独立 composer。

### 4. Hermes 机制进入运行时，不复制 Hermes 页面

借鉴 Hermes Studio 的机制：

- 稳定成员 ID 的结构化 mention；
- 每个成员独立逻辑 session；
- 房间共享摘要和成员上下文投影；
- 一次 run 一张安静的运行卡；
- 宿主签发 handoff/outbox/attempt；
- 运行证据、条件路由、失败重跑和恢复状态。

不照搬：

- 将 Group Chat 和 Workflow 作为两个新的一级产品入口；
- 把自由 DAG 作为普通融合会话的默认交互；
- 让 Agent 文本里的 `@` 直接成为路由协议；
- 复制 Hermes 的 provider/profile/credential/memory 全家桶。

## 运行时边界

```text
普通会话 Chat
  └─ SessionCollabBridgeService
      └─ Fusion Room Runtime
          ├─ authority / snapshot / event cursor
          ├─ member logical sessions
          ├─ scheduler / run / attempt
          ├─ mailbox / A2A / continuation
          ├─ task / artifact / workspace lease
          └─ summary / handoff
```

Renderer 只消费快照、事件和投影；调度、权限、预算、幂等和副作用判断必须留在
主进程或 `packages/core`。

## 后果

正面：

- 用户始终感觉自己在同一个会话里工作；
- 融合会话可以逐步增强，不必再设计第二套聊天体验；
- 协作室的复杂运行时状态仍然有独立边界；
- Codex、Claude Code/kscc、Pi 等异构后端可以共享同一编排管线。

代价：

- Chat 需要根据 `fusionRoomId` 切换协作壳；
- 需要维护普通会话与 room 的进出桥接、摘要和回写；
- 同一页面内必须清楚区分 session 消息和 room 运行证据；
- 独立创建、无来源会话的协作室仍需要保留房间列表和管理入口。

## 验收标准

1. 普通会话开启协作后，用户不需要学习第二套聊天入口。
2. 协作期间不会出现原普通会话与融合壳双重可写入口。
3. 结束协作后，原会话能看到结构化 handoff，并能通过 `roomId` 回看房间。
4. 失败、取消、重启和重复点击不会生成重复运行或重复副作用。
5. 用户可以在一个融合壳中看懂“谁在做、在等谁、结果是什么、如何继续”。
