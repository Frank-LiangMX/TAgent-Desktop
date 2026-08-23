# P0-1 · 融合会话认证/ACL 协议 + 测试

> **角色**：实现 agent（kscc）  
> **模型建议**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：当前工作目录（`main`，已与 origin 同步）  
> **上游真源**：
> - [`13-HANDOFF-2026-08-23.md`](./13-HANDOFF-2026-08-23.md) §7 P0-1 / §8 推荐顺序第 1 步  
> - [`06-MULTIUSER-FUSION-IMPLEMENTATION.md`](./06-MULTIUSER-FUSION-IMPLEMENTATION.md) §6  
> - [`03-IMPLEMENTATION-PHASES.md`](./03-IMPLEMENTATION-PHASES.md) 当前交接基线  

---

## 目标（本切片唯一交付）

在 `packages/core` 落地一套**纯协议层**的认证/ACL 判定，并用单测钉死：

1. **principal**：已认证身份（`userId` / `kind` / 可选 `roomId` scope）  
2. **room scope**：invite token / principal 绑定的房间范围；越权房间一律拒绝  
3. **Bot owner consent**：无 consent 不得把该 seat 当可运行/可写能力开放  
4. **resource grant**：个人资源未授权不得进入房间工作区写回/读取（协议级；不接真实文件系统）  
5. **费用主体（billing subject）**：Bot 模型费用归属 `botOwnerUserId`；发起人与费用主体可分离；所有者离线不自动转移费用

**验收标准**：有独立模块 + 回归测试；gateway 的房间入口授权可复用该协议（至少 room membership / room scope）；**不打开公网入口**；不改 renderer 大 UI。

---

## 允许做的事

- 新增例如：
  - `packages/core/src/collaboration/fusion-room-acl.ts`
  - `packages/core/src/collaboration/fusion-room-acl.test.ts`
- 从 `fusion-room-gateway.ts` 抽出/对齐 `defaultAuthorize`，改为调用 ACL 协议的 room-access 判定（行为保持兼容；补 roomId scope 与 worker 语义的测试）。
- 在 `packages/core/src/index.ts` 导出新模块公开类型与函数。
- 更新文档（必须）：
  - `12-IMPLEMENTATION-LOG-2026-08-22.md` 追加 **§72**（写清交付、测试命令、明确未做）
  - `13-HANDOFF-2026-08-23.md` 在 §7 P0-1 或 §3 旁注：协议层已落地，真实账户认证/证书仍未做
  - 如触及阶段勾选，轻量更新 `03-IMPLEMENTATION-PHASES.md` / `06` 对应一句状态（勿大段重写）

---

## 禁止

- 打开打包版网络入口、默认 HTTPS 公网监听、绕过认证的 loopback 例外扩大  
- 伪造「真实账户登录 / OAuth / 证书生命周期已完成」  
- 大改 renderer UI、重写 authority 状态机、重写 HTTP server 传输层  
- 提交含密钥/token 明文；不要 `git reset --hard` / 覆盖无关本地改动  
- 不要把本切片扩展成跨机器 E2E 或真实 provider 接入  

**可以 commit，但不要 push**（由主控 agent / 用户决定何时 push）。

---

## 建议 API 形状（可微调，但语义必须覆盖）

