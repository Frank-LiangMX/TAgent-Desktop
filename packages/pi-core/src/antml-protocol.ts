/**
 * antml 协议解析与序列化
 *
 * kscc bare 是"纯文本推理大脑"，不碰工具。模型在 text 块里用 antml 标记表示工具调用，
 * Pi 端自己解析这些标记成 ToolCall，执行后把结果序列化成 antml:function_results 回喂。
 *
 * 实测语法（kscc 1.1.28 + glm-5.2，稳定）：
 *
 * 工具调用（模型输出，承载在 text 块的 text_delta 流里）：
 *   <antml:invoke name="list_files">
 *   <antml:parameter name="path">.</antml:parameter>
 *   </antml:invoke>
 *   - 参数是子元素 <antml:parameter name="key">value</antml:parameter>，不是空格分隔
 *   - 多工具调用背靠背，无外层包裹
 *   - 参数值是原始文本，换行/引号/JSON 原样，不转义
 *
 * 工具结果回喂（Pi 序列化，作为下一轮 user message 喂 kscc stdin）：
 *   <antml:function_results>
 *   <antml:result>
 *   <antml:name>list_files</antml:name>
 *   <antml:output>file1.ts\nfile2.ts</antml:output>
 *   <antml:isError>true</antml:isError>   <!-- 错误时加 -->
 *   </antml:result>
 *   </antml:function_results>
 *
 * 无官方 spec，解析器宽容处理（属性引号可有可无、换行数不定）。
 */

/** 一个解析出的工具调用 */
export interface AntmlToolCall {
  /** 工具名（invoke name 属性） */
  name: string;
  /** 参数 map（parameter name → 原始文本值，类型 coerce 由调用方按 schema 做） */
  arguments: Record<string, string>;
  /** 该 invoke 块在原文里的起止位置，用于剥离标记文本 */
  start: number;
  end: number;
  /** 原始 invoke 块全文（调试用） */
  raw: string;
}

/** 一个待序列化的工具结果 */
export interface AntmlToolResult {
  name: string;
  /** 结果文本（成功 = 输出，错误 = 错误信息） */
  output: string;
  isError?: boolean;
}

// ============ 解析：antml:invoke → ToolCall[] ============

const INVOKE_RE = /<antml:invoke\s+name\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/antml:invoke>/g;
const PARAM_RE = /<antml:parameter\s+name\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/antml:parameter>/g;

/**
 * 从一段完整文本里解析所有 antml:invoke 工具调用。
 * 必须在 text 块结束后调用（流式增量可能切断标签，完整解析只做 finalize）。
 *
 * 返回所有解析出的 ToolCall。文本里没有标记则返回空数组。
 */
export function parseAntmlInvokes(text: string): AntmlToolCall[] {
  const calls: AntmlToolCall[] = [];
  // 重置正则 lastIndex（全局正则复用安全）
  INVOKE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOKE_RE.exec(text)) !== null) {
    const full = m[0];
    const name = m[1] ?? '';
    const body = m[2] ?? '';
    const args: Record<string, string> = {};
    // 解析参数子元素
    PARAM_RE.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = PARAM_RE.exec(body)) !== null) {
      const key = pm[1] ?? ''
      const val = pm[2] ?? ''
      args[key] = val;
    }
    calls.push({
      name,
      arguments: args,
      start: m.index,
      end: m.index + full.length,
      raw: full,
    });
  }
  return calls;
}

/** 判断文本里是否含 antml:invoke 标记（轻量检测，用于流式判断是否要等 block 结束再解析） */
export function hasAntmlInvoke(text: string): boolean {
  return /<antml:invoke\s+name/.test(text);
}

/**
 * 从文本里剥离所有 antml:invoke 块，返回剩余的自然语言文本。
 * 用于把 assistant message 的 text content 里工具标记去掉，只保留给用户看的文字。
 */
export function stripAntmlInvokes(text: string): string {
  return text.replace(INVOKE_RE, "").replace(/<antml:parameter[^>]*>[\s\S]*?<\/antml:parameter>/g, "").trim();
}

// ============ 序列化：ToolResult → antml:function_results 文本 ============

/**
 * 把工具结果序列化成 antml:function_results 文本，作为下一轮 user message 喂给 kscc。
 * 多个结果合并到一个 function_results 块。
 */
export function serializeAntmlResults(results: AntmlToolResult[]): string {
  const inner = results.map(serializeOneResult).join("\n");
  return `<antml:function_results>\n${inner}\n</antml:function_results>`;
}

function serializeOneResult(r: AntmlToolResult): string {
  const lines = [
    "<antml:result>",
    `<antml:name>${r.name}</antml:name>`,
    `<antml:output>${r.output}</antml:output>`,
  ];
  if (r.isError) {
    lines.push(`<antml:isError>true</antml:isError>`);
  }
  lines.push("</antml:result>");
  return lines.join("\n");
}

// ============ 工具 schema → system prompt 文本 ============

/**
 * 工具 schema 描述（用于注入 system prompt，让模型知道有哪些工具可调、参数怎么传）。
 * Pi 自定义工具不进 kscc 内置工具集，靠 system prompt 告知模型。
 */
export interface ToolSchemaDescriptor {
  name: string;
  description: string;
  /** 参数名 → 类型描述（"string" | "number" | "boolean" | "object" | "array"） */
  parameters: Record<string, { type: string; description?: string; required?: boolean }>;
}

/**
 * 生成 system prompt 的工具调用指引段落，告诉模型：
 *   1. 有哪些工具可用（name + 参数）
 *   2. 调用时必须用 antml:invoke 格式输出（给完整示例）
 *   3. 工具结果会以 antml:function_results 形式回喂，模型据此继续
 */
export function buildToolsSystemPromptSection(tools: ToolSchemaDescriptor[]): string {
  if (tools.length === 0) return "";
  const toolsDesc = tools.map((t) => {
    const params = Object.entries(t.parameters).map(([k, v]) => `- ${k} (${v.type})${v.required ? " 必填" : "可选"}${v.description ? `：${v.description}` : ""}`).join("\n");
    return `### ${t.name}\n${t.description}\n参数：\n${params}`;
  }).join("\n\n");

  return [
    "## 可用工具",
    toolsDesc,
    "",
    "## 工具调用格式",
    "调用工具时，必须严格输出以下 antml 标记格式（不要用其他格式）：",
    "<antml:invoke name=\"工具名\">",
    "<antml:parameter name=\"参数名1\">参数值1</antml:parameter>",
    "<antml:parameter name=\"参数名2\">参数值2</antml:parameter>",
    "</antml:invoke>",
    "",
    "示例（列出目录文件）：",
    "<antml:invoke name=\"list_files\">",
    "<antml:parameter name=\"path\">.</antml:parameter>",
    "</antml:invoke>",
    "",
    "调用工具后，工具结果会以 <antml:function_results> 形式返回给你，你据此继续回答或做下一步。",
    "不要在文本里假装或模拟工具结果，等真正的 function_results 返回。",
  ].join("\n");
}
