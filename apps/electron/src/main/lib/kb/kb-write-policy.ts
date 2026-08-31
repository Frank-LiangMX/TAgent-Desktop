/**
 * 知识库文档写入发布闸门。
 *
 * dev.6 默认关闭文档写入，避免尚未稳定的入库链路进入发行版使用路径。
 * 开发或专项验证时可显式设置 TAGENT_ENABLE_KB_WRITES=1/true 恢复写入。
 */
export const KNOWLEDGE_BASE_WRITE_ENABLE_ENV = "TAGENT_ENABLE_KB_WRITES";

export const KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE =
  "知识库文档写入在当前版本暂不可用";

export function areKnowledgeBaseWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[KNOWLEDGE_BASE_WRITE_ENABLE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function assertKnowledgeBaseWritesEnabled(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!areKnowledgeBaseWritesEnabled(env)) {
    throw new Error(KNOWLEDGE_BASE_WRITES_DISABLED_MESSAGE);
  }
}