```ts
// 示意 — 实现时可命名微调，但测试要覆盖同等语义

export type FusionAclDecision =
  | { allowed: true; reasons?: string[] }
  | { allowed: false; code: 'FORBIDDEN' | 'SCOPE_MISMATCH' | 'NO_CONSENT' | 'NO_GRANT' | 'BILLING_LOCKED'; reason: string }

export interface FusionAclPrincipal {
  userId: string
  kind?: 'user' | 'worker'
  /** Bearer invite / session 绑定的房间；有则只能访问该 room */
  roomId?: string
}

export interface FusionResourceGrant {
  resourceId: string
  ownerUserId: string
  granteeUserId: string
  /** e.g. 'read' | 'write' | 'mount' */
  actions: ReadonlyArray<'read' | 'write' | 'mount'>
  expiresAt?: number
  revokedAt?: number
}

/** 房间入口：谁能看见/连接该 RoomSession */
export function decideRoomAccess(input: {
  principal: FusionAclPrincipal
  roomId: string
  ownerUserId: string
  humanMembers: ReadonlyArray<{ userId: string; status: string }>
}): FusionAclDecision

/** Bot 是否可在本房间以给定能力运行（consent ∩ seat 归属） */
export function decideBotRuntimeAccess(input: {
  seat: { id: string; ownerUserId: string; status?: string }
  ownerConsent: boolean
  requestedCapability: 'read-only' | 'workspace-write' | 'run'
}): FusionAclDecision

/** 资源授权是否覆盖本次动作 */
export function decideResourceAccess(input: {
  principal: FusionAclPrincipal
  resourceOwnerUserId: string
  action: 'read' | 'write' | 'mount'
  grants: ReadonlyArray<FusionResourceGrant>
  now?: number
}): FusionAclDecision

/** 费用主体：永远是 Bot owner；不可因发起人或房主而偷换 */
export function resolveBillingSubject(input: {
  seatOwnerUserId: string
  initiatedByUserId: string
  /** 所有者离线也不能转移 */
  ownerOffline?: boolean
}): { billingUserId: string; initiatedByUserId: string }
```

实现约束：

- **纯函数 / 无 I/O**（便于单测；不读盘、不碰 Electron）。  
- gateway `defaultAuthorize` 应委托 `decideRoomAccess`（或等价），保持：owner 可进；invited/active/offline 成员可进；`removed`/`left` 拒绝；`principal.roomId` 与目标 room 不符拒绝；`kind==='worker'` 仅当 principal.userId === ownerUserId（与现逻辑一致，除非测试证明需更严且你在日志写明）。  
- `resolveBillingSubject` 必须与 authority 的 `botOwnerUserId` 语义一致：费用归 seat.ownerUserId。  
- 不要在本切片强行改 `recordUsage` 签名；协议层给出判定即可，测试断言语义。

---

## 必须覆盖的测试用例

至少包含：

1. owner 可访问房间；非成员拒绝；`left`/`removed` 拒绝；`offline`/`invited`/`active` 允许（与 gateway 现状对齐）。  
2. `principal.roomId` 绑定 A 时访问 B → `SCOPE_MISMATCH` / forbidden。  
3. Bot seat 无 consent → runtime/write 拒绝；consent=true 且 read-only 请求允许；workspace-write 在协议层可先只要求 consent（房间 policy 交集可留 TODO，但要在注释/日志写明）。  
4. 资源：所有者本人可读写；他人无 grant 拒绝；有 `write` grant 可写；过期/撤销 grant 拒绝。  
5. 费用：`billingUserId === seatOwnerUserId`，即使 `initiatedByUserId` 是房主或其他人，且 `ownerOffline=true` 也不转移。  
6. gateway 回归：现有 `fusion-room-gateway.test.ts` 仍通过；若抽出 defaultAuthorize，补 1–2 个 ACL 委托相关断言或独立 acl 测试即可。

---

## 验证命令（做完必须跑）

在仓库根：

```powershell
bun test packages/core/src/collaboration/fusion-room-acl.test.ts
bun test packages/core/src/collaboration/fusion-room-gateway.test.ts
bun run --filter='@tagent/core' typecheck
git diff --check
```

若 `@tagent/core` filter 不适用，改用项目既有 core typecheck 方式；失败不要伪称通过。

可选更广：

```powershell
bun test packages/core/src/collaboration
```

---

## 完成时输出

1. 改动文件列表  
2. 测试命令与结果摘要  
3. 明确**未做**项（真实账户、证书、跨机器 E2E、公网入口等）  
4. 已更新的文档段落编号  
5. 若已 commit：给出 hash 与 message；**不要 push**

开始前先快速读 `13-HANDOFF` §7–§8、`06` §6、现有 `fusion-room-gateway.ts` 的 `defaultAuthorize` 与 `FusionRoomPrincipal`，再实现。切片结束不要声称跨用户网络可用。
