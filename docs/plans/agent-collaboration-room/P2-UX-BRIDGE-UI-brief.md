# P2-UX-BRIDGE-UI · 单会话↔协作室桥接确认 UI

> **角色**：实现 agent（kscc）  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `716eda2`（服务层已合）  
> **规格**：[14-SESSION-COLLAB-BRIDGE-SPEC.md](./14-SESSION-COLLAB-BRIDGE-SPEC.md)  
> **上游**：`enterCollaborationWithBridge` / `exitCollaborationWithBridge` IPC 已暴露（须 `userConfirmed: true`）

---

## 目标

把「明示进房 / 明示退出」接到用户可见路径：

1. **关掉静默升级**：`SessionBotBar` 选满 2 个 Bot **不再**自动调 `upgradeFusionSessionToRoom`。  
2. **开启协作确认**：≥2 Bot 时按钮改为「开启协作」→ `DestructiveConfirmDialog`（或同等 AlertDialog）说明后果 → 确认后调 `enterCollaborationWithBridge({ sessionId, userConfirmed: true })` → 派发 `tagent:session-meta-changed`（Chat 切到协作壳）。  
3. **结束协作确认**：协作壳（`CollaborationRoomsPage`，且房间有 `sourceSessionId` 绑当前会话）头部加「结束协作」→ 确认 → `exitCollaborationWithBridge` → `session-meta-changed`（回到单会话壳 + 面板可见回写 system 卡）。  
4. **文案**：说人话（前情提要 / 写回摘要 / 原会话记录保留），不要技术词堆砌。  
5. 组件测 + toast busy/error；§87 + handoff / 14-SPEC §5。

---

## 非目标

- ❌ host 工具接 `read-source-excerpt`（另切片）  
- ❌ 改 bridge 服务预算/精炼逻辑  
- ❌ 改 Rail / 再加「协作」一级入口  
- ❌ 成员减到 1 个时**静默** exit（可选：移除后 toast 提示「可点结束协作」；**不要**自动调 exit）  
- ❌ 触碰 `BotSidecarPanel*` / `image-lightbox` / `message/index` / `tokens.css`  
- ❌ push

---

## A. SessionBotBar

文件：`apps/electron/src/renderer/components/chat/SessionBotBar.tsx`

1. `toggleBot`：保存 `botProfileIds` 后，**删除** `if (nextIds.length >= 2) await upgradeToRoom(...)`。  
2. ≥2 且无 `fusionRoomId`：显示「开启协作」按钮；点击 **先开确认框**，不要直接 IPC。  
3. 确认框文案建议：  
   - 标题：`开启协作？`  
   - 说明：将为当前会话创建协作室；单会话历史保留；会把近期对话精炼为前情提要交给协作成员；协作期间在本标签内使用协作界面。  
   - 确认：`开启协作` / 取消  
4. 确认后：`enterCollaborationWithBridge({ sessionId, userConfirmed: true })`；pending 禁用按钮；成功 → `tagent:session-meta-changed` + toast.success；失败 toast.error。  
5. **禁止**再调用 `upgradeFusionSessionToRoom`（旧静默路径从此 UI 断开）。  
6. 已有 `fusionRoomId`：按钮可隐藏（Chat 已切协作壳）或显示「协作中」disabled——选隐藏以免双入口。  
7. hint 文案改掉「多个 Bot 将进入融合会话路由」→「加入 2 个及以上 Bot 后，可点「开启协作」进入协作模式」。

可选小测：`SessionBotBar.test.tsx`（jsdom）—— mock `enterCollaborationWithBridge`：选 2 Bot 不自动调用；点开启→确认后才调用且带 `userConfirmed:true`。

## B. CollaborationRoomsPage — 结束协作

1. Props 增可选：`sourceSessionId?: string`（Chat 传入 `session.id`）、`onCollaborationExited?: () => void`。  
2. 当 `room.sourceSessionId` 存在且（若传了 sourceSessionId）与之相等时，头部显示「结束协作」按钮（不要和「归档」混淆）。  
3. 确认框：  
   - 标题：`结束协作？`  
   - 说明：将把协作结论精炼写回原会话；协作室记录保留（暂停）；本标签回到普通会话。  
   - 确认：`结束并写回`  
4. 调 `exitCollaborationWithBridge({ sessionId: room.sourceSessionId, userConfirmed: true })`；成功 → `tagent:session-meta-changed` + `onCollaborationExited?.()` + toast；失败 toast。  
5. Chat.tsx：  
```tsx
<CollaborationRoomsPage
  roomId={session.fusionRoomId}
  sourceSessionId={sessionId}
  ...
  onCollaborationExited={() => setFusionRoomRefreshKey((v) => v + 1)}
/>
```
（meta 变更后 `usePersistedSessionMeta` 应清掉 fusionRoomId → 自动切回普通 Chat；若需强制 bump 已有 refreshKey。）

## C. 确认框组件

优先复用 `@tagent/ui` 的 `DestructiveConfirmDialog`（已有 pendingLabel）。进房非删除语义也可用同一组件，换 title/confirmLabel 即可；不必新造 modal。

## D. 文档

- `12-IMPLEMENTATION-LOG` §87  
- `13-HANDOFF` §7 P2 旁注  
- `14-SPEC` §5：UI 层 ✅；host 工具仍待  
- commit：`feat(fusion): P2-UX bridge confirm UI for enter/exit collaboration`；不 push

---

## 验收

```powershell
# 若有新增测试：
bunx vitest run apps/electron/src/renderer/components/chat/SessionBotBar.test.tsx
# 及相关 collab page 测（若有）
bun run --filter='./apps/electron' typecheck
git diff --check
```

手测说明写进 §87（无 Electron GUI 时以组件测 + typecheck 为准）。

返回：改动文件、测试结果、未做项（host 工具、成员减员自动提示可选是否做了）。
