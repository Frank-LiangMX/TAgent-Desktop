# 协作室后续开发：TAgent 与 Hermes / Ekko 对照

日期：2026-10-19。范围为继续开发现有协作室和多人融合房间。参考本地 `F:\hermes-studio` 的当前代码；此次静态检查，没有运行参考项目或协作室测试，没有修改产品代码。下文路径分别相对于两个仓库。

## 已有基础与本轮纠正

TAgent 的 `docs/plans/agent-collaboration-room/04-HERMES-BORROW-SPEC.md` 已记录点名守卫、成员上下文投影、共享摘要、交接 outbox 和安静运行卡片的借鉴。不能把这些已有能力再次列作从零开发。

`17-FUSION-SESSION-REVIEW-2026-09-02.md` 第 7 节记录了发送幂等、退出收口、失败回写保留关联、切房隔离等修复；前面的问题描述是历史诊断，不能直接当成当前仍未修复的缺陷。本轮未重新执行该记录中的测试。

本地 `CollaborationRoomService`、远程 `FusionRoomHost/Gateway` 及来源会话桥接各有实现。后续应明确每个房间的权威运行时和转换边界，避免形成用户看到同一个协作室、后台却有两套不一致状态的体验。不要求为了共享界面而合并原生会话记录。

## 当前源码确认的关键缺口

### 1. 房间执行能力不能直接等同于普通聊天三核能力

`apps/electron/src/main/lib/collaboration/collaboration-room-service.ts:408` 默认装配 `createDefaultChannelMemberStack`，运行时调用其 adapter。

`member-backend-adapter.ts:528` 的 `runTurn` 拒绝非 `channel` 后端，提示当前仅支持 Pi 和 HTTP 渠道；第 343 行默认能力声明不支持原生 resume、实时输入、工具桥及结构化事件。第 551 行的房间工具循环还要求宿主提供 handler、成员能力允许工具桥且渠道为 Anthropic messages 协议。其余路径使用文本 seat runner。

因此同样显示为一个成员，不代表它都能执行任务分派、相互询问和文件操作。普通聊天 Claude/Codex 验证不能充当协作室的三核验收。

生命周期文件还保留 Codex native resume 分支，而执行器拒绝该后端，Codex 中止兼容函数已为空实现。这至少说明能力声明、生命周期分支和实际执行路径需要对齐；不能凭 handle 的 resumeMode 推导原生恢复已可用。

建议：先做协作成员能力矩阵，覆盖渠道协议、内核、房间工具、流式事件、取消和恢复。界面按真实能力允许添加和分派；逐个接入已有三核适配器，禁止失败后静默换内核或重复发起请求。成员上下文必须按 room/seat 隔离。

### 2. 远程房间目前没有默认接通成员执行

`apps/electron/src/main/lib/collaboration/fusion-room-transport-bootstrap.ts:92`、`:129` 均明确设置 `enableDefaultMemberExecution: false`；`apps/electron/src/main/index.ts:379` 没有注入账户认证适配器。默认 fallback 拒绝访问，已有邀请 token 可提供限定身份访问。

已有 token 哈希、过期与撤销存储、房间 ACL、TLS 和网络闸门，不能说权限基础完全不存在。但这些仍未形成完整的房主建立身份、邀请加入、批准成员执行、撤销授权的用户流程。

建议：先补身份与房主控制闭环，再按显式授权装配执行桥。不能把 enableDefaultMemberExecution 简单改为 true 当成功能完成。第一版远程执行可限定为房主机器托管 Agent，来宾携带自己机器上的 Agent 作为后续独立阶段。

### 3. 远程流式传输和重连需要补实际装配

`fusion-room-execution-bridge.ts:334` 会调用可选 `onTextDelta`；默认 `fusion-room-runtime.ts` 装配执行桥时没有传该回调。这意味着现有回调接口本身不足以证明远端可见实时文字。

`packages/core/src/collaboration/fusion-room-session-adapter.ts` 已有事件游标、SSE、快照和 replay 后刷新；但 `connect()` 仅建立一次订阅，没有在订阅结束后清理句柄并自动退避重连的流程。`applySnapshot()` 也没有按版本拒绝过期快照，存在需专项验证的 HTTP 返回与 SSE 更新交错风险。本轮未动态复现该风险。

