/**
 * @tagent/pi-core
 *
 * TAgent 可复用 Pi 内核库 —— 把 Pi Agent + kscc bare 模型泵封装成可复用模块。
 * 将来 TAgent 桌面版与可能的 TAgent CLI 版都调这一个内核。
 */

// M1：kscc bare 模型泵
export { createKsccBareStreamFn, type CreateKsccBareStreamFnOptions } from "./kscc-bare-stream-fn.ts";
// M1+：HTTP 直连 streamFn（不走 kscc，直接 HTTP 请求外部渠道）
export { createHttpDirectStreamFn, type CreateHttpDirectStreamFnOptions } from "./http-direct-stream-fn.ts";
export { AssistantMessageBuilder } from "./assistant-message-builder.ts";
export {
  mapKsccLineToPiEvents,
  mapStopReason,
  type KsccLine,
  type AnthropicStreamEvent,
  type ParsedLine,
} from "./kscc-ndjson-parser.ts";
export { spawnKsccBare, type KsccBareSpawnOptions, type KsccBareProcess } from "./kscc-spawn.ts";

// M2：antml 协议 + 工具 + 权限
export {
  parseAntmlInvokes,
  hasAntmlInvoke,
  stripAntmlInvokes,
  serializeAntmlResults,
  buildToolsSystemPromptSection,
  type AntmlToolCall,
  type AntmlToolResult,
  type ToolSchemaDescriptor,
} from "./antml-protocol.ts";
export { readTool, writeTool, editTool, bashTool, createBashTool, defaultTools, defaultToolDescriptors, type BashToolDetails } from "./tools.ts";
export { checkToolPermission, checkBashPermission, type PermissionCheckResult } from "./permissions.ts";

// M3：Xfast 竞争调度
export { createXfastStreamFn, type XfastConfig } from "./xfast-stream-fn.ts";

// M4：MoA 多模型协作
export {
  runReferenceModels,
  buildAggregatorPrompt,
  buildAggregatorContext,
  type ReferenceModelConfig,
  type ReferenceOutput,
} from "./moa-orchestrator.ts";

// M5：MCP 桥（MCP server 工具 → Pi AgentTool）
export {
  buildMcpTools,
  buildMcpToolsForServer,
  disposeMcpConnections,
  invalidateMcpServer,
  type McpServerEntry,
  type McpTransportType,
  type WorkspaceMcpConfig,
} from "./mcp-bridge.ts";
