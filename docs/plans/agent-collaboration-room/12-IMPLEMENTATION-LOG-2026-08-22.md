# 融合会话实施记录 · 2026-08-22

> 目标：持续完成统一会话、持久 Bot、融合路由、协作室复用和安全边界。
> 本记录只写已落地的用户能力、运行时契约、测试和明确阻塞，不把讨论结论当成完成状态。

## 1. 本轮已完成

### 1.1 Sidecar 场景会话隔离

- 隐藏 Bot session id 从全局 bot_sidecar_<botId> 改为稳定的 bot_sidecar_<主会话>_<botId>。
- 同一个主会话和 Bot 关闭后重开仍复用上下文；不同主会话不会共享 sidecar 对话历史。
- 既有关闭、最小化、桥接归属校验保持不变。
- 回归测试覆盖重开复用和关闭后拒绝桥接。

### 1.2 单 Bot 运行时绑定

- 普通/单 Bot 会话发送前读取 Bot 当前 config revision。
- Bot 显式配置渠道时优先使用该渠道；未配置渠道时继承当前会话渠道。
- Bot 显式配置模型时优先使用该模型；未配置模型时继承当前发送模型或渠道默认模型。
- 多 Bot 主会话不按每条 @ 动态切换主运行内核，避免 KSCC/Pi 跨核污染；新发送路径统一进入 RoomSession，旧会话首次发送时自动迁移。
- 会话 meta 最终保存实际使用的渠道和模型，重启后显示与运行一致。

### 1.3 融合模式与协调者持久化

- AgentSessionMeta 增加 fusionMode、fusionCoordinatorBotProfileId 和预留的 fusionRoomId。
- 更新会话 Bot 参与者时，由主进程派生 ordinary / single-bot / multi-bot。
- 多 Bot 默认协调者会持久化；协调者仍在参与者列表中时继续使用它，删除/替换后自动按剩余顺序接任。
- 共享 resolveSessionFusionRoute、KSCC/Pi prompt 和 RoomSession 路由统一读取该协调者。

## 2. 验证结果

- bun run typecheck：shared/core/pi-core/ui/electron 全部通过。
- 融合路由与 Bot prompt 回归：13 tests passed。
- Sidecar 回归：单独执行 2 tests passed。
- git diff --check：通过；仅有工作区既存的换行转换提示。

## 3. 尚未完成且不能假装完成

- Bot 记忆已有 candidate/active 边界；Bot 库现可将用户明确提交的笔记用本地安全整理器拆分、去重并生成候选，仍不自动进入 prompt。真正的模型整理出站调用尚未默认接入，避免未经授权发送用户笔记或源码。
- 本轮尝试让 kscc 直接读取仓库做审计时被安全层拦截，因为会把源码/用户笔记发送给指定模型服务；未绕过。kscc CLI 已确认可用，后续需用户明确授权代码或笔记向指定模型出站后再接入。
- 新的多 Bot 发送路径已经切换到可见协作室的 RoomScheduler/mailbox；旧会话在首次发送时自动幂等迁移，历史 advisor 字段仅保留兼容读取。
- 多用户远程账户、owner consent、费用归属和服务端权威 RoomSession 仍需复用/演进协作室服务；当前本地协作室已有任务、A2A、工作区和冲突控制，但尚未成为统一会话的公共真值源。

## 4. 下一批实现顺序

1. 完成协作室打包版发布闸门、消息投影回流和真实多用户 RoomSession 网络层验收。
2. 复用现有 RoomScheduler、mailbox、task、artifact、workspace lock/SHA 检查，把多 Bot 顾问链逐步替换为结构化事件链。
3. 对 Bot revision 的 permission/capabilities、owner consent、room policy 和 task scope 做运行时交集校验。
4. 在获得明确出站授权后，把模型整理器接到现有 candidate 接口；整理结果只能落 candidate，用户确认后才进入 Bot prompt。
5. 为 KSCC/Pi 增加停止、超时、重启恢复和费用归属的统一运行测试。

## 5. 多 Bot 顾问的工具/权限边界修正

- 历史 advisor 代码的权限约束仍保留为兼容层；新 RoomSession 成员直接使用主进程组装的 capabilities 快照。
- Bot revision 为 read-only 时，RoomSession 成员不会获得 workspace-write；成员工具桥仍由 capabilities 与房间工作区权限共同限制。
- Bot revision 为 workspace-write 时，仍需通过房间成员 capabilities、owner consent 和 workspace scope；不能仅凭 Bot revision 绕过主进程权限。
- 房间成员执行已经复用 RoomScheduler/mailbox；owner consent、room policy、task scope 和 resource grant 仍是独立的运行时交集校验。

## 6. 融合会话升级为协作室的第一条运行链路

- 协作室实体增加 sourceSessionId，升级后原会话仍保留，房间记录来源会话。
- 新增 collaboration-room:upgrade-from-session IPC：同一 session 重复升级会返回已有房间；少于两个 Bot、Bot 缺失或已归档时 fail-closed。
- 升级时把当前 Bot 的 config revision 物化为协作室成员快照，并沿用 fusionCoordinatorBotProfileId；Bot 库后续发布新 revision 不会静默改写既有房间成员。
- 会话 Bot 条提供“升级为协作”入口，成功后自动切换协作室页面。
- 已升级会话发消息时复用 CollaborationRoomService.appendUserMessage 和 RoomScheduler，不再启动普通会话 runtime；因此默认无 @ 由协作者承接，@ 点名、多成员工具、A2A 信箱、任务/产物和工作区安全继续由协作室统一处理。
- 协作室主区现已嵌入原会话标签页，复用既有时间线、Markdown、成员管理、运行卡、A2A 信箱、任务/产物工作面板与输入框；房间仍由主进程作为唯一运行真值。
- 升级后的原会话 Bot 条显示“打开协作”；直接增删 Bot 会被阻止，避免源会话成员列表与协作室加入时快照分叉。成员替换应在协作室成员管理中完成。
- 协作室在打包版仍受现有发布闸门限制，仅开发环境注册 IPC；本轮新增的内嵌视图和记忆整理已完成构建，但正式发布前仍需完成发布闸门与真实多用户网络层验收。

### 本阶段验证

- 新增来源会话持久化回归测试；当前 Bun 直接运行协作室测试时会被 Electron safeStorage 导出兼容性阻塞，待测试运行器/模块 mock 统一后复跑。
- electron typecheck 已通过；升级入口、IPC、preload 和主进程路由均通过类型检查。
- bun run build：通过；主进程、preload、Pi core 和 renderer 均完成构建。

## 7. 本轮新增：协作室内嵌与 Bot 记忆整理

- 升级后的 `fusionRoomId` 会让 `Chat` 在同一会话标签页挂载 `CollaborationRoomsPage`，不再把用户引导到另一套独立会话入口。
- 关联房间监听 `collaboration-room:changed`，消息、成员、run、任务和产物变化会刷新内嵌页面；房间输入仍通过 `CollaborationRoomService.appendUserMessage` 进入统一调度。
- 成员移除会生成短交接摘要并追加系统审计消息；协作者变化会同步源会话，成员少于两个时源会话退出 multi-bot 房间路由，历史房间保留在协作室列表。
- Bot 库新增“整理为候选”：只处理用户明确输入的笔记，做本地拆分/去重，候选必须由用户确认后才激活；没有把主会话内容或源码静默发送给外部模型。
- 房间和成员快照开始记录 `ownerUserId` / `botOwnerUserId` / `ownerConsent`；非房主 Bot 未获授权时在 run 触发前 fail-closed，不消耗该 Bot 所有者的渠道费用。真实账户邀请、网络同步和授权 UI 仍未完成。
- `bun test apps/electron/src/main/lib/bot/bot-memory-service.test.ts`：9 tests passed。
- `bun run typecheck`：shared/core/pi-core/ui/electron 全部通过。
- `bun run build`：主进程、preload、Pi core 和 renderer 全部通过。
## 8. 本轮新增：重启投影与授权时序

- 协作室 IPC 注册后的启动恢复现在分两步执行：先把遗留 queued/running/awaiting_peer run 收敛为中断或阻塞，再扫描所有包含 sourceSessionId 的历史房间，以房间成员快照重新投影来源会话的 Bot 列表、fusionMode、协调者和 fusionRoomId。
- 来源会话已经被删除时，投影会安全跳过，不会阻断其它房间恢复；房间历史和成员快照仍然保留，便于审计和手动处理。
- Bot 成员的 room member 配置副本不能通过普通成员设置原地改写 channel/model；服务端也拒绝绕过 UI 的修改。替换必须先移除旧成员，再从 Bot 库重新加入，形成新的 config revision 快照。
- 房间 run 在入队前和真正执行前各做一次 Bot 所有人授权/成员状态检查。入队后撤回授权、移除成员或状态失效时，执行前直接 fail-closed，不调用模型，并留下可见系统审计消息。
- 本轮用本机 kscc glm-5.2 做了不发送源码的抽象审阅，采纳了三条验收原则：快照与来源投影的真值关系必须明确；授权撤回要覆盖执行前 TOCTOU；无授权时不能通过投影泄露不必要的 Bot 配置。
- 验证：bun run typecheck 通过；bun run build 通过。Prettier 对四个历史上未完全格式化的文件仍给出整体格式提示，本轮没有用全文件格式化制造无关 diff。

## 9. 本轮新增：房间用户成员与 Bot 所有人授权

- 协作室房间新增持久化的 humanMembers 状态机：invited → active → left/removed；旧房间没有该字段时只派生一个 local-user 房主，不会静默增加其它权限。
- 新增邀请、接受、主动离开、房主移除和用户成员列表 IPC。发送房间消息必须由 active 人类成员发起，消息作者落盘为对应 userId。
- Bot 成员保存 botOwnerUserId 与 ownerConsent。房主可以把其它用户的 Bot 加入房间，但只有 Bot 所有人能够授权或撤回；撤回会取消该席位尚未完成的 run，执行前仍会再次读取成员快照做 fail-closed 校验，避免排队期间的授权竞态。
- 协作室头部已复用现有主题组件显示用户成员、邀请入口和 Bot 授权状态。当前桌面版的 local-user 是本地身份模拟；真实账户认证、网络邀请投递、远端服务端裁决和房主转移仍属于发布前的多用户网络层工作，不在本地 IPC 中伪造完成。
- 本轮测试：Vitest 下协作室 Bot/用户成员测试 6 项通过；Bun 直接运行 Electron 测试仍受 Electron safeStorage mock/模块环境限制，不能作为该测试的有效 runner。


## 10. 本轮新增：Bot 工具能力交集在执行适配器生效

- MemberTurnInput 现在携带主进程组装的成员 capabilities 快照。
- KSCC 工具循环、外部原生 tool-use 适配器和 KSCC 工具描述生成均检查 supportsToolBridge；成员能力为 false 时不创建工具桥，回落为纯文本执行路径。
- 这修正了“渠道支持工具 ≠ 该 Bot 房间席位被授予工具”的边界；workspace 工具仍额外受 workspaceId 与 permissionProfile 约束。

## 11. 本轮新增：房间服务工作区、产物下载与第二 Bot 自动升级

- 新建协作室现在持久化 'roomWorkspace' 元数据，并在 ~/.tagent[-dev]/collaboration/room-workspaces/<roomId>/ 下按房间创建实际服务目录及 shared/members/tasks/artifacts/audit 子目录。
- 新融合房间的 workspace_* 工具、room_publish_artifact、产物预览和下载都优先落在该服务工作区内；旧房间没有 roomWorkspace 时仍兼容原 workspaceId 个人项目目录，避免历史数据立即失效。
- 新增安全的产物下载链路：服务端再次校验房间归属、活跃用户成员、相对路径、符号链接和普通文件；Electron 主进程弹出保存对话框后才复制到用户选择的目标，渲染层不能传任意绝对路径。
- 现有主题的协作室工作面板新增“下载”按钮，下载成功后显示目标文件路径；取消保存对话框不视为错误。
- 会话中加入第二个 Bot 后，Bot 条会自动调用幂等的 upgradeFusionSessionToRoom；升级成功后打开同一会话内的协作视图，失败时保留已保存的 Bot 选择并保留“升级为协作”按钮作为重试入口。单 Bot 仍沿用普通会话运行链路。
- 本轮 bun run typecheck：shared/core/pi-core/ui/electron 全部通过。
- 本轮尝试再次调用 kscc --model glm-5.2 做抽象审查时，CLI 版本检查可用，但完整子进程被 Windows CreateProcessWithLogonW failed: 1385 拒绝；未发送源码、路径或用户数据，也未绕过该安全边界。前一轮成功的抽象审查结论仍以第 8 节为准。

### 仍未完成的边界

