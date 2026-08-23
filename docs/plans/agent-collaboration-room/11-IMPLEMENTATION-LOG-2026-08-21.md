# 实施记录：Bot 配置与长期记忆持久化

> 日期：2026-08-21
> 主规格：[06-MULTIUSER-FUSION-IMPLEMENTATION.md](./06-MULTIUSER-FUSION-IMPLEMENTATION.md)
> 前置记录：[09-IMPLEMENTATION-LOG-2026-08-20.md](./09-IMPLEMENTATION-LOG-2026-08-20.md)

## 1. 本轮起始目标（随后扩展到最小可用入口）

进入融合会话实现时，先完成 Phase A 的本地领域服务；随后在不接多人网络的前提下补上最小 Bot 库 UI、会话参与者配置和单 Bot 普通路径。

- BotProfile 长期身份和 BotConfigRevision 配置版本可落盘。
- revision 发布后不可原地修改；新配置只能追加下一个版本。
- Bot 归档保留历史 revision，保证已有房间席位仍可解释。
- Bot 长期记忆先落 candidate/active 状态边界。
- candidate 不进入 prompt，只有显式确认才能成为 active。
- 不把 RoomBotSeat、房间消息或房间私有上下文写进 BotProfile。

## 2. 已实现

### 2.1 共享契约

- `packages/shared/src/types/fusion-session.ts`
  - 新增 `BotProfileRecord`，把长期 Bot 配置与 revision 集合组成可持久化记录。
  - 新增 `BotMemoryRecord`、`BotMemoryState` 和来源场景枚举。
  - 明确 candidate 记忆不能直接注入 prompt。

### 2.2 本地路径

- `apps/electron/src/main/lib/config/config-paths.ts`
  - `getBotProfilesPath()`：`~/.tagent[-dev]/bots.json`
  - `getBotMemoriesPath()`：`~/.tagent[-dev]/bot-memories.json`

### 2.3 Bot 配置服务

- `apps/electron/src/main/lib/bot/bot-profile-service.ts`
  - 原子 JSON 存储，损坏记录 fail-closed。
  - `createBotProfile()`：必须同时绑定首个 revision。
  - `publishBotConfigRevision()`：只允许追加 `latest + 1`，自动更新 current revision。
  - `saveBotProfileRecord()`：禁止修改已有 revision 内容。
  - `archiveBotProfile()`：归档而非物理删除。

### 2.4 Bot 记忆服务

- `apps/electron/src/main/lib/bot/bot-memory-service.ts`
  - `saveBotMemoryCandidate()`：只允许新候选写入。
  - `activateBotMemory()`：唯一的 candidate → active 入口，并提升 revision。
  - `rejectBotMemory()` / `archiveBotMemory()`：候选记忆的终态处理。
  - `getActiveBotMemories()`：只返回 active，其他状态不能泄漏到 prompt 组装层。
  - AI 去重、合并、精炼尚未实现；本轮只建立安全状态边界。

## 3. 验证结果

命令：

    bun test apps/electron/src/main/lib/bot/bot-profile-service.test.ts apps/electron/src/main/lib/bot/bot-memory-service.test.ts

结果：16 pass，0 fail，33 expect。

命令：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。

## 4. 重要边界

- BotProfile 是用户长期配置；加入房间时仍需复制为 RoomBotSeat，不能把 Bot 全局记录直接当房间成员。
- revision 快照只描述身份、渠道、模型、工具能力和权限配置，不携带普通会话 transcript、房间消息或私有工作区。
- `ownerUserId` 已进入 BotProfile 和记忆记录，但本轮尚未接账户鉴权；服务层不能被误认为已经具备多用户授权能力。
- 记忆服务不自动激活任何 AI 整理结果；后续 consolidation job 必须先写 candidate，再等待用户确认。
- 现有 `dock.css` 有一处用户未提交修改，本轮保留，不纳入融合会话切片。

## 5. 下一步

1. 为 Bot 服务增加 IPC 类型和主进程注册，先实现 Bot 库只读列表、创建、归档、发布配置版本。
2. 在角色库页面增加同级 Bot 页，不重写现有角色卡页面。
3. 将单 Bot 添加入口接入普通会话的 participant 配置，单 Bot 继续复用普通 AgentSession。
4. 为 `RoomBotSeat` 增加从 BotProfile + revision 创建快照的纯函数，并接入旧 CollaborationMember 兼容读取。
5. 后续再做 candidate 记忆的 AI 整理、用户确认 UI，以及多 Bot 协调路由。

