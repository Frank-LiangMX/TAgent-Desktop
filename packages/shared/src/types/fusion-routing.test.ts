import { describe, expect, test } from "vitest";
import { resolveFusionCoordinator, resolveFusionRoute } from "./fusion-routing";

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
        seats: (seats
          .map((seat) => ({ ...seat, status: "paused" as const })) as typeof seats)
          .concat([{ ...seats[0]!, status: "idle" as const }]),
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
