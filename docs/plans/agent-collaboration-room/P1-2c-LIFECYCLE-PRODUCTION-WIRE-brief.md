# P1-2c · 生产路径注入 MemberSessionLifecycle（CollaborationRoomService / Fusion runtime）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `4eb6e69`（已与 origin 同步）  
> **上游**：P1-2b（`bindTurnAbort` / `createChannelBackendAdapter(lifecycle?)`）、`collaboration-room-service.ts:313`、`fusion-room-runtime.ts`、`collaboration-ipc.ts`

---

## 现状缺口

- `CollaborationRoomService` 默认：`createChannelBackendAdapter()` **无 lifecycle** → interrupt 无法取消 inflight kscc turn（仅靠 service 自己的 `AbortController`，与 lifecycle heartbeat/interrupt 脱节）。  
- `createFusionRoomTransportRuntime`：只有显式传入 `memberAdapter` 才建 `ExecutionBridge`；无「默认带 lifecycle 的生产装配」工厂。  
- `cancelRun` 只 abort service 本地 controller，**不**调用 `lifecycle.interruptSession`。

---

## 目标

1. **默认生产装配**共享同一 `ChannelMemberSessionLifecycleAdapter` + `createChannelBackendAdapter(lifecycle)`。  
2. `CollaborationRoomService` 默认走该装配；`cancelRun` / turn 结束路径与 lifecycle 协作（cancel → `interruptSession`；turn 用 `logicalSessionId` + bindTurnAbort）。  
3. Fusion runtime 提供显式工厂（例如 `createDefaultFusionMemberExecution()` 或 `createFusionRoomTransportRuntime` 增加 `enableDefaultMemberExecution?: boolean`），默认仍可不启网络；**启用执行时**必须带 lifecycle。  
4. 单测证明：默认 service 路径 interrupt/cancel 能取消挂起 turn；未注入时行为可测。  
5. §80 + handoff 旁注。

---

## 建议实现

### A. 共享工厂

```ts
// member-backend-factory.ts（新）或放在 member-backend-adapter.ts
export function createDefaultChannelMemberStack(): {
  lifecycle: ChannelMemberSessionLifecycleAdapter
  adapter: MemberBackendAdapter
} {
  const lifecycle = new ChannelMemberSessionLifecycleAdapter()
  return { lifecycle, adapter: createChannelBackendAdapter(lifecycle) }
}
```

### B. CollaborationRoomService

- Options 增加可选 `lifecycle?: MemberSessionLifecycleAdapter`（测试可注入 Fake）。  
- 默认：`const stack = createDefaultChannelMemberStack(); adapter=stack.adapter; lifecycle=stack.lifecycle`。  
- 若调用方只传 `adapter` 不传 lifecycle → 保持旧行为（无 lifecycle），兼容现有测试。  
- `executeRun`：在组 `MemberTurnInput` 时已有 `logicalSessionId`；确保 adapter 已绑 lifecycle 即可（bindTurnAbort 在 adapter.runTurn 内）。  
- **可选增强**：turn 开始前 `lifecycle.createSession(...)`（fail-closed 不影响若渠道缺失——或懒创建）；若过重，本切片可只保证 **cancel → interruptSession({ handle: { sessionId: logicalSessionId, ... }})**。  
- `cancelRun`：在 abort 本地 controller 之后，若有 lifecycle 与 member.logicalSessionId，调用 `interruptSession`（忽略 NOT_FOUND）。

### C. Fusion runtime

- 新增 helper：`createDefaultFusionMemberAdapterStack()` 同 A。  
- `FusionRoomTransportRuntimeOptions` 增加 `enableDefaultMemberExecution?: boolean`：为 true 且未传 `memberAdapter` 时自动装配 stack + ExecutionBridge。  
- **默认 false**（保持「不自动开执行/网络」）；文档写明如何在可信环境打开。  
- 或提供独立导出函数供 IPC/未来入口调用，避免静默改默认。

推荐：**默认 false 的显式开关 + 工厂函数**，CollaborationRoomService **默认 true 注入**（本地协作室本就在跑模型）。

### D. 测试

1. Service 默认构造：adapter 为带 lifecycle 的 Channel 栈（可通过 cancel 挂起 turn 断言，用 Fake hang adapter + Fake lifecycle 注入更稳）。  
2. 注入 hang adapter + Fake lifecycle：cancelRun → lifecycle.heartbeat alive=false（需先 createSession 或 interrupt 用 logicalSessionId）。  
3. 只传 mock adapter、不传 lifecycle：cancel 仍只 abort 本地 signal（回归）。  
4. `enableDefaultMemberExecution: true` 时 runtime 有 executionBridge；默认 false 时无。

---

## 禁止

- 默认打开 fusion 非 loopback 网络监听  
- 谎报 resume  
- 动无关 unstaged UI 文件  
- **可以 commit；主控会 push**

---

## 验证

```powershell
bunx vitest run apps/electron/src/main/lib/collaboration/collaboration-room-run.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/member-backend-adapter.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-runtime.test.ts
# 新增工厂/接线测
bun run --filter='./apps/electron' typecheck
git diff --check
```

---

## 完成输出

1. 文件列表  
2. 默认谁注入、谁仍 opt-in  
3. 测试结果  
4. 未做：持久 outbox worker、全量 createSession-before-every-turn（若未做）  
5. §80；commit；勿自行 push