### 2.5 IPC 接线

- `packages/shared/src/types/fusion-session.ts`
  - 新增 `BOT_IPC_CHANNELS`、保存/创建/发布 revision、记忆状态迁移的输入类型。
- `apps/electron/src/main/lib/bot/bot-profile-ipc.ts`
  - 由主进程注册 Bot 配置和记忆 handler。
  - renderer 不能直接访问 `bots.json` / `bot-memories.json`。
- `apps/electron/src/main/index.ts`
  - 启动时注册 Bot IPC。
- `apps/electron/src/preload/index.ts`、`apps/electron/src/renderer/App.tsx`
  - 暴露并声明 Bot 库和记忆 API。

IPC 目前仍是本地 Desktop 边界；ownerUserId 已随数据传递，但账户鉴权和多用户授权尚未实现，不能把这些 handler 当成服务端权限层。

## 6. 本轮继续实现：Bot 库与会话参与者

### 6.1 Bot 库入口

- 角色库新增同级「Bot 库」页，保留原有角色卡页，不把角色卡强行改造成 Bot。
- Bot 页支持创建、查看当前 revision、查看长期记忆、归档 Bot。
- 创建时必须绑定一个角色快照和首个 revision；当前页面先复用本地默认角色，后续补完整的角色选择、渠道、模型和工具能力编辑器。
- 归档不是删除：历史 revision 和记忆仍保留；已经加入会话的 Bot 会显示「已归档」，用户可以从该会话移除或替换。

### 6.2 普通会话融合入口

- `AgentSessionMeta.botProfileIds` 保存会话对 BotProfile 的引用。
- Chat 输入框顶部增加 Bot 参与者条，普通会话仍使用原入口和原消息流，只多一个「加入 Bot / 管理」操作。
- 0 个 Bot = 普通会话；1 个 Bot = 单 Bot 直连；2 个及以上 = 保存为融合参与者配置，等待 RoomSession 多 Bot 路由接管。
- 主进程会对 Bot ID 列表去空、去重，不能由 renderer 直接写本地 Bot 文件。

### 6.3 单 Bot 双核注入

- 新增 `bot-session-prompt.ts`，从 BotProfile 当前 revision 读取角色快照，从 BotMemoryService 只读取 `active` 记忆。
- candidate、rejected、archived 记忆永远不会进入 prompt；长期记忆与当前用户要求冲突时以当前用户要求为准。
- KSCC 使用既有 `systemPrompt.append`，Pi 使用既有 `systemPromptAppend`；因此单 Bot 不需要另起一套 agent loop。
- 多 Bot 暂时只注入诚实的等待边界，不伪装普通 Agent 已经具备协调者能力；下一阶段接入 RoomSession、默认协调者和 Bot 间工作流。

## 7. 本轮验证

命令：

    bun test apps/electron/src/main/lib/bot

结果：19 pass，0 fail，39 expect。

命令：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。

## 8. 当前明确未完成项

1. Bot 创建页仍是第一版：角色选择、Bot 专属 channel/model、工具能力编辑和配置 revision 发布 UI 需要补齐。
2. 多 Bot RoomSession 尚未启动：默认协调者、@ 指定承接、Bot 间协调消息、替换/删除席位快照、多人访问授权仍未接入。
3. 悬浮 Bot sidecar、桥接 IPC、bot-chat 独立会话以及 AI 记忆整理/精炼任务仍未实现。
4. 当前 ownerUserId 仍是本地数据字段，不等于账户授权；服务端 Bot 归属、费用扣除和多用户工作区隔离需要后续服务端切片。

## 9. 本轮继续实现：RoomBotSeat 快照

