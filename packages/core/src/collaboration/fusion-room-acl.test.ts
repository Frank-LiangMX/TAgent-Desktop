import { describe, expect, test } from "vitest"
import {
  decideBotRuntimeAccess,
  decideResourceAccess,
  decideRoomAccess,
  isAllowed,
  resolveBillingSubject,
  type FusionAclDecision,
  type FusionAclPrincipal,
  type FusionResourceGrant,
} from "./fusion-room-acl"

const principal = (userId: string, extra: Partial<FusionAclPrincipal> = {}): FusionAclPrincipal => ({
  userId,
  ...extra,
})

const members = (items: Array<{ userId: string; status: string }>) => items

/** 拒绝时取 code，允许时取 undefined，便于 toBe("CODE") 断言。 */
function denyCode(decision: FusionAclDecision): string | undefined {
  return decision.allowed === false ? decision.code : undefined
}

describe("decideRoomAccess", () => {
  test("owner 可访问房间；非成员拒绝", () => {
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("owner"),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([]),
        }),
      ),
    ).toBe(true)
    expect(
      decideRoomAccess({
        principal: principal("outsider"),
        roomId: "room-a",
        ownerUserId: "owner",
        humanMembers: members([]),
      }),
    ).toEqual({ allowed: false, code: "FORBIDDEN", reason: expect.any(String) })
  })

  test("left / removed 拒绝；offline / invited / active 允许（与 gateway 现状对齐）", () => {
    const ownerUserId = "owner"
    const roomId = "room-a"
    const check = (userId: string, status: string) =>
      decideRoomAccess({
        principal: principal(userId),
        roomId,
        ownerUserId,
        humanMembers: members([{ userId, status }]),
      })
    expect(isAllowed(check("u-left", "left"))).toBe(false)
    expect(isAllowed(check("u-removed", "removed"))).toBe(false)
    expect(isAllowed(check("u-offline", "offline"))).toBe(true)
    expect(isAllowed(check("u-invited", "invited"))).toBe(true)
    expect(isAllowed(check("u-active", "active"))).toBe(true)
    expect(denyCode(check("u-left", "left"))).toBe("FORBIDDEN")
    expect(denyCode(check("u-removed", "removed"))).toBe("FORBIDDEN")
  })

  test("principal.roomId 绑定 A 时访问 B → SCOPE_MISMATCH", () => {
    const decision = decideRoomAccess({
      principal: principal("owner", { roomId: "room-a" }),
      roomId: "room-b",
      ownerUserId: "owner",
      humanMembers: members([]),
    })
    expect(decision.allowed).toBe(false)
    expect(denyCode(decision)).toBe("SCOPE_MISMATCH")
  })

  test("principal.roomId 与目标房间一致时仍按成员关系判定", () => {
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("owner", { roomId: "room-a" }),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([]),
        }),
      ),
    ).toBe(true)
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("u-active", { roomId: "room-a" }),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([{ userId: "u-active", status: "active" }]),
        }),
      ),
    ).toBe(true)
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("outsider", { roomId: "room-a" }),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([]),
        }),
      ),
    ).toBe(false)
  })

  test("worker principal 仅当 userId === ownerUserId 才放行；scope 先于 worker 判定", () => {
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("owner", { kind: "worker" }),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([]),
        }),
      ),
    ).toBe(true)
    // worker 不是房主，即便它出现在人类成员列表里也拒绝
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("u-active", { kind: "worker" }),
          roomId: "room-a",
          ownerUserId: "owner",
          humanMembers: members([{ userId: "u-active", status: "active" }]),
        }),
      ),
    ).toBe(false)
    // scope 不匹配优先于 worker 判定
    const scoped = decideRoomAccess({
      principal: principal("owner", { kind: "worker", roomId: "room-a" }),
      roomId: "room-b",
      ownerUserId: "owner",
      humanMembers: members([]),
    })
    expect(scoped.allowed).toBe(false)
    expect(denyCode(scoped)).toBe("SCOPE_MISMATCH")
  })
})

