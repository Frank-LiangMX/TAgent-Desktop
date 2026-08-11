# Agent 协作室 Stage 1 实现说明

> 分支：`feature/collab-room`
> 上游规格：`docs/plans/agent-collaboration-room/00-MASTER.md` · `01-PRODUCT-UX-SPEC.md` · `02-RUNTIME-A2A-SPEC.md`（§2 字段契约）· `03-IMPLEMENTATION-PHASES.md` §3 · `docs/decisions/ADR-0007-agent-collaboration-room.md`
> 范围：静态房间壳 + 落盘 + CRUD；**不**自动运行 Agent、**不** A2A、**不**多成员并行调度。

## 1. 做了什么

### A. Shared（`packages/shared/src/types/`）

| 文件 | 作用 |
| --- | --- |
| `collaboration-room.ts` | 领域实体与状态枚举：`CollaborationRoom` / `CollaborationMember` / `CollaborationMessage`（最小可用模型）+ `CollaborationRun` / `CollaborationMailboxEnvelope` / `CollaborationRoomTask`（S2+ 占位类型与状态枚举）。含默认常量（并发 3 / A2A 深度 4 / 硬上限 10 / 成员上限 6）、ID 前缀、创建/更新/追加输入类型、`isCollaborationRoomStatus` / `isCollaborationMemberStatus` 类型守卫、`validateCreateCollaborationRoomInput` 输入校验。 |
| `collaboration-room-channels.ts` | `COLLABORATION_ROOM_IPC_CHANNELS` 通道常量（`collaboration-room:list/create/get/update/list-messages/append-user-message/list-members` + `changed` S2+ 占位）+ IPC payload 类型。 |
| `collaboration-room.test.ts` | 13 个单测：常量、状态类型守卫、create 输入校验（空标题/超长/成员超限/成员名空/并发越界/A2A 深度超硬上限）。 |
| `types/index.ts` | barrel 新增 `export * from './collaboration-room'` / `'./collaboration-room-channels'`。 |

### B. Main（`apps/electron/src/main/lib/collaboration/`）

| 文件 | 作用 |
| --- | --- |
| `collaboration-room-repository.ts` | atomic-json 持久化，三份文件 `~/.tagent[-dev]/collaboration/{rooms,members,messages}.json`，各 `{version, items}`。`loadRooms/saveRooms/upsertRoom/getRoom`、`loadMembers/saveMembers/appendMembers/listMembersByRoom`、`listMessagesByRoom/appendMessage`。读写均走 `readJsonSafe`/`writeJsonAtomic`（tmp + .bak + rename，损坏自愈）。 |
| `collaboration-room-service.ts` | `CollaborationRoomService`（`static create()`，无状态）：`listRooms / createRoom / getRoomById / updateRoom / listMessages / appendUserMessage / listMembers`。含 ID 生成（`cr_/cm_/msg_/ls_` + `randomUUID`）、默认值、状态转换（archive 记 `archivedAt`、resume 清）、协调者解析（显式标记 → 否则指派首成员 → 空白团队留空）、`appendUserMessage` 只落盘静态用户消息。 |
| `collaboration-ipc.ts` | `registerCollaborationRoomIpc()` 注册 7 个 `ipcMain.handle`，委托给 service 实例；service 抛错 → invoke reject，渲染层 try/catch。 |
| `collaboration-room-repository.test.ts` | 10 个集成测试（`TAGENT_CONFIG_DIR` 指向临时目录）：createRoom + 成员 + 协调者解析、getRoom/listRooms、appendUserMessage + listMessages、updateRoom（rename/pause/archive + archivedAt）、**「重启后数据仍在」（新 service 实例读到已落盘数据）**。 |

接线改动：
- `main/lib/config/config-paths.ts`：新增 `getCollaborationDir/Path`（`mkdirSync` 兜底建 `collaboration/` 子目录）。
- `main/index.ts`：在 `bootstrapKanban` 后动态 `import('./lib/collaboration/collaboration-ipc')` 并 `registerCollaborationRoomIpc()`。
- `preload/index.ts`：`electronAPI` 新增 `listCollaborationRooms / createCollaborationRoom / getCollaborationRoom / updateCollaborationRoom / listCollaborationMessages / appendCollaborationUserMessage / listCollaborationMembers`（`ipcRenderer.invoke(...) as Promise<T>`）。

### C. Renderer

| 文件 | 作用 |
| --- | --- |
| `components/shell/Rail.tsx` | `RailItem` 新增 `'collaboration'`（位于 chat 之后）；新增 `onCollaboration` prop 与 `<RailIcon railId="collaboration" icon={<CirclesThreePlus/>} label="协作">`（不复用角色库的 `UsersThree`，符合 01-UX-SPEC §1.1）。 |
| `components/collaboration/CollaborationRoomSidebar.tsx` | 房间列表 + 新建 + 选中 + 每房间「更多」菜单（重命名 / 暂停-恢复 / 归档）+ 已归档底栏（恢复）。 |
| `components/collaboration/CollaborationRoomsPage.tsx` | 空态引导 + 选中房间头部（标题/状态/目标/成员数 + 重命名/暂停/归档）+ 时间线（只显示已存消息，简单气泡）+ `ChatInput` 发**静态用户消息**（`appendCollaborationUserMessage` → 落盘 + 刷新，不 `sendAgent`）。 |
| `App.tsx` | `declare global electronAPI` 加 7 个方法签名；`railSupportsSidebar` 改为 `chat \|\| collaboration`；`sidebarOpen` 门用 `railSupportsSidebar(activeRail)`；`sidebar={...}` 按 `activeRail` 分支（collaboration → `CollaborationRoomSidebar`，其余 → `SessionSidebar`）；主区路由顶部加 `activeRail === 'collaboration'` 分支；新增 `activeCollaborationRoomId / collabRefreshKey` 状态与 `selectCollaborationRoom / newCollaborationRoom / bumpCollab`；`<Rail onCollaboration={...}>`。 |