参考 Ekko 的 `packages/server/src/modules/studio/services/group-chat/stream-snapshots.ts`：每个 Agent 当前正在生成的段单独保存，重新加入房间时先恢复该段；完成消息进入存储。`sockets/group-chat.ts:4651` 有实际接入。

参考其 `agent-relay-event-sink.ts`：远程 Agent 输出携带 runId/seq，支持约 40ms 合批、单包等待确认及有界积压。这里的 ACK 是其 Agent relay 通道设计，TAgent 不必为此替换现有 SSE；可以分别在上行 Agent 通道和下行房间订阅中实现适合的限流与恢复策略。

建议：房间事件带 room/seat/run/message 身份与单调版本，实时草稿和持久消息分开管理；补连接状态、订阅结束处理、退避重连、游标恢复和快照版本检查。网络失败后可恢复读取，但副作用命令必须凭幂等键处理，不能盲目自动重试。

### 4. 邀请入口应表达操作，而不是配置传输参数

当前 `FusionRoomRemoteConnectDialog.tsx` 要求服务地址、房间 ID、可选 token，适合调试连接；还不是完整的加入房间流程。

Ekko 的 `group-chat/agent-relay-store.ts`、`controllers/group-chat-agent-link.ts` 有接入请求、房主审批、短期票据及 online/offline/revoked 的 connector 状态。值得借鉴的是这套可解释流程，不能照搬其身份或权限默认值。

建议用户流程为：房主点击邀请 → 选择来宾权限及有效期 → 对方打开邀请并确认身份 → 房主按策略批准 → 成员列表显示连接和执行状态 → 房主可撤销。添加远程 Agent 另需说明由谁运行、访问哪个工作区、使用谁的渠道额度。网络地址和证书详情进入高级诊断。

## 建议按三个可交付阶段继续

### A. 把现有本地协作室做成确定能完成任务的闭环

- 整理实际能力矩阵，修正生命周期与执行器的矛盾；先保证已支持的 Pi/HTTP 路径工具闭环，再逐核接入 Claude/Codex 房间执行。
- 保留当前普通会话进入/退出融合的产品入口，继续复用任务、产物、审批和 mailbox。
- 验收：协调者分派两个任务，A 向 B 提问并恢复，双方发布产物，协调者汇总；停止、重试及退出回写后结果可追溯。涉及文件写入的并行任务必须验证既有工作区权限和冲突保护。
- 这个阶段不能只测试两个模型各回一句话，要走实际房间工具和生产调度器。

### B. 交付两台设备可用的协作室

- 补房主身份、邀请管理、加入确认、权限撤销；复用已有 token、ACL、TLS，不另造一套存储。
- 首版由房主主机托管成员执行，明确主机离线时房间暂停或不可用。
- 接通远程实时输出、草稿快照和订阅重连，区分“已连接房间”与“Agent 可执行”。
- 验收：两台设备加入同一房间，共同查看和发送；掉线后恢复不重复执行；撤销后拒绝新访问和动作，关闭既有订阅；执行结果未知时保留未知状态，不自动重放有副作用的操作。

### C. 来宾携带 Agent 加入

- 借鉴 Ekko 的配对审批和 connector 状态，建立 Agent 所有者、房间席位、执行机器三者绑定。
- 接入独立的远程 Agent 事件上行、确认、去重、超时和撤销机制；凭证和私有工作区留在执行端。
- 验收：来宾机器掉线/恢复不会产生两个执行者；房主移除 Agent 后停止接收其新结果和新任务；额度主体、产物来源、可见范围明确。

本轮建议优先启动 A，并把 B 的身份与事件契约一并设计清楚。B、C 不以“打开网络开关”代替交付。自动智能路由、更多内核及更复杂的拓扑暂不作为首个协作闭环的前置条件。

## 界面目标

主区显示用户请求、成员正式回复和成果；运行卡显示执行者、当前任务、等待对象与失败原因；侧栏查看参与者、任务、文件和邀请。工具原始日志按需展开。网络诊断不占据关于页。选择态继续遵守用户偏好：圆角整行底色与左侧强调竖线不得组合使用。