describe("decideBotRuntimeAccess", () => {
  const seat = (status?: string) => ({ id: "seat-1", ownerUserId: "bot-owner", status })

  test("seat 已移除 → FORBIDDEN（先于 consent）", () => {
    const decision = decideBotRuntimeAccess({
      seat: seat("removed"),
      ownerConsent: true,
      requestedCapability: "read-only",
    })
    expect(decision.allowed).toBe(false)
    expect(denyCode(decision)).toBe("FORBIDDEN")
  })

  test("无 consent → runtime / write / read-only 均拒绝（NO_CONSENT）", () => {
    for (const capability of ["run", "workspace-write", "read-only"] as const) {
      const decision = decideBotRuntimeAccess({
        seat: seat("idle"),
        ownerConsent: false,
        requestedCapability: capability,
      })
      expect(decision.allowed).toBe(false)
      expect(denyCode(decision)).toBe("NO_CONSENT")
    }
  })

  test("consent=true 且 read-only 请求允许", () => {
    expect(
      isAllowed(
        decideBotRuntimeAccess({
          seat: seat("idle"),
          ownerConsent: true,
          requestedCapability: "read-only",
        }),
      ),
    ).toBe(true)
  })

  test("workspace-write 在协议层只要求 consent（房间 policy 交集留 TODO）", () => {
    // 协议层：consent=true 即放行 workspace-write；room policy ∩ seat capabilities 交集交给 authority/runtime。
    expect(
      isAllowed(
        decideBotRuntimeAccess({
          seat: seat("idle"),
          ownerConsent: true,
          requestedCapability: "workspace-write",
        }),
      ),
    ).toBe(true)
    expect(
      isAllowed(
        decideBotRuntimeAccess({
          seat: seat("idle"),
          ownerConsent: true,
          requestedCapability: "run",
        }),
      ),
    ).toBe(true)
  })
})

describe("decideResourceAccess", () => {
  const grant = (over: Partial<FusionResourceGrant> = {}): FusionResourceGrant => ({
    resourceId: "res-1",
    ownerUserId: "owner-a",
    granteeUserId: "grantee-b",
    actions: ["read"],
    ...over,
  })

  test("所有者本人可读 / 写 / 挂载，无需 grant", () => {
    for (const action of ["read", "write", "mount"] as const) {
      expect(
        isAllowed(
          decideResourceAccess({
            principal: principal("owner-a"),
            resourceOwnerUserId: "owner-a",
            action,
            grants: [],
          }),
        ),
      ).toBe(true)
    }
  })

  test("他人无 grant 拒绝（NO_GRANT）", () => {
    const decision = decideResourceAccess({
      principal: principal("grantee-b"),
      resourceOwnerUserId: "owner-a",
      action: "read",
      grants: [],
    })
    expect(decision.allowed).toBe(false)
    expect(denyCode(decision)).toBe("NO_GRANT")
  })

  test("有 read grant 可读；动作不在 grant 内拒绝", () => {
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "read",
          grants: [grant()],
        }),
      ),
    ).toBe(true)
    const writeDecision = decideResourceAccess({
      principal: principal("grantee-b"),
      resourceOwnerUserId: "owner-a",
      action: "write",
      grants: [grant()],
    })
    expect(writeDecision.allowed).toBe(false)
    expect(denyCode(writeDecision)).toBe("NO_GRANT")
  })

  test("有 write grant 可写", () => {
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "write",
          grants: [grant({ actions: ["write"] })],
        }),
      ),
    ).toBe(true)
  })

  test("过期 grant 拒绝（expiresAt <= now）", () => {
    const decision = decideResourceAccess({
      principal: principal("grantee-b"),
      resourceOwnerUserId: "owner-a",
      action: "read",
      grants: [grant({ expiresAt: 100 })],
      now: 100,
    })
    expect(decision.allowed).toBe(false)
    expect(denyCode(decision)).toBe("NO_GRANT")
    // 未过期仍有效
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "read",
          grants: [grant({ expiresAt: 100 })],
          now: 99,
        }),
      ),
    ).toBe(true)
  })

  test("撤销 grant 拒绝（revokedAt <= now）", () => {
    const decision = decideResourceAccess({
      principal: principal("grantee-b"),
      resourceOwnerUserId: "owner-a",
      action: "read",
      grants: [grant({ revokedAt: 50 })],
      now: 50,
    })
    expect(decision.allowed).toBe(false)
    expect(denyCode(decision)).toBe("NO_GRANT")
  })

  test("grantee / owner 不匹配的 grant 不生效", () => {
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "read",
          grants: [grant({ granteeUserId: "someone-else" })],
        }),
      ),
    ).toBe(false)
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "read",
          grants: [grant({ ownerUserId: "owner-other" })],
        }),
      ),
    ).toBe(false)
  })

  test("多条 grant 中存在一条有效即放行（忽略过期条目）", () => {
    expect(
      isAllowed(
        decideResourceAccess({
          principal: principal("grantee-b"),
          resourceOwnerUserId: "owner-a",
          action: "read",
          grants: [grant({ expiresAt: 1 }), grant({ resourceId: "res-2" })],
          now: 100,
        }),
      ),
    ).toBe(true)
  })
})

