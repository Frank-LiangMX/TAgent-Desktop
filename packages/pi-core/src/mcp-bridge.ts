/**
 * MCP 桥：MCP server 工具 → Pi AgentTool
 *
 * Pi 无原生 MCP 支持，本桥连接 MCP server，把其工具转成 Pi 的 AgentTool 注入 Agent。
 * 参考 Proma 的 pi-mcp-tools.ts，适配 pi-core 双轨（AgentTool + ToolSchemaDescriptor）。
 *
 * 消费 TAgent 的 McpServerEntry（type: 'stdio'|'http'|'sse'，有 enabled 开关）。
 * transport 三分支；listTools 批量转 AgentTool（mcp__server__tool 命名防撞车）；
 * execute 调 callTool + convertMcpResult；Type.Unsafe 包 inputSchema 当 TypeBox。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHash } from "node:crypto";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { ToolSchemaDescriptor } from "./antml-protocol.ts";

// ============ TAgent MCP 配置类型（对齐 packages/shared/src/types/agent.ts） ============

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpServerEntry {
  type: McpTransportType;
  command?: string; // stdio
  args?: string[]; // stdio
  env?: Record<string, string>; // stdio
  url?: string; // http/sse
  headers?: Record<string, string>; // http/sse
  timeout?: number; // 启动超时秒，仅 stdio，默认 30
  enabled: boolean;
}

export interface WorkspaceMcpConfig {
  servers: Record<string, McpServerEntry>;
}

// ============ 常量 ============

const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

// ============ 工具命名（防撞车） ============

function normalizeToolSegment(segment: string): string {
  const normalized = segment.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return "unnamed";
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`;
}

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeToolSegment(serverName)}__${normalizeToolSegment(toolName)}`;
}

// ============ transport 创建 ============

function getTimeoutMs(config: McpServerEntry): number {
  const timeoutSec = typeof config.timeout === "number" ? config.timeout : undefined;
  if (!timeoutSec || !Number.isFinite(timeoutSec) || timeoutSec <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  return timeoutSec * 1000;
}

function createTransport(name: string, config: McpServerEntry): Transport | undefined {
  if (config.type === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim()) {
      console.warn(`[MCP 桥] 服务器 ${name} 缺少 command，已跳过`);
      return undefined;
    }
    const env = config.env && typeof config.env === "object" ? config.env : undefined;
    return new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter((a): a is string => typeof a === "string") : undefined,
      env,
      stderr: "inherit",
    });
  }
  if (config.type === "http") {
    if (typeof config.url !== "string" || !config.url.trim()) {
      console.warn(`[MCP 桥] 服务器 ${name} 缺少 url，已跳过`);
      return undefined;
    }
    const headers = config.headers;
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
    });
  }
  if (config.type === "sse") {
    if (typeof config.url !== "string" || !config.url.trim()) {
      console.warn(`[MCP 桥] 服务器 ${name} 缺少 url，已跳过`);
      return undefined;
    }
    const headers = config.headers;
    return new SSEClientTransport(new URL(config.url), {
      requestInit: headers ? { headers } : undefined,
      eventSourceInit: headers
        ? ({
            fetch: (input: string | URL, init?: RequestInit) =>
              fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
          } as never)
        : undefined,
    });
  }
  console.warn(`[MCP 桥] 服务器 ${name} 使用暂不支持的类型 ${config.type}，已跳过`);
  return undefined;
}

// ============ JSON Schema → TypeBox ============

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return !!schema && typeof schema === "object" && !Array.isArray(schema);
}

function toTypeBoxSchema(schema: unknown): TSchema {
  if (!isObjectSchema(schema)) return Type.Object({});
  if (schema.type !== "object") return Type.Object({});
  return Type.Unsafe(schema);
}

// ============ MCP 结果 → Pi AgentToolResult ============

function stringifyForTool(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

interface McpCallToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
  toolResult?: unknown; // 老协议
}

function convertMcpResult(result: McpCallToolResult): AgentToolResult<unknown> {
  const content: Array<TextContent | ImageContent> = [];

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
      } else {
        // audio/resource/resource_link 降级成文本
        content.push({ type: "text", text: stringifyForTool(block) });
      }
    }
  } else if (result.toolResult !== undefined) {
    // 老协议
    content.push({ type: "text", text: stringifyForTool(result.toolResult) });
  }

  if (result.structuredContent !== undefined) {
    content.push({ type: "text", text: `structuredContent:\n${stringifyForTool(result.structuredContent)}` });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: stringifyForTool(result) });
  }

  // MCP 软失败（isError=true）：前置文本提示（Pi 无 isError 字段，靠文本告知模型）
  if (result.isError) {
    content.unshift({ type: "text", text: "MCP 工具返回 isError=true（执行失败）。以下是错误信息：" });
  }

  return { content, details: result };
}

// ============ MCP client manager（单例复用连接） ============

interface McpConnection {
  client: Client;
  transport: Transport;
  tools?: Awaited<ReturnType<Client["listTools"]>>["tools"];
}

function configHash(config: McpServerEntry): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}

class McpClientManager {
  private connections = new Map<string, Promise<McpConnection>>();

  async getConnection(serverName: string, config: McpServerEntry): Promise<McpConnection> {
    const key = `${serverName}:${configHash(config)}`;
    let conn = this.connections.get(key);
    if (conn) return conn;

    conn = this.createConnection(serverName, config);
    this.connections.set(key, conn);
    conn.catch(() => {
      // 连接失败从 map 删，下次重连
      this.connections.delete(key);
    });
    return conn;
  }

  private async createConnection(serverName: string, config: McpServerEntry): Promise<McpConnection> {
    const transport = createTransport(serverName, config);
    if (!transport) throw new Error(`MCP 服务器 ${serverName} transport 创建失败`);

    const client = new Client({ name: "tagent-pi-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
    transport.onerror = (err) => {
      console.warn(`[MCP 桥] 服务器 ${serverName} transport 错误:`, err);
    };
    transport.onclose = () => {
      const key = `${serverName}:${configHash(config)}`;
      this.connections.delete(key);
    };

    await client.connect(transport, { timeout: getTimeoutMs(config) });
    return { client, transport };
  }

  async listTools(serverName: string, config: McpServerEntry) {
    const conn = await this.getConnection(serverName, config);
    if (!conn.tools) {
      const result = await conn.client.listTools();
      conn.tools = result.tools;
    }
    return conn.tools;
  }

  async callTool(
    serverName: string,
    config: McpServerEntry,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const conn = await this.getConnection(serverName, config);
    return conn.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal, timeout: DEFAULT_MCP_REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true } as never,
    );
  }

  async dispose(): Promise<void> {
    const conns = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(
      conns.map(async (c) => {
        try {
          const conn = await c;
          await conn.transport.close();
        } catch {
          /* 忽略 */
        }
      }),
    );
  }

  /** 主动失效某 server 的连接（配置变更时调用） */
  invalidateServer(serverName: string): void {
    for (const key of Array.from(this.connections.keys())) {
      if (key.startsWith(`${serverName}:`)) {
        const conn = this.connections.get(key);
        this.connections.delete(key);
        conn?.then((c) => c.transport.close().catch(() => {})).catch(() => {});
      }
    }
  }
}

