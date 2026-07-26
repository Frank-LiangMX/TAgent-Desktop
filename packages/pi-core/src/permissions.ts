/**
 * M2 最简权限：Bash 危险命令拦截
 *
 * Pi 无 permissionMode 概念，用 beforeToolCall 钩子（返回 {block, reason}）做权限。
 * M2 先做最简：危险命令 block，其他全 allow。CLI 加 --yes 跳过确认。
 *
 * 危险模式：rm -rf / 强制 git push / sudo / 磁盘写入 / 进程强杀 等。
 * 匹配到就返回 {block: true, reason}，Pi loop 会把 reason 作为 error tool result 喂回模型。
 */

/** 危险命令模式（命中即 block） */
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-rf?\s+\/(?:\s|$)/, reason: "rm -rf / 根目录删除，禁止" },
  { pattern: /\brm\s+-rf?\s+[\w./-]*\s*\*\s*$/m, reason: "rm -rf 通配删除，危险" },
  { pattern: /\bsudo\b/, reason: "sudo 提权命令，需确认" },
  { pattern: /\bgit\s+push\s+.*--force/i, reason: "git push --force 强推，需确认" },
  { pattern: /\bgit\s+push\s+-f\b/i, reason: "git push -f 强推，需确认" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/, reason: "直接写磁盘设备，禁止" },
  { pattern: /\bmkfs\b/, reason: "mkfs 格式化，禁止" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "dd 写磁盘设备，禁止" },
  { pattern: /\bchmod\s+-R\s+777\s+\//, reason: "chmod -R 777 根目录，禁止" },
  { pattern: /\bkill\s+-9\s+1\b/, reason: "kill -9 init 进程，禁止" },
  { pattern: /\b:\(\)\s*\{.*\};\s*:\)/, reason: "fork bomb，禁止" },
  { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b/, reason: "关机/重启命令，需确认" },
];

export interface PermissionCheckResult {
  /** true = 阻止执行 */
  block: boolean;
  /** 阻止时的原因（喂回模型） */
  reason?: string;
}

/**
 * 检查 Bash 命令是否危险。
 * @param command Bash 命令文本
 * @param allowDangerous 是否跳过确认（CLI --yes）。true 则全 allow
 */
export function checkBashPermission(
  command: string,
  allowDangerous: boolean,
): PermissionCheckResult {
  if (allowDangerous) return { block: false };
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { block: true, reason: `危险命令被拦截：${reason}。如确需执行，请用 --yes 启动 CLI。` };
    }
  }
  return { block: false };
}

/** 通用权限检查：按工具名分发。M2 只拦 Bash，其他工具全 allow。 */
export function checkToolPermission(
  toolName: string,
  args: unknown,
  allowDangerous: boolean,
): PermissionCheckResult {
  if (toolName === "Bash") {
    const command = (args as { command?: string })?.command ?? "";
    return checkBashPermission(command, allowDangerous);
  }
  // Read/Write/Edit 默认 allow（M2 最简，不拦文件读写）
  return { block: false };
}