describe("resolveBillingSubject", () => {
  test("billingUserId === seatOwnerUserId，即使发起人是房主或其他人", () => {
    expect(
      resolveBillingSubject({ seatOwnerUserId: "bot-owner", initiatedByUserId: "room-owner" }),
    ).toEqual({ billingUserId: "bot-owner", initiatedByUserId: "room-owner" })
    expect(
      resolveBillingSubject({ seatOwnerUserId: "bot-owner", initiatedByUserId: "someone-else" }),
    ).toEqual({ billingUserId: "bot-owner", initiatedByUserId: "someone-else" })
    // 发起人就是 Bot owner 本人也保持归属一致
    expect(
      resolveBillingSubject({ seatOwnerUserId: "bot-owner", initiatedByUserId: "bot-owner" }),
    ).toEqual({ billingUserId: "bot-owner", initiatedByUserId: "bot-owner" })
  })

  test("ownerOffline=true 也不转移费用主体", () => {
    expect(
      resolveBillingSubject({
        seatOwnerUserId: "bot-owner",
        initiatedByUserId: "room-owner",
        ownerOffline: true,
      }),
    ).toEqual({ billingUserId: "bot-owner", initiatedByUserId: "room-owner" })
  })
})

describe("ACL 委托与 gateway defaultAuthorize 行为一致", () => {
  // 这些用例镜像 fusion-room-gateway.test.ts 的语义，确保 defaultAuthorize 委托 decideRoomAccess 后行为不回退。
  const roomId = "gateway-room"
  const ownerUserId = "owner"

  test("owner / active / invited / offline 成员可进；left / removed / 非成员拒绝", () => {
    const allowed = (userId: string, status?: string) =>
      isAllowed(
        decideRoomAccess({
          principal: principal(userId),
          roomId,
          ownerUserId,
          humanMembers: status ? members([{ userId, status }]) : members([]),
        }),
      )
    expect(allowed("owner")).toBe(true)
    expect(allowed("user-b", "active")).toBe(true)
    expect(allowed("user-b", "invited")).toBe(true)
    expect(allowed("user-b", "offline")).toBe(true)
    expect(allowed("user-b", "left")).toBe(false)
    expect(allowed("user-b", "removed")).toBe(false)
    expect(allowed("outsider")).toBe(false)
  })

  test("带 room scope 的 principal 不能跨房间访问", () => {
    expect(
      isAllowed(
        decideRoomAccess({
          principal: principal("owner", { roomId: "gateway-room" }),
          roomId: "other-room",
          ownerUserId: "owner",
          humanMembers: members([]),
        }),
      ),
    ).toBe(false)
  })
})
