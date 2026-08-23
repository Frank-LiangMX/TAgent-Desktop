# P1-1b · confirm-resume → 新 turn（bridge）+ Gateway/Adapter + 远程页最小 UI

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main`（本地已有 P1-1 `da43aa7` 等，ahead 未 push）  
> **上游**：[`P1-1-CONTINUATION-OUTBOX-brief.md`](./P1-1-CONTINUATION-OUTBOX-brief.md)、`fusion-room-execution-bridge.ts`、`fusion-room-gateway.ts`、`FusionRoomRemotePage.tsx`、`fusion-room-action-adapter.ts`、`fusion-room-view-model.ts`

---

## 目标

把 P1-1 的「用户确认 resume」接到真正可执行的链路，并在远程融合页给出最小可观察/可点确认 UI：

1. **Execution bridge**：收到 `confirm-resume-continuation` 结果后：
   - `blocked_run`：以**新** `start-run`（新 runId/fence，新 idempotencyKey）拉起 seat 的新 turn；prompt 标明「用户已确认继续此前被中断的工作」；**绝不**复用旧 fence / 把 blocked 改回 running。  
   - `mailbox_outbox`：delivery 已由 authority 推进为 `dispatched` 后，按现有 `send-mailbox` 类似路径唤醒 `toMemberId`（若信封类型需要），或至少确保不自动重放 `outcome_unknown`。  
2. **Gateway**：增加 wire action `confirm-resume-continuation`（payload **不含** actorUserId；由 principal 注入）。  
3. **ViewModel**：`createFusionRoomViewModel` 增加 `continuations: FusionContinuationItem[]`（调用 `listFusionContinuations(snapshot)`；可从 `@tagent/core` 导出纯函数）。  
4. **ActionAdapter**：`confirmResumeContinuation({ continuationId, kind, idempotencyKey? })`。  
5. **FusionRoomRemotePage**：在审批/mailbox 区块旁增加「待确认续跑」列表；对 `requiresUserConfirm===true` 显示「确认继续」按钮；busy/error 态；确认后依赖 snapshot 刷新。  
6. **测试**：bridge 单测（blocked confirm → 新 run completed，旧 run 仍 blocked）；gateway 注入 actor 测；view-model continuations 投影测；adapter 测（若已有模式）。  
7. **文档**：§77；handoff 旁注。

---

## 允许 / 禁止

**允许**：改 bridge / gateway / view-model / action-adapter / FusionRoomRemotePage；导出 continuation 类型；扩展 gateway test / bridge test。

**禁止**：

- 启动自动 confirm / 自动重放 blocked  
- 把旧 fence 复活为 running  
- 打开公网、改 P0 闸门默认  
- 大改本地 CollaborationRoomService（legacy）除非必要；本切片聚焦 Fusion RoomSession 链路  
- **可以 commit，不要 push**；勿动 `tokens.css`

---

## Bridge 行为细则

`handleAction(roomId, { type: 'confirm-resume-continuation' }, result)`：

- `result` 为 `FusionResumeContinuationResult`  
- 仅当 `status === 'confirmed' | 'already_confirmed'` 时调度（already 也要幂等不双开：用稳定 executionKey 如 `resume:" + continuationId`）  
- `blocked_run`：从 snapshot 取旧 run → seat + triggerMessage；若缺 triggerMessage，可用房间最近一条用户消息或跳过并打日志（优先有 triggerMessageId）  
- 新 turn 的 `idempotencyKey` / executionKey 必须与旧 `fusion-run:` 不同，例如 `fusion-resume:" + oldRunId`  
- `mailbox_outbox`：取 envelope，找 root message + toMember seat，`schedule(..., 'resume-mailbox:'+id, '用户已确认重投未送达的协作消息：'+payload)`  

`runtime` 里已有 `onAction → executionBridge.handleAction`：确认走 `host.dispatch` / gateway 后应能自然触发；补测覆盖。

---

## UI 细则

- 只展示 `listFusionContinuations` 结果（或 view.continuations）  
- `requiresUserConfirm` 才出按钮；`awaiting_peer` 只读展示  
- 文案简洁：种类中文短标签 + summary 截断  
- 不展示私钥/内部 fence 细节（可显示 runId 短尾）  

---

## 验证

```powershell
bun test apps/electron/src/main/lib/collaboration/fusion-room-execution-bridge.test.ts
bun test packages/core/src/collaboration/fusion-room-gateway.test.ts
bun test packages/core/src/collaboration/fusion-room-continuation.test.ts
bun test packages/core/src/collaboration/fusion-room-host.test.ts
bun test apps/electron/src/renderer/components/collaboration/fusion-room-view-model.test.ts
bun test apps/electron/src/renderer/components/collaboration/fusion-room-action-adapter.test.ts
bun run --filter='@tagent/core' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

无 Electron GUI：不要求实机点远程页；用单测证明 bridge 新 turn + view 投影。§77 注明未做实机手测。

---

## 完成输出

1. 文件列表  
2. bridge 如何保证新 fence  
3. 测试结果  
4. 未做：持久 outbox worker 进程、本地 legacy 协作室同等 UI、真实 provider resume  
5. §77；commit；**勿 push**
