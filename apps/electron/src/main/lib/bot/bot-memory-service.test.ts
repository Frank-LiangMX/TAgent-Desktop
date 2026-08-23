import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BotMemoryRecord } from "@tagent/shared";

let memoriesPath = "";

vi.mock("../config/config-paths", () => ({
  getBotMemoriesPath: () => memoriesPath,
  getBotProfilesPath: () => memoriesPath,
}));

vi.mock("../memory/memory-llm-client", () => ({
  completeMemoryLlm: vi.fn(),
}));

import { completeMemoryLlm } from "../memory/memory-llm-client";

const {
  activateBotMemory,
  consolidateBotMemory,
  consolidateBotMemoryWithAi,
  archiveBotMemory,
  getActiveBotMemories,
  loadBotMemories,
  rejectBotMemory,
  saveBotMemoryCandidate,
} = await import("./bot-memory-service");

describe("bot-memory-service", () => {
  let tempDir = "";

  beforeEach(() => {
    vi.mocked(completeMemoryLlm).mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "tagent-bot-memory-test-"));
    memoriesPath = join(tempDir, "bot-memories.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeCandidate = (id = "memory-1"): BotMemoryRecord => ({
    id,
    botProfileId: "bot-researcher",
    ownerUserId: "user-a",
    text: "用户偏好先给结论，再给证据。",
    state: "candidate",
    confidence: 0.9,
    sourceSurface: "bot-chat",
    sourceReferenceId: "session-1",
    createdAt: 100,
    updatedAt: 100,
    revision: 1,
  });

  test("整理用户笔记只生成去重后的 candidate", () => {
    const result = consolidateBotMemory({
      botProfileId: "bot-researcher",
      ownerUserId: "user-a",
      sourceSurface: "user-note",
      sourceReferenceId: "note-1",
      evidence:
        "先给结论，再给证据。\n先给结论，再给证据。\n遇到不确定内容要明确标注。",
    });
    expect(result.created).toHaveLength(2);
    expect(result.created.every((memory) => memory.state === "candidate")).toBe(
      true,
    );
    expect(result.skipped).toHaveLength(1);
    expect(getActiveBotMemories("bot-researcher")).toEqual([]);
  });
  test("默认不把笔记发送给模型", async () => {
    const result = await consolidateBotMemoryWithAi({
      botProfileId: "bot-researcher",
      ownerUserId: "user-a",
      sourceSurface: "user-note",
      evidence: "只在明确同意后发送模型。",
    });
    expect(result.method).toBe("local");
    expect(completeMemoryLlm).not.toHaveBeenCalled();
    expect(result.created.every((memory) => memory.state === "candidate")).toBe(
      true,
    );
  });

  test("明确同意后由模型压缩为 candidate，不直接激活", async () => {
    vi.mocked(completeMemoryLlm).mockResolvedValue(
      JSON.stringify({
        memories: [
          { text: "这个 Bot 的长期记忆只保存稳定偏好。", confidence: 0.8 },
        ],
      }),
    );
    const result = await consolidateBotMemoryWithAi({
      botProfileId: "bot-researcher",
      ownerUserId: "user-a",
      sourceSurface: "user-note",
      evidence: "请把稳定偏好整理成长期记忆。",
      allowModelProcessing: true,
    });
    expect(result.method).toBe("ai");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.state).toBe("candidate");
    expect(getActiveBotMemories("bot-researcher")).toEqual([]);
    expect(completeMemoryLlm).toHaveBeenCalledTimes(1);
  });

  test("模型失败时回退到本地整理并给出提示", async () => {
    vi.mocked(completeMemoryLlm).mockRejectedValue(new Error("模型暂不可用"));
    const result = await consolidateBotMemoryWithAi({
      botProfileId: "bot-researcher",
      ownerUserId: "user-a",
      sourceSurface: "user-note",
      evidence: "模型失败后仍然需要保留这条本地笔记。",
      allowModelProcessing: true,
    });
    expect(result.method).toBe("local");
    expect(result.warning).toContain("模型暂不可用");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.state).toBe("candidate");
  });
  test("候选记忆可落盘，但不会进入 active 读取", () => {
    saveBotMemoryCandidate(makeCandidate());
    expect(loadBotMemories("bot-researcher")).toHaveLength(1);
    expect(getActiveBotMemories("bot-researcher")).toEqual([]);
  });

  test("只有用户确认才能激活记忆", () => {
    saveBotMemoryCandidate(makeCandidate());
    const active = activateBotMemory("memory-1", 200);
    expect(active.state).toBe("active");
    expect(active.activatedAt).toBe(200);
    expect(active.revision).toBe(2);
    expect(getActiveBotMemories("bot-researcher")).toEqual([active]);
  });

  test("禁止外部直接写 active", () => {
    expect(() =>
      saveBotMemoryCandidate({
        ...makeCandidate(),
        state: "active",
        activatedAt: 100,
      }),
    ).toThrow("必须先进入 candidate");
  });

  test("只有 candidate 可以确认，重复确认会被拒绝", () => {
    saveBotMemoryCandidate(makeCandidate());
    activateBotMemory("memory-1", 200);
    expect(() => activateBotMemory("memory-1", 300)).toThrow("只有 candidate");
  });

  test("候选记忆可以拒绝或归档", () => {
    saveBotMemoryCandidate(makeCandidate("reject-me"));
    saveBotMemoryCandidate(makeCandidate("archive-me"));
    expect(rejectBotMemory("reject-me", 300).state).toBe("rejected");
    expect(archiveBotMemory("archive-me", 400).state).toBe("archived");
    expect(getActiveBotMemories("bot-researcher")).toEqual([]);
  });

  test("active 记忆不能直接拒绝或归档", () => {
    saveBotMemoryCandidate(makeCandidate());
    activateBotMemory("memory-1", 200);
    expect(() => rejectBotMemory("memory-1")).toThrow("不能直接");
    expect(() => archiveBotMemory("memory-1")).toThrow("不能直接");
  });

  test("非法 confidence、source 和空文本会被拒绝", () => {
    expect(() =>
      saveBotMemoryCandidate({ ...makeCandidate(), confidence: 2 }),
    ).toThrow("confidence");
    expect(() =>
      saveBotMemoryCandidate({
        ...makeCandidate(),
        sourceSurface: "unknown" as never,
      }),
    ).toThrow("sourceSurface");
    expect(() =>
      saveBotMemoryCandidate({ ...makeCandidate(), text: " " }),
    ).toThrow("text");
  });

  test("不同 Bot 的 active 记忆相互隔离", () => {
    saveBotMemoryCandidate(makeCandidate("memory-a"));
    saveBotMemoryCandidate({
      ...makeCandidate("memory-b"),
      botProfileId: "bot-writer",
    });
    activateBotMemory("memory-a", 200);
    activateBotMemory("memory-b", 200);
    expect(
      getActiveBotMemories("bot-researcher").map((memory) => memory.id),
    ).toEqual(["memory-a"]);
    expect(
      getActiveBotMemories("bot-writer").map((memory) => memory.id),
    ).toEqual(["memory-b"]);
  });
});
