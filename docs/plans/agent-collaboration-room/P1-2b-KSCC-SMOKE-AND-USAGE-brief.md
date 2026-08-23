# P1-2b · 本机 kscc 窄冒烟（create→turn→interrupt）+ bridge 接线 normalize usage

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main`（`cf63a96` 已 push）  
> **上游**：[`P1-2a`](./P1-2a-PROVIDER-LIFECYCLE-CONTRACT-brief.md)、`ChannelMemberSessionLifecycleAdapter`、`ChannelBackendAdapter`、`fusion-room-execution-bridge.recordUsage`、`packages/pi-core` kscc bare（**bare 不原生 resume**）

---

## 目标（两块一起做）

### A. 窄冒烟：create → turn → interrupt（诚实边界）

已知事实：`kscc bare` **不 resume**（见 `kscc-spawn.ts` 注释）。因此本切片：

- **不**声称原生 resume E2E  
- **要**打通：lifecycle `createSession` → `ChannelBackendAdapter.runTurn`（可用 Fake/seat runner mock，或门控真机）→ `interruptSession` 能取消**进行中**的 turn → `heartbeat.alive=false`

实现重点：把 lifecycle 的 interrupt 从「只记 Set」升级为 **可取消 inflight turn**（每 session 登记 `AbortController`，turn 开始注册、结束清理；`interruptSession` abort 之）。`ChannelBackendAdapter.runTurn` 已透传 `input.signal`——需要 **组合信号**（调用方 signal + session interrupt controller）。

建议形状（可微调）：

```ts
// ChannelMemberSessionLifecycleAdapter 增加：
registerTurnSignal(sessionId: string, signal: AbortSignal): AbortSignal
// 或
beginTurn(sessionId): { signal: AbortSignal; end(): void }
interruptSession → abort 该 session 的 controller
```

`ChannelBackendAdapter` 可选注入 lifecycle，以便 runTurn 内：

```ts
const signal = lifecycle?.bindTurnAbort(logicalSessionId, input.signal) ?? input.signal
```

**默认单测**：不依赖真机网络——用 Fake runner / mock `runTurn` 挂起直到 abort，断言 interrupt 后 promise 以 abort/cancel 结束 + heartbeat false。

**可选真机门控**（环境变量，例如 `TAGENT_KSCC_LIFECYCLE_SMOKE=1`）：

- 若本机无 `kscc` 或无可用渠道 → **skip**（不算失败）  
- 若开启：create → 极短 `runTurn`（`kscc -p` 一句话）→ 或并行挂起 turn + interrupt  
- 失败如实记入 §79，禁止为绿而假造  

### B. bridge 接线 `normalizeMemberTurnUsage`

改 `fusion-room-execution-bridge.ts` 的 `recordUsage`：

- 用 `normalizeMemberTurnUsage(result.usage, { wallTimeMs: result.usage?.wallTimeMs })`（或 bridge 自测的 wall 时钟）  
- 若 normalize 后仍无任何可记账字段则 return  
- 保持既有 idempotencyKey / costMicros 换算  
- 补/改 bridge 单测：只有 wallTimeMs 或只有 tokens 时的回写行为符合预期（对照 authority `recordUsage` 字段；若 authority 不收 wallTime，至少 tokens 路径用 normalize）

---

## 允许 / 禁止

**允许**：改 `member-session-lifecycle.ts`、`member-backend-adapter.ts`（最小注入）、`fusion-room-execution-bridge.ts` + 测试；新增 smoke 测试文件；§79 + handoff 旁注。

**禁止**：

- 谎报 kscc bare 支持 native resume  
- 无门控时强制连真网导致 CI 红（默认单测必须离线可过）  
- 打开公网 / 动无关 unstaged UI 文件  
- **可以 commit；本轮主控会决定是否 push**

---

## 验证

```powershell
bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/fusion-room-execution-bridge.test.ts
bunx vitest run apps/electron/src/main/lib/collaboration/member-backend-adapter*.test.ts
# 若新增 smoke：
bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle-kscc-smoke.test.ts

bun run --filter='@tagent/shared' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

可选手动：

```powershell
$env:TAGENT_KSCC_LIFECYCLE_SMOKE='1'
bunx vitest run apps/electron/src/main/lib/collaboration/member-session-lifecycle-kscc-smoke.test.ts
```

---

## 完成输出

1. 文件列表  
2. interrupt 如何接到 AbortSignal  
3. 是否跑过真机门控（跑了/跳过/失败原因）  
4. normalize 接线说明  
5. §79；commit；勿自行 push

先读 P1-2a 实现与 `ChannelBackendAdapter.runTurn` 的 signal 透传，再改。