- 房间服务工作区已隔离并可产出；“导入个人工作区”现在通过主进程目录选择器显式复制，不能把个人目录自动当成共享真值。
- 多用户远程账户、服务端权威 RoomSession、owner consent 网络投递、费用归属与离线恢复仍未完成。
- 打包版协作室 IPC 仍受发布闸门限制；在打开前必须先完成本地融合运行链路的发布测试，不能仅删除 app.isPackaged 条件。
- 多 Bot 通过自动升级或首次发送迁移后走 RoomScheduler/mailbox；历史多 Bot 会话无需手工重建，第一次发送会幂等补建房间。
## 12. 本轮新增：显式导入工作区与最终验证

- 房间头部新增“导入个人工作区”入口，使用主进程目录选择器，不接受渲染层传入绝对源路径。
- 导入只对 active 房间的 active 人类成员开放；新房间必须有 roomWorkspace。导入内容写入房间服务目录，已有文件不覆盖，跳过 .git、node_modules、.tagent 和符号链接，单次最多 10000 个文件 / 256MB。
- 导入与产物下载都走现有主题组件和 Electron API，不新造独立样式系统。
- 本轮 bun run typecheck：全部通过。
- 本轮 bun run build：主进程、preload、Pi core、renderer 全部通过；仅保留既有动态 import 与大 chunk 警告。
- 本轮尝试启动 Vitest 时再次遇到 Windows CreateProcessWithLogonW failed: 1385，测试进程未能建立；没有把未运行的测试写成通过。此前已通过的针对性测试结果仍保留在前文。
## 13. 本轮新增：统一会话入口、旧双 Bot 迁移与发布边界

- Rail 只保留“会话”作为普通、单 Bot、融合和协作的统一入口；协作室侧栏和全局新建协作室入口不再作为第二套用户入口。
- Chat 根据会话 meta 的 fusionRoomId 在同一标签页内挂载协作工作面，普通会话添加第二个 Bot 时自动调用幂等升级；升级后继续停留在当前会话页。
- CollaborationRoomService.upgradeFusionSession 成为 UI、IPC 和运行时共用的迁移真值：读取会话 Bot 快照，创建带 sourceSessionId/roomWorkspace 的房间，投影 fusionRoomId，并保留原会话消息。
- 旧的多 Bot 会话在首次发送前已经完成用户消息主会话落盘；运行时随后只向 RoomSession 追加一次房间消息并结束主会话 turn，不重复写气泡、不再启动旧 advisor chain。主进程发出 session meta 变化事件，当前标签页立即读取 fusionRoomId。
- 本地开发版的统一融合运行链路已接通；打包版 app.isPackaged 发布闸门仍保留。原因不是 UI 未完成，而是多用户认证、服务端权威裁决、owner consent 网络投递、费用归属和离线恢复尚未完成，不能把本地 IPC 当成广域网能力。
- 验证：bun run typecheck 通过；此前 bun run build 通过。Vitest 仍受 Windows 进程创建错误阻塞，不能宣称本轮测试已运行。
- kscc：再次尝试使用 kscc --model glm-5.2 做抽象审阅时，版本检查可用，但完整子进程被 Windows CreateProcessWithLogonW failed: 1385 阻断；未发送源码、路径或用户数据，也未绕过安全边界。

### 当前 release blocker

1. 打包版本地融合 IPC 的安全回归与启动恢复验证。
2. 多用户账户、房主/成员身份、Bot 所有人授权、费用主体和断线恢复的服务端实现。
3. RoomEvent/消息投影在多客户端下的公共写入 gate 与审计。
4. KSCC/Pi 停止、超时、重启和费用归属的统一测试矩阵。
## 14. 本轮新增：local-only 发布边界（未开启生产闸门）

- CollaborationRoomService 增加 localOnly 运行策略：拒绝远程人类成员邀请/接受、非本机房主和其他用户所有的 Bot；本机 Bot 仍可创建房间、升级会话和运行。
- 这些校验位于主进程服务层，不能通过渲染层伪造 actorUserId 绕过；新增 Bot 回归测试覆盖本机 Bot 允许、远程用户拒绝、他人 Bot 拒绝和远程房主拒绝。
- 这只是发布安全前置，不等于已经打开打包版 IPC。当前 app.isPackaged 闸门仍保留，原因是还需要完成启动恢复、退出/升级兼容、打包产物实测和跨客户端服务端边界，不能用 local-only 代码掩盖未完成的多用户服务。
- 验证：bun run typecheck 通过；新增 Vitest 测试因 Windows CreateProcessWithLogonW 1385 尚未实际运行。
## 15. 本轮验证校正：房间工作区与完整协作套件

- 产物测试夹具已对齐房间专属工作区：新建房间的写入、嵌套目录、符号链接和目录目标均验证在 roomWorkspace 根目录下；旧数据无 roomWorkspace 时仍覆盖 fail-closed 兼容路径。
- 协作目录完整测试已通过：16 个测试文件、247 个测试全部通过。运行命令使用单线程 Vitest 参数，以适配 Windows 当前进程创建限制。
- bun run typecheck 已通过：shared/core/pi-core/ui/electron 全部通过。
- bun run build 已通过：Pi core、主进程、preload、renderer 全部完成构建；仅有既有的动态 import 和大 chunk 警告。
- 这证明本地融合运行链路、房间工作区隔离和当前协作服务回归是可构建、可测试的；不改变第 13、14 节的发布边界：打包版协作 IPC 闸门仍保留，多用户服务端权威、网络授权、费用主体和离线恢复仍未完成。
## 16. 本轮新增：RoomEvent 写入账本与消息投影审计

- 共享契约新增 CollaborationRoomEvent：每个房间有单调 sequence，事件携带 actorUserId、entityId、causationId、幂等键和结构化 payload。
- 本地持久层新增 events.json，appendRoomEvent 支持 expectedSequence 乐观并发检查和 idempotencyKey 幂等重放；事件读取只按房间投影，渲染层不能直接写事件文件。
- CollaborationRoomService 已把房间创建、房间状态更新、人类成员状态变化以及所有服务层消息写入接入 RoomEvent 账本；旧 rooms/members/messages JSON 仍保留，便于当前版本兼容和逐步迁移。
- 本地事件账本暂作为审计/投影桥接，不宣称已经等价于多用户服务端事务。服务端版本仍需把事件 append、权限裁决、消息 projection 和版本提交放入同一公共写入 gate。
- 验证：协作目录 17 个测试文件、249 个测试全部通过；bun run typecheck 通过。最终 bun run build 仍需在本轮代码稳定后复跑。
## 17. 本轮最终验证

- RoomEvent 接入后的最终 bun run typecheck：通过。
- RoomEvent 接入后的最终 bun run build：通过；Pi core、主进程、preload 和 renderer 均完成构建。仍只有已有的动态 import 与大 chunk 警告。
- 协作回归基线保持 17 个测试文件、249 个测试全部通过。
- 当前可交付范围仍是本地融合运行链路与安全持久化增强；打包版 IPC 发布闸门、多用户服务端 RoomSession、远程身份/费用/授权和离线恢复不在本轮被误标为完成。
## 18. 本轮新增：服务端 RoomSession 权威核心与 RoomHost

- @tagent/core 新增 FusionRoomAuthority：用宿主无关的事务状态机承载人类成员、Bot 席位快照、协调者、Bot 所有人 consent、公开消息、RoomEvent、工作区文件版本、短锁和费用账本。
- 所有公共动作先做身份/房主/成员/Bot 所有人授权检查，再在同一次状态变更中写 projection 和事件；错误不会广播或改变快照。
- 多用户工作区实现了相对路径 fail-closed、锁租约、基于 SHA-256 的乐观版本检查和冲突拒绝；费用记录固定 botOwnerUserId，并在未授权时拒绝记账。
- 新增 FusionRoomHost：按 roomId 管理多个权威 RoomSession，提供动作分发、事件订阅和快照恢复。未来 HTTP/WebSocket 层只需做认证、调用 dispatch、持久化快照并转发通知。
- 新增 7 项核心测试：邀请/接受/在线状态、协调者默认路由、跨所有者授权、费用幂等、工作区锁与 SHA 冲突、快照恢复、运行 fencing；RoomHost 测试覆盖隔离、广播和错误不广播。
- 这仍不是已经上线的网络服务：Electron 当前 IPC 发布闸门保持关闭，真实账号认证、传输层、持久化数据库、断线重连和生产级多实例并发还需接入 RoomHost。
## 19. 本轮新增：运行 fencing 与 KSCC/Pi 生命周期边界

- FusionRoomAuthority 新增可恢复的 FusionRoomRun：记录 seat、发起用户、KSCC/Pi backend、递增 fence、运行状态和结束摘要；同一 Bot 席位禁止并发运行。
- finishRun 必须携带当前 fence；旧 KSCC 进程或旧 Pi loop 的迟到结果会被拒绝，避免旧运行覆盖新运行。
- Bot 所有人撤回授权、Bot 席位移除时，权威层会取消该席位的 running run；授权和费用边界因此落在运行提交前后两侧，而不是只依赖 UI。
- FusionRoomHost 已支持 start-run / finish-run 动作分发和事件通知；7 个核心测试通过，bun run typecheck 通过。
- 这仍不是 KSCC/Pi 的真实 adapter 接线：真实进程的 create/resume/compact/interrupt、运行心跳、崩溃恢复和 usage 回写还要接入该 fencing 契约，不能把当前纯核心实现称为完整双核生产运行时。
## 20. 本轮最终验证：权威核心与 fencing

- bunx vitest run apps/electron/src/main/lib/collaboration packages/core/src/collaboration --pool=threads --maxWorkers=1 --minWorkers=1 --no-file-parallelism：19 个测试文件、256 个测试全部通过。
- bun run typecheck：shared、core、pi-core、ui、electron 全部通过。
- bun run build：Pi core、Electron main、preload、renderer 全部通过；仅保留既有动态 import 和大 chunk 警告。
- git diff --check：无空白错误；Git 只提示工作区现有文件的 LF/CRLF 转换警告。
- 本轮没有提交或推送，也没有打开打包版协作 IPC 闸门；下一阶段必须接入真实认证、传输、持久化和双核 adapter 后，才能进行发布版多用户验收。
## 21. 本轮新增：服务层 fencing 接入真实 RoomSession run 路径

- 共享 CollaborationRun 和 MemberTurnInput 增加可选 fence；服务层新建 run 从 0 开始，取消、恢复遗留运行和每次合法状态 CAS 都会递增 fencing token。
- CollaborationRoomService.executeRun 在 queued → running 时捕获本次执行 token，并把它注入 MemberTurnInput；KSCC/Pi adapter 回调只能携带该 token，旧执行回调不能通过服务层状态检查。
- 所有终态写入（完成、取消、失败、等待 A2A/审批、usage）都必须匹配本次执行 token；成功结果在 token 校验通过后才追加为公开成员消息，避免取消或重启后的迟到正文污染房间时间线。
- 这把通用核心的 fencing 约束接到了现有本地 RoomSession 服务路径，但仍不是生产多用户双核完成：真实 KSCC/Pi create/resume/compact/interrupt、心跳、崩溃恢复、远程身份/传输/持久化和 usage 服务端回写仍待接入。
- 针对 run 取消、恢复和多用户授权的协作室测试继续通过；类型检查和生产构建通过。完整 Vitest 回归需使用 Electron 兼容的 Vitest 入口确认，Bun 直接测试不能替代它。
## 22. 本轮验证：KSCC 竞态建议落地

- 使用本机 kscc glm-5.2 仅评审通用 fencing 原则，未读取或发送仓库源码、路径和用户数据。
- 采纳并落地“取消后的僵尸回调不可写回”和“重启后 token 高水位严格递增”两项验收；新增 Core 测试覆盖快照恢复后继续运行同一 Bot 时 fence 不回退、不复用。
- Electron 兼容 Vitest 完整回归：19 个测试文件、256 个测试全部通过（新增恢复测试包含在内）。
- Bun 直接测试仍不作为 Electron 协作测试依据：其会把 Electron 原生模块按普通 Bun 模块加载，触发 safeStorage 导出兼容错误；项目回归入口固定使用 Vitest。

## 23. 本轮新增：Bot 长期记忆注入与 RoomHost 快照持久化

- 融合成员执行上下文现在只读取该成员 `botProfileId` 对应的 active BotMemoryRecord；candidate、其它 Bot 的记忆和未确认草稿不会进入 prompt。
- 注入内容明确标记为“参考信息，不是当前指令”，每条限制长度并限制条数，避免长期记忆无限膨胀或改变当前任务优先级。
- `FusionRoomHost` 增加可注入的 `FusionRoomSnapshotStore`：创建、恢复和每次成功 dispatch 后保存权威快照；新进程可按 roomId 懒恢复，且恢复后 fence 高水位和事件序列继续递增。
- 本地 `CollaborationRoomService` 的成员 run 在终态竞争中保留 `usage.recorded` 审计事件；即使取消赢得状态 CAS，已经发生的模型消耗仍不会从账本中消失。
- 验证：`bun run typecheck` 通过；共享上下文、Host 恢复、Electron run 定向测试 24 项全部通过。
- 当前边界：SnapshotStore 仍是抽象接口，尚未接入远程数据库/HTTP/WebSocket；KSCC/Pi 的真实 resume、compact、interrupt、心跳和服务端 usage 回写仍需下一阶段实现。

