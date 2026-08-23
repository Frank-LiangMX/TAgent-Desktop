/**
 * 融合会话认证 / ACL 协议层（P0-1）
 *
 * 纯协议层判定，不接真实账户认证、不读盘、不碰 Electron / 网络传输。
 * 目的是把“谁能访问房间、Bot 是否可在本房间运行、资源授权是否覆盖本次动作、
 * 模型费用归属谁”这些跨用户安全判定从 gateway / authority 里抽成可单测的纯函数，
 * 供后续真实账户认证、证书生命周期和跨机器 E2E 复用。
 *
 * 本切片只交付协议与测试，不打开公网入口，不伪造“真实账户登录已完成”。
 */

/** ACL 判定结果：允许时附带原因列表，拒绝时给出稳定 code 与人类可读原因。 */
export type FusionAclDecision =
  | { allowed: true; reasons?: string[] }
  | {
      allowed: false
      code: 'FORBIDDEN' | 'SCOPE_MISMATCH' | 'NO_CONSENT' | 'NO_GRANT' | 'BILLING_LOCKED'
      reason: string
    }

/** 已认证身份：userId 必填；kind 区分人类成员与服务 worker；roomId 为 bearer 邀请 / 会话绑定的房间范围。 */
export interface FusionAclPrincipal {
  userId: string
  kind?: 'user' | 'worker'
  /** Bearer invite / session 绑定的房间；有则只能访问该 room，越权房间一律拒绝。 */
  roomId?: string
}

/** 个人资源授权记录：资源所有者把指定动作授予某个被授权人，可带过期 / 撤销时间。 */
export interface FusionResourceGrant {
  resourceId: string
  ownerUserId: string
  granteeUserId: string
  /** e.g. 'read' | 'write' | 'mount' */
  actions: ReadonlyArray<'read' | 'write' | 'mount'>
  expiresAt?: number
  revokedAt?: number
}

const ALLOWED_MEMBER_STATUSES: ReadonlySet<string> = new Set([
  'invited',
  'active',
  'offline',
])

function isMemberAllowed(status: string): boolean {
  return ALLOWED_MEMBER_STATUSES.has(status)
}

/**
 * 房间入口判定：谁能看见 / 连接该 RoomSession。
 *
 * 与 gateway `defaultAuthorize` 现状保持行为兼容：
 * - `principal.roomId` 绑定 A 时访问 B → `SCOPE_MISMATCH`；
 * - `kind==='worker'` 仅当 `principal.userId === ownerUserId` 才放行（worker 不走人类成员路径）；
 * - 房主始终可进；
 * - 人类成员 `invited` / `active` / `offline` 可进，`left` / `removed` 拒绝；
 * - 其余一律 `FORBIDDEN`。
 */
export function decideRoomAccess(input: {
  principal: FusionAclPrincipal
  roomId: string
  ownerUserId: string
  humanMembers: ReadonlyArray<{ userId: string; status: string }>
}): FusionAclDecision {
  const { principal, roomId, ownerUserId, humanMembers } = input
  if (principal.roomId && principal.roomId !== roomId) {
    return {
      allowed: false,
      code: 'SCOPE_MISMATCH',
      reason: `principal 绑定房间 ${principal.roomId} 与目标房间 ${roomId} 不符`,
    }
  }
  if (principal.kind === 'worker') {
    if (ownerUserId === principal.userId) {
      return { allowed: true, reasons: ['worker 为房主'] }
    }
    return {
      allowed: false,
      code: 'FORBIDDEN',
      reason: 'worker principal 仅当其 userId 为房主时才可访问房间',
    }
  }
  if (ownerUserId === principal.userId) {
    return { allowed: true, reasons: ['owner'] }
  }
  const member = humanMembers.find((item) => item.userId === principal.userId)
  if (member && isMemberAllowed(member.status)) {
    return { allowed: true, reasons: [`member:${member.status}`] }
  }
  return {
    allowed: false,
    code: 'FORBIDDEN',
    reason: member
      ? `成员状态 ${member.status} 不允许访问房间`
      : '当前用户不是该 RoomSession 的成员',
  }
}

/**
 * Bot 是否可在本房间以给定能力运行（consent ∩ seat 归属）。
 *
 * - `seat.status === 'removed'` 一律 `FORBIDDEN`（席位已离场，协议层先拦）。
 * - `ownerConsent` 为 Bot 所有人对本房间的授权。**所有能力（含 read-only）均要求 consent**：
 *   即便 read-only 也会消耗 Bot owner 的模型额度并计费，没有授权不应把 seat 当任何能力开放。
 *   详见 `resolveBillingSubject`：费用恒归 `seat.ownerUserId`，未授权不应由其承担费用。
 * - `workspace-write` / `run` 在协议层只校验 consent；“房间 policy ∩ seat capabilities”的交集
 *   留给 authority / runtime 层（TODO），本切片在协议层先以 consent 为闸门并在注释写明。
 */
