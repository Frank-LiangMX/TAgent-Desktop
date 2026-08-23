# P1-2a · MemberBackend 生命周期契约（create/resume/compact/interrupt/heartbeat/usage）

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main`（与 origin 同步于 `00d136b`；工作区可能有无关未提交 UI 改动，**勿动**）  
> **上游**：[`13-HANDOFF` §7 P1-1 / §8 第 5 步](./13-HANDOFF-2026-08-23.md)、[`06` §8](./06-MULTIUSER-FUSION-IMPLEMENTATION.md)、现有 `MemberBackendAdapter` + `ChannelBackendAdapter`

---

## 目标

为融合会话 / RoomSession 补齐 **统一 provider 生命周期契约**（不直接绑死 KSCC 进程细节），并用 **Fake + 薄封装** 钉死行为：

1. `create` / `resume` / `compact` / `interrupt` / `heartbeat`  
2. turn `usage` 规范化回写形状（与 authority `recordUsage` / `MemberTurnResult.usage` 对齐）  
3. **诚实能力**：`supportsResume` 等不得谎报；未实现则 fail-closed  

**本切片不宣称**：本机 kscc/Pi 真机 create→resume E2E 已完成（那是后续 P1-2b）。

---

## 建议 API（可微调，语义必须覆盖）

在 `packages/shared`（或 `packages/core` 若更合适，但类型优先 shared）新增，例如：

```ts
export type MemberSessionResumeMode = 'native' | 'replay' | 'none'

export interface MemberSessionHandle {
  sessionId: string
  /** 逻辑席位/成员会话键；与 RoomBotSeat.logicalSessionId 对齐用途 */
  logicalSessionId: string
  backend: 'pi' | 'kscc' | 'cli' | 'channel'
  resumeMode: MemberSessionResumeMode
  createdAt: number
}

export interface MemberSessionCreateInput {
  roomId: string
  memberId: string
  logicalSessionId: string
  backend?: MemberTurnInput['backend']
  channelId?: string
  modelId?: string
  workspaceId?: string
  signal?: AbortSignal
}

export interface MemberSessionResumeInput {
  handle: MemberSessionHandle
  /** 仅 native 有意义；replay 由宿主重放上下文，不要求 provider 原生 id */
  providerSessionId?: string
  signal?: AbortSignal
}

export interface MemberSessionCompactInput {
  handle: MemberSessionHandle
  reason?: string
  signal?: AbortSignal
}

export interface MemberSessionInterruptInput {
  handle: MemberSessionHandle
  reason?: string
}

export interface MemberSessionHeartbeatResult {
  alive: boolean
  at: number
  detail?: string
}

/** 规范化后的用量，供 Host recordUsage / bridge 回写 */
export interface NormalizedMemberUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  wallTimeMs?: number
  toolCalls?: number
  costUsd?: number
}

export function normalizeMemberTurnUsage(
  usage: MemberTurnResult['usage'] | undefined,
  extras?: { wallTimeMs?: number; toolCalls?: number },
): NormalizedMemberUsage

/**
 * 生命周期扩展。可与现有 MemberBackendAdapter 组合：
 * - 旧代码只依赖 runTurn 继续工作
 * - 新 Host/bridge 可依赖 lifecycle
 */
