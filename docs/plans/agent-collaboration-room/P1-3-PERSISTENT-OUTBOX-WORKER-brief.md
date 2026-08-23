# P1-3 · 持久 Outbox Worker（可观察 + 安全 drain，副作用项需确认）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `cbfd6cb`  
> **上游**：P1-1/P1-1b continuation、`FusionRoomHost.recoverInterruptedRuns`、`listFusionContinuations`、legacy `CollaborationRoomService.recoverInterruptedRuns` 的 outbox 安全重投语义

---

## 目标

为 **Fusion RoomSession** 增加持久 outbox worker：

1. **扫描可观察 continuation**（复用 `listFusionContinuations`）。  
2. **安全自动 drain**（仅无/未启动副作用的项）：  
   - `approved_awaiting_resume`（用户已批准，`requiresUserConfirm=false`）→ 驱动 execution bridge 拉新 turn（同 P1-1b approval 路径）。  
   - `mailbox_outbox` 且 `delivery==='outbox'`（尚未 dispatched，对齐 legacy「无 deliveryRunId 可安全重投」）→ 以 **房主 actor** 调用 `confirmResumeContinuation`（幂等）并让 bridge 处理 `confirm-resume-continuation` 结果。  
3. **绝不自动**：`blocked_run`、`pending_approval`、`depth_stop`、`outcome_unknown`、已 `dispatched/accepted` 的信封。  
4. **持久化**已处理 continuation 键，避免重启双开；worker 状态文件 atomic 写。  
5. Runtime 启动：`recoverInterruptedRuns` 之后跑一次 `drainAll`；可选 interval（默认关或长间隔）。  
6. §81 + handoff。

---

## 建议 API

```ts
// apps/electron/.../fusion-room-outbox-worker.ts

export type OutboxDrainAction =
  | { kind: 'auto'; continuationId: string; continuationKind: FusionContinuationKind; result: 'drained' | 'skipped' | 'failed'; detail?: string }
  | { kind: 'observe'; continuationId: string; continuationKind: FusionContinuationKind; reason: string }

export interface FusionRoomOutboxWorkerOptions {
  host: FusionRoomHost
  executionBridge?: FusionRoomExecutionBridge
  /** 状态文件路径；默认 getCollaborationDir()/fusion-outbox-worker.json */
  statePath?: string
  /** 系统 drain 使用的 actor；默认各房间 ownerUserId */
  resolveActorUserId?: (roomId: string) => string
}

export class FusionRoomOutboxWorker {
  constructor(options: FusionRoomOutboxWorkerOptions)
  /** 只读扫描 */
  scan(roomId: string): FusionContinuationItem[]
  scanAll(): Array<{ roomId: string; items: FusionContinuationItem[] }>
  /** 对单房间执行策略；返回动作日志 */
  drainRoom(roomId: string): OutboxDrainAction[]
  drainAll(): OutboxDrainAction[]
  /** 已处理键（持久） */
  listProcessedKeys(): string[]
}
```

处理键建议：`roomId + ':' + kind + ':' + continuationId`（approval 用 approvalId；blocked 永不写入 processed-as-auto）。

策略函数可纯函数化便于测：

```ts
export function classifyOutboxDrain(item: FusionContinuationItem): 'auto' | 'observe'
// auto: approved_awaiting_resume | mailbox_outbox（且调用方再校验 delivery）
// observe: 其余
```

对 `mailbox_outbox`：drain 前再读 snapshot，确认 `delivery==='outbox'`；否则 observe。

`approved_awaiting_resume`：从 snapshot 取 approval，构造 bridge 可识别的结果，调用  
`executionBridge.handleAction(roomId, { type: 'resolve-approval' }, approval)`  
（与用户刚批准时相同；若 bridge 未注入则只记 observe/skipped）。

---

## 接线

- `createFusionRoomTransportRuntime`：`recoverInterruptedRuns` 后  
  `const worker = new FusionRoomOutboxWorker({ host, executionBridge }); worker.drainAll()`  
  并把 `worker` 挂到 runtime 返回值（`readonly outboxWorker?: FusionRoomOutboxWorker`）。  
- **不要**默认开短轮询；若加 `outboxPollMs`，默认 `undefined`/0 = 不轮询。  
- CollaborationRoomService legacy 路径本切片**可不改**（已有 recover outbox 重投）；§81 注明「Fusion worker 与 legacy recover 语义对齐」。

---

## 测试（必须离线）

1. classify：各 kind → auto/observe。  
2. drain：approved_awaiting_resume → bridge 被调用一次；重复 drain 因 processed 键不双开。  
3. drain：mailbox_outbox + delivery outbox → confirm-resume 推进 + bridge；delivery 已非 outbox → skip。  
4. blocked_run / pending_approval → 仅 observe，不改 snapshot。  
5. 状态文件：drain 后新 Worker 同 path 仍记得 processed。  
6. runtime：`enableDefaultMemberExecution` 或注入 adapter 时，启动路径调用 recover + drain（可用 spy/计数）。

```powershell
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-outbox-worker.test.ts
bunx vitest run packages/core/src/collaboration/fusion-room-continuation.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts
bun run --filter='@tagent/core' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

---

## 禁止

- 自动重放 blocked_run / outcome_unknown  
- 默认打开公网 / 短轮询打爆模型  
- 动无关 unstaged UI 文件  
- **可以 commit；主控 push**

---

## 完成输出

1. 文件列表  
2. auto vs observe 策略表  
3. 测试结果  
4. 未做：legacy service 共用 worker、IPC 暴露 scan、轮询默认开  
5. §81；commit；勿自行 push