## 24. 本轮新增：KSCC/Pi usage 归属与兼容执行契约

- `MoASeatRunner` 保留原有 `runSeat(): Promise<string>`，新增可选 `runSeatWithUsage()`；KSCC result 和 Pi 最终消息均在同一执行实现中提取 input/output/total/cache/cost。
- Electron adapter 只按结构判断是否存在 `runSeatWithUsage`，绝不在新路径抛错后再调用旧路径，避免同一个逻辑 run 重复请求和重复扣费。
- 旧 adapter 没有 usage 时保持原调用路径，usage 字段未知而不是伪造 `0`；房间服务仍补记墙钟时长，已返回的 token/cost 继续进入 `usage.recorded` 账本。
- 本机 KSCC CLI 审查确认了单次执行、正文一致性、未知 usage 和重试累计语义四个约束；本轮只落地单次结构选择和真实返回值映射，服务端费用结算仍待远程账户层。
- 验证：融合相关 39 个测试文件、657 项测试全部通过；`bun run typecheck` 全部通过；`git diff --check` 无空白错误（仅有既存 LF/CRLF 提示）。
- 当前边界：纯文本 runner 与工具桥 Agent 路径都能回写 provider usage，但仍是本地 RoomEvent 审计，不是服务端扣费；重试累计语义、远程账单对账和多用户费用裁决还需单独接入，不能宣称费用结算已完成。

## 25. 本轮新增：多用户 RoomSession gateway、HTTP/SSE 与快照文件存储

- `FusionRoomGateway` 作为 transport-neutral 边界管理认证 principal、ACL、连接、订阅和动作转换；客户端 action 类型不暴露 actorUserId，运行时即使 wire payload 携带伪造 actor 也会被 principal 覆盖。
- 新增 HTTP transport：`POST/GET /rooms`、`GET /rooms/:roomId`、`POST /rooms/:roomId/actions`，以及 `GET /rooms/:roomId/events` SSE；SSE 首先发送快照，随后发送 RoomEvent 通知并处理断线清理。
- Electron 新增 `FileFusionRoomSnapshotStore`，使用现有 atomic-json 保存权威快照；新的 FusionRoomHost 进程可以按 roomId 惰性恢复，事件序列和 fencing 高水位由权威快照继续维护。
- 验证：gateway/authority/host、HTTP/SSE、文件快照共 14 项测试通过；`bun run typecheck` 通过。
- 当前边界：HTTP server 目前是可嵌入的传输模块，认证仍由调用方注入，尚未在打包桌面版自动监听公网端口；生产部署还需要真实账户认证、TLS/反向代理、连接限流、跨进程数据库事务和多实例事件总线。

## 26. 本轮新增：传输层安全边界

- RoomSession 创建入口限制 roomId 为 1–64 位字母、数字、下划线和连字符，避免任意标识进入远程资源键。
- HTTP body 在读取前检查 Content-Length，并在流式读取中再次限制大小；SSE 心跳会重新调用认证器，认证失效时主动断开连接。
- 使用本机 KSCC CLI 做了不读取仓库的传输安全审查，采纳 IDOR、SSE 重认证、body/连接限额、快照完整性和幂等键隔离等风险清单。
- 当前边界：还未实现公网认证令牌、TLS、SSE 连接配额/背压、跨进程单写者和快照完整性 MAC；因此 HTTP 模块仍不能直接暴露到公网。


## 27. 本轮新增：Fusion Room transport 运行时组合层

新增 `apps/electron/src/main/lib/collaboration/fusion-room-runtime.ts`，把以下组件组装成一个显式生命周期对象：

- `FileFusionRoomSnapshotStore`：本地快照持久化；
- `FusionRoomHost`：房间权威状态与惰性恢复；
- `FusionRoomGateway`：认证 principal 注入、房间访问控制、事件订阅；
- `createFusionRoomHttpServer`：HTTP/SSE transport。

运行时默认只创建对象，不监听任何端口；只有调用 `start({ host, port })` 才启动。默认监听地址为 `127.0.0.1`，调用方必须提供真实的 `authenticate(request)`。`close()` 可重复调用，并会主动回收活跃 SSE 连接。该组合层目前没有接入 Electron 启动流程，打包版协作室闸门保持关闭。

## 28. 本轮新增：SSE 生命周期与安全边界修正

根据 KSCC 对新增 transport 的定向审查，补齐以下边界：

- SSE 建连在 `gateway.connect()` 或 `subscribe()` 失败时，释放用户连接配额并断开已建立的 Gateway connection；
- 对响应关闭、响应错误、请求关闭和写入竞态做清理，避免向已销毁响应写入；
- heartbeat 重新认证同时校验 `userId` 与 `kind`；
- 每个用户的 SSE 连接数默认上限为 8，可由运行时配置；
- malformed URI 按 400 返回，不向客户端泄漏底层错误文本；
- HTTP server 的异步处理增加兜底，避免异常变成未处理 rejection；
- runtime start/close 增加 starting/closing 状态，避免重复启动竞态；关闭时调用 `closeAllConnections()`。

新增/更新测试：

- HTTP/SSE：20 项目标测试全部通过（本轮新模块合计 20/20）；
- 覆盖连接超限、失败建连不占用配额、活跃 SSE 关闭、快照重启恢复；
- `bun run typecheck` 全部通过；
- `bun run build` 全部通过，仍有已有的动态 import 与大 chunk 警告；
- 直接用 Bun 扫描完整 Electron 协作目录时，部分旧测试受 Electron `safeStorage` ESM mock 环境不匹配影响，出现 15 个环境加载失败；新 transport 和 core collaboration 测试未受影响。

## 29. 当前发布边界与下一步

当前可交付的是本地/服务端核心、持久化、权限网关、显式启动的 HTTP/SSE transport 以及测试闭环。尚未完成的发布前事项：

- 将真实账户认证/会话服务接入 `authenticate`；
- 明确服务端/房主端工作区与文件下载权限；
- 在认证闭合后再决定是否开启打包版协作室 IPC 与网络入口；
- 为多进程/多实例部署增加共享存储或单写者约束；
- 继续把现有 Electron 本地 `CollaborationRoomService` 与新 Gateway 的事件/运行链路做统一适配。


## 30. 本轮新增：多用户邀请令牌与物理工作区事务

- 新增文件型 RoomSession 邀请令牌存储：明文令牌只在签发响应中返回，磁盘只保存 SHA-256；令牌可以设置过期时间并可按 token 或 room 撤销。
- 邀请令牌携带 room scope。Gateway 会拒绝把某个房间签发的令牌用于另一个房间；无效的令牌头不会静默降级到其它认证方式。
- 新增人类成员离开/移除动作：普通成员可以主动离开，房主不能离开；房主可以移除其它成员，但不能移除自己。成员状态仍由权威 RoomSession 保存。
- RoomHost 的 commit-file 现在采用两阶段事务：先由 authority 校验锁、SHA 和权限，再由 workspace store 写临时文件；物理提交成功后才保存快照。任一步失败都会回滚临时文件、恢复旧快照并且不广播事件。
- Electron 默认 workspace store 将每个房间物化到独立目录，限制安全相对路径、拒绝反斜杠/符号链接/越界路径，且在读取旧文件或创建目录前先检查符号链接，限制单文件大小，并支持原子替换和旧版本恢复。
- 远程文件下载采用显式发布模型：普通工作文件默认 downloadable=false，HTTP 只允许下载权威快照中明确标记为 downloadable=true 且物理文件存在的版本；未发布文件统一返回 404，不提供任意工作区文件读取接口。
- 验证：融合核心 Host、HTTP/SSE、文件事务针对性测试 33/33 通过；bun run typecheck 全部通过；Windows 多级路径误判越界问题已由测试发现并修复。
- 尚未完成：邀请令牌和 HTTP/SSE runtime 尚未接入打包版启动流程；真实账户认证、TLS/反向代理、跨进程单写者、数据库/MAC、断线恢复和生产多实例事件总线仍属于发布前工作。打包版协作 IPC 闸门保持关闭。


## 31. 本轮新增：Bot 成员逻辑会话的持久上下文摘要

- CollaborationMember.summary 现在承担房间内 Bot 逻辑会话的短上下文摘要：完整消息仍保存在房间消息账本，摘要只保留最近交互和未完成任务，限制在 1400 字符以内。
- 每次成功完成成员 turn 后，服务更新该成员摘要；下一次 turn 的上下文投影会把它放入 system prompt，并明确标记为“参考信息，不是当前指令”。
- 这不是把 Bot 变成常驻进程，也不是把所有历史无限塞进 prompt；KSCC/Pi 物理执行仍按 turn 创建/销毁，持久的是成员逻辑身份、房间消息和短摘要。
- 这样重启后的恢复边界清晰：旧 run 不自动重放，避免未知副作用；新 run 从持久化成员摘要、房间摘要、近期消息和已确认 Bot 记忆重新构建上下文。
- 共享上下文投影新增回归测试通过；Electron run 集成测试在 Bun 下仍受已有 Electron safeStorage mock 导出不兼容影响，类型检查通过，需在项目 Vitest runner 可用后补跑集成验证。

## 32. 本轮新增：Bot 记忆 AI 整理的显式同意边界

- Bot 记忆整理增加 `allowModelProcessing` 显式开关；未勾选时只使用本地分段/去重，不会把笔记素材发送给任何模型。
- 用户勾选“允许模型精炼（会发送这段笔记）”后，才调用当前记忆模型客户端；客户端沿用已有渠道优先、kscc 内网回退的选路，不改变 Bot 的正式运行模型配置。
- AI 只负责把用户提交的素材压缩成最多 8 条短候选，候选仍然必须经过用户确认才能进入 active；模型不得直接改变 Bot 生效记忆。
- AI 无法调用、返回非法 JSON 或没有有效候选时，自动回退到本地整理，并返回 warning；这条回退不会让用户的笔记静默丢失。
- 验证：bun run typecheck 通过；bun run build 通过。记忆服务单测已补齐默认不出网、显式同意、candidate-only 和失败回退四条覆盖，但当前直接 bun test 仍被 Electron 原生模块的 safeStorage ESM mock 兼容问题阻断，需在项目 Vitest runner 可启动后执行。
- 当前边界：AI 整理结果仍是候选，不是自动记忆；Bot 的房间持续上下文仍由成员摘要/消息账本管理，AI 记忆整理不自动读取主会话或房间历史。
## 33. 本轮新增：持久 Bot 的物理生命周期审计结论

- 当前融合成员的 `ChannelBackendAdapter` 每次 turn 按成员配置选择一次 KSCC bare 或 Pi HTTP runner；两者都通过独立 prompt 执行，不复用普通会话的 Pi Agent 实例。
- KSCC bare runner 当前只封装一次 `spawnKsccBare`，没有可保存的原生 session/resume token；Pi HTTP runner 当前每轮构造单条 user message，也没有可跨进程恢复的远端 thread。
- 因此 `logicalSessionId` 当前表示成员的稳定逻辑身份键，不代表常驻进程、远端线程或可自动重放的旧 run。重启后的安全恢复来自持久成员、消息账本、短摘要和 active Bot 记忆，旧副作用 run 不自动重放。
- 普通会话的 Pi AgentAdapter 确实有进程内 Agent Map、compact 和 interrupt，但它的状态依赖普通会话运行时，不能未经隔离直接借给融合房间成员；未来若接入真正常驻 Bot，必须新增 owner/资源配额、心跳、失效恢复、原生 resume 证明和跨进程持久化。
- 验证：融合核心/Gateway/Host/上下文/路由定向测试 37 项通过；bun run typecheck 和 bun run build 通过；直接 Bun 执行 Electron/Vitest 用例仍受 safeStorage，Pi Vitest 用例受 vi.hoisted 兼容性影响。
## 34. 本轮新增：CLI worker 成员后端与按根消息累计预算

