# 多用户融合会话与 Bot：实现记录

> 规则：本文件按时间追加，不删除历史结论；每次实现、代理协作、测试和阻塞都记录证据。
> 主规格：[06-MULTIUSER-FUSION-IMPLEMENTATION.md](./06-MULTIUSER-FUSION-IMPLEMENTATION.md)

## 记录格式

每条记录尽量包含：日期、范围、操作者/代理、读取或修改的文件、命令和结果、决策、风险、下一步。代理只做只读分析时也要记录，避免重复调查；代理修改代码时必须记录精确文件和验证命令。

## 2026-08-20：启动长期实现模块

### 用户确认的目标

- 将普通会话和融合会话收敛到一个会话入口。
- 0 Bot 保持普通会话；1 Bot 直接对话；第 2 个 Bot 加入后启用默认协调者、@ 路由、任务和 Bot 间协作。
- Bot 是长期身份，房间内加入的是 Bot 的席位/配置副本；席位有独立场景上下文和运行生命周期。
- Bot 拥有可持续整理的长期记忆；候选记忆必须先落盘，用户确认后才进入 Prompt。
- 正式会话中的临时 @ Bot 使用可关闭、最小化、拖拽和缩放的侧窗；侧窗通过桥接向主会话提交提案，不能直接写公共时间线。
- 多用户房间使用服务端权威工作区；个人文件明确共享后才进入工作区；产出先通过下载回到用户本机。
- Bot 服务和费用归属 Bot 所有者，但房间策略、任务范围和资源所有者授权共同决定有效权限。
- 长期实现需复用现有协作室能力，并保留清晰的文档和实施证据。

### 已确认的本地 KSCC 模型

来源：用户提供的 KSCC `/model` 选择界面；模型名不是推测。

| 模型 | 最大 token limit | 备注
| --- | ---: | --- |
| deepseek-v4-flash | 1,024,000 | 已用 CLI 最小探针验证可调用
| glm-5 | 200,000 | 选择器可见
| glm-5.1 | 200,000 | 选择器可见
| glm-5.2 | 1,024,000 | 用户截图中当前选中；后续架构复核首选
| kimi-k2.5 | 256,000 | 选择器可见
| kimi-k2.6 | 262,000 | 选择器可见
| kimi-k3 | 1,024,000 | 选择器可见
| mimo-v2.5 | 1,024,000 | 选择器可见
| mimo-v2.5-pro | 1,024,000 | 选择器可见

验证命令（只读、无工具、无 session 持久化）：

    kscc -p --model deepseek-v4-flash --no-session-persistence --tools "" --effort low --output-format text --max-budget-usd 0.5 "只回复 DEEPSEEK_MODEL_OK，不读取或修改文件。"

结果：输出 DEEPSEEK_MODEL_OK，退出码 0。较长的代码库审计在低预算下触发 Exceeded USD budget，因此后续代理任务必须拆成单文件/单问题、短输出和明确预算。

### 代理协作记录

| ID | 代理/模型 | 范围 | 模式 | 结果 | 状态
| --- | --- | --- | --- | --- | --- |
| A-001 | deepseek-v4-flash | 只读审阅 packages/shared/src/types/collaboration-room.ts，限制 500 字 | CLI | 发现现有 Room/Member/Task/host tools；缺 HumanMember、解耦 RoomBotSeat、独立 RoomWorkspace | 已完成
| A-002 | glm-5.2 | 复核 06 主规格与共享类型，提出迁移兼容的类型切片 | CLI | 待执行 | 待执行
| A-003 | deepseek-v4-flash | 为第一切片设计测试矩阵/fixture，不改代码 | CLI | 待执行 | 待执行

### A-001 摘要

现有 collaboration-room.ts 已有：四态房间、预算、maxConcurrentRuns、maxA2ADepth、a2aHandoffEnabled、coordinatorMemberId、attachedBoardId、summaryEveryUtterances；CollaborationMember 已有 backend、roleSnapshot、capabilities、permissionProfile、isCoordinator、mentionAliases；RoomTask 有严格状态迁移和 version CAS；host tools 已包含 room task、artifact、workspace。