const manager = new McpClientManager();

/** 释放所有 MCP 连接（进程退出 / 工作区切换时调） */
export function disposeMcpConnections(): Promise<void> {
  return manager.dispose();
}

/** 失效某 server 的连接（配置变更时调） */
export function invalidateMcpServer(serverName: string): void {
  manager.invalidateServer(serverName);
}

// ============ MCP 工具 → Pi AgentTool 批量转换 ============

/**
 * 把一个 MCP server 的所有工具转成 Pi AgentTool[]。
 * 返回 AgentTool 数组 + 对应的 ToolSchemaDescriptor 数组（双轨对齐）。
 */
export async function buildMcpToolsForServer(
  serverName: string,
  config: McpServerEntry,
): Promise<{ tools: AgentTool<any>[]; descriptors: ToolSchemaDescriptor[] }> {
  if (!config.enabled) return { tools: [], descriptors: [] };

  const mcpTools = await manager.listTools(serverName, config);
  const tools: AgentTool<any>[] = [];
  const descriptors: ToolSchemaDescriptor[] = [];
  const seenNames = new Set<string>();

  for (const mcpTool of mcpTools) {
    const toolName = mcpToolName(serverName, mcpTool.name);
    if (seenNames.has(toolName)) {
      console.warn(`[MCP 桥] 工具名 ${toolName} 重复，跳过`);
      continue;
    }
    seenNames.add(toolName);

    const parameters = toTypeBoxSchema(mcpTool.inputSchema);
    const description = mcpTool.description || `MCP 工具 ${mcpTool.name}`;

    // AgentTool：execute 调 manager.callTool
    const tool: AgentTool<any> = {
      name: toolName,
      label: mcpTool.title || mcpTool.name,
      description,
      parameters,
      execute: async (_id, params, signal) => {
        const result = await manager.callTool(serverName, config, mcpTool.name, params as Record<string, unknown>, signal);
        return convertMcpResult(result as McpCallToolResult);
      },
    };
    tools.push(tool);

    // ToolSchemaDescriptor：注入 kscc system prompt 让模型用 antml 调用
    descriptors.push(mcpToolToDescriptor(toolName, description, mcpTool.inputSchema));
  }

  return { tools, descriptors };
}