- `createRoomBotSeatFromProfile()` 已加入 shared 融合契约。
- 加入房间时读取 Bot 的 current revision，并复制 displayName、roleSnapshot、backend、channel/model、permission 和 capabilities。
- roleSnapshot 与 capabilities 做深拷贝；后续 Bot 库发布新 revision、归档或修改内存，不会无声改写已有席位。
- 已归档 Bot 禁止加入新房间，但已经存在的历史席位仍可解释；用户需要通过会话/房间操作显式移除或替换。
- `id`、`roomId`、`logicalSessionId` 和 `createdAt` 由 RoomSession 创建方提供，避免领域函数自行生成不可追踪的运行时 ID。

验证：shared 融合测试 8 pass，0 fail；全工作区 typecheck 通过。

## 10. 下一块实现顺序

1. 把 `createRoomBotSeatFromProfile()` 接到现有协作室成员创建/替换流程，旧 CollaborationMember 继续兼容读取。
2. 建立 `RoomSession` 的单 Bot / 多 Bot participant runtime，默认第一个 Bot 为 coordinator。
3. 实现未 @ 指定时 coordinator 承接、@ Bot 定向承接、Bot→Bot 协调消息不直接冒充用户消息。
4. 再接入 sidecar 悬浮窗、桥接 IPC 和长期记忆 candidate 生成/整理。

## 11. 全量回归

命令：

    bun run test

结果：179 个测试文件通过，2195 个测试通过，0 fail。

## 12. 本轮继续实现：接入现有协作室成员流程

- `CollaborationMember` 增加可选 `botProfileId` 和 `configRevisionId`，旧成员数据无需迁移即可继续读取。
- 创建房间初始成员、向已有房间追加成员时，如果输入带 `botProfileId`，主进程读取 Bot 当前 revision 并投影为成员快照：
  - displayName / roleSnapshot
  - backend / channelId / modelId
  - permissionProfile / capabilities
  - configRevisionId
- 这条桥接复用现有成员持久化、@ 提及解析、协调者、RoomScheduler、A2A mailbox 和工具权限，不另造一套成员运行时。
- 空房间追加第一个 Bot 时自动设置为 coordinator；第二个 Bot 保持普通成员。创建房间时仍由现有房间协调者解析逻辑保证第一个成员兜底。
- 已归档 Bot 不能加入新房间；已落盘成员保留自己的 revision 快照，不会因 Bot 库后续发布而变化。

验证：

    bun run test -- apps/electron/src/main/lib/collaboration/collaboration-room-bot.test.ts

结果：2 pass，0 fail。

## 13. 当前边界

当前协作室运行时仍以兼容的 `CollaborationMember` 作为执行行，`RoomBotSeat` 是规范模型和快照构造函数；后续如果服务端多人化，需要把这层兼容投影迁移到独立 seat 表，并加入 owner 授权、费用归属和远端工作区访问控制。

## 14. 本轮继续实现：协作室 UI 入口

- 现有「添加成员」Popover 增加 Bot 选择器，和普通成员入口共用，不新增第二个房间入口。
- 选择 Bot 后显示快照提示，并锁定角色/渠道/模型表单；这些字段由 Bot 当前 revision 决定，避免用户误以为正在修改房间副本。
- 提交后沿用现有 `addCollaborationMember` IPC；未选择 Bot 的路径和旧 UI 行为不变。
- 归档 Bot 不出现在新加入列表；历史房间成员仍保留已复制的快照字段。

验证：协作室 Bot 集成测试与原协作室持久化测试共 12 pass，0 fail；全工作区 typecheck 通过。

## 15. 本轮继续实现：协作室成员移除与 Bot 替换

- 成员删除采用软删除：CollaborationMember.status = 'removed'，写入 removedAt，保留历史消息、run 和 Bot 加入时的 botProfileId/configRevisionId 快照。
- 已移除成员从文本 @、结构化 mention、@all 和无 @ 默认协调者路由中排除；历史时间线仍可读取。
- 删除 queued/running 成员前会先取消对应 run；删除协调者后，最早的剩余成员接任；没有剩余成员时房间协调者为空。
- 替换不是修改旧成员，而是先移除旧成员、再新增一个成员 ID 和新的 Bot revision 快照，避免历史执行上下文被改写。
- 协作室成员设置面板增加确认后的「移除成员」入口，已移除成员以灰度状态保留在审计视图；@ 列表和渠道可用性提示不再包含它。

