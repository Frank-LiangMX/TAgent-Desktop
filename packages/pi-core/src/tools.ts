/**
 * Pi Agent 内置工具：Read / Bash / Edit / Write
 *
 * 用底层 Agent 的 AgentTool 接口（非 AgentHarness，绕开 ExecutionToolContext 复杂度）。
 * 失败 throw（Pi loop 会转成 isError tool result）。
 * 参数 schema 用 TypeBox（从 pi-ai 重导出）。
 *
 * kscc bare 是文本推理大脑，这些工具在 Pi 侧执行，结果通过 antml:function_results 回喂。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

// ============ Read ============

const readSchema = Type.Object({
  path: Type.String({ description: "要读取的文件绝对或相对路径" }),
  offset: Type.Optional(Type.Number({ description: "开始行号（1-based），默认 1" })),
  limit: Type.Optional(Type.Number({ description: "读取行数，默认全读" })),
});

export const readTool: AgentTool<typeof readSchema, { path: string; lines: number }> = {
  name: "Read",
  label: "Read",
  description: "读取本地文件内容。一次读一个文件，返回文本内容。",
  parameters: readSchema,
  execute: async (_id, params): Promise<AgentToolResult<{ path: string; lines: number }>> => {
    const path = resolvePath(params.path);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const start = (params.offset ?? 1) - 1;
    const end = params.limit ? start + params.limit : lines.length;
    const sliced = lines.slice(Math.max(0, start), Math.max(0, end)).join("\n");
    return {
      content: [{ type: "text", text: sliced }],
      details: { path, lines: lines.length },
    };
  },
};

// ============ Write ============

const writeSchema = Type.Object({
  path: Type.String({ description: "要写入的文件路径" }),
  content: Type.String({ description: "文件内容" }),
});

export const writeTool: AgentTool<typeof writeSchema, { path: string; bytes: number }> = {
  name: "Write",
  label: "Write",
  description: "写入本地文件（覆盖已有内容）。目录不存在会自动创建。",
  parameters: writeSchema,
  execute: async (_id, params): Promise<AgentToolResult<{ path: string; bytes: number }>> => {
    const path = resolvePath(params.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    return {
      content: [{ type: "text", text: `已写入 ${path}（${params.content.length} 字符）` }],
      details: { path, bytes: params.content.length },
    };
  },
};

// ============ Edit ============

const editSchema = Type.Object({
  path: Type.String({ description: "要编辑的文件路径" }),
  oldText: Type.String({ description: "要替换的原文（必须精确匹配，含缩进）" }),
  newText: Type.String({ description: "替换后的新文本" }),
});

export const editTool: AgentTool<typeof editSchema, { path: string; replaced: number }> = {
  name: "Edit",
  label: "Edit",
  description: "精确替换文件中的一段文本。oldText 必须在文件中唯一存在且精确匹配。",
  parameters: editSchema,
  execute: async (_id, params): Promise<AgentToolResult<{ path: string; replaced: number }>> => {
    const path = resolvePath(params.path);
    const content = await readFile(path, "utf8");
    if (!content.includes(params.oldText)) {
      throw new Error(`oldText 在文件 ${path} 中未找到（必须精确匹配，含缩进和换行）`);
    }
    const occurrences = content.split(params.oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(`oldText 在文件 ${path} 中出现 ${occurrences} 次，必须唯一。请提供更多上下文使其唯一。`);
    }
    const newContent = content.replace(params.oldText, params.newText);
    await writeFile(path, newContent, "utf8");
    return {
      content: [{ type: "text", text: `已替换 ${path} 中 1 处文本` }],
      details: { path, replaced: 1 },
    };
  },
};

// ============ Bash ============

const bashSchema = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令" }),
  timeout: Type.Optional(Type.Number({ description: "超时毫秒数，默认 30000" })),
});

export interface BashToolDetails {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const bashTool: AgentTool<typeof bashSchema, BashToolDetails> = {
  name: "Bash",
  label: "Bash",
  description: "执行 shell 命令并返回 stdout/stderr/exitCode。用于跑脚本、查目录、git 操作等。",
  parameters: bashSchema,
  execute: async (_id, params): Promise<AgentToolResult<BashToolDetails>> => {
    const timeoutMs = params.timeout ?? 30000;
    const result = await runShell(params.command, timeoutMs, process.cwd());
    // 输出过长截断
    const MAX = 8000;
    let out = result.stdout;
    let err = result.stderr;
    if (out.length > MAX) out = truncateOutput(out, MAX);
    if (err.length > MAX) err = truncateOutput(err, MAX);
    const text = `[exit ${result.exitCode}]\nstdout:\n${out}\nstderr:\n${err}`;
    // 非零退出也当成功返回（让模型看到错误信息自己处理），只有命令根本跑不了才 throw
    if (result.exitCode === -1) {
      throw new Error(`命令执行失败：${err}`);
    }
    return {
      content: [{ type: "text", text }],
      details: result,
    };
  },
};

/**
 * 创建带指定 cwd 的 Bash 工具实例（会话级，闭包注入工作目录，不读 process.cwd）。
 * 用于多会话/多工作区场景：每个会话一个 bashTool，cwd 不串。
 */