- 融合成员的 MemberTurnInput 现在携带稳定 logicalSessionId、backend、cliWorkerId 和宿主注入的房间物理工作区根目录；主进程不接受模型自行切换这些安全字段。
- ChannelBackendAdapter 增加显式 backend = cli 路径：读取本机 CLI worker 配置，要求 worker 总开关已启用、worker 已启用且本机可用、房间存在真实工作区、成员权限为 workspace-write；任一条件不满足都 fail-closed，不静默回退到渠道后端。
- 添加成员和成员设置界面复用现有主题化 Select/Button，可以选择“渠道 / Pi”或本机 CLI worker；CLI worker 的默认模型来自 worker 配置，渠道/模型选择在 CLI 模式下禁用。Bot 成员仍然是加入时配置副本，不能原地切换后端、worker 或权限；要替换必须移除后重新加入。
- 共享创建/更新校验拒绝没有 worker 或没有 workspace-write 的 CLI 成员；主进程服务层再次校验，防止绕过渲染层直接 IPC 写入必然失败的配置。
- 房间预算现在按触发消息的 rootMessageId 聚合已落盘 run 的 token、墙钟和宿主工具调用次数：maxTurns 记录 toolCalls，maxUsageTokens 和 maxWallTimeMs 不再只看单个 turn；达到上限的后续 run fail-closed，已经发生的 usage 仍进入 usage.recorded 审计事件。
- 验证：bun run typecheck 全部通过；bun run build 全部通过，仅保留既有动态 import 和大 chunk 警告；共享融合回归 53 项通过。直接 bun test 执行 Electron 协作测试仍会被 Electron 原生 safeStorage ESM 导出 mock 不兼容阻断，不能据此判定业务失败；需使用项目 Electron/Vitest 入口。
- 本机 kscc doctor 通过（1.2.1，commit 316ce99628e8）。本轮尝试用 kscc -p --model glm-5.2 做只读定向审查，但即使设置很低预算仍因模型费用超过上限而未返回审查结论，因此本节只记录本地类型、构建和测试结果，不把 KSCC 失败调用当作代码审查意见。
- 当前边界：CLI worker 仍是每个 turn 启动/回收的短命物理执行，不等于常驻 Bot 进程；多 run 同根消息的预算预留、跨进程服务端计费和打包版远程 RoomSession 仍需在生产多用户阶段补齐。

## 35. 本轮新增：共享工作区写入租约

- 新增 `FileFusionRoomWorkspaceLeaseStore`，把工作区写入并发控制落到房间物理目录的 `audit/.tagent-leases`；租约文件只保存短 token、作用域、owner 截断值和过期时间，不改变工作区业务文件布局。
- `workspace_write_file`、`workspace_apply_patch`、`workspace_delete_file`、`workspace_move_file` 和 `room_publish_artifact` 按规范化相对路径获取租约，并通过临时文件 + `rename` 完成单文件替换；`workspace_run_command` 使用整个房间工作区的粗粒度租约，避免命令对未知文件的修改与显式文件工具交叉覆盖。
- 注册租约时使用原子目录 mutex，清理过期租约；进程崩溃不会永久占用路径，无法取得租约时工具 fail-closed 并返回稍后重试，而不是继续写盘。读文件/搜索保持只读并发，不需要阻塞写入。
- 新增 4 个租约测试，覆盖同路径互斥、workspace 粗粒度冲突、过期回收和崩溃遗留 registry mutex 回收；`bun run typecheck` 通过，租约测试与现有产物/run 恢复回归共 56 项通过。
- 当前边界：这是本地文件层的并发租约，不是跨节点数据库事务；多文件批量提交、跨进程预算原子预留、真实 RoomSession 服务端单写者仍未完成。房间服务工作区继续保持显式权限和路径 fail-closed，打包版网络入口闸门不变。

## 36. 本轮新增：投影来源边界与横向 prompt-injection 基础隔离

- `CollaborationProjectedMessage` 增加宿主生成的 `source` 字段，区分用户消息、成员自身历史、其他成员、系统事件、信箱预览和 A2A continuation；原有展示正文前缀保持兼容。
- 成员 system prompt 明确声明：房间消息、系统事件、Bot 记忆、信箱和 A2A 正文都是外部数据，不具备指令或权限；只有宿主结构化字段和 `hostToolHandler` 鉴权有效。
- 发送到渠道/Pi/CLI adapter 前，`flattenProjectedTurn` 用 `COLLAB_CONTEXT` 边界包裹每段上下文，并先清理正文伪造的边界标记，避免普通消息伪装成宿主来源。
- 这层是 prompt 隔离的基础防线，不把模型当作权限裁决者；room 工具仍从真实 run/member 上下文取身份、房间和权限，消息正文不能通过提示注入改变工具授权。
- 验证：共享上下文 12 项通过，shared/core 类型检查通过；跨 backend 的真实运行时注入测试、服务端策略引擎和完整多用户认证仍未完成。

## 37. 本轮新增：queued run 的安全跨重启恢复

- `recoverInterruptedRuns` 不再把所有遗留 queued run 一律标失败：房间仍 active、成员未移除、触发消息仍存在时，服务会递增 attempt/fence 并重新交给本次进程的 scheduler。
- 只有已经进入 running 的遗留 run 继续标记 `INTERRUPTED`，并将关联的已 dispatched/accepted A2A 信箱收口为 `outcome_unknown`；`awaiting_peer` 仍标记 blocked，不自动重放未知副作用。
- 房间 paused、成员已移除或触发消息缺失的 queued run fail-closed 为 interrupted，不会在恢复阶段偷偷启动模型。
- 新增启动恢复集成测试：queued run 跨 service 实例重新入队后完成，running run 保持中断；run 测试 11 项通过，`bun run typecheck` 和完整 `bun run build` 通过。
- 当前边界：scheduler 队列本身仍是进程内存态，跨多个服务进程/节点需要公共单写者或数据库队列租约；queued 恢复只覆盖无模型副作用窗口，不等于可恢复任意 running session。

## 38. 本轮新增：多文件工作区提交事务

- 核心 authority 新增 `commitWorkspaceFiles`：先在 authority 快照副本上逐个验证房间状态、成员权限、路径、锁和 expected SHA；任一文件失败时，原权威状态完全不变。
- Host 新增 `commit-files` 动作：所有物理文件先 `prepareCommit`，再按顺序提交；任一提交或快照保存失败时，所有已准备/已提交事务逆序 rollback，避免多文件只落盘一部分。
- Gateway/HTTP 沿用现有 principal 注入和动作透传，批量动作使用用户和动作类型作用域的幂等键；重放会返回之前同一批文件版本和事件，不会重新消耗锁。
- 批量提交拒绝空列表和重复路径；物理存储仍由具体 workspace store 决定，当前文件型 store 的临时文件、原子 rename 和旧内容恢复策略继续生效。
- 验证：core authority、Host、Gateway 定向测试 18/18 通过；`bun run typecheck` 全部通过。
- 当前边界：这是单个 Host/单写者范围内的多文件原子提交；跨进程/跨节点仍需公共数据库事务或单写者租约，Git worktree/分支生命周期也尚未接入。
## 39. 本轮新增：同根消息预算的本进程并发闸门

- 发现并修复一个并发窗口：多个成员 run 同时启动时，原实现会同时读取同一份已落盘 root usage，导致 token、墙钟或 toolCalls 预算被并行超卖。
- 对设置了任一 root budget 的房间，服务现在按 `roomId + rootMessageId` 建立进程内异步 gate；同一根消息的 run 依次进入模型执行窗口，无预算房间继续保持原有并行行为。
- gate 支持 AbortSignal，等待中的 run 被取消时会释放自己的队列位置；模型执行结束、失败、取消或 awaiting 收口时都在 `finally` 释放 gate，避免死锁。
- 新增 run 集成测试：同一根消息扇出两个成员、房间允许并发但开启 token 预算时，模型适配器最大同时执行数保持为 1，两个 run 均可在余额内完成。
- 验证：协作室 run 集成测试 12/12 通过；`bun run typecheck` 全部通过。
- 当前边界：这是单个 Electron service 进程内的预算闸门；跨进程/跨节点仍必须由数据库原子 reservation、公共队列或单写者服务提供，不能把本地 Map 当成生产计费真值。
## 40. 本轮新增：跨进程根消息预算租约

- 在已有房间物理工作区租约注册表上增加可配置 TTL；预算租约使用 `__root-budget__:<rootMessageId>` 作用域，不与文件路径或整个 workspace 命令租约混淆。
- 设置预算的 run 在读取 root usage 前同时取得本进程 gate 和持久文件租约；另一个 Electron/service 实例不能在同一根消息上同时进入模型执行窗口，释放或过期后才可继续读取最新账本。
- 租约等待最多 5 秒，取消立即退出；协调租约无法取得时 fail-closed，不调用模型。最长 TTL 受 24 小时硬上限约束，进程崩溃仍有过期回收边界。
- 新增跨实例租约测试，覆盖同一预算作用域互斥、长 TTL 和过期回收；run 集成测试继续通过。
- 验证：租约/run 测试 17/17 通过，`bun run typecheck` 通过。
- 当前边界：这是同一台机器/共享文件系统上的跨进程协调；跨节点部署仍需数据库 reservation、公共队列或单写者服务，不能把本地文件租约当作分布式一致性协议。
## 41. 本轮新增：时间线窗口化渲染

- `CollaborationTimeline` 默认只渲染最近 120 个聚合时间线条目，较早内容通过主题化 Button 按 120 条一批加载；加载时补偿 scrollTop，避免视口跳动。
- 切换房间使用 room key 重置窗口，新的消息仍保持在末尾窗口内；A2A、run 卡、审批卡和深度停止卡沿用原有 grouping 与渲染，不改变消息真值或审计记录。
- 这是第一阶段的 DOM 窗口化，避免长房间一次性创建过多卡片；当前消息和 run 仍由 IPC 全量加载，真正的服务端分页/动态高度虚拟列表仍是后续性能项。
- 验证：`bun run typecheck` 通过。
## 42. 本轮新增：邀请令牌索引的跨进程写锁

- `FileFusionRoomInviteTokenStore` 的签发、单 token 撤销和按房间撤销现在通过相邻 `.lock` 目录串行化；每次操作都会在锁内重新读取最新 JSON，再做原子写入，避免多实例最后写入者覆盖其它邀请。
- 锁有 60 秒陈旧回收边界；锁竞争直接返回可重试错误，不会在认证或令牌更新时静默覆盖数据。认证读取仍使用原子快照，令牌 secret 仍只保存 hash。
- 验证：邀请令牌与 transport runtime 测试 7/7 通过，`bun run typecheck` 通过。
- 当前边界：这是单机共享文件索引的协调，不替代真实账户服务、数据库事务、TLS 和跨节点 token revocation。
## 43. 本轮新增：FusionRoom 快照的乐观并发保护

- FusionRoomSnapshotStore.save 增加可选 expectedEventCount；Host 每次 dispatch 保存新快照时携带动作前事件数。
- FileFusionRoomSnapshotStore 在同一文件锁内重新读取最新快照并比较事件数；发现本地 Host 已过期时抛出 FusionRoomSnapshotConflictError，由 HTTP 层按 CONFLICT 返回，避免旧 Host 覆盖新事件。
- FusionRoomHost.createRoom 同时检查本地内存和持久存储中的 roomId；多实例首次创建同名 RoomSession 会被拒绝，不会覆盖已有快照。
- 快照写入仍使用原子 JSON 替换；动作失败时 Host 只恢复本地内存 authority，不再用旧快照反向写盘，避免错误回滚覆盖其它 Host 已提交的数据。
- 新增多 Host 回归测试：第一个 Host 提交后，第二个持有旧快照的 Host 写入被拒绝；重新加载后同一用户可以继续发送。
- 验证：快照、Host、runtime 定向测试 11/11 通过；bun run typecheck 通过。
- 当前边界：这解决的是同一台机器/共享文件系统上的旧快照覆盖问题，不是跨节点事务、事件总线或数据库 CAS；冲突后客户端必须重新加载 RoomSession，再由用户决定是否重试。
## 44. 本轮新增：跨 backend 成员执行回归

- 为 ChannelBackendAdapter 增加 CLI worker 回归覆盖：成员配置为 backend=cli 时，宿主工作区根目录、logicalSessionId 和任务 prompt 会传给 CLI worker，worker 返回正文与墙钟用量。
- CLI 成员若不是 workspace-write、没有房间工作区或指定 worker 不可用，统一抛出带 code 的解析错误；测试确认不会回退到渠道/Pi 后端。
- 渠道/Pi 纯文本路径、KSCC/外部工具桥的既有 40 项测试继续通过；新增 CLI 路径 3 项测试通过。
- 验证：member-backend-adapter 测试 18/18 通过；bun run typecheck 通过。
- 当前边界：这些是适配器契约和 mock runner 的运行验证，尚未替代真实 KSCC 子进程、真实外部账户和生产 CLI worker 的端到端测试；真实后端仍需在可控测试账户/沙箱工作区中单独验收。
## 45. 本轮新增：未知副作用状态的用户提示

- 恢复阶段把 awaiting_peer 收口为 blocked 时，Run 卡片现在同时显示阻塞状态和宿主错误说明；用户可以看到“应用重启时发现仍在运行的 run，已标记中断（请重新发送消息以重试）”等实际处理建议。
- 仍不提供隐式 retry 按钮：running/awaiting run 可能已经产生模型工具或 A2A 副作用，用户必须显式重新发送消息，创建新的 message/run 幂等链。
- 验证：全量 typecheck 通过；UI 变更只影响错误说明展示，不改变 run 状态机或持久化数据。
## 46. 本轮新增：RoomEvent cursor 断线重放

