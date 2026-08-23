# P2-UX-BRIDGE-SERVICE · 单会话↔协作室桥接服务层

> **角色**：实现 agent（kscc）  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `9a8aa3a`（契约层已合）  
> **产品规格**：[14-SESSION-COLLAB-BRIDGE-SPEC.md](./14-SESSION-COLLAB-BRIDGE-SPEC.md)  
> **契约**：[session-collab-bridge.ts](../../../packages/shared/src/types/session-collab-bridge.ts)  
> **上游 brief**：`P2-UX-BRIDGE-ENTER-EXIT-CONTRACT-brief.md`（已完成）

---

## 目标

在**不改 UI、不静默改自动升级行为**的前提下，落地服务层：

1. **明示进房**：`userConfirmed === true` 才允许；调用既有 `upgradeFusionSession`；把单会话面板消息精炼为 `SessionToRoomBrief`，写入房间 `goal`（短）+ **系统消息**（完整 formatted brief）+ 可选房间摘要种子。  
2. **明示退出**：`userConfirmed === true` 才允许；精炼协作结论为 `RoomToSessionHandoff`，**写回**原 session 面板（system 消息）；清除 `fusionRoomId` / 调整 `fusionMode`；房间保留（可 `paused`，勿删历史）。  
3. **按需读原史**：`readSourceSessionExcerpt` 服务函数（预算校验 + 读 panel + clamp）；IPC 暴露；**本切片不接 host 工具表**（工具接线留后）。  
4. LLM 可注入；失败 **fail-closed 启发式**（从最近消息抽字段），不抛崩、不阻塞建房。  
5. 单测 + §86 log + handoff / 14-SPEC §5 旁注。

---

## 非目标（禁止）

- ❌ 改 `SessionBotBar` 自动升级 UI / 加确认弹窗（UI 层下一切片）  
- ❌ 改 `removeMember` 静默回退为自动 exit（须用户确认；本切片只提供 exit API）  
- ❌ 把单会话运行时改成 room 投影  
- ❌ 整包原 JSONL 塞进每轮 prompt  
- ❌ 触碰 `BotSidecarPanel*` / `image-lightbox` / `message/index` / `tokens.css`  
- ❌ push

---

## 建议落点

```text
apps/electron/src/main/lib/collaboration/
  session-collab-bridge-service.ts       # 核心服务
  session-collab-bridge-service.test.ts  # 假 modelCaller + 临时目录
  collaboration-ipc.ts                  # 注册 3 个 IPC
packages/shared/src/types/
  collaboration-room-channels.ts        # 新 channel + input/output 类型
apps/electron/src/preload/index.ts      # 暴露 API
apps/electron/src/renderer/App.tsx      # Window.electronAPI 类型同步
```

复用：

- `CollaborationRoomService.upgradeFusionSession` / `updateRoom` / `appendSystemMessage`（若 private，本切片可加 package-visible helper 或 public thin wrapper，**勿复制建房逻辑**）  
- `readPanelMessages` / `appendPanelMessages` / `getSessionMeta` / `updateSessionMeta`  
- `listMessagesByRoom` / `listRoomTasksByRoom` / `getCollaborationSummary`  
- `@tagent/shared` 契约：`buildSessionToRoomBrief` / `format*` / `clampBridgeText` / `validateSourceExcerptBudget`  
- 便宜模型：优先注入 `modelCaller`；默认实现可复用 `completeMemoryLlm` **或** 与 `CollaborationSummaryRunner` 同风格的 seat runner——**测试必须注入假 caller**，CI 不打真网。

---

## API 契约

### Enter

```ts
export interface EnterCollaborationWithBridgeInput {
  sessionId: string
  /** 必须为 true；否则抛 USER_CONFIRM_REQUIRED */
  userConfirmed: true
  title?: string
  goalHint?: string  // 用户/UI 可选短目标，优先进 brief.goal
  signal?: AbortSignal
}

export interface EnterCollaborationWithBridgeResult {
  roomId: string
  sourceSessionId: string
  brief: SessionToRoomBrief
  briefSource: 'llm' | 'heuristic'
  reusedExistingRoom: boolean
}
```

流程：

1. `userConfirmed !== true` → 抛错（稳定 code/message）。  
2. 读 meta；若已有 `fusionRoomId` 且房间存在 → **幂等**：可选刷新 brief（本切片：**不重复 summarize**，直接返回 `reusedExistingRoom: true` + 空/既有说明即可；或读房间最近一条「前情提要」系统消息解析——选简单：返回 reuse，brief 用房间 goal 填最小结构）。  
3. 否则 `upgradeFusionSession({ sessionId, title, goal: goalHint })`。  
4. 读 panel 消息 → `transcriptForSummarize`（最近有效发言，字符硬顶 ≈ 进房 DEFAULT×CHARS_PER_TOKEN 的 **输入侧** 再加一档，建议输入硬顶 12k 字符；超则头尾保留）。  
5. 调 `modelCaller` 要求返回 **JSON**（goal/decisions/openQuestions/todos/artifacts）；解析失败或抛错 → **heuristic**：取最近 user 文本作 goal，其余列表空，`narrative` = 最近若干条拼接再 clamp。  
6. `buildSessionToRoomBrief({ ..., sourceSessionId, budgetTokens: DEFAULT })`。  
7. `updateRoom({ roomId, goal: brief.goal || room.goal })`；`appendSystemMessage(roomId, '【单会话前情提要】\n' + formatSessionToRoomBriefForPrompt(brief))`。  
8. 返回 result。

