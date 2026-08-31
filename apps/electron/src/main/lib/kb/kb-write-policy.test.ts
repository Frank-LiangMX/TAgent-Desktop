import { describe, expect, it } from "vitest";
import {
  areKnowledgeBaseWritesEnabled,
  assertKnowledgeBaseWritesEnabled,
  KNOWLEDGE_BASE_WRITE_ENABLE_ENV,
  KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE,
} from "./kb-write-policy";

describe("knowledge-base write policy", () => {
  it("默认关闭文档写入", () => {
    expect(areKnowledgeBaseWritesEnabled({})).toBe(false);
    expect(() => assertKnowledgeBaseWritesEnabled({})).toThrow(
      KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE,
    );
  });

  it("只接受显式启用值", () => {
    for (const value of ["1", "true", "TRUE", " yes "]) {
      expect(
        areKnowledgeBaseWritesEnabled({
          [KNOWLEDGE_BASE_WRITE_ENABLE_ENV]: value,
        }),
      ).toBe(true);
    }
    expect(
      areKnowledgeBaseWritesEnabled({
        [KNOWLEDGE_BASE_WRITE_ENABLE_ENV]: "0",
      }),
    ).toBe(false);
  });

  it("启用后允许写入", () => {
    expect(() =>
      assertKnowledgeBaseWritesEnabled({
        [KNOWLEDGE_BASE_WRITE_ENABLE_ENV]: "1",
      }),
    ).not.toThrow();
  });
});
