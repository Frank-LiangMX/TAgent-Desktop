/**
 * normalizeMemberTurnUsage 单测（P1-2a）。
 *
 * 覆盖：undefined / 全字段 / 缺字段 / extras 填充 / extras 覆盖 / NaN 与非有限数过滤 /
 * 仅 extras 部分字段时 usage 补齐。纯函数，不依赖时间、不读 DB。
 */
import { describe, expect, test } from "vitest";
import { normalizeMemberTurnUsage } from "./member-session-lifecycle";

describe("normalizeMemberTurnUsage", () => {
  test("undefined usage → 空 NormalizedMemberUsage（无任何字段）", () => {
    expect(normalizeMemberTurnUsage(undefined)).toEqual({});
  });

  test("全字段 usage → 原样保留（仅过滤 undefined）", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      wallTimeMs: 100,
      toolCalls: 2,
      costUsd: 0.005,
    };
    expect(normalizeMemberTurnUsage(usage)).toEqual(usage);
  });

  test("缺字段 usage → 只保留已定义字段", () => {
    expect(normalizeMemberTurnUsage({ inputTokens: 7 })).toEqual({
      inputTokens: 7,
    });
    expect(
      normalizeMemberTurnUsage({ totalTokens: 42, costUsd: 0.01 }),
    ).toEqual({ totalTokens: 42, costUsd: 0.01 });
  });

  test("extras.wallTimeMs / toolCalls 填充 usage 缺失项", () => {
    expect(
      normalizeMemberTurnUsage(
        { inputTokens: 5 },
        { wallTimeMs: 200, toolCalls: 3 },
      ),
    ).toEqual({ inputTokens: 5, wallTimeMs: 200, toolCalls: 3 });
  });

  test("extras 覆盖 usage 同名字段（宿主度量优先）", () => {
    expect(
      normalizeMemberTurnUsage(
        { wallTimeMs: 100, toolCalls: 1 },
        { wallTimeMs: 250, toolCalls: 4 },
      ),
    ).toEqual({ wallTimeMs: 250, toolCalls: 4 });
  });

  test("NaN / 非有限数被丢弃，保留正常字段", () => {
    expect(
      normalizeMemberTurnUsage({
        inputTokens: Number.NaN,
        outputTokens: 5,
        wallTimeMs: Number.POSITIVE_INFINITY,
        costUsd: Number.NaN,
      }),
    ).toEqual({ outputTokens: 5 });
  });

  test("extras 仅传 wallTimeMs 时，toolCalls 仍可来自 usage", () => {
    expect(
      normalizeMemberTurnUsage({ toolCalls: 9 }, { wallTimeMs: 50 }),
    ).toEqual({ toolCalls: 9, wallTimeMs: 50 });
  });

  test("0 是合法有限数，被保留（不与 undefined 混淆）", () => {
    expect(
      normalizeMemberTurnUsage({ inputTokens: 0, outputTokens: 0 }),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("extras 全为 undefined 时等价于仅 usage", () => {
    expect(
      normalizeMemberTurnUsage({ inputTokens: 3 }, { wallTimeMs: undefined }),
    ).toEqual({ inputTokens: 3 });
  });
});