- FusionRoomGateway 新增受 ACL 保护的 listEvents(connectionId, roomId, afterSequence)，只返回当前用户可见房间的事件后缀，并拒绝负数/非安全整数游标。
- HTTP/SSE 支持 query 参数 after 和 Last-Event-ID；首次连接仍发送 snapshot，带游标重连则发送 replay 事件，不重复推送整份快照。
- SSE 每条 RoomEvent 通知和初始/replay payload 都携带最后事件序列的 id，客户端可直接把它作为下一次 Last-Event-ID。
- 非法 cursor 在建立 SSE 前返回 INVALID_STATE/400；成员被移除后无法继续读取或重放该房间事件。
- 验证：gateway 与 HTTP/SSE 定向测试 13/13 通过；bun run typecheck 通过。
- 当前边界：这是 RoomSession transport 的 cursor 协议，尚未接入 Electron renderer 的远程 SSE 客户端；跨节点事件总线和持久化事件裁剪仍未完成。
## 47. 本轮新增：可复用的 RoomSession HTTP/SSE 客户端

- core 新增 `FusionRoomHttpClient`，统一封装 RoomSession 的房间列表、创建、快照读取和 action dispatch；所有请求都从调用方注入 baseUrl/token，不从 wire payload 猜测用户身份。
- 客户端支持 `Authorization: Bearer`、结构化 `FusionRoomHttpError`、邀请签发、已发布文件下载、`Last-Event-ID` cursor 和 SSE 的 snapshot/replay/live notification 三种 envelope；订阅通过 AbortController 提供显式 close/done，不自动重试可能带来副作用的动作请求。
- 新增 3 项客户端测试，覆盖鉴权头与 JSON endpoint、SSE cursor/envelope 解析、HTTP 错误映射和非法 cursor；客户端类型从 `@tagent/core` 公共入口导出。
- 验证：客户端定向测试 3/3 通过；全量 `bun run typecheck` 通过。
- KSCC：本轮先运行本机 `kscc doctor` 确认 CLI 安装正常，再尝试用 `glm-5.2` 对客户端做只读审阅；调用因预算不足退出且没有返回审阅文本，因此不把它当作代码结论，源码测试仍是验收依据。
- 当前边界：客户端已经可供 renderer/远端 RoomSession adapter 使用，但当前 Electron 打包版网络入口和真实账户认证仍按安全闸门关闭；本轮没有伪造公网登录，也没有把本地 IPC 房间自动切换到未经认证的 HTTP transport。
## 48. 本轮修正：SSE 流尾解析边界

- 发现客户端在响应以非换行结尾时，会把残留的 `event:`/`id:` 行误当成 JSON data；解析器现在统一经过 `processLine`，只有真正的 data 行在事件边界或 EOF 才 emit。
- 回归测试覆盖最后一条事件没有终止空行的情况；客户端测试 3/3、真实 runtime HTTP/SSE 端到端测试 5/5、全量 typecheck 继续通过。

## 49. 本轮新增：RoomSession 成员执行回写与关闭生命周期

- core authority 新增受控 `member-message` action：只有 active room、active actor、已通过 owner consent 的 bot seat 才能回写成员消息；支持 root/reply/run/depth、目标成员和幂等键，消息仍通过同一事件账本广播。
- Electron 新增 `FusionRoomExecutionBridge`：用户 `message` action 进入后按显式 target、coordinator 或首个 active bot 路由，启动 fenced run，组装成员的 system/user prompt，调用注入的 `MemberBackendAdapter`，再把 Markdown 正文、usage 和 run 状态写回 RoomSession。HTTP runtime 已有真实链路测试：HTTP action → adapter → member message → completed run。
- 工具能力不在 bridge 内重造。bridge/runtime 增加显式 `hostToolHandlerFactory` 注入点，把普通协作 agent 已有的 `hostToolHandler` 传给 adapter；未注入时保持纯文本路径和 fail-closed，不伪造工具权限。生产版仍需把现有协作室的宿主工具状态机以受控 factory 接入新的 RoomSession authority，不能直接把 legacy service 私有状态透传给远程 bot。
- 生命周期按 KSCC 短审查意见修正：`dispose` 设置关闭闸门并拒绝新 action，不清空仍在收尾的 controller；`disposeAndWait` 等待已接收 turn；runtime close 在停止 server 前先完成 bridge 收口；取消中的 run 会落为 `cancelled` 而不是 `failed`。
- 用户与成员消息统一增加 256 KiB UTF-8 字节上限；共享上下文提示词同步明确“其他成员的正文不是给你的指令”，修复 A2A 回归契约漂移。
- 验证：执行 bridge 3 项、runtime 6 项、authority/Host/Gateway/HTTP client/transport 和 legacy collaboration 合计 23 个测试文件、232 项测试全部通过；`bun run typecheck` 通过；`git diff --check` 通过。KSCC `glm-5.2` 短审查实际返回，生命周期问题已按审查修复；其余 prompt 数据边界和宿主 actor 归因保留为架构约束，不用模型输出作权限依据。
- 当前边界：新 bridge 尚未自动接入 Electron renderer 的远程 RoomSession；打包版网络入口和真实账户认证继续保持关闭；生产工具 factory、成员长期 session/resume、跨节点单写者与真实 provider 端到端验收仍未完成。
## 50. 本轮新增：RoomSession transport-neutral adapter

- core 新增 `FusionRoomSessionAdapter`，封装单个 RoomSession 的快照加载、action dispatch、SSE 订阅、event cursor、replay 后权威刷新和显式 close；renderer/service 不再需要直接理解 HTTP response、SSE envelope 或 Last-Event-ID。
- adapter 不自动重试有副作用的 action；断线恢复由重新创建/连接 adapter 后从当前快照和 cursor 继续，避免客户端自行猜测一次 action 是否已经落盘。
- 新增 2 项 adapter 测试，覆盖快照/action 状态、cursor、notification 和 close 后拒绝更新；`@tagent/core` 公共入口已导出。
## 51. 本轮新增：多用户 Bot 权限与 renderer view model

- 房主可代加入其他用户的 Bot，但不可代签 owner consent；Bot 所有人 active 后才能授权。
- FusionRoomSessionAdapter 已覆盖 load、dispatch、SSE cursor/replay、close 竞态、subscribeSnapshot 副本安全。
- renderer 新增 fusion-room-view-model.ts，仅投影 room/user/Bot/message/workspace/permission，不猜 title/tasks/artifacts/approvals。
- 已验证：定向 19 用例、完整 24 文件 236 用例、视图模型 6 用例、typecheck、build、diff check 全部通过；构建只有既有动态 import 与大 chunk 警告。
- 待完成：controller/page 接入、真实认证、打包版网络入口、生产工具 factory、服务端恢复。
- 当前边界：`CollaborationRoomsPage` 仍使用 legacy IPC 数据模型，尚未把 core `FusionRoomAuthoritySnapshot` 映射成现有时间线/工作面板模型；下一步应先定义统一 view model，再在同一 UI 中选择 local IPC 或 authenticated RoomSession adapter，不能直接并行维护第二套页面。
## 52. 本轮新增：renderer controller 与显式远端 RoomSession factory

- renderer 新增 `FusionRoomViewModelController`：订阅 `FusionRoomSessionAdapter` 快照并投影为 view，提供 load/dispatch/connect/close 生命周期；新增关闭后拒绝更新与不可变快照副本测试。
- 抽象 `FusionRoomSessionAdapterLike`，controller 不直接依赖具体 adapter 实现，便于在同一 UI 中替换 local IPC 或 authenticated RoomSession adapter。
- 新增 `fusion-room-remote-session.ts`：以显式 roomId/baseUrl/token 创建 `FusionRoomHttpClient → FusionRoomSessionAdapter → FusionRoomViewModelController`；不自动发起任何请求、不回退本地 IPC；roomId/baseUrl 缺失时 fail-closed。
- 验证：24 个相关测试通过，`bun run typecheck` 通过。
- 当前页面仍保留 legacy IPC，因为 authority snapshot 尚不包含 tasks/artifacts/approvals/mailbox/title，尚未自动接入页面；待补齐这些投影字段后再切换。

## 53. 本轮新增：明文 HTTP RoomSession 的 loopback 安全闸门

- `FusionRoomTransportRuntime` 在未配置 TLS 且未配置真实账户认证时，只允许监听 `localhost`、`::1` 和 `127.0.0.0/8`；拒绝 `0.0.0.0`、`::`、局域网 IP 和任意 hostname。
- 拒绝非法监听地址时 runtime 保持未启动状态，调用方可安全改用 loopback 地址重新 `start`，不会留下半监听或占用端口的中间态。
- 15 个 runtime 测试和 `bun run typecheck` 全部通过。
- 这不是 LAN/WAN 发布：跨主机访问仍需 TLS、真实账户认证和打包版显式启动入口；明文 HTTP 仅限本机 loopback 自测与调试，打包版协作 IPC 网络闸门保持关闭。

## 54. 本轮新增：HTTPS transport 与 loopback gate

- `fusion-room-http-server` 新增 `FusionRoomTlsOptions` 和 `createFusionRoomHttpsServer`，与现有 HTTP server 复用同一请求处理，仅在传输层套 TLS。
- `FusionRoomTransportRuntime` 按 `tls` 配置选择启动 HTTP 或 HTTPS server；未配置 TLS 时沿用既有 loopback 闸门，非 loopback 监听地址一律拒绝，loopback 仍可使用。
- 验证：runtime/http server 25 个测试和 `bun run typecheck` 全部通过。
- 这仍不是自动开启打包版网络：真实账户认证、证书配置生命周期和显式 host API 仍待完成；跨主机访问所需的 TLS/认证/打包版显式启动入口保持关闭。

## 55. 本轮验证：HTTPS/renderer transport 全量回归

- 新增 HTTPS server 支持与 tls 选择：`fusion-room-http-server` 新增 `FusionRoomTlsOptions` 与 `createFusionRoomHttpsServer`，`FusionRoomTransportRuntime` 按 `tls` 配置在 HTTP/HTTPS 间选择，未配置 TLS 时沿用既有 loopback 闸门，非 loopback 监听地址一律拒绝。
- 全量回归：26 个融合/协作测试文件、270 个用例全部通过。
- `bun run typecheck`、`bun run build`、`git diff --check` 均通过；构建仅保留既有动态 import 与大 chunk 警告。
- 当前仍未打开打包版网络入口；远程 renderer factory 需显式配置 roomId/baseUrl/token 才会创建 RoomSession，不回退本地 IPC。
- 真实账户/证书生命周期和页面全量 remote projection 仍待完成：跨主机访问所需的 TLS/真实认证、证书配置生命周期，以及 `CollaborationRoomsPage` 接入 authority snapshot 的全量 remote projection 均未完成，打包版协作 IPC 网络闸门保持关闭。

## 56. 本轮安全收口：remote factory URL 校验

- 显式远端 RoomSession factory 现在只接受可解析的 http/https baseUrl，拒绝 file/javascript/相对 URL 和 username/password；token 不写入错误。
- 新增 5 个 factory 测试通过。
- workspace typecheck 通过。

## 57. 本轮新增：远端页面 action facade 与可选页面入口

- 新增 `FusionRoomActionAdapter`，覆盖房间 `message`、人类成员邀请/接受/主动离开/房主移除、presence、Bot 加入/授权/移除和房间 status 变更；所有动作通过 controller/adapter 派发，完全不接受渲染层传入的 `actorUserId`，身份由已认证的 RoomSession principal 决定。
- adapter 在房间快照未加载时先 fail-closed，不向未建立权威状态的房间派发任何动作；避免渲染层在拿到空快照前伪造成员状态或消息。
- `CollaborationRoomsPage` 默认继续使用本地 IPC 数据模型，行为不变；只有显式传入 `remoteSession`（由 `fusion-room-remote-session` 构造的 controller）时才挂载 `FusionRoomRemotePage`，不自动切换、不回退本地 IPC。
- `FusionRoomRemotePage` 复用现有主题化 `Button`、`MessageResponse` 和输入 `textarea`，不新造第二套样式系统；支持通过 SSE 订阅房间快照/事件更新，并通过 action facade 发送消息，不再直接触碰 wire/SSE 协议。
- 任务、产物、审批、mailbox 和房间 title 仍保留在本地/legacy 投影边界：远端页面只投影 authority snapshot 中已有的 room/user/Bot/message/workspace/permission 字段，不猜测尚未由权威层暴露的 tasks/artifacts/approvals/mailbox/title。
- 验证：action adapter、view model、remote factory、remote page 相关测试通过；`bun run typecheck` 通过。
- 当前边界：远端页面入口仍需显式 roomId/baseUrl/token 才会创建，打包版网络入口和真实账户认证保持关闭；tasks/artifacts/approvals/mailbox/title 的远端投影仍待权威层补齐后再接入，不在本轮伪造完成。