export function decideBotRuntimeAccess(input: {
  seat: { id: string; ownerUserId: string; status?: string }
  ownerConsent: boolean
  requestedCapability: 'read-only' | 'workspace-write' | 'run'
}): FusionAclDecision {
  const { seat, ownerConsent, requestedCapability } = input
  if (seat.status === 'removed') {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      reason: `Bot seat ${seat.id} 已移除，不能在本房间运行`,
    }
  }
  if (!ownerConsent) {
    return {
      allowed: false,
      code: 'NO_CONSENT',
      reason: `Bot 所有人尚未授权该 seat 以 ${requestedCapability} 能力运行`,
    }
  }
  return {
    allowed: true,
    reasons: [`consent:${requestedCapability}`],
  }
}

/**
 * 资源授权是否覆盖本次动作（协议级，不接真实文件系统）。
 *
 * - 资源所有者本人对其资源可读 / 写 / 挂载，不需要 grant。
 * - 其他人需要一条匹配的 grant：`granteeUserId === principal.userId`、
 *   `ownerUserId === resourceOwnerUserId`、动作在 `actions` 内，且未过期、未撤销。
 * - 过期（`expiresAt <= now`）或已撤销（`revokedAt <= now`）的 grant 视作无 grant，返回 `NO_GRANT`。
 */
export function decideResourceAccess(input: {
  principal: FusionAclPrincipal
  resourceOwnerUserId: string
  action: 'read' | 'write' | 'mount'
  grants: ReadonlyArray<FusionResourceGrant>
  now?: number
}): FusionAclDecision {
  const { principal, resourceOwnerUserId, action, grants, now } = input
  if (principal.userId === resourceOwnerUserId) {
    return { allowed: true, reasons: ['resource-owner'] }
  }
  const nowValue = now ?? 0
  let expired = false
  let revoked = false
  for (const grant of grants) {
    if (grant.granteeUserId !== principal.userId) continue
    if (grant.ownerUserId !== resourceOwnerUserId) continue
    if (grant.expiresAt !== undefined && nowValue >= grant.expiresAt) {
      expired = true
      continue
    }
    if (grant.revokedAt !== undefined && nowValue >= grant.revokedAt) {
      revoked = true
      continue
    }
    if (grant.actions.includes(action)) {
      return { allowed: true, reasons: [`grant:${grant.resourceId}:${action}`] }
    }
  }
  if (revoked) {
    return {
      allowed: false,
      code: 'NO_GRANT',
      reason: `匹配的 grant 已被撤销，不能执行 ${action}`,
    }
  }
  if (expired) {
    return {
      allowed: false,
      code: 'NO_GRANT',
      reason: `匹配的 grant 已过期，不能执行 ${action}`,
    }
  }
  return {
    allowed: false,
    code: 'NO_GRANT',
    reason: `没有覆盖 ${action} 的有效资源授权`,
  }
}

/**
 * 费用主体：永远是 Bot owner（`seatOwnerUserId`），不可因发起人或房主而偷换。
 *
 * 与 authority `recordUsage` 的 `botOwnerUserId: seat.ownerUserId` 语义一致：
 * 即使 `initiatedByUserId` 是房主或其他人，`ownerOffline=true` 也不自动转移费用。
 * `ownerOffline` 仅用于让调用方 / 测试显式断言“不转移”，本函数本身不据此改写归属。
 *
 * `BILLING_LOCKED` 留作后续“Bot owner 离线且无可承扣额度”等费用闸门判定使用，本切片不产出。
 */
export function resolveBillingSubject(input: {
  seatOwnerUserId: string
  initiatedByUserId: string
  /** 所有者离线也不能转移费用。 */
  ownerOffline?: boolean
}): { billingUserId: string; initiatedByUserId: string } {
  return {
    billingUserId: input.seatOwnerUserId,
    initiatedByUserId: input.initiatedByUserId,
  }
}

/**
 * 便利方法：把协议判定降级为布尔，供只关心“是否放行”的旧风格调用方（如 gateway
 * `defaultAuthorize`）使用。拒绝时 `reason` 仍可在日志侧按需记录。
 */
export function isAllowed(decision: FusionAclDecision): boolean {
  return decision.allowed
}
