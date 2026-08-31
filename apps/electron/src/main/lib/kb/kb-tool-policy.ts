export type KnowledgeBaseToolMode = "off" | "preferred" | "strict";

export interface KnowledgeBaseToolPolicy {
  bound: boolean;
  mode: KnowledgeBaseToolMode;
}

export interface KnowledgeBaseToolGate {
  resetForNewTurn(): void;
  observeToolBatch(toolCalls: Array<{ tool_name?: string }>): void;
  beforeToolUse(toolName: string): string | undefined;
}

function leafToolName(toolName: string): string {
  const parts = toolName.split("__");
  return (parts[parts.length - 1] ?? toolName).trim().toLowerCase();
}

function isKnowledgeBaseSearch(toolName: string): boolean {
  return leafToolName(toolName) === "kb_search";
}

function isWebLookup(toolName: string): boolean {
  const leaf = leafToolName(toolName).replace(/[-\s]/g, "_");
  return (
    leaf === "websearch" ||
    leaf === "web_search" ||
    leaf === "webfetch" ||
    leaf === "web_fetch"
  );
}

/**
 * 知识库模式的最小运行时门控。
 *
 * 提示词负责引导模型，门控负责防止网页工具在知识库检索之前抢跑：
 * - preferred：当前回合先完成一次 kb_search，之后允许网页补充；
 * - strict：整回合禁止 WebSearch/WebFetch；
 * - off / 未绑定：不拦截。
 */
export function createKnowledgeBaseToolGate(
  policy: KnowledgeBaseToolPolicy,
): KnowledgeBaseToolGate {
  let searchedThisTurn = false;

  return {
    resetForNewTurn(): void {
      searchedThisTurn = false;
    },

    observeToolBatch(toolCalls): void {
      if (
        toolCalls.some((call) =>
          isKnowledgeBaseSearch(String(call.tool_name ?? "")),
        )
      ) {
        searchedThisTurn = true;
      }
    },

    beforeToolUse(toolName): string | undefined {
      if (!policy.bound || policy.mode === "off" || !isWebLookup(toolName)) {
        return undefined;
      }
      if (policy.mode === "strict") {
        return "当前会话处于知识库“仅用”模式，禁止调用 WebSearch/WebFetch；只能依据已绑定知识库内容回答。";
      }
      if (!searchedThisTurn) {
        return "当前会话已绑定知识库且处于“优先”模式，请先调用 kb_search 检索绑定知识库，再使用网页工具补充。";
      }
      return undefined;
    },
  };
}