## 58. 本轮验证：远端页面入口与 action facade 回归

- `CollaborationRoomsPage` 默认仍走 local IPC 分支，保持原有逻辑不变；只有显式传入 `remoteSession`（由 `fusion-room-remote-session` 构造的 controller）时才挂载 `FusionRoomRemotePage`，不自动切换、不回退本地 IPC。
- `FusionRoomActionAdapter` / `FusionRoomViewModelController` / `FusionRoomSessionAdapter` / `fusion-room-remote-session` 与 legacy `CollaborationWorkPanel` / `ApprovalCard` 同 core/main 融合回归，共 29 个测试文件、286 个测试全部通过。
- `bun run build` 与 `git diff --check` 均通过；构建仅保留既有动态 import 与大 chunk 警告。

## 59. 远程融合会话的显式用户入口

- 现有协作室空态增加“连接远程融合会话”按钮，复用现有页面，不新增 rail 入口。
- 新增 FusionRoomRemoteConnectDialog：填写服务地址、房间 ID、可选 token 后显式调用 createFusionRoomRemoteSession，提交前不建立网络连接。
- token 只存在 React 内存态，关闭对话框时清空，不写入 localStorage、数据库或日志。
- CollaborationRoomsPage wrapper 管理 ownedRemoteSession，外部 remoteSession 优先；关闭远程视图后回到本地空态并释放连接。
- 验证：全仓 bun run typecheck 通过；bun run build 通过；build 仅保留既有大 chunk warning。
- 当前边界：远端 authority snapshot 尚未提供 legacy tasks/artifacts/approvals/mailbox/title 投影，FusionRoomRemotePage 当前是消息、成员、工作区摘要和 markdown 的最小远端面，后续需补齐权威投影或明确降级提示。

## 60. 本轮新增：FusionRoomActionAdapter 工作区与运行 action facade

- `FusionRoomActionAdapter` 在 §57 已覆盖的消息/成员/presence/Bot/status 动作之外，补齐六类 workspace 与 run action facade：`acquireWorkspaceLock`（`lock`）、`commitFile`（`commit-file`）、`commitFiles`（`commit-files`）、`recordUsage`（`usage`）、`startRun`（`start-run`）、`finishRun`（`finish-run`）。六者均通过同一 `dispatch(action)` 通道派发，统一受“快照未加载先 fail-closed”闸门保护。
- 与既有动作一致，这六个 facade 的入参全部为 `Omit<…Input, 'actorUserId'>`：渲染层不接受、也不向 adapter/controller 传递 `actorUserId`，身份始终由已认证 RoomSession 的 principal 决定；新增动作在测试中再次断言 `fake.actions.every(action => !('actorUserId' in action))` 为真，renderer 无法借工作区/运行动作伪造执行者。
- `fusion-room-action-adapter.test.ts` 当前共 4 个测试，覆盖不含 actorUserId 的页面动作映射、`addBot`/`connect`/幂等 `close`、六类工作区与运行动作映射、以及快照未加载时 fail-closed；聚焦运行 4 pass。
- 不在本轮伪造完成：远程 authority snapshot 的 legacy tasks/artifacts/approvals/mailbox/title 全量远端投影仍待权威层补齐后再接入；生产 tool factory（真实工具授权/装配链路）未完成；真实账户认证、证书生命周期与打包版协作 IPC 网络闸门仍保持关闭，跨主机访问所需的 TLS/认证配置不在本轮交付。

## 61. 远程 authority 工作区数据进入 view model

- `FusionRoomViewModel` 新增 `files`、`locks`、`runs` 三个字段，类型分别为 `FusionRoomAuthoritySnapshot['files']`、`FusionRoomAuthoritySnapshot['locks']`、`FusionRoomAuthoritySnapshot['runs']`（即权威层的 `FusionWorkspaceFileVersion[]`、`FusionWorkspaceLock[]`、`FusionRoomRun[]`），由 authority snapshot 索引类型派生，不在渲染层自行发明字段形状。
- `createFusionRoomViewModel` 对这三个数组逐项浅拷贝：`snapshot.files.map((file) => ({ ...file }))`、`snapshot.locks.map((lock) => ({ ...lock }))`、`snapshot.runs.map((run) => ({ ...run }))`，与既有 `humanMembers`/`bots`/`messages` 一致，避免把权威快照内部数组引用直接暴露给渲染层。
- 远端页面尚未把这三项渲染成面板：当前 `FusionRoomRemotePage` 仍只投影 room/user/Bot/message/workspace/permission，`files`/`locks`/`runs` 只进入 view model 数据层，不在本轮声称远端工作区/运行 UI 已完成。
- 验证：`apps/electron/src/renderer/components/collaboration/fusion-room-view-model.test.ts` 18 项测试全部通过；`bun run typecheck` shared/core/pi-core/ui/electron 全部 workspace 通过。
- 保持边界：远端 authority snapshot 的 legacy tasks/artifacts/approvals/mailbox/title 高级投影、生产 tool factory（真实工具授权/装配链路）、真实账户认证/证书生命周期与打包版协作 IPC 网络闸门仍未完成，跨主机访问所需的 TLS/认证配置不在本轮交付。

## 62. 远程融合页展示 authority 工作区状态

- `FusionRoomRemotePage` 在成员 chips 行与消息滚动区之间新增一块主题一致的远端工作区面板：复用既有 `border-border` / `bg-background` / `text-foreground` / `text-muted-foreground` / `bg-muted` / `bg-primary` 主题 token，不新增任何 CSS 文件或样式表，也不引入新依赖（仍只用 React、`@tagent/ui` 的 `MessageResponse`/`Button`、`lucide-react` 图标和既有 action/view-model 模块）。
- 工作区摘要只展示 `workspace.kind` / `workspace.status` / `workspace.id`，不展示 `rootPath`、`storageKey`、文件 `sha256` 或任何 token；`rootPath`/`storageKey` 按 shared 类型注释本就是服务端内部字段，客户端不应当作可读写路径。
- 已提交文件列取自 `view.files`，逐条展示 `relativePath` 与 `version`（`v{version}`）；活动锁列取自 `view.locks`，逐条展示 `relativePath`、`ownerUserId` 与 `expiresAt > Date.now() ? '持有中' : '已过期'`；运行列取自 `view.runs`，先 `[...view.runs].reverse()` 再 `slice(0, 4)` 倒序最多 4 条，逐条展示 `seatId` / `backend` / `status` / `fence`。
- 三列均加入空态文案：文件“暂无已提交文件”、锁“暂无活动锁”、运行“暂无运行”；整块面板仅在 `view` 已加载时渲染，未加载时不占位。
- 验证：`bun run typecheck` 全部通过；相关 3 个测试文件 27 pass；`bun run build` 成功，仅保留既有动态 import 与大 chunk warning。

## 63. 远程工作区发布产物下载入口

- FusionRoomRemotePage 复用现有 FusionRoomHttpClient.downloadPublishedFile(roomId, relativePath)，仅在 authority snapshot 的文件条目明确为 downloadable === true 时显示主题一致的 ghost/sm Button 和 Download 图标；普通工作文件不显示下载按钮。
- 点击后通过 Blob、URL.createObjectURL 和临时 a 元素触发浏览器下载，文件名取 relativePath 最后一段；下载中禁用对应按钮并显示“下载中…”，成功后清理 object URL，异常复用页面现有错误状态，finally 清理下载状态。
- 服务端既有 files endpoint 仍负责校验文件属于当前房间且明确 published/downloadable，并通过既有 publishedFileReader 提供内容；未发布文件继续返回不可发现的错误，不因新增 UI 扩大工作区访问边界。
- 本轮验证：bun run typecheck 通过；fusion-room-view-model.test.ts、fusion-room-action-adapter.test.ts、fusion-room-remote-session.test.ts 共 27 pass / 0 fail；bun run build 成功，仅保留既有动态 import 与大 chunk 警告。

## 64. 工作区 authority projection 回归覆盖

- fusion-room-view-model.test.ts 新增 workspace projection 测试：构造一个普通文件（未设置 downloadable）、一个已发布文件（downloadable: true）、一个锁和一个运行，断言 files/locks/runs 投影字段与发布标记正确，普通文件仍不具备 downloadable 标记。
- 测试继续修改 view.files/view.locks/view.runs 的顶层字段，断言原始 authority snapshot 未被修改，覆盖 view model 对三个 authority 数组的浅拷贝隔离边界。
- 本轮验证：该测试文件 19 pass / 0 fail / 66 expect；bun run typecheck 全部 workspace 通过。
- 保持边界：这只是 projection 回归覆盖，不代表远端 tasks/artifacts/approvals/mailbox/title 或生产认证/打包网络入口已经完成。
- 未完成边界保持不变：远程 tasks/artifacts/approvals/mailbox/title 完整投影、生产 tool factory、真实账户认证/证书生命周期、打包版协作网络入口仍未交付。不要声称真实浏览器下载已做端到端运行验证。
## 65. Remote Fusion Room task authority vertical slice（2026-08-23）

本轮把本地协作室已有的轻量任务语义，正式接入远程融合会话自己的 authority；没有把 legacy task 数据伪造投影到远程快照。

- FusionRoomAuthoritySnapshot 现在持有 tasks: CollaborationRoomTask[]。新建房间初始化为空数组，恢复旧快照时对缺失字段兼容为 []。
- authority 增加 createTask / updateTask：校验房间归属、标题、成员归属；创建从 todo 开始；更新使用严格状态迁移和 expectedVersion CAS；每次写入通过 room.updated 事件持久化，并支持 scoped idempotency。
- FusionRoomHost 增加 create-task / update-task action，沿用原有 snapshot save、workspace transaction rollback 和 event notification。
- FusionRoomGateway 增加对应 wire action；actorUserId 仍由 authenticated principal 注入，wire payload 中的伪造 actor 不会进入 authority。
- renderer 的 view-model 深拷贝 tasks 及依赖数组；action adapter 暴露不接收 actorUserId 的 create/update 方法；远程页面使用现有主题渲染只读任务摘要。
- 回归：authority/host/gateway/renderer 聚焦测试 47 pass、0 fail、187 expect；全仓 typecheck 通过。
- 仍未完成：远程 artifacts、approvals、mailbox/A2A 高级投影与操作；title/goal；生产 tool factory；真实账户认证、证书生命周期、打包网络入口、跨节点单写者与真实多用户端到端验收。

## 66. Remote Fusion Room artifact authority vertical slice（2026-08-23）

- FusionRoomAuthoritySnapshot 增加 artifacts: CollaborationArtifact[]；新建和旧快照恢复默认空数组。
- authority 增加 publishArtifact：要求 active room、真实 Bot seat/owner consent、安全相对路径、1 MiB 内容上限和 summary 长度上限；sha256 与 byteSize 由 authority 从实际 content 计算；taskId 必须指向当前房间任务；产物写入 artifact.published 事件并支持幂等重放。
- Host/Gateway 增加 publish-artifact action，actorUserId 仍由认证 principal 注入；renderer view-model 深拷贝 artifacts，action adapter 暴露不接收 actorUserId 的 publishArtifact，远程页面用现有主题显示发布产物摘要。
- 验证：本轮聚焦 authority/gateway/renderer 测试 41 pass、0 fail、168 expect；全仓 typecheck 通过；build 已完成，首次 build 发现并修正了重复 dispatch case，修正后需再跑一次最终 build。
- 边界：artifact 元数据与受控发布路径已接通；审批、mailbox/A2A 高级投影、title/goal、生产工具 factory、真实账户认证/证书生命周期、打包网络入口和跨节点一致性仍未完成。

## 67. Remote Fusion Room approvals and A2A mailbox vertical slice（2026-08-23）

- FusionRoomAuthoritySnapshot 增加 approvals 与 mailbox，并对旧快照缺失字段恢复为空数组；新建房间默认初始化为空。
- authority 增加 requestUserApproval / resolveUserApproval：审批请求必须绑定已授权 Bot 的 running run；问题、原因、选项和回复有长度/数量限制；决策使用 pending -> approved/denied/cancelled 的单向语义；request/resolve 均支持幂等重放并写入 authority event。
- authority 增加 sendMailbox / replyMailbox：只允许已授权 Bot 之间交接；发送者必须绑定 running run；rootMessageId 必须来自当前房间消息；causationId、depth、requestId、attemptId 等安全字段由 authority 生成或推导；payload 32 KiB 上限，硬深度上限 10，自环和已结束 question 拒绝。
- Host/Gateway/action adapter 接入四类 action。gateway 仍从 authenticated principal 注入 actorUserId，wire payload 中的伪造 actor 不会进入 authority。
- FusionRoomViewModel 投影 approvals/mailbox；FusionRoomRemotePage 复用现有主题组件显示待审批卡、批准/拒绝按钮和 A2A 审计流，没有新增 CSS 或第二套样式。
- 验证：authority/gateway/session-adapter/renderer 聚焦测试 47 pass、0 fail、203 expect；全仓 bun run typecheck 通过。
- 明确边界：mailbox 当前完成 authority 信封状态、权限、幂等和远程投影，尚未接入 Bot backend 的自动 dispatch、awaiting_peer continuation、真实跨节点 mailbox worker；审批当前完成远程状态和用户决策入口，尚未将 approved/denied 自动驱动 Pi/KSCC turn 状态机。title/goal、生产工具 factory、真实账户认证/证书生命周期、打包网络入口、跨节点单写者/持久化与多用户端到端验收仍未完成。
## 68. Fusion Room execution bridge、默认宿主工具和 A2A continuation（2026-08-23）

