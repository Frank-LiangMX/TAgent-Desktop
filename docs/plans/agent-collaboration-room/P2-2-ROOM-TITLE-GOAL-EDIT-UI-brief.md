# P2-2 · 房间 title/goal 编辑 UI（本地 + 远程 Fusion 页，owner-only）

> **角色**：实现 agent（kscc）  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `09e76ac`（P0-3c 已合）  
> **上游**：authority `updateMetadata`、gateway `update-metadata`、`FusionRoomActionAdapter.updateMetadata`、本地 `updateCollaborationRoom` 已支持 `goal`

---

## 目标

补齐交接文档 P2 §2「title/goal 编辑 UI」缺口：

1. **本地** `CollaborationRoomsPage`：标题已有重命名；补 **目标（goal）编辑**（owner 或现有 rename 同等权限）。
2. **远程** `FusionRoomRemotePage`：补 **标题 + 目标** owner-only 内联/对话框编辑，经 `actions.updateMetadata`。
3. **单测**：纯函数或组件最小渲染测；不依赖 Electron GUI。
4. **文档**：§84 implementation log + 轻量更新 `13-HANDOFF` §7 P2 旁注。

---

## 已有能力（勿重复造轮）

| 层 | 入口 |
|---|---|
| Fusion authority | `FusionRoomAuthority.updateMetadata` — owner-only，`title`/`goal` 可选，幂等键 |
| Gateway | `{ type: 'update-metadata', input }` |
| Remote adapter | `FusionRoomActionAdapter.updateMetadata` |
| View model | `FusionRoomViewModel.title` / `.goal` / `.ownerUserId` |
| 本地 service | `CollaborationRoomService.updateRoom` 已收 `goal` |
| 本地 IPC | `updateCollaborationRoom({ roomId, title?, goal? })` |
| 本地 UI | 标题 pencil → `setTextPrompt("rename")`；goal 只读 truncate |

---

## 实现要求

### A. 本地 CollaborationRoomsPage

- 在 header 目标行（`目标：{room.goal}`）旁加编辑入口（pencil 或「编辑目标」），复用现有 `TextPromptDialog` / `setTextPrompt` 模式（与 rename 一致）。
- 新 prompt kind 如 `"edit-goal"`：multiline 可选（Textarea 优于单行若已有组件）；空字符串允许（清空目标）。
- 提交：`updateCollaborationRoom({ roomId, goal: trimmed })`；与当前值相同则 no-op。
- 权限：与 rename 一致（本地房间创建者/owner；若页面无 owner 字段则沿用现有 rename 可见性，不扩大权限）。
- 归档房间：disabled（与 rename 一致）。

### B. 远程 FusionRoomRemotePage

- Header 区：`view.title` 作主标题；`view.goal` 独立一行（非拼进 debug 串）。
- Owner-only：比较 `view.ownerUserId` 与当前 actor。远程页若无 actorUserId，用 gateway 注入的 principal——查 `FusionRoomRemoteSession` / controller 是否暴露 `actorUserId` 或 `isOwner`；若无，在 view-model 投影加 `canEditMetadata: boolean`（由 snapshot owner 与 session 的 authenticated userId 比较，**仅 UI 闸**，authority 仍 enforce）。
- 编辑 UX：最小可行——标题/目标各一个 inline 编辑或两个小对话框；busy/error 态；成功后 snapshot 刷新（`actions.updateMetadata` 已返回 view）。
- 非 owner：只读展示，不出编辑按钮。
- 调用：`actions.updateMetadata({ roomId: view.roomId, title?, goal?, idempotencyKey? })`；可分别改 title 或 goal。

### C. 测试

至少覆盖：

1. `fusion-room-action-adapter.test.ts`：补 `updateMetadata` dispatch 形状（若尚未有）。
2. 本地：组件测或 extract 纯函数 `canEditRoomMetadata(ownerUserId, actorUserId)`（若新增）。
3. Remote page：jsdom 最小渲染——owner 见编辑按钮、非 owner 不见；mock actions.updateMetadata。

禁止：实机 Electron GUI 手测声称完成。

### D. 禁止项

- **不**改 authority / gateway 协议语义。
- **不**动无关未提交文件：`BotSidecarPanel.tsx`、`BotSidecarPanel.test.tsx`、`image-lightbox.tsx`、`message/index.tsx`、`tokens.css`。
- **不**默认开网络 / 不做 OAuth / 不做跨机器 E2E。
- **不** push；可 commit，message 形如 `feat(fusion): P2-2 room title/goal edit UI (local + remote, owner-only)`。

---

## 验收

```powershell
bunx vitest run apps/electron/src/renderer/components/collaboration/fusion-room-action-adapter.test.ts
# + 本切片新增/修改的 test 文件
bun run --filter='./apps/electron' typecheck
git diff --check
```

---

## 交付物

1. 代码 + 测试  
2. `12-IMPLEMENTATION-LOG-2026-08-22.md` §84  
3. `13-HANDOFF-2026-08-23.md` §7 P2 旁注一行  
4. 返回：改动文件列表、测试结果、诚实未做项