export interface MemberSessionLifecycleAdapter {
  capabilities(): CollaborationMemberCapabilities
  createSession(input: MemberSessionCreateInput): Promise<MemberSessionHandle>
  resumeSession(input: MemberSessionResumeInput): Promise<MemberSessionHandle>
  compactSession(input: MemberSessionCompactInput): Promise<{ ok: boolean; summary?: string }>
  interruptSession(input: MemberSessionInterruptInput): Promise<void>
  heartbeat(handle: MemberSessionHandle): Promise<MemberSessionHeartbeatResult>
}
```

可选：`MemberBackendAdapter & MemberSessionLifecycleAdapter` 的组合类型别名。

---

## 实现要求

### 1. Fake（单测主力）

`FakeMemberSessionLifecycleAdapter`（放 electron collaboration 测试旁或 shared 测试旁）：

- `createSession` → 新 handle，`resumeMode` 可配置（默认 `native`）  
- `resumeSession`：仅当 capabilities.supportsResume 且 mode=native；否则抛明确错误码/消息  
- `compactSession`：记录调用次数；可配置失败  
- `interruptSession`：标记 handle 中断；之后 `heartbeat.alive=false`；并发 `runTurn`（若 fake 也实现 adapter）应可被取消  
- `heartbeat`：未 interrupt → alive；已 interrupt / 未知 session → alive=false  
- 全程无 I/O  

### 2. Channel 薄封装（诚实 fail-closed）

新增 `ChannelMemberSessionLifecycleAdapter`（或同名）包裹/并列于 `ChannelBackendAdapter`：

- `createSession`：返回基于 `logicalSessionId` 的 handle；`backend` 按解析结果标 `kscc`/`channel`；**当前** `resumeMode='none'` 或 `'replay'`（因为现 CHANNEL 能力 `supportsResume:false`）——在注释与 capabilities 中诚实标明  
- `resumeSession`：若 `!supportsResume` → **抛错 fail-closed**（禁止假装原生 resume 成功）  
- `compactSession`：现阶段可返回 `{ ok: false, summary: 'not implemented' }` 或 no-op `{ ok: true, summary: 'noop' }`，但必须在文档/日志写明未接真实压缩  
- `interruptSession`：登记 sessionId，供后续 turn 的 AbortSignal 协作（最小：内存 Set）；不杀真实子进程也可，但要在 §78 写清「未接进程级 kill」  
- `heartbeat`：create 后未 interrupt → alive；interrupt 后 false  

**不要**在本切片大改 `ChannelBackendAdapter.runTurn` 主路径；生命周期是叠加契约。

### 3. usage 规范化

- `normalizeMemberTurnUsage` 纯函数 + 单测（缺字段、全字段、extras 合并）  
- 可选：在 `fusion-room-execution-bridge` 的 `recordUsage` 调用处改用 normalize（小改；若风险高则只导出函数 + 测，§78 注明 bridge 接线留给下一切）

### 4. 文档

- `12-IMPLEMENTATION-LOG` **§78**  
- `13-HANDOFF` §7 P1-1 / §8 第 5 步旁注：契约 + Fake + Channel fail-closed 已落地；**真机 provider E2E 未做**  
- 轻量更新 `06` §8 / Phase F 一句  

---

## 禁止

- 宣称 kscc/Pi 真机 resume E2E 完成  
- 谎报 `supportsResume: true`  
- 打开公网 / 改 P0 闸门  
- 大改 renderer  
- 提交无关 `chat.css` / `image-lightbox` / `tokens.css`  
- **可以 commit，不要 push**（或可 commit；由主控决定 push）

---

## 必须测试

1. Fake：create → heartbeat alive → interrupt → heartbeat dead  
2. Fake：supportsResume=false 时 resume 抛错  
3. Fake：supportsResume=true 时 resume 返回同 logicalSessionId / 新或同 sessionId（文档化）  
4. Fake：compact 可配置成功/失败  
5. Channel lifecycle：create 成功；resume fail-closed；interrupt 后 heartbeat false  
6. `normalizeMemberTurnUsage` 边界  
7. 现有 `member-backend-adapter` / execution-bridge 回归不破（至少跑相关 vitest）

```powershell
bun test packages/shared/src/types/member-session-lifecycle.test.ts
# 或你实际放置路径
bun test apps/electron/src/main/lib/collaboration/member-session-lifecycle.test.ts
bun test apps/electron/src/main/lib/collaboration/fusion-room-execution-bridge.test.ts
bun run --filter='@tagent/shared' typecheck
bun run --filter='@tagent/core' typecheck
bun run --filter='./apps/electron' typecheck
git diff --check
```

---

## 完成输出

1. 文件列表  
2. 能力诚实性说明（resume/compact 现状）  
3. 测试结果  
4. 明确未做：真机 kscc resume E2E、进程级 kill、bridge 全量改用 normalize（若未接）  
5. §78；commit；**勿 push**

先读现有 `MemberBackendAdapter` / `ChannelBackendAdapter.capabilities` / `06` §8，再实现。