验证：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。

    bun run test -- packages/shared/src/types/collaboration-room.test.ts apps/electron/src/main/lib/collaboration/collaboration-room-bot.test.ts

结果：55 pass，0 fail。

## 16. 本轮继续实现：Bot sidecar 第一切片

- 普通会话中点击已加入 Bot 芯片，会在当前会话主列内打开可拖拽、可调整大小的悬浮面板；不新增页面入口。
- 面板支持关闭、收起为吸边球、恢复；生命周期由主进程 bot-sidecar-service 登记，重开同一会话/同一 Bot 复用 sidecar ID。 会话切换或组件卸载时主动关闭登记，避免隐藏状态残留。
- 面板读取 Chat 当前已加载的主会话最近内容，展示 Bot 当前职责和可用分析上下文。
- 用户点击「交给主会话」时，先调用 SIDECAR_BRIDGE_REQUEST 做 sidecar/session/Bot 归属校验，再调用现有 steerAgent IPC 把建议交给正式会话 Agent；旁路文本不会直接写入主时间线。
- 当前明确边界：独立 Bot session 和流式分析已经接入，但 Bot 之间的多 Bot 协调、自动上下文摘要和候选记忆整理仍未完成；正式写入仍必须经过桥接后由主会话 Agent 承接。

验证：

    bun run typecheck

结果：全工作区通过。

    bun run test -- apps/electron/src/main/lib/bot/bot-sidecar-service.test.ts apps/electron/src/main/lib/collaboration/collaboration-room-bot.test.ts packages/shared/src/types/collaboration-room.test.ts

结果：57 pass，0 fail。

全量回归（本轮变更后）：180 个测试文件、2199 个测试通过，0 fail。

## 17. 本轮修复：Bot sidecar 交互与主题对齐

- 修复标题栏 pointer capture 吞掉右侧按钮点击的问题：现在只有标题拖拽区负责移动，最小化和关闭按钮属于独立控制区。
- 修复拖拽偏移：拖拽位移按 Bot 面板的 offsetParent 定位容器换算，不再把 viewport 坐标直接写入局部绝对定位坐标。
- 吸边球区分点击与拖拽：点击恢复 Bot 窗口，实际拖动只移动位置，不误触发恢复。
- 小窗根面板和吸边球接入现有 session-glass-surface / session-glass-popover 以及 surface token；移除 Bot 小窗自建的浅色/深色背景、边框、阴影和 primary 实色，确保跟随用户主题、材质和明暗模式。
- 这次“关闭”只关闭 sidecar UI 登记，不删除 Bot 的长期配置、记忆或隐藏专属 session；“最小化”只切换为吸边球，恢复时复用原有 sidecar/session 身份。

验证：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。

    bun test apps/electron/src/main/lib/bot/bot-sidecar-service.test.ts

结果：2 pass，0 fail。

    git diff --check

结果：通过；仅有 Git 关于现有文件 LF/CRLF 的提示。

## 18. 本轮修复：会话重开恢复 Bot 参与者

- Bot 参与者引用本身已经通过 UPDATE_SESSION_META 写入 agent session index；丢失发生在 renderer 重开路径：SessionRouter / Dock ChatPane 只从 localStorage 的 TabItem 拼装 SessionMeta，而 TabItem 只保存标题、工作区、渠道和模型。
- 新增 usePersistedSessionMeta：会话页面挂载或切换时从 listSessions 回读主进程持久化元数据，并以 sessionId 防止异步回写到错误会话。
- 普通标签和分屏 ChatPane 都将回读的 botProfileIds 传给 Chat；关闭 tab、重新打开、应用重启后均能恢复已加入 Bot。
- 不把 Bot 成员塞入 tab 缓存作为唯一来源，避免会话配置和 UI 打开状态发生双份事实源；Bot 库长期配置仍由 BotProfile 独立持久化。

验证：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。

    bun run test -- apps/electron/src/main/lib/agent/session-store.test.ts apps/electron/src/main/lib/bot/bot-sidecar-service.test.ts

结果：2 个测试文件、17 tests 通过，0 fail。

## 19. 本轮修复：Bot 选择 Popover 关闭与锚点跳位

