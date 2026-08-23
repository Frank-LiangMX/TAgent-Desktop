import { describe, expect, test } from "vitest";
import {
  parseFusionBotMentions,
  resolveFusionCoordinator,
  resolveFusionRoute,
  resolveSessionFusionRoute,
} from "./fusion-routing";

const seats = [
  {
    id: "seat_a",
    status: "idle" as const,
    isCoordinator: false,
    createdAt: 10,
  },
  { id: "seat_b", status: "idle" as const, isCoordinator: true, createdAt: 20 },
  {
    id: "seat_c",
    status: "paused" as const,
    isCoordinator: false,
    createdAt: 30,
  },
];

describe("fusion routing", () => {
  test("多个 Bot 无 @ 交给默认协调者", () => {
    expect(resolveFusionRoute({ seats })).toEqual({
      ok: true,
      seatId: "seat_b",
      reason: "coordinator-default",
    });
  });

  test("只有一个可用 Bot 时就是普通直聊路径", () => {
    expect(
      resolveFusionRoute({
        seats: (
          seats.map((seat) => ({
            ...seat,
            status: "paused" as const,
          })) as typeof seats
        ).concat([{ ...seats[0]!, status: "idle" as const }]),
      }),
    ).toEqual({ ok: true, seatId: "seat_a", reason: "single-bot-default" });
  });

  test("@ 精确路由，但不可用席位必须拒绝", () => {
    expect(resolveFusionRoute({ seats, mentionedSeatId: "seat_a" })).toEqual({
      ok: true,
      seatId: "seat_a",
      reason: "explicit-mention",
    });
    expect(resolveFusionRoute({ seats, mentionedSeatId: "seat_c" })).toEqual({
      ok: false,
      reason: "mentioned-seat-unavailable",
    });
  });

  test("协调者移除后按首次加入时间提升下一席位", () => {
    const withoutCoordinator = seats.map((seat) =>
      seat.id === "seat_b" ? { ...seat, status: "removed" as const } : seat,
    );
    expect(resolveFusionCoordinator(withoutCoordinator)).toBe("seat_a");
    expect(resolveFusionRoute({ seats: withoutCoordinator })).toEqual({
      ok: true,
      seatId: "seat_a",
      reason: "single-bot-default",
    });
  });

  test("没有可用席位时不静默回退到普通 Agent", () => {
    expect(
      resolveFusionRoute({
        seats: seats.map((seat) => ({ ...seat, status: "removed" as const })),
      }),
    ).toEqual({
      ok: false,
      reason: "no-routable-bot",
    });
  });
});

describe("session fusion routing", () => {
  const bots = [
    { id: "bot_writer", displayName: "写作 Bot" },
    { id: "bot_reviewer", displayName: "审阅 Bot" },
  ];

  test("解析当前会话已加入 Bot 的名称和 id 提及", () => {
    expect(
      parseFusionBotMentions("请 @写作 Bot 先写，@bot_reviewer 再审阅", bots),
    ).toEqual([
      {
        botProfileId: "bot_writer",
        displayName: "写作 Bot",
        raw: "@写作 Bot",
        index: 2,
      },
      {
        botProfileId: "bot_reviewer",
        displayName: "审阅 Bot",
        raw: "@bot_reviewer",
        index: 13,
      },
    ]);
  });

  test("0/1/多 Bot 共享稳定路由规则", () => {
    expect(resolveSessionFusionRoute(undefined)).toEqual({
      mode: "ordinary",
      reason: "ordinary-default",
    });
    expect(resolveSessionFusionRoute(["bot_writer"])).toMatchObject({
      mode: "single-bot",
      targetBotProfileId: "bot_writer",
      reason: "single-bot-default",
    });
    expect(
      resolveSessionFusionRoute(["bot_writer", "bot_reviewer"]),
    ).toMatchObject({
      mode: "multi-bot",
      targetBotProfileId: "bot_writer",
      coordinatorBotProfileId: "bot_writer",
      reason: "coordinator-default",
    });
  });

  test("持久化协调者仍在席位中时优先于数组第一项", () => {
    expect(
      resolveSessionFusionRoute(
        ["bot_writer", "bot_reviewer"],
        [],
        "bot_reviewer",
      ),
    ).toMatchObject({
      mode: "multi-bot",
      targetBotProfileId: "bot_reviewer",
      coordinatorBotProfileId: "bot_reviewer",
      reason: "coordinator-default",
    });
  });
  test("@ 指定 Bot；未加入的 Bot 不改变默认协调者", () => {
    expect(
      resolveSessionFusionRoute(
        ["bot_writer", "bot_reviewer"],
        ["bot_reviewer"],
      ),
    ).toMatchObject({
      mode: "multi-bot",
      targetBotProfileId: "bot_reviewer",
      reason: "explicit-mention",
    });
    expect(
      resolveSessionFusionRoute(
        ["bot_writer", "bot_reviewer"],
        ["bot_missing"],
      ),
    ).toMatchObject({
      mode: "multi-bot",
      coordinatorBotProfileId: "bot_writer",
      reason: "mentioned-bot-unavailable",
    });
  });
});
