# P2-1 · 本地协作室「待确认续跑」完整切片

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `a253bd0`  
> **上游**：远程页 `FusionRoomRemotePage` 续跑 UI、`listFusionContinuations` 语义、`CollaborationRoomsPage` 审批/深度停止、`CollaborationRoomService.recoverInterruptedRuns`

---

## 目标

给 **本地 CollaborationRoomService 路径** 补齐与远程 Fusion 页对等的「待确认续跑」能力：

1. **列出**本地房间可观察 continuation（blocked run / pending approval / depth_stop / awaiting_peer / mailbox outbox 等）。  
2. **确认继续 blocked**：不复活旧 fence；基于原 `triggerMessageId` **新建** queued/running turn（新 runId/fence），旧 run 保持 `blocked`。  
3. **IPC + preload + App.tsx 类型**。  
4. **UI**：`CollaborationRoomsPage`（或工作面板旁）展示列表；`requiresUserConfirm` 的 blocked 出「确认继续」；pending approval / depth_stop 给只读提示并指向既有入口（或直接复用现有按钮）。  
5. 纯函数 list + 单测；§82 + handoff。

---

## 数据与 API

### 列表（建议放 shared 或 electron 旁纯函数，便于测）

形状对齐 Fusion 的 `FusionContinuationItem` 时可复用类型，或定义：

```ts
export type LocalCollaborationContinuationKind =
  | 'blocked_run'
  | 'pending_approval'
  | 'awaiting_peer'
  | 'awaiting_user'
  | 'depth_stop'
  | 'mailbox_outbox'

export interface LocalCollaborationContinuationItem {
  id: string
  roomId: string
  kind: LocalCollaborationContinuationKind
  requiresUserConfirm: boolean
  summary: string
  createdAt?: number
  refs?: { runId?: string; memberId?: string; envelopeId?: string; approvalId?: string }
}

export function listLocalCollaborationContinuations(input: {
  roomId: string
  runs: CollaborationRun[]
  mailbox: CollaborationMailboxEnvelope[]
  approvals: CollaborationUserApprovalRequest[]
  maxA2ADepth?: number
  handoffEnabled?: boolean
}): LocalCollaborationContinuationItem[]
```

规则对齐 Fusion / legacy：

- `run.status==='blocked'` → blocked_run，`requiresUserConfirm=true`  
- pending approval → pending_approval，`requiresUserConfirm=true`（确认走既有 resolve IPC）  
- awaiting_peer / awaiting_user → 只读观察  
- depth_stop presentable → depth_stop（确认走既有 continueDepthStop）  
- mailbox `delivery==='outbox'` 且未终态 → mailbox_outbox（legacy recover 已可能自动重投；列表仍可观察；本切片 **可不** 新开 outbox confirm，除非无自动重投路径）

### Service

```ts
listContinuations(roomId: string): LocalCollaborationContinuationItem[]
confirmResumeBlockedRun(input: { roomId: string; runId: string; idempotencyKey?: string }): 
  | { ok: true; newRunId: string }
  | { ok: false; reason: string }
```

`confirmResumeBlockedRun`：

- 校验 room active、run 存在且 `status==='blocked'`、member 未 removed、triggerMessage 仍在。  
- **禁止**把旧 run 改回 running。  
- 新建 run：新 id、新 fence、同一 memberId + triggerMessageId（注意现有幂等键 `collaborationRunIdempotencyKey(trigger, member)`——若会撞已有 blocked 的同一 key，需在幂等键中纳入 `resume-of:<oldRunId>` 或 `attempt` 递增，**写进实现与测试**）。  
- enqueue scheduler；broadcast CHANGED。  
- 幂等：同 idempotencyKey 重复调用返回同一 newRunId。

### IPC

- `collaboration-room:list-continuations` `{ roomId }` → items[]  
- `collaboration-room:confirm-resume-blocked` `{ roomId, runId, idempotencyKey? }` → ok 结果  

preload + `App.tsx` electronAPI 类型同步。

### UI

在 `CollaborationRoomsPage` 时间线旁/审批区附近加「待确认续跑」块（文案可抽与 Fusion 共用的 label map，避免复制粘贴失控——允许小 shared helper）。

- blocked：按钮「确认继续」→ confirm-resume-blocked IPC  
- pending_approval / depth_stop：提示「请使用下方审批 / 深度停止卡片」或滚动定位到既有 UI  
- busy/error toast  

---

## 禁止

- 复活旧 blocked run 的 fence  
- 自动重放 blocked（仍需用户点确认）  
- 大改远程 Fusion 页（可抽共用 label）  
- 动无关 unstaged UI（chat.css / lightbox / tokens）  
- **可以 commit；主控 push**

---

## 验证

```powershell
bunx vitest run packages/shared/src/types/collaboration-local-continuation.test.ts
# 或实际路径
bunx vitest run apps/electron/src/main/lib/collaboration/collaboration-room-continuation.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/collaboration-room-run.test.ts
bun run --filter='@tagent/shared' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

无 Electron GUI：UI 用组件/model 单测或最小渲染测；§82 注明未实机点击。

---

## 完成输出

1. 文件列表  
2. 幂等键如何避免与旧 blocked run 冲突  
3. 测试结果  
4. 未做：Fusion outbox scan IPC（若未做）、实机手测  
5. §82；commit；勿自行 push
