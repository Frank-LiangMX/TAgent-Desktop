/**
 * 知识库文档写入发布闸门。
 *
 * 正式入库默认可用；部署方可显式设置 TAGENT_ENABLE_KB_WRITES=0 关闭。
 * Agent 入库仍须绑定知识库、提交带标签的草稿并由用户确认。
 */
export const KNOWLEDGE_BASE_WRITE_ENABLE_ENV = "TAGENT_ENABLE_KB_WRITES";

export const KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE =
  "知识库文档写入在当前版本暂不可用";

export function areKnowledgeBaseWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[KNOWLEDGE_BASE_WRITE_ENABLE_ENV]?.trim().toLowerCase();
  return (
    value === undefined ||
    value === "" ||
    value === "1" ||
    value === "true" ||
    value === "yes"
  );
}

export function assertKnowledgeBaseWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!areKnowledgeBaseWritesEnabled(env)) {
    throw new Error(KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE);
  }
}
