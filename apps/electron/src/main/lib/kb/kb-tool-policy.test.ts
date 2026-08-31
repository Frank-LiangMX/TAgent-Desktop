import { describe, expect, it } from "vitest";
import { createKnowledgeBaseToolGate } from "./kb-tool-policy";

describe("knowledge-base tool gate", () => {
  it("preferred 模式要求每个回合先完成 kb_search", () => {
    const gate = createKnowledgeBaseToolGate({ bound: true, mode: "preferred" });

    expect(gate.beforeToolUse("WebSearch")).toContain("先调用 kb_search");
    gate.observeToolBatch([{ tool_name: "mcp__kb__kb_search" }]);
    expect(gate.beforeToolUse("WebSearch")).toBeUndefined();

    gate.resetForNewTurn();
    expect(gate.beforeToolUse("web_fetch")).toContain("先调用 kb_search");
  });

  it("strict 模式始终拒绝网页搜索，但不拦知识库工具", () => {
    const gate = createKnowledgeBaseToolGate({ bound: true, mode: "strict" });

    expect(gate.beforeToolUse("WebFetch")).toContain("仅用");
    expect(gate.beforeToolUse("mcp__kb__kb_search")).toBeUndefined();
  });

  it("未绑定或 off 模式不拦截网页工具", () => {
    expect(
      createKnowledgeBaseToolGate({ bound: false, mode: "preferred" }).beforeToolUse(
        "WebSearch",
      ),
    ).toBeUndefined();
    expect(
      createKnowledgeBaseToolGate({ bound: true, mode: "off" }).beforeToolUse(
        "WebSearch",
      ),
    ).toBeUndefined();
  });
});