缺口：没有 HumanMember/online 状态；当前成员与 Bot 配置耦合，缺 seatId 和 BotProfile 引用；只有 workspaceId 可选字段，没有 RoomWorkspace 的 id/rootPath/kind 等验证契约。

## 当前仓库基线

已存在并应复用：

- packages/shared/src/types/collaboration-room.ts
- packages/shared/src/types/collaboration-a2a.ts
- apps/electron/src/main/lib/collaboration/
- 现有 room multi、artifact、approval、A2A、workspace 测试
- apps/electron/src/main/lib/ipc/session-service.ts
- apps/electron/src/main/lib/memory/memory-consolidation-service.ts
- 现有 renderer 会话、Dock 和协作室组件

工作区在启动时已有用户修改，当前阶段不清理、不回滚、不覆盖无关改动。实现代理必须先读取相关 diff，避免把用户正在做的 memory、scroll、dock 和 Chat 改动当成基线删除。

## 切片追踪

| 切片 | 目标 | 负责 | 代码文件 | 测试 | 状态
| --- | --- | --- | --- | --- | --- |
| A | 领域类型与旧数据兼容读取 | 主 agent + GLM 复核 | 待定 | shared type/schema tests | 未开始
| B | BotProfile/revision/memory candidate-active | 主 agent | 待定 | memory tests | 未开始
| C | 1 Bot 融合路径复用普通 Agent | 主 agent | 待定 | session routing tests | 未开始
| D | 多 Bot Router/coordinator/A2A | 主 agent + DeepSeek 测试设计 | 待定 | routing/task/mailbox tests | 未开始
| E | 多用户/owner consent/ACL | 主 agent | 待定 | permission tests | 未开始
| F | RoomWorkspace/lock/SHA/download | 主 agent | 待定 | workspace concurrency tests | 未开始
| G | Sidecar/bridge IPC/UI | 主 agent | 待定 | bridge and renderer tests | 未开始
| H | KSCC/Pi adapter/fencing/recovery | 主 agent | 待定 | adapter contract tests | 未开始

## 决策变更记录

| 日期 | 决策 | 原因 | 影响
| --- | --- | --- | --- |
| 2026-08-20 | 不把 Bot 设计为永久 KSCC session | 一个 Bot 要并行参与多个场景，且 KSCC session 可压缩/重建 | BotProfile、AgentSession、Run 分层
| 2026-08-20 | 1 Bot 与普通会话走同一执行路径 | 减少用户配置和运行时分叉 | 第二个 Bot 才启用 Room 调度
| 2026-08-20 | 普通会话升级采用派生 RoomSession | 保护原私聊上下文和私有文件 | 需要共享内容选择/摘要迁移
| 2026-08-20 | 公共时间线由宿主唯一写入 | 防止侧窗、Agent loop、Bot 直接越权插入 | bridge proposal + schema gate
| 2026-08-20 | 服务端 RoomWorkspace 为权威产出位置 | 多用户必须有共同实际文件位置 | 成员通过下载获得本地产出
| 2026-08-20 | 默认短锁 + expected SHA，复杂任务用副本/worktree | 兼顾低冲突协作与多文件长任务 | 需实现 conflict/merge 审计

## 实施纪律

1. 先补类型和 contract tests，再接 UI。
2. 每个新 IPC 都要有调用者身份、room/seat/task 作用域和失败分支。
3. 所有跨用户、跨 Bot、跨工作区的数据流默认拒绝，显式授权后才开放。
4. 运行中任务不因 Bot 配置更新而无声改变；权限收紧可立即生效。
5. 代码提交前执行针对性测试、typecheck/lint（若项目脚本可用）和 git diff --check。
6. 每次代理调用记录模型、预算、提示范围、输出摘要和是否改文件。

## 下一步

1. 用 glm-5.2 对 06 主规格和现有共享类型做短范围架构复核。
2. 根据复核结果确定 A 切片的最小兼容类型，不立即重构现有 room runtime。
3. 用 DeepSeek 生成 A 切片的测试矩阵，再由主 agent 编写类型/测试。
4. 完成 A 后更新本日志、06 的复选框和计划状态，再进入 B。
