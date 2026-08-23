# P1-1 · 可观察 continuation outbox + 用户确认 resume（不自动重放）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main`（本地 ahead P0-1..P0-3b，未 push）  
> **上游**：[`13-HANDOFF` §7 P1-2 / §8 第 4 步](./13-HANDOFF-2026-08-23.md)、`fusion-room-host.recoverInterruptedRuns`、`collaboration-a2a.ts` delivery 迁移、`fusion-room-execution-bridge` 审批 continuation  

---

## 目标

落地第一刀 **可观察 outbox + 显式确认 resume**，服务离线/进程重启后：

- 已批准 approval、已回复 mailbox、仍停在 `delivery:'outbox'` 的信封、以及被标成 `blocked`（未知副作用）的 run **都能被列出观察**；  
- 涉及文件/命令/网络等未知副作用的 continuation **必须**进入显式 `resume_confirm`（或等价）状态，**禁止**启动时自动重放；  
- 用户（或房主 actor）确认后，才允许安全入队下一次 turn / 安全重投 outbox。

本切片以 **packages/core 协议 + Host API + 单测** 为主；**不要**做完整远程 UI。Execution bridge 可接最小 `confirm` 钩子，但默认仍不自动跑有副作用的旧 run。

---

## 建议设计（可微调，语义必须保留）

### 1. 观察模型（纯函数，易测）

新增例如 `packages/core/src/collaboration/fusion-room-continuation.ts`：

```ts
export type FusionContinuationKind =
  | 'blocked_run'           // recoverInterruptedRuns 标 blocked，未知副作用
  | 'pending_approval'      // approvals status=pending
  | 'approved_awaiting_resume' // approved 但对应 run 仍 awaiting_user / 未 continuation
  | 'mailbox_outbox'        // delivery === 'outbox'（尚未 dispatched）
  | 'awaiting_peer'         // 可观察；通常等 peer reply，不需用户 confirm
  | 'depth_stop'            // 可选：可 continue 一次的 depth stop 信封

export interface FusionContinuationItem {
  id: string                // 稳定 id：runId / approvalId / envelopeId
  roomId: string
  kind: FusionContinuationKind
  /** 是否需要人类显式确认后才能推进 */
  requiresUserConfirm: boolean
  /** 若自动推进是否可能有外部副作用（文件/命令/网络） */
  sideEffectRisk: 'none' | 'unknown' | 'known'
  summary: string
  createdAt?: number
  refs?: { runId?: string; seatId?: string; envelopeId?: string; approvalId?: string }
}

export function listFusionContinuations(snapshot: FusionRoomAuthoritySnapshot): FusionContinuationItem[]
```

规则：

- `blocked` run → `blocked_run`，`requiresUserConfirm=true`，`sideEffectRisk='unknown'`  
- `pending` approval → `pending_approval`，`requiresUserConfirm=true`（审批本身就是确认）  
- `delivery==='outbox'` 且未终态 → `mailbox_outbox`；**默认** `requiresUserConfirm=true` 若无法证明无副作用，否则可标 `sideEffectRisk:'none'` 且仍允许列表观察（安全重投也走 confirm 更稳）  
- `awaiting_peer` → 可观察，`requiresUserConfirm=false`（等 peer）  
- **不要**把 `completed/failed/cancelled` 放进列表  

### 2. Host API

在 `FusionRoomHost`（或相邻模块）增加：

- `listContinuations(roomId): FusionContinuationItem[]` → 调纯函数  
- `confirmResumeContinuation(input: { roomId; actorUserId; continuationId; kind; idempotencyKey? })`：  
  - 仅房主或具备权限的人类成员（与现有 active human 守卫对齐）  
  - `blocked_run`：将 run 标记为可恢复队列态（例如新增 status `resume_confirmed` **或** 写事件 `run.resume_confirmed` + 在 snapshot 旁路字段；**优先少改状态机**：可写 `CollaborationRoomEvent` + 返回「已确认、待 execution bridge 拉起新 turn」而不把旧 fence 的 running 复活）。**禁止**直接把旧 `fence` 的 blocked run 改回 `running` 并静默重放。  
  - `mailbox_outbox`：仅当 `canTransitionCollaborationDelivery(outbox → dispatched)` 时，把 delivery 推进为 `dispatched`（或项目既有「安全重投」语义），并写事件；若无法安全投递则 `outcome_unknown` 路径不得自动变回可重放。  
  - 幂等：同 `idempotencyKey` 重复确认返回同一结果。  

### 3. 启动路径

- `recoverInterruptedRuns()` 保持：running → blocked，**不**自动 confirm。  
- runtime 启动后可 `listContinuations` 供后续 UI/IPC；**本切片可不注册完整 renderer**，但 Host 测试必须覆盖「重启后仍能列出 blocked + outbox」。

### 4. Execution bridge（最小）

- 可选：增加 `confirmResumeBlockedRun` 后由 bridge 显式 `execute` **新** turn（新 runId/fence），prompt 注明「用户确认继续此前被中断的工作」。  
- 若改动面过大：本切片只做到 Host 事件 + 列表，bridge 留 TODO 并在 §76 写明。

---

## 允许 / 禁止

**允许**：core 新文件与测试；host/authority 小改；shared 类型若需为 run 增加 `resume_confirmed` 再三思——优先用事件而非膨胀状态枚举；文档 §76 + handoff §8 第 4 步旁注。

**禁止**：

- 启动自动重放 blocked run / dispatched 后 outcome_unknown 的信封  
- 打开公网 / 改 P0 闸门默认  
- 大改设置页 UI（P0-3b 已完成）  
- **可以 commit，不要 push**

---

## 必须测试

1. `listFusionContinuations`：空快照；blocked；pending approval；outbox；awaiting_peer；忽略 completed。  
2. `recoverInterruptedRuns` 后 list 含 blocked 且 `requiresUserConfirm=true`。  
3. `confirmResumeContinuation` 对 blocked：幂等；产生可观察「已确认」证据（事件或状态）；**旧 run 不得悄悄变回 running 并用同一 fence 继续**。  
4. outbox confirm：delivery 合法前进；非法迁移拒绝。  
5. 非成员 / 错误 continuationId → FORBIDDEN / NOT_FOUND。

```powershell
bun test packages/core/src/collaboration/fusion-room-continuation.test.ts
bun test packages/core/src/collaboration/fusion-room-host.test.ts
bun test packages/shared/src/types/collaboration-a2a.test.ts
bun run --filter='@tagent/core' typecheck
git diff --check
```

---

## 完成输出

1. 文件列表  
2. 确认策略（事件 vs 新 status）与「为何不自动重放」  
3. 测试结果  
4. 未做：完整 outbox worker 进程、远程 UI、真实 provider resume  
5. §76；commit；**勿 push**

先读 `recoverInterruptedRuns`、`canTransitionCollaborationDelivery`、mailbox `delivery:'outbox'` 写入点，再实现。