export function createBashTool(cwd: string): AgentTool<typeof bashSchema, BashToolDetails> {
  return {
    name: "Bash",
    label: "Bash",
    description: "执行 shell 命令并返回 stdout/stderr/exitCode。用于跑脚本、查目录、git 操作等。",
    parameters: bashSchema,
    execute: async (_id, params): Promise<AgentToolResult<BashToolDetails>> => {
      const timeoutMs = params.timeout ?? 30000;
      const result = await runShell(params.command, timeoutMs, cwd);
      const MAX = 8000;
      let out = result.stdout;
      let err = result.stderr;
      if (out.length > MAX) out = truncateOutput(out, MAX);
      if (err.length > MAX) err = truncateOutput(err, MAX);
      const text = `[exit ${result.exitCode}]\nstdout:\n${out}\nstderr:\n${err}`;
      if (result.exitCode === -1) {
        throw new Error(`命令执行失败：${err}`);
      }
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}

/**
 * Windows 命令净化：去掉命令末尾的 `| more` 分页段。
 * cmd 的 more.com 会把 UTF-8 输出按控制台代码页（GBK）重编码 → 中文乱码，
 * 且满屏后暂停等待按键（管道下无按键 → 挂起直到超时被杀）。
 * 工具本身会截断过长的输出，分页无意义，直接去掉。
 */
function normalizeCommandForWindows(command: string): string {
  if (process.platform !== "win32") return command;
  return command.replace(/\s*\|\s*more(?:\s+[^\s|]*)?\s*$/i, "");
}

/** 截断长输出：保留头尾（头部 70% + 尾部 30%），避免尾部错误信息/目标文件被整体丢掉 */
function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n… [中段 ${omitted} 字符已省略，共 ${text.length} 字符] …\n${text.slice(-tail)}`;
}

/**
 * 解码子进程输出：优先 UTF-8 严格解码（fatal），失败回退 GBK。
 * 中文 Windows（代码页 936）下 dir/type/findstr/git log 等命令输出 GBK，
 * 默认 Buffer.toString() 按 UTF-8 硬解会产生乱码。
 */
function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      // Node/Bun 的 Encoding 类型未收录 gbk（WHATWG 标准编码，运行时 ICU 支持）
      return new TextDecoder("gbk" as never).decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

/** Windows 下杀掉整个进程树（shell:true 的 cmd.exe 会再 spawn 命令进程，只杀父进程会留孤儿） */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
  }
}

function runShell(command: string, timeoutMs: number, cwd: string): Promise<BashToolDetails> {
  return new Promise((resolve) => {
    const child = spawn(normalizeCommandForWindows(command), {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killProcessTree(child);
        const stderr = decodeOutput(Buffer.concat(stderrChunks)) + `\n[超时 ${timeoutMs}ms 被杀]`;
        resolve({ exitCode: -1, stdout: decodeOutput(Buffer.concat(stdoutChunks)), stderr });
      }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdoutChunks.push(Buffer.from(d)); });
    child.stderr?.on("data", (d: Buffer) => { stderrChunks.push(Buffer.from(d)); });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 0,
          stdout: decodeOutput(Buffer.concat(stdoutChunks)),
          stderr: decodeOutput(Buffer.concat(stderrChunks)),
        });
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          stdout: decodeOutput(Buffer.concat(stdoutChunks)),
          stderr: decodeOutput(Buffer.concat(stderrChunks)) + `\n${err.message}`,
        });
      }
    });
  });
}

// ============ 工具集导出 + schema 描述（注入 system prompt） ============

import type { ToolSchemaDescriptor } from "./antml-protocol.ts";

/** 默认工具集（Read/Write/Edit/Bash） */
export const defaultTools = [readTool, writeTool, editTool, bashTool];

/** 默认工具集的 schema 描述（注入 kscc bare system prompt，让模型用 antml:invoke 调用） */
export const defaultToolDescriptors: ToolSchemaDescriptor[] = [
  {
    name: "Read",
    description: "读取本地文件内容。",
    parameters: {
      path: { type: "string", required: true, description: "文件路径" },
      offset: { type: "number", description: "开始行号 1-based" },
      limit: { type: "number", description: "读取行数" },
    },
  },
  {
    name: "Write",
    description: "写入本地文件（覆盖）。",
    parameters: {
      path: { type: "string", required: true, description: "文件路径" },
      content: { type: "string", required: true, description: "文件内容" },
    },
  },
  {
    name: "Edit",
    description: "精确替换文件中一段文本。",
    parameters: {
      path: { type: "string", required: true, description: "文件路径" },
      oldText: { type: "string", required: true, description: "要替换的原文，须唯一精确匹配" },
      newText: { type: "string", required: true, description: "替换后的文本" },
    },
  },
  {
    name: "Bash",
    description: "执行 shell 命令。",
    parameters: {
      command: { type: "string", required: true, description: "shell 命令" },
      timeout: { type: "number", description: "超时毫秒，默认 30000" },
    },
  },
];