/**
 * 把所有 enabled MCP server 的工具批量转成 Pi AgentTool[] + ToolSchemaDescriptor[]。
 * 并行连所有 server，单个失败不影响其他（allSettled）。
 */
export async function buildMcpTools(
  config: WorkspaceMcpConfig,
): Promise<{ tools: AgentTool<any>[]; descriptors: ToolSchemaDescriptor[] }> {
  const entries = Object.entries(config.servers).filter(([, c]) => c.enabled);
  const results = await Promise.allSettled(entries.map(([name, cfg]) => buildMcpToolsForServer(name, cfg)));

  const tools: AgentTool<any>[] = [];
  const descriptors: ToolSchemaDescriptor[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const entry = entries[i];
    if (r.status === "fulfilled") {
      tools.push(...r.value.tools);
      descriptors.push(...r.value.descriptors);
    } else {
      console.warn(`[MCP 桥] 服务器 ${entry?.[0] ?? i} 连接失败:`, r.reason);
    }
  }
  return { tools, descriptors };
}

// ============ MCP Tool → ToolSchemaDescriptor ============

function mcpToolToDescriptor(
  name: string,
  description: string,
  inputSchema: unknown,
): ToolSchemaDescriptor {
  const desc: ToolSchemaDescriptor = { name, description, parameters: {} };
  if (!isObjectSchema(inputSchema) || inputSchema.type !== "object") return desc;

  const props = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  if (!props) return desc;

  for (const [paramName, paramSchema] of Object.entries(props)) {
    if (!isObjectSchema(paramSchema)) continue;
    const type = typeof paramSchema.type === "string" ? paramSchema.type : "string";
    const isRequired = required.includes(paramName);
    const paramDesc = typeof paramSchema.description === "string" ? paramSchema.description : undefined;

    // 嵌套对象/数组：type 标 object/array，description 塞精简 JSON Schema
    let finalDesc = paramDesc;
    if (type === "object" || type === "array") {
      const schemaSnippet = JSON.stringify(paramSchema, null, 2).slice(0, 400);
      finalDesc = paramDesc ? `${paramDesc}\nJSON Schema: ${schemaSnippet}` : `JSON Schema: ${schemaSnippet}`;
    }

    desc.parameters[paramName] = {
      type,
      description: finalDesc,
      required: isRequired,
    };
  }
  return desc;
}