### Exit

```ts
export interface ExitCollaborationWithBridgeInput {
  sessionId: string
  userConfirmed: true
  signal?: AbortSignal
}

export interface ExitCollaborationWithBridgeResult {
  roomId: string
  sourceSessionId: string
  handoff: RoomToSessionHandoff
  handoffSource: 'llm' | 'heuristic'
}
```

流程：

1. 确认闸。  
2. meta 必须有 `fusionRoomId`；房间必须存在。  
3. 收集房间消息/任务/现有 summary → 模型或启发式 → `buildRoomToSessionHandoff`。  
4. `appendPanelMessages` 写一条 `type:'system'`（或项目惯例的可见系统卡），正文 = `【协作室回写】\n` + `formatRoomToSessionHandoffForPrompt(handoff)`。  
5. `updateSessionMeta(sessionId, { fusionRoomId: undefined, fusionMode: 按剩余 botProfileIds 算 ordinary|single-bot|…, fusionCoordinatorBotProfileId: 视情况清 })`——**对齐** `syncSourceSessionAfterRoomMemberChange` 的降档语义，但**不要**依赖成员数自动触发；exit 是用户显式结束协作。建议 exit 后：`fusionRoomId` 清空；`fusionMode` 按当前 `botProfileIds.length` 重算；房间 `updateRoom({ status: 'paused' })`（保留可从协作列表再看，但不绑 Chat 壳）。  
6. 推 `session_meta_changed`（若有现成 sendPayload 入口，经 IPC 层调 session 服务事件；没有则至少 meta 落盘，renderer 下次读 meta 生效——在 FINDINGS/§86 写明）。

### Excerpt

```ts
readSourceSessionExcerpt(
  req: SourceSessionExcerptRequest,
  alreadyUsedThisTurnTokens: number,
): SourceSessionExcerptResult
```

- `validateSourceExcerptBudget` 失败 → 抛或返回 truncated 空（选抛稳定错误，IPC 可映射）。  
- 读 `sourceSessionId` 的 panel；`query` 有则简单包含匹配（大小写不敏感），否则最近 N 条（默认 12）。  
- `clampBridgeText` 到 allowedTokens。

---

## IPC

在 `COLLABORATION_ROOM_IPC_CHANNELS` 增加：

- `ENTER_WITH_BRIDGE: 'collaboration-room:enter-with-bridge'`  
- `EXIT_WITH_BRIDGE: 'collaboration-room:exit-with-bridge'`  
- `READ_SOURCE_EXCERPT: 'collaboration-room:read-source-excerpt'`

preload + App.tsx 同步。`userConfirmed` 必须由 renderer 传入；主进程再校验。

**保留**旧 `upgrade-from-session` 不动（UI 未改前旧路径仍可用）；§86 标明「旧路径仍无精炼桥；新路径须走 enter-with-bridge」。

---

## 测试（必须，无真网）

`session-collab-bridge-service.test.ts`：

1. enter 缺 `userConfirmed` → 抛。  
2. enter + 假 LLM JSON → room.goal 更新 + 系统消息含「前情提要」+ briefSource=`llm`。  
3. enter + 假 LLM 抛错 → heuristic 仍成功建房/写 brief。  
4. enter 已有 fusionRoomId → reusedExistingRoom。  
5. exit 缺确认 → 抛；exit 成功 → panel 有回写 system 消息 + meta.fusionRoomId 清空 + room paused。  
6. excerpt 超单轮预算 → 拒绝；正常 → truncated/tokenEstimate 合理。  

可用临时 `TAGENT_*` 数据目录 / 既有 collab test harness（对照 `collaboration-room-bot.test.ts`）。

---

## 文档

1. `12-IMPLEMENTATION-LOG` **§86**  
2. `13-HANDOFF` §7 P2 旁注：服务层已落地，UI 确认仍未做  
3. `14-SESSION-COLLAB-BRIDGE-SPEC` §5：服务层 ✅ / UI 待做  
4. commit：`feat(fusion): P2-UX bridge service enter/exit/excerpt (confirm-gated)`；**不 push**

---

## 验收

```powershell
bunx vitest run apps/electron/src/main/lib/collaboration/session-collab-bridge-service.test.ts
bun run --filter='./apps/electron' typecheck
git diff --check
```

返回：改动文件、测试结果、诚实未做（UI、host 工具接线、旧 upgrade 静默路径未关）。
