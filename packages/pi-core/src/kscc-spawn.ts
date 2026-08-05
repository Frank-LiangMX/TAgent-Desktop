/**
 * kscc bare 子进程管理
 *
 * spawn `kscc -p --bare` 做模型泵：
 *   - 三件套：--tools "" + --max-turns 1 + system-prompt 禁工具/禁标记
 *   - --output-format stream-json --include-partial-messages 拿流式 NDJSON
 *   - stdin 喂对话文本，stdout 吐 NDJSON 事件流
 *
 * kscc bare 不 resume、不读 sdk-config JSONL、每次独立 —— 喂多少收多少，
 * 这正是 bare 治 resume 长会话爆/慢根因的关键。
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { buildToolsSystemPromptSection, serializeAntmlResults, type ToolSchemaDescriptor } from "./antml-protocol.ts";

// ============ Windows .cmd/.bat spawn 安全解析 ============

/**
 * 判断路径是否为 Windows 批处理（.cmd / .bat）。
 * 仅按扩展名判断，不读盘。
 */
export function isWindowsBatchFile(filePath: string): boolean {
  return /\.(cmd|bat)$/i.test(filePath);
}

/**
 * 为 cmd.exe /c 命令行转义单个参数。
 * 空串必须写成 ""，否则会被吞掉（如 --tools ""）。
 */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  // 含空白或 cmd 元字符时双引号包裹；内部 " 加倍
  if (/[\s"&<>|^()%!`]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

export interface ResolvedSpawnInvocation {
  command: string;
  args: string[];
  /** 传给 spawn 的额外选项（如 windowsVerbatimArguments） */
  options: Pick<SpawnOptions, "windowsVerbatimArguments">;
}

/**
 * 解析实际 spawn 目标。
 *
 * Windows 上 Node 不经 shell 无法执行 .cmd/.bat（ENOENT / not a valid Win32 application）。
 * 对批处理走 `cmd.exe /d /s /c "..."` + windowsVerbatimArguments，避免 shell:true
 * 把临时路径（8.3 短名 / 反斜杠）解析坏；非 Windows 或非批处理原样直 spawn。
 *
 * @param platform 可注入，便于单测（默认 process.platform）
 */
export function resolveKsccSpawnInvocation(
  ksccPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): ResolvedSpawnInvocation {
  if (platform === "win32" && isWindowsBatchFile(ksccPath)) {
    // /d 禁用 AutoRun；/s 配合首尾引号剥离规则；/c 执行后退出
    // 整行再包一层引号：/s 会剥掉最外层首尾 "，留下内部已正确引用的 command line
    const inner = [quoteCmdArg(ksccPath), ...args.map(quoteCmdArg)].join(" ");
    const cmdline = `"${inner}"`;
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", cmdline],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: ksccPath, args, options: {} };
}

/** extractToolResults 内部用的轻量结构 */
interface AntmlResultLike {
  name: string;
  output: string;
  isError?: boolean;
}

/** kscc bare 的基础 system prompt（中性，工具引导由 tools 段提供） */
const KSCC_BARE_SYSTEM_PROMPT = [
  "你是一个助手。",
  "根据用户需求回答；有可用工具时按需调用，无工具或不需要时直接回答。",
].join("\n");

/** 无工具时的禁工具约束（防模型凭训练记忆输出 antml/command 标记） */
const KSCC_BARE_NO_TOOLS_PROMPT = [
  "硬约束：当前无可用工具，禁止输出 <antml:invoke>、<command>、<FilesystemTool>、tool_use 等任何工具调用标记。",
  "只输出对用户问题的直接文本回答。",
].join("\n");

/** 把 system prompt 写到临时文件，返回文件路径（用 --system-prompt-file 传给 kscc）。
 * 写文件而非直接传参数，是因为 Windows shell:true 下多行参数值会被换行符切断，
 * 导致 --output-format stream-json 等后续参数被吃掉，kscc 退回 text 输出。 */
function writeSystemPromptFile(systemPrompt: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-cli-sp-"));
  const filePath = join(dir, "prompt.txt");
  writeFileSync(filePath, systemPrompt, "utf8");
  return filePath;
}

export interface KsccBareSpawnOptions {
  /** kscc 可执行文件路径，默认 "kscc" */
  ksccPath?: string;
  /** 要用的模型 id（传给 kscc --model） */
  modelId: string;
  /** Pi 的 context：systemPrompt + messages */
  context: Context;
  /** abort 信号 */
  signal?: AbortSignal;
  /** 额外附加到 system prompt 的内容（如 Agent loop 的指令） */
  appendSystemPrompt?: string;
  /** 可用工具的 schema 描述（注入 system prompt，让模型用 antml:invoke 调用）。
   * kscc bare 不接受 JSON schema --tools，Pi 自定义工具靠 system prompt 告知模型。 */
  tools?: ToolSchemaDescriptor[];
}

export interface KsccBareProcess {
  /** 等待子进程结束，返回 exit code */
  wait: () => Promise<number>;
  /** 主动 kill 子进程 */
  kill: () => void;
  /** stdout 的 NDJSON 行异步迭代器 */
  lines: AsyncIterable<string>;
  /** stderr 累积（用于错误诊断） */
  stderr: string;
}

/**
 * spawn kscc bare 子进程，返回可异步迭代 stdout NDJSON 行的对象。
 * 失败不 throw（由调用方在 streamFn 里 catch 并转成 error 事件）。
 */
export function spawnKsccBare(opts: KsccBareSpawnOptions): KsccBareProcess {
  const ksccPath = opts.ksccPath ?? "kscc";
  // 拼装 system prompt：基础 + 工具引导（有工具）或禁工具约束（无工具）+ 附加内容
  const toolsSection = opts.tools && opts.tools.length > 0 ? buildToolsSystemPromptSection(opts.tools) : "";
  const parts = [KSCC_BARE_SYSTEM_PROMPT];
  if (toolsSection) {
    parts.push(toolsSection);
  } else {
    parts.push(KSCC_BARE_NO_TOOLS_PROMPT);
  }
  if (opts.appendSystemPrompt) parts.push(opts.appendSystemPrompt);
  const systemPrompt = parts.join("\n\n");

  // system prompt 写临时文件，用 --system-prompt-file 传（避免 shell 换行切断参数）
  const promptFile = writeSystemPromptFile(systemPrompt);
  const promptDir = promptFile.replace(/[/\\][^/\\]+$/, "");

  const args = [
    "-p",
    "--bare",
    "--verbose",
    "--max-turns", "1",
    "--tools", "",
    "--system-prompt-file", promptFile,
    "--model", opts.modelId,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--input-format", "text",
  ];

  // Windows 上 .cmd/.bat 必须经 cmd.exe；非批处理 / 非 Windows 直 spawn。
  // 不用 shell:true —— 那会把临时路径（8.3 短名 + 反斜杠）解析坏，
  // 导致 --system-prompt-file 失效。改用 /d /s /c + windowsVerbatimArguments 保路径原样。
  const invocation = resolveKsccSpawnInvocation(ksccPath, args);
  const child = spawn(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...invocation.options,
  });

  // 子进程退出后清理临时目录
  child.on("exit", () => {
    try { rmSync(promptDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  const stderrBuf: string[] = [];

  // 把 stdin 写进去：序列化 context 成纯文本对话
  const stdinText = serializeContextToStdin(opts.context, opts.modelId);
  if (child.stdin) {
    child.stdin.end(stdinText);
  }

  // 收集 stderr
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk.toString());
    });
  }

  // abort 信号：kill 子进程
  const onAbort = () => {
    killChild(child);
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      killChild(child);
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // 构建异步迭代器：按行读 stdout NDJSON
  const lines = createLineIterator(child);

  return {
    wait: () => waitForChild(child),
    kill: () => {
      killChild(child);
      opts.signal?.removeEventListener("abort", onAbort);
    },
    lines,
    get stderr() {
      return stderrBuf.join("");
    },
  };
}

/**
 * 把 Pi 的 Context 序列化成 kscc bare 的 stdin 纯文本。
 *
 * M1 策略：把整个对话历史拼成多轮文本对话喂给 kscc（bare 不 resume，每次独立）。
 * systemPrompt 走 --system-prompt 参数，不拼进 stdin。
 *
 * 注意：context.messages 是 pi-ai 的 Message[]（UserMessage | AssistantMessage | ToolResultMessage）。
 * M1 只处理 text 内容，tool_result 等降级成简单文本。
 */
function serializeContextToStdin(context: Context, _modelId: string): string {
  const lines: string[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text) lines.push(text);
    } else if (msg.role === "assistant") {
      // assistant 消息：text/thinking 喂回，toolCall 块还原成 antml:invoke（让模型知道上轮调了啥）
      const text = extractAssistantTextWithToolCalls(msg.content);
      if (text) lines.push(text);
    } else if (msg.role === "toolResult") {
      // 工具结果序列化成 antml:function_results 喂回
      const results = extractToolResults(msg);
      if (results.length > 0) {
        lines.push(serializeAntmlResults(results));
      }
    }
  }
  // kscc text 输入模式：把对话拼成一个块，最后一段作为当前 user 输入
  return lines.join("\n\n");
}

/** 从 ToolResultMessage 提取 antml 结果（name + output + isError） */
function extractToolResults(msg: unknown): AntmlResultLike[] {
  const results: AntmlResultLike[] = [];
  if (!msg || typeof msg !== "object") return results;
  const m = msg as Record<string, unknown>;
  // ToolResultMessage: { role:"toolResult", toolName, content:(TextContent|...)[], isError }
  const name = typeof m.toolName === "string" ? m.toolName : (typeof m.name === "string" ? m.name : "tool");
  const isError = Boolean(m.isError);
  let output = "";
  if (typeof m.content === "string") {
    output = m.content;
  } else if (Array.isArray(m.content)) {
    output = m.content.map((b: unknown) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object") {
        const bb = b as Record<string, unknown>;
        if (bb.type === "text" && typeof bb.text === "string") return bb.text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (output) results.push({ name, output, isError });
  return results;
}

/** 从 assistant 消息提取文本 + 把 toolCall 块还原成 antml:invoke 标记 */
function extractAssistantTextWithToolCalls(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") { parts.push(block); continue; }
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "thinking") { /* thinking 不喂回 */ }
      else if (b.type === "toolCall") {
        // 还原成 antml:invoke
        const name = typeof b.name === "string" ? b.name : "tool";
        const args = (b.arguments ?? {}) as Record<string, unknown>;
        const paramLines = Object.entries(args).map(([k, v]) =>
          `<antml:parameter name="${k}">${typeof v === "string" ? v : JSON.stringify(v)}</antml:parameter>`
        ).join("\n");
        parts.push(`<antml:invoke name="${name}">\n${paramLines}\n</antml:invoke>`);
      }
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** 从 pi-ai message content 提取文本（兼容 string 和 content block 数组） */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "thinking" && typeof b.thinking === "string") return ""; // thinking 不喂回 LLM
          if (b.type === "toolCall") return ""; // tool_call 不喂回
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

// ============ 子进程工具函数 ============

function killChild(child: ChildProcess): void {
  try {
    if (!child.killed) {
      child.kill("SIGTERM");
      // 硬杀兜底：1s 后还没死就 SIGKILL
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1000);
    }
  } catch {
    // 忽略，进程可能已退出
  }
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * 创建 stdout 的按行异步迭代器。
 * kscc stream-json 每行一个完整 JSON，按 \n 切分。
 */
function createLineIterator(child: ChildProcess): AsyncIterable<string> {
  const queue: string[] = [];
  let resolveNext: ((r: IteratorResult<string>) => void) | null = null;
  let done = false;
  let buffer = "";

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: trimmed, done: false });
    } else {
      queue.push(trimmed);
    }
  };

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        flushLine(line);
      }
    });
    child.stdout.on("end", () => {
      // flush 残留 buffer
      if (buffer.trim()) flushLine(buffer);
      buffer = "";
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    });
  } else {
    done = true;
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
}