本轮把前面已落 authority 的 approval/mailbox 从“可记录状态”推进到显式 runtime 的可执行闭环。

- FusionRun 增加 awaiting_peer / awaiting_user；start-run 记录 triggerMessageId，新增 await-run 使用 fencing token 将运行安全切换到等待态并释放 Bot seat。旧的完成/取消回写不会覆盖已进入等待态的 run。
- FusionRoomExecutionBridge 现在处理 user message、带目标的 member-message、send-mailbox、resolve-approval、reply-mailbox：无 @ 消息仍由 coordinator/首个 Bot 承接；A2A 提问会触发目标 Bot；用户审批或 peer reply 会根据原 run 的 triggerMessageId 创建新的 continuation run。
- waitForIdle 改为动态 drain，覆盖等待期间由 mailbox/approval 产生的新运行，避免关闭或测试在 continuation 尚未加入 inflight 时提前返回。
- 新增 fusion-room-host-tools.ts 默认宿主工具工厂，接入 room_send、room_ask、room_reply、room_task_assign、room_task_update、room_publish_artifact、room_request_user；actor、room、seat、run、fence 均由宿主闭包提供，模型只能提供业务参数。
- 工作区工具接入 workspace_read_file、workspace_search、workspace_write_file、workspace_apply_patch、workspace_run_command。文件写入/补丁先走 authority lock，再走 host commit；命令复用既有白名单、shell:false、参数控制字符拒绝、超时和输出上限。
- publish-artifact 在 FusionRoomHost 中与实际 workspace prepare/commit 进入同一个 host transaction：authority 失败或快照持久化失败时回滚文件，不再出现只写元数据或只写文件的半完成状态。
- 文件工作区新增受限搜索与命令入口；路径解析、符号链接检查、读写权限和 owner consent 仍由宿主/authority 约束。workspace_delete_file / workspace_move_file 当前继续 fail-closed，未绕过版本账本实现直写。
- 新增 A2A 集成回归：Bot A room_ask → run awaiting_peer → Bot B 被触发并 room_reply → Bot A continuation 完成。相关 authority/gateway/workspace/command/bridge 定向回归共 53 pass、0 fail、230 expects；bun run typecheck 通过。
- KSCC：本轮再次发起窄范围只读审计，但 CLI 进入交互后在限定等待时间内没有返回审阅文本，已中止；不把没有输出的 KSCC 调用当作结论，当前结论以源码审计、类型检查和回归测试为准。

当前边界：这是显式创建的 FusionRoomTransportRuntime 的真实执行闭环，不代表 Electron 打包版已经自动开启网络；真实账户认证、证书生命周期、跨节点单写者/事件总线、多用户跨机器 E2E、真实 Pi/KSCC/provider 进程验收仍待完成。审批和 mailbox 已能驱动显式 runtime 的 continuation，但仍未接入持久化 scheduler 的跨重启恢复；room title/goal 和 delete/move 工作区工具也未在本轮完成。
## 69. RoomSession 元数据与未知副作用运行恢复（2026-08-23）

- `FusionRoomAuthoritySnapshot` 增加可选 `title` / `goal`；新建房间写入规范化标题和目标，旧快照缺失字段时以 `roomId` 和空目标兼容恢复。
- authority 新增 owner-only 的 `updateMetadata`，通过 `room.updated` 事件和 scoped idempotency 持久化；Host、Gateway、renderer action adapter 和 view model 全链路接入。远程页面显示标题、目标和 room 状态，但仍保持现有主题组件，不引入第二套样式。
- `FusionRoomRunStatus` 增加 `blocked`。`FusionRoomHost.recoverInterruptedRuns()` 在 transport runtime 启动时扫描持久快照：只处理上次进程退出时仍为 `running` 的 run，将其安全收束为 `blocked`，不自动重放可能已经执行过外部命令、文件写入或网络调用的任务；`awaiting_peer` / `awaiting_user` 继续依赖 durable mailbox/approval 语义恢复。
- 恢复动作使用原 run 的 fence 和稳定幂等键，仍通过统一 dispatch、snapshot save、event notification 进入 authority，不直接改内存状态。
- 回归：fusion-room-host 7 pass / 26 expects；全仓 `bun run typecheck` 通过。
- 当前明确边界：远程持久化 continuation worker 尚未补齐“服务离线期间已批准审批/已回复 mailbox 自动排队”的扫描与去重；`workspace_delete_file` / `workspace_move_file` 仍 fail-closed；真实账户认证、证书生命周期、打包网络入口、跨节点单写者和真实多用户端到端验收仍未完成。
## 70. Fusion workspace delete/move 能力闭环（2026-08-23）

- `FusionWorkspaceFileVersion` 增加可选 `deleted` tombstone。删除不从 authority 账本物理抹除版本，而是保留 sha/version/更新时间，继续阻止旧内容覆盖；renderer projection 和 published download 会过滤 tombstone。
- authority 新增 `deleteWorkspaceFile` 与 `moveWorkspaceFile`：删除要求当前用户有效锁和 SHA；移动要求源/目标双锁、拒绝覆盖已存在目标，并以一个 `room.updated` workspace event 记录移动审计；两者均支持幂等重放。
- Host 新增 `delete-file` / `move-file` action，并把 `prepareDelete` / `prepareMove` 纳入与 commit/publish 相同的物理事务队列：authority 失败或 snapshot save 失败时回滚 Host 状态和物理动作。
- FileFusionRoomWorkspaceStore 复用安全相对路径、符号链接拒绝、普通文件限制；移动使用原子 rename，删除只允许普通文件，移动 rollback 可恢复源路径。
- Gateway 从 authenticated principal 注入 actorUserId；renderer facade 与默认 Fusion Bot host tools 已接入，Bot 先申请锁再执行 delete/move，不再 fail-closed 缺能力。
- 验证：authority 13 pass / 88 expects；Host/Gateway/FileStore 定向合计 22 pass / 73 expects；全仓 `bun run typecheck` 通过。
- KSCC：使用 `kscc -p --bare --model glm-5.2` 发起只读窄审查，但在限定等待内没有输出，已终止；不把无输出调用当作审查结论。
- 当前边界：delete/move 的真实 runtime tool E2E、跨主机认证/证书、跨节点单写者和打包网络入口仍未完成；重启后的审批/mailbox continuation 仍只可观察、不能无确认自动重放可能产生副作用的 turn。
## 71. 跨设备长期开发交接（2026-08-23）

- 新增 [13-HANDOFF-2026-08-23](./13-HANDOFF-2026-08-23.md)，集中记录当前产品结论、代码地图、authority/Host/Gateway/runtime/renderer 边界、workspace/Bot 工具、验证命令、安全不变量、未完成项和推荐开发顺序。
- `03-IMPLEMENTATION-PHASES.md` 新增 §0.2 当前交接基线，明确历史切片与当前真实状态的优先级；`06-MULTIUSER-FUSION-IMPLEMENTATION.md` 新增 §0.1 当前实现校正，避免把设计草案误读为已交付能力。
- 当前交接强调：打包网络入口仍关闭；真实账户、证书、跨机器多用户、跨节点单写者、真实 provider E2E 和持久 continuation worker 仍未完成；未知副作用 run 不自动重放。
## 72. 融合会话认证 / ACL 协议层 + 测试（P0-1）（2026-08-23）

本轮交付 P0-1 的纯协议层认证 / ACL 判定，不接真实账户、不读盘、不碰 Electron / 网络传输，为后续真实账户认证与跨机器 E2E 复用。

- 新增 `packages/core/src/collaboration/fusion-room-acl.ts`，纯函数 / 无 I/O，公开：`FusionAclDecision`（`allowed` + 拒绝 `code: FORBIDDEN | SCOPE_MISMATCH | NO_CONSENT | NO_GRANT | BILLING_LOCKED`）、`FusionAclPrincipal`、`FusionResourceGrant`，以及判定函数 `decideRoomAccess` / `decideBotRuntimeAccess` / `decideResourceAccess` / `resolveBillingSubject` 和便利方法 `isAllowed`。
- `decideRoomAccess` 与 gateway `defaultAuthorize` 行为对齐：`principal.roomId` 跨房间 → `SCOPE_MISMATCH`；`kind==='worker'` 仅当 `userId === ownerUserId` 放行；房主始终可进；人类成员 `invited`/`active`/`offline` 放行，`left`/`removed` 拒绝；其余 `FORBIDDEN`。
- `decideBotRuntimeAccess`：`seat.status==='removed'` 先 `FORBIDDEN`；**所有能力（含 read-only）均要求 `ownerConsent`**——即便 read-only 也会消耗 Bot owner 模型额度并计费，未授权不应开放任何能力；`workspace-write` / `run` 在协议层只以 consent 为闸门，“房间 policy ∩ seat capabilities”交集留给 authority/runtime（TODO，已在源码注释写明）。
- `decideResourceAccess`：资源所有者本人可读 / 写 / 挂载无需 grant；他人需匹配 `granteeUserId` + `ownerUserId` + 动作且未过期（`expiresAt <= now`）、未撤销（`revokedAt <= now`）；否则 `NO_GRANT`，reason 区分过期 / 撤销 / 缺失。
- `resolveBillingSubject`：`billingUserId === seatOwnerUserId` 恒成立，与 authority `recordUsage` 的 `botOwnerUserId: seat.ownerUserId` 语义一致；`initiatedByUserId` 可为房主或他人，`ownerOffline=true` 也不转移费用。`BILLING_LOCKED` 留作后续“Bot owner 离线且无可承扣额度”费用闸门使用，本切片不产出。
- gateway `defaultAuthorize` 改为委托 `decideRoomAccess`，行为保持兼容；新增 gateway 测试覆盖 worker principal（房主放行 / 非房主即便活跃成员也拒绝）。`packages/core/src/index.ts` 导出新模块公开类型与函数。
- 验证：`bun test packages/core/src/collaboration/fusion-room-acl.test.ts` 21 pass / 0 fail / 58 expect；`bun test packages/core/src/collaboration/fusion-room-gateway.test.ts` 10 pass / 0 fail / 32 expect；`bun run --filter='@tagent/core' typecheck` 通过；`git diff --check` 通过。可选 `bun test packages/core/src/collaboration` 全目录通过。
- 明确未做：真实账户登录 / OAuth / 证书生命周期、邀请 token 与账户身份绑定、跨机器多用户 E2E、公网 / HTTPS 入口、loopback 例外扩大、`recordUsage` 签名改动、renderer UI 变更、跨节点单写者 / 持久 continuation worker；`BILLING_LOCKED` 费用闸门未接入。本切片只交付协议与测试，不代表跨用户网络已可用。
- 交接文档与本日志、阶段文档必须和代码/测试在同一提交链中，另一台设备按 handoff 的 clone/pull/typecheck 流程继续。

## 73. 双用户 / 双 Bot owner / 共享工作区 HTTP·SSE fixture E2E（P0-2）（2026-08-23）

本轮交付 P0-2 的本地 loopback fixture E2E，跑通一条跨用户垂直切片，仍不打开公网入口、不接真实账户 / OAuth / 证书 / 跨机器。复用 P0-1 的 ACL 协议层与现有 runtime / invite token store / workspace store / HTTP·SSE transport，未改任何源码，仅新增测试文件。