- 加入或移除 Bot 保存成功后立即关闭 Popover；保存失败时保留弹窗并继续提示错误。
- 关闭时机放在 updateSessionMeta 成功之后，避免用户看到已选状态但实际未落盘。
- 修复后不会因触发按钮文案在“加入 Bot”和“管理”之间变化而重新测量并跳到另一侧。

## 20. 本轮修复：Bot 小窗分析结果未显示

- 根因：小窗最初按旧的 payload.event.type = "text_delta" 结构监听流事件，但当前双核统一 IPC 使用 payload.kind：KSCC 可能发 stream_text_delta，Pi 主要发累计的 sdk_message，结束和错误才位于 tagent_event.event。
- 修复：BotSidecarPanel 同时解析 stream_text_delta、sdk_message、tagent_event.turn_end 和 tagent_event.session_error；累计快照整体替换，增量事件按 suffix 追加，并过滤非 assistant 消息。
- 影响：点击「分析」后，KSCC/Pi 的 Bot 输出都会显示在小窗「Bot 分析结果」区域；错误会显示在小窗底部提示，不再出现请求已发出但界面无反馈的情况。

验证：

    bun run typecheck

结果：全工作区通过。

## 21. 本轮调整：Bot 小窗改为独立聊天区

- 原来的小窗是“主会话上下文预览 + 单次分析表单”，不具备连续对话的视觉和交互语义。
- 改为独立 Bot 消息流：用户消息和 Bot 回复使用左右气泡区分，消息区独立滚动，底部固定输入框支持 Enter 发送、Shift+Enter 换行。
- 主会话内容收进可展开的上下文条，只作为 Bot 的参考来源，不再占据聊天正文区域。
- 保留“交给主会话”作为旁路桥接动作；发送给 Bot 的内容仍通过隐藏 Bot session 运行，不直接写入主会话时间线。

验证：

    bun run typecheck

结果：全工作区通过。

## 22. 本轮调整：Bot 模型、Composer 和 Markdown 对齐

- Bot 旁路隐藏 session 的渠道和模型来自 Bot 当前生效的 config revision（revision.channelId / revision.modelId），不是主会话当前模型；小窗上下文条显示该模型。
- 输入区复用主会话的 chat-input-glass、composer-editor、composer-footer-bar 和主题按钮状态，不再使用单独的实心“分析”按钮样式。
- Bot assistant 消息改用 @tagent/ui MessageResponse，复用主会话的 GFM、数学、代码块和富内容 Markdown 渲染链路。

验证：

    bun run typecheck

结果：全工作区通过。

## 23. 本轮修复：Bot 默认模型与聊天动作语义

- 角色库创建的 Bot revision 允许暂不填写渠道和模型；打开 Bot 旁路时，优先使用 Bot revision 的显式配置，否则继承当前主会话实际生效的渠道和模型。这样新建 Bot 可以直接对话，显式配置过的 Bot 仍使用自己的模型。
- 小窗底部的“发送给 Bot”和“交给主会话”是两个不同动作：前者发送一条 Bot 独立会话消息，后者把 Bot 当前建议通过已有桥接校验后交给主会话 Agent；两者使用不同图标。
- Bot 对话提示词改为普通消息语义，不再把每条输入包装成一次性“分析任务”。

验证：

    bun run typecheck

结果：全工作区通过。

    bun run test -- apps/electron/src/main/lib/agent/session-store.test.ts apps/electron/src/main/lib/bot/bot-sidecar-service.test.ts

结果：通过。

## 24. 本轮修复：Bot 小窗输入区层级

- 根因是通用 Textarea 默认边框、主题 chat-input-glass 外框和原生 resize-y 同时生效，形成双边框、双缩放手柄和底栏错位。
- Bot 输入框现在只保留主题输入容器的外框，Textarea 使用透明无边框样式；移除原生 textarea 缩放，保留 Bot 窗口自身的调整大小能力。
- 底栏拆分为左侧模型/状态信息和右侧“交给主会话”/“发送给 Bot”操作区，沿用现有主题 token 和通用按钮，不创建新的视觉体系。

验证：

    bun run typecheck

结果：全工作区通过。

## 25. 本轮调整：Bot 小窗输入密度