文案统一用「协作室 / 成员 / 房间」，避免「数字员工」（空态说明里提及 Stage 1 边界，不作信息架构名）。

## 2. 如何手测

> 启动：`bun run dev`（或 `apps/electron` 下 `bun run dev`）。

1. **Rail 切换不破坏普通会话**
   - 打开会话，发几条消息 / 留一个 tab。
   - 点 Rail「协作」→ 进入协作室空态；会话侧栏/会话/草稿不受影响。
   - 切回「会话」→ 之前的 tab/草稿/绿点状态正常（离开会话页会清当前会话绿点，与切到插件/记忆/角色库行为一致）。
   - 再点当前「协作」Rail → 侧栏折叠/展开切换。

2. **创建房间 → 发两条用户消息 → 重启 → 仍在**
   - 协作室侧栏点「新建」→ 创建「新协作室」并选中。
   - 在主区输入框发两条消息（Enter 发送）→ 时间线出现两条用户气泡。
   - 关闭 app 再重开 → 切到协作 → 房间仍在、消息仍在（侧栏列表 + 时间线均恢复）。
   - 自动化等价：`collaboration-room-repository.test.ts` 的「重启后数据仍在」用例。

3. **归档 / 暂停可验证**
   - 房间行「更多」菜单 → 重命名（弹 `prompt`）→ 名字更新。
   - 「暂停新运行」→ 状态标签变「已暂停」、侧栏圆点变琥珀；头部按钮变「恢复运行」。
   - 「归档」→ 房间从主列表消失，进入侧栏「已归档（N）」；主区输入框变「已归档房间不再发送新消息」提示。
   - 展开已归档 → 点「▶ 恢复」→ 房间回到主列表，`archivedAt` 清空。
   - 同样的重命名/暂停/归档入口也在主区头部按钮可操作。

数据落盘位置：`~/.tagent-dev/collaboration/{rooms,members,messages}.json`（dev 模式；正式为 `~/.tagent/collaboration/`）。

## 3. 验证结果

- `vitest run packages/shared`：24 文件 / 476 用例全过（含新增 `collaboration-room.test.ts` 13 个）。
- `vitest run apps/electron/src/main/lib/collaboration/collaboration-room-repository.test.ts`：10 个全过（含重启持久化）。
- `tsc --noEmit -p packages/shared/tsconfig.json`：0 错误。
- `tsc --noEmit -p apps/electron/tsconfig.json`：0 错误（main + preload + renderer 全量）。
- `build:main` + `build:preload`（esbuild）：构建成功；`dist/main.cjs` / `dist/preload.cjs` 均含全部 8 个 `collaboration-room:*` 通道字符串与 `registerCollaborationRoomIpc`（未被 tree-shake）。

## 4. 未做（S2+ 入口）

按 `03-IMPLEMENTATION-PHASES.md` 的阶段切片，以下留到后续阶段，代码里已留类型/状态枚举占位：

- **S2 单成员真实运行**：`MemberBackendAdapter`（`capabilities()` + `runTurn`）、`MemberTurnInput` 上下文投影、`CollaborationRun` 真实读写、run 状态机（queued→running→done/failed/cancelled）、事件 outbox + IPC 推送、成员卡 / run 详情页。当前 `appendUserMessage` 不触发任何 run，`capabilities` 全 false，`status='offline'`。
- **S3 多成员并行 + 协调者**：`RoomScheduler`（房间总并发、成员内串行、公平队列、scheduler lease）、无点名路由协调者、多点名并行扇出、预算/并发上限强制。
- **S4 结构化 A2A 与等待恢复**：`room_send/ask/reply/publish_artifact/task_update/request_user` 工具、`CollaborationMailboxEnvelope` 真实读写、`awaiting_peer/awaiting_user`、root/causation/depth + fingerprint + 循环检测 + TTL。`COLLABORATION_ROOM_IPC_CHANNELS.CHANGED` 事件广播此时启用（Stage 1 渲染层在变更后主动重新拉取）。
- **S5 任务 / 产物 / 看板**：`CollaborationRoomTask` 真实读写、room task ↔ kanban task bridge、`attachedBoardId` 落地、产物校验（相对路径/hash/权限）。
- **S6 并发写入与生产化**：Git worktree / 文件租约、横向 prompt injection 隔离、预算统计与硬截止、时间线虚拟化、Markdown/附件渲染复用（Stage 1 时间线为 plain text 简单气泡）、错误恢复操作。

已知 Stage 1 简化（已在代码注释标注）：
- `appendUserMessage` 的 `authorId` 暂用 `'user'` 占位（S2+ 接真实用户身份）；`rootMessageId` 暂等于自身（S2+ 接回复链根解析）。
- `createRoom` 先写 `rooms.json` 再写 `members.json`，成员写失败时房间已落盘（可接受降级，S2+ 再补事务/回滚）。
- 协调者不变量为骨架版：未显式标记时指派首个成员；空白团队 `coordinatorMemberId=''`，S2+ 启动 run 前再强校验。
- 「新建」直接创建默认名「新协作室」的空白团队（无分步向导），重命名在头部/侧栏完成；多步创建向导（01-UX-SPEC §8）留 S2+。