- 新增 `apps/electron/src/main/lib/collaboration/fusion-room-multiuser-fixture.test.ts`，`describe('multiuser fixture E2E (HTTP/SSE, loopback only)')`，2 个 test / 48 expect：一个跨用户垂直切片 + 一个 SSE 加分项。全程 `runtime.start({ host: '127.0.0.1', port: 0 })`，物理工作区用 `FileFusionRoomWorkspaceStore({ rootForRoom: (roomId) => join(tempDir, 'ws', roomId) })` 限定在临时目录，避免污染真实 collaboration room 工作区。
- 认证链与生产一致：`createFusionRoomTransportRuntime` 内部用 `createFusionRoomInviteAuthenticator` 让 Bearer 邀请 token 优先于 `x-user-id` 头，无 token 才回退头。房主 A 走 `x-user-id` 头，受邀用户 B 走 Bearer token。**不需要为 P0-2 最小补齐 `principal.roomId`**：`FileFusionRoomInviteTokenStore.authenticate` 已返回 `{ userId, kind: 'user', roomId: record.roomId }`，`decideRoomAccess` 已据此判 `SCOPE_MISMATCH`，gateway `defaultAuthorize` 已委托。
- 覆盖的最低断言（与 brief 一一对应）：
  1. 未邀请 outsider 对 room-a 的 `GET /rooms/room-a` 与 `POST .../actions` 一律 403 `FORBIDDEN`。
  2. A `POST /rooms/room-a/invites { userId: 'user-b' }` 签发 `frt1.*` token；B 用 Bearer `accept-invitation` 后成为 active 成员；**token 身份优先于随意头**——B 带 Bearer token 同时伪造 `x-user-id: user-a` 发消息，`authorId` 仍是 `user-b`；**绑定 room-a 的 token 不能进 room-b**——HTTP 层 403，且协议层 `decideRoomAccess({ principal: { userId: 'user-b', roomId: 'room-a' }, roomId: 'room-b', ... }).code === 'SCOPE_MISMATCH'` 旁路断言。
  3. A 加入 `ownerUserId=A` 的 Bot → `botOwnerConsents[seatA]` 自动 `true`；`usage` 成功，`usage[seatA].botOwnerUserId === 'user-a'`；`resolveBillingSubject({ seatOwnerUserId: 'user-a', initiatedByUserId: 'user-a' }).billingUserId === 'user-a'`。
  4. A 代邀请 `ownerUserId=B` 的 Bot → `botOwnerConsents[seatB]` 为 `false`（仅 pending，不自动 consent）；B consent 前 `start-run` / `usage` 均被 `canRun` 以 `CONSENT_REQUIRED`（HTTP 400）拒绝；A 代签 `bot-consent` 被 `setBotOwnerConsent` 以 `FORBIDDEN`（HTTP 403，"只有 Bot 所有人可以授权或撤回"）拒绝。
  5. B 亲自 `bot-consent`（Bearer token，actor=B）后 `botOwnerConsents[seatB] === true`；A `start-run` / `usage` 在 seatB 上成功，`usage[seatB].botOwnerUserId === 'user-b'`；`resolveBillingSubject({ seatOwnerUserId: 'user-b', initiatedByUserId: 'user-a' }).billingUserId === 'user-b'`（发起人是房主 A 也不转移费用主体）。
  6. 共享工作区：A `lock` + `commit-file`（`downloadable: true`）发布 `report.md`，B 用 Bearer token `GET /rooms/room-a/files?path=report.md` 下载到相同内容且 `content-disposition` 含文件名；A 再提交非 downloadable 的 `secret.md`，B 下载得 404（不泄露文件名 / 状态）。
  7. （加分）SSE：B 用 Bearer token 订阅 `/rooms/room-a/events`，首条为 `snapshot`；A 发消息后 B 读到下一条含 `message.appended` 的事件增量。
- 验证（实跑结果）：
  - `bun test apps/electron/src/main/lib/collaboration/fusion-room-multiuser-fixture.test.ts` → **2 pass / 0 fail / 48 expect**。
  - `bun test packages/core/src/collaboration/fusion-room-acl.test.ts` → 21 pass / 0 fail / 58 expect。
  - `bun test packages/core/src/collaboration/fusion-room-gateway.test.ts` → 10 pass / 0 fail / 32 expect。
  - `bun test apps/electron/src/main/lib/collaboration/fusion-room-http-server.test.ts` → 6 pass / 0 fail / 28 expect。
  - `bun run --filter='@tagent/core' typecheck` 通过；`bun run --filter='./apps/electron' typecheck`（`tsc --noEmit`，`tsconfig.include: src/**/*` 覆盖新测试文件）通过；`git diff --check` 退出 0（仅有 `packages/ui/.../tokens.css` 的既存 LF→CRLF 提示，与本切片无关）。
  - **阻塞记录（如实，未删任何安全检查装通过）**：`bun test apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts` → 18 pass / **1 fail** / 107 expect。失败用例为 `FusionRoom transport TLS 选项 > 未提供 tls 构造 HTTP server，提供 tls 构造 HTTPS server`（runtime.test.ts:185 `expect(httpRuntime.server).not.toBeInstanceOf(HttpsServer)`）。**这是 Bun 1.3.14 的 `node:http`/`node:https` 运行期 quirk**：Bun 下 `http.Server` 与 `https.Server` 共用同一 constructor，故未开 TLS 的 HTTP server 也 `instanceof https.Server`，使 `not.toBeInstanceOf(HttpsServer)` 失败。**与 P0-2 无关、非回归**：把新测试文件移走后该失败仍按原样复现（18 pass / 1 fail），属既存 runner 环境问题，业务逻辑与 typecheck/build 均不受影响。复现命令：`bun test apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts`。按 handoff §6 既定约定，不把 Bun 直接加载的运行期差异误判为业务失败；不在此切片改 runtime 测试或源码绕过。
- 明确未做（与 handoff §7/§8 一致）：真实账户登录 / OAuth、证书生成 / 轮换 / 撤销、服务端部署配置、打包版显式网络启动 UI、跨机器 / 跨节点多用户 E2E、单写者 / 乐观并发 / 事件总线 / 预算原子预留、`BILLING_LOCKED` 费用闸门、renderer UI 变更、`recordUsage` 签名改动。本切片只证明「同一台机器、同一进程、loopback HTTP·SSE 之上，邀请 token 身份 + Bot owner consent + 费用主体归属 + 共享工作区下载」的协议与 transport 链路在双用户场景下端到端成立，不代表跨机器 / 真实账户 / 公网入口已可用。

## 74. 证书生命周期 + 打包版协作 / 网络显式闸门（P0-3）（2026-08-23）

本轮交付 P0-3：RoomSession 服务端 TLS 证书的本地生命周期存储（生成 / 加载 / 轮换 / 撤销）+ 打包版协作 / 网络的显式闸门决策函数与持久化偏好。**默认仍关闭打包版协作与公网监听**；不接真实账户 / OAuth / 跨机器 E2E / 生产 CA。

新增文件：
- `apps/electron/src/main/lib/collaboration/fusion-room-cert-store.ts`：用 Node 内置 `node:crypto` 生成自签 X.509 v3 证书（RSA 2048 / SHA256，SAN: DNS:localhost + IP:127.0.0.1），**不引入任何外部 CA 库**；ASN.1 DER 编码器为本文件内联纯函数，SubjectPublicKeyInfo 直接用 `publicKey.export({type:'spki',format:'der'})` 取得，签名用 `crypto.createSign`，指纹用 `X509Certificate.fingerprint256`。`FusionRoomCertStore({dir, now})` 持久化到 `<dir>/fusion-room-certs.json`（atomic-json 三步原子写 + `.bak` 自愈），提供 `generate` / `list` / `listPublic`（剥离私钥）/ `revoke`（幂等）/ `rotate`（撤销旧 active + 生成新 active）/ `resolveTlsOptions`（返回最新 active 且未过期证书的 `{key, cert}`）/ `hasActiveCert`。状态派生 `revoked > expired > active`（不依赖落盘 `status` 字段，过期按注入 `now` 自动判定）。
- `apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.ts`：纯函数 `decidePackagedCollaborationGate({isPackaged, prefs, hasActiveCert})` → `{registerIpc, allowNonLoopbackListen, reasons}`，规则与 brief 一一对应（dev 恒开 IPC；打包默认全关；仅 `enableCollaboration` → IPC 开但非 loopback 关；`enableNetworkListen` 还需 active 证书）；`validateFusionRoomNetworkPrefs` 拒绝 `allowInsecureNetwork` 等明文公网开关（在 `normalize` 前对**原始输入**检查，避免被静默洗掉）+ 拒绝 `enableNetworkListen` 缺 `enableCollaboration`；`load/save` 走 atomic-json，默认全关。
- `apps/electron/src/main/lib/collaboration/fusion-room-network-prefs-ipc.ts`：**始终注册**的小型 IPC（`fusion-room-network-prefs:get/set` + `fusion-room-certs:list/generate/revoke`），让用户能显式控制闸门；本身不注册协作室 IPC、不开网络监听、不回传私钥。
- 对应单测：`fusion-room-cert-store.test.ts`、`fusion-room-network-prefs.test.ts`。

修改：
- `main/index.ts`：用 `decidePackagedCollaborationGate` 替代硬编码 `!app.isPackaged`；默认 prefs 全关 → 打包行为不变（`registerIpc=false`，打印 `[collaboration] disabled: ...`），dev 仍 `registerIpc=true`；始终注册 prefs/certs 管理 IPC。
- `preload/index.ts` + `renderer/App.tsx`：新增 5 个 `electronAPI` 方法（`getFusionRoomNetworkPrefs` / `setFusionRoomNetworkPrefs` / `listFusionRoomCerts` / `generateFusionRoomCert` / `revokeFusionRoomCert`），App.tsx 全局声明同步（与 preload 同口径，遵循「新增 preload IPC 须同步 App.tsx」约定）。
- `config/config-paths.ts`：新增 `getFusionRoomNetworkPrefsPath()`（`~/.tagent[-dev]/collaboration/fusion-room-network-prefs.json`）。
- `fusion-room-runtime.test.ts`：修 Bun 1.3.14 下 `instanceof HttpsServer` 误报（Bun 的 `node:http`/`node:https` Server 共用同一 constructor、且 `https.createServer({})` 无证书会降级为明文 HTTP）。改为跨运行时稳定的行为探测：明文 HTTP transport 接受明文请求；HTTPS transport（用 cert store 产出的真实自签材料构造）对明文请求做 TLS 握手并失败。新增 cert store → runtime loopback `start/close` 集成用例。**未删任何安全断言**，只换 Bun/Node 都稳的探测方式。
- 不改 `fusion-room-runtime.ts` 的 loopback 明文拒绝语义；cert store 只产出可喂给 `FusionRoomTlsOptions` 的材料，非 loopback 放行仍由 runtime + 显式闸门决定。

验证（实跑结果）：
- `bun test apps/electron/src/main/lib/collaboration/fusion-room-network-prefs.test.ts` → 12 pass / 0 fail / 37 expect。
- `bun test apps/electron/src/main/lib/collaboration/fusion-room-cert-store.test.ts` → 7 pass / 0 fail / 43 expect。
- `bun test apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts` → **20 pass / 0 fail / 113 expect**（修复了 §73 记录的 Bun `instanceof` 1 fail；新增 2 用例：行为探测 + cert store 集成）。
- `bun test packages/core/src/collaboration/fusion-room-acl.test.ts` → 21 pass / 0 fail / 58 expect。
- `bun run --filter='@tagent/core' typecheck` 通过；`bun run --filter='./apps/electron' typecheck` 通过；`git diff --check` 退出 0（仅 `packages/ui/.../tokens.css` 既存 LF→CRLF 提示，与本切片无关、未触碰）。
- runtime 行为探测在 Bun 1.3.14 与 Node 24 / vitest 2.1.9 下均 20 pass，确认跨运行时稳定。

闸门默认仍关闭的证据：
- `decidePackagedCollaborationGate({isPackaged:true, prefs:DEFAULT, hasActiveCert:false})` → `{registerIpc:false, allowNonLoopbackListen:false}`（`fusion-room-network-prefs.test.ts` 用例断言）。
- `main/index.ts` 默认 prefs 全关时走 `else` 分支，不 `import('./lib/collaboration/collaboration-ipc')`，协作室 IPC 不注册。
- `validateFusionRoomNetworkPrefs` 显式拒绝 `allowInsecureNetwork` 等明文公网开关；`FusionRoomNetworkPrefs` 不含任何不安全监听字段。
- cert store 撤销 / 过期证书不进 `resolveTlsOptions`，即不可用于 `start({host: 非 loopback})`。

明确未做（与 handoff §7/§8 一致）：
- 真实账户登录 / OAuth、邀请 token 与账户身份绑定、跨机器多用户 E2E、生产 CA、服务端部署配置。
- `allowNonLoopbackListen` 当前由决策函数产出并经 `console.log` 记录，但远程 FusionRoom transport 尚未从 Electron 启动接入（runtime 仍只在测试 / 显式装配中使用）；该输出是后续「transport 启动时据闸门 + 证书材料决定是否放行非 loopback」的前置信号，本切片不接通远程 transport 启动。
- 设置页危险区 UI 开关未做（API 已通过 preload + App.tsx 全量暴露并 typecheck，UI 属后续切片）。
- 跨节点单写者 / 乐观并发 / 事件总线 / 预算原子预留、持久 continuation worker、`BILLING_LOCKED` 费用闸门仍未做。
- 本切片只交付证书生命周期 + 显式闸门 + 决策函数与测试，**不代表打包版已默认可被公网访问或跨用户网络已可用**。