- Bot 小窗输入区不再直接沿用主会话的宽松输入密度；字体收紧为 11px、最小高度 44px、较小内边距和圆角，底栏按钮统一为 10px/24px 控件。
- 模型显示保留短模型名，完整来源仍通过 title 可查看，避免在窄小窗中挤压操作区。

验证：

    bun run typecheck

结果：全工作区通过。

## 26. 本轮实现：Bot 运行配置

- Bot 库详情新增“运行配置”区：渠道支持“跟随使用它的会话”或指定已启用渠道；指定渠道后可选择该渠道的具体模型或渠道默认模型。
- 保存通过既有 publishBotConfigRevision IPC 追加新的不可变 revision，旧 revision 和已经加入房间的 RoomBotSeat 副本不被修改。
- sidecar 运行时语义同步：Bot 明确配置模型时使用 Bot 模型；Bot 明确配置渠道但未配置模型时使用该渠道默认模型；Bot 未配置渠道时才继承打开它的主会话模型。
- 新建 Bot 后自动打开详情并初始化“跟随会话”状态；创建表单文案明确运行配置位于 Bot 详情。

验证：

    bun run typecheck

结果：全工作区通过。

    bun run test -- apps/electron/src/main/lib/bot/bot-profile-service.test.ts apps/electron/src/main/lib/bot/bot-sidecar-service.test.ts

结果：10 tests 通过，0 fail。

## 27. 本轮继续实现：普通会话 Bot 融合路由与 @ 入口

- 扩展 `packages/shared/src/types/fusion-routing.ts`：普通会话沿用协作室的稳定路由规则。
  - 0 个 Bot 保持普通会话。
  - 1 个 Bot 直接作为当前对话对象。
  - 多个 Bot 由加入顺序中的第一个 Bot 作为默认协调者。
  - 用户 `@` 当前会话已加入的 Bot 时，按 BotProfile id 定向承接；未加入或不可用目标不改变默认协调者。
  - 协调者被移除后，剩余列表的第一个 Bot 自动接任，不依赖随机 id 或内存状态。
- 普通会话输入框复用既有 MentionPicker，不增加新的 Bot 入口；当前会话中的 Bot 与角色一起显示，但 Bot 额外显示 `Bot` 标签。
- 角色 followMode、`pendingMentionRoleIds` 和角色系统提示词只接收角色提及，Bot 提及不会污染角色跟随状态。
- KSCC 与 Pi 的 `buildBotSessionPromptAppend` 现在读取本轮 prompt，生成明确的默认协调者/显式 Bot 路由说明，并注入各 Bot 的职责与 active 长期记忆。
- 当前阶段采用诚实的“协调者承接”边界：主会话只输出一条协调后的正式答复，不伪造其他 Bot 已经发言、调用工具或完成工作；真实 Bot→Bot 独立执行仍待后续融合执行通道。

验证：

    bun test packages/shared/src/types/fusion-routing.test.ts

结果：8 pass，0 fail。

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。
## 28. 本轮继续实现：多 Bot 顾问执行链

- `SessionService` 在主用户消息落盘后识别当前会话的多个有效 Bot；单 Bot 和普通会话完全不进入这条路径。
- 当前路由目标由共享 `resolveSessionFusionRoute()` 决定：无 @ 使用第一个 Bot 作为协调者，有 @ 使用当前会话中被点名的 Bot；被归档/不存在的 Bot 不参与路由。
- 非当前承接 Bot 使用稳定的隐藏 session id `fusion_bot_<主会话>_<bot>`，每个 Bot 复用自己的隐藏持久上下文，并按 Bot revision 的 channel/model 运行；未显式配置时沿用主会话渠道和模型。
- 顾问先输出内部报告，正式主会话再把报告作为受控上下文交给协调者；报告不会直接写进主会话时间线，也不会伪装成用户可见的独立 Bot 气泡。
- 顾问超时或失败会转成内部失败说明交给协调者，主会话仍可继续回答；等待器在 turn_end/session_error 时释放，避免隐藏会话永久挂起。
- 当前仍不是完整的 Bot→Bot 实时 mailbox：顾问阶段是“并行独立分析 → 协调者收口”，后续可在此基础上增加工具委派、阶段性回传和可见的协作事件卡。

验证：

    bun run typecheck

结果：shared、core、pi-core、ui、electron 全部通过。