import type { TAgentPermissionMode } from '../types/agent'

/**
 * 工具分类规则 — Agent 权限系统
 *
 * 定义安全工具白名单、安全 Bash 命令模式和危险命令列表。
 * 用于智能模式下的自动允许/询问判断。
 */

/** 始终安全的工具（免询问）— 读文件/搜索/信息查询，不写盘 */
export const SAFE_TOOLS: readonly string[] = [
  'Read', // 文件读取（项目内读操作默认放行）
  'Glob', // 文件名搜索
  'Grep', // 内容搜索
  'WebSearch', // 网络搜索
  'WebFetch', // 网页获取
  'TodoRead', // Todo 列表读取
  'TodoWrite', // Todo 列表写入（无安全风险）
  'TaskOutput', // 后台任务输出
  // 注意：AskUserQuestion 不在此列表 — 由 canUseTool 拦截并展示交互式 UI
]

/** 安全的 Bash 命令模式（全局只读，不依赖 cwd） */
export const SAFE_BASH_PATTERNS: readonly RegExp[] = [
  /^git\s+(status|log|diff|show|branch|remote|tag)\b/i,
  /^ls\b/i,
  /^head\b/i,
  /^tail\b/i,
  /^grep\b/i,
  /^rg\b/i,
  /^which\b/i,
  /^where\b/i, // Windows where.exe / PowerShell where 别名（只读定位）
  /^pwd$/i,
  /^env$/i,
  /^whoami$/i,
  /^uname\b/i,
  /^tree\b/i,
  /^wc\b/i,
  /^file\b/i,
  /^stat\b/i,
  /^du\b/i,
  /^df\b/i,
  /^node\s+--version$/i,
  /^bun\s+--version$/i,
  /^npm\s+(list|ls|view|info|outdated)\b/i,
  /^bun\s+(pm\s+ls)\b/i,
  // Windows 只读列举
  /^dir\b/i,
  // 注意：cat/echo/find/type/Get-Content 不在此列表（可触达 cwd 外）
  // 这些走 isProjectLocalReadOnlyBash（必须带 cwd 且路径在项目内）
]

/**
 * 危险命令前缀（按破坏性分类，语言无关）
 *
 * 匹配规则：token-based 前缀匹配（见 isDangerousCommand）。
 * 列表条目按"破坏性类别"组织，便于审阅与扩展。
 *
 * 设计原则：
 * - 只列"破坏性"操作（删除/覆盖/卸载/清理/系统修改/远程执行）
 * - 高频只读/构建命令（npm install、go build、cargo test）不列入，避免过度拦截
 * - 安装依赖（npm install、pip install、cargo add）不列入——供应链风险由用户自行评估
 */
export const DANGEROUS_COMMANDS: readonly string[] = [
  // A. 删除/破坏文件系统
  'rm',
  'rmdir',
  'del', // Windows
  'unlink',
  'shred',
  'truncate',
  'mkfs',
  'fdisk',
  'parted',
  'dd',
  // B. 权限/系统修改
  'sudo',
  'su',
  'doas',
  'runas', // Windows
  'chmod',
  'chown',
  'chgrp',
  'systemctl',
  'service',
  'launchctl', // macOS
  'sc stop', // Windows 服务
  'sc delete',
  'regedit', // Windows 注册表
  'defaults write', // macOS 系统配置
  'defaults delete',
  // C. 网络下载/执行（可能拉取并执行任意代码）
  'curl',
  'wget',
  'aria2c',
  'fetch',
  // D. 远程登录/传输
  'ssh',
  'scp',
  'rsync',
  'mosh',
  'telnet',
  'rlogin',
  // E. 进程控制
  'kill',
  'killall',
  'pkill',
  'taskkill', // Windows
  // F. 包管理卸载/破坏（只列卸载和安装二进制，不列安装依赖）
  'pip uninstall',
  'pip3 uninstall',
  'uv pip uninstall',
  'npm uninstall',
  'npm rm',
  'npm un',
  'yarn remove',
  'pnpm remove',
  'pnpm rm',
  'apt remove',
  'apt purge',
  'apt-get remove',
  'apt-get purge',
  'yum remove',
  'dnf remove',
  'brew uninstall',
  'pacman -R',
  'pacman -Rs',
  'pacman -Rns',
  'cargo uninstall',
  'go install', // 安装二进制到 GOPATH/bin
  // G. 构建清理（删除产物）
  'make clean',
  'make distclean',
  'make uninstall',
  'make mrproper',
  'cargo clean',
  'go clean',
  'bazel clean',
  'mvn clean',
  'gradle clean',
  // H. Git 破坏性操作
  'git push',
  'git reset',
  'git rebase',
  'git checkout .', // 丢弃工作区改动
  'git checkout --', // 丢弃工作区改动（显式 -- 分隔）
  'git clean',
  'git branch -D',
  'git branch -d',
  'git commit --amend',
  'git stash drop',
  'git stash clear',
  'git filter-branch',
  'git reflog expire',
  // I. 容器/编排破坏
  'docker rm',
  'docker rmi',
  'docker system prune',
  'docker volume rm',
  'docker network rm',
  'docker kill',
  'docker stop',
  'docker compose down',
  'docker-compose down',
  'kubectl delete',
  // J. 发布（影响外部状态）
  'npm publish',
]

/**
 * 检测 Bash 命令是否包含危险结构
 *
 * 检测管道、输出重定向、exec 子命令等危险模式。
 * MVP 阶段使用简单字符串检测，后续可升级为 shell AST 解析。
 */
export function hasDangerousStructure(command: string): boolean {
  // 管道操作
  if (/[|]/.test(command)) return true
  // 输出重定向
  if (/>{1,2}/.test(command)) return true
  // find -exec / -delete（可执行任意命令/删除文件）
  // 注意：\b 在空格与 - 之间不匹配（两者都是非单词字符），
  // 必须用 (?:^|\s) 确保 -exec/-delete 是独立参数
  if (/(?:^|\s)-exec\b/.test(command) || /(?:^|\s)-delete\b/.test(command)) return true
  // 命令链接操作符（&&、;）
  if (/[;&]/.test(command)) return true
  // 子 shell / 命令替换（$(...) 和反引号）
  if (/\$\(/.test(command) || /`/.test(command)) return true
  return false
}

/**
 * 检测 Bash 命令是否包含真正会写文件 / 执行任意命令的结构
 *
 * 与 hasDangerousStructure 的差异：不再把命令链接（&&/;）和管道（|）判为危险，
 * 因为这些结构本身不写文件、不执行任意命令，只是组合命令的方式。
 *
 * 用于 isWhitelisted：用户选过"总是允许 Bash"后，只对真正能绕过工具分类
 * 直接修改文件系统的结构重新询问，不再因中性结构（&&/|）反复弹窗。
 */
export function hasWriteStructure(command: string): boolean {
  // 输出重定向（> / >>）— 可写文件
  if (/>{1,2}/.test(command)) return true
  // find -exec / -delete — 可执行任意命令 / 删除文件
  if (/(?:^|\s)-exec\b/.test(command) || /(?:^|\s)-delete\b/.test(command)) return true
  // 子 shell / 命令替换（$(...) 和反引号）— 可执行任意命令
  if (/\$\(/.test(command) || /`/.test(command)) return true
  return false
}

/** 按 | / && / ; 拆分复合命令段（引号内不拆——MVP 足够覆盖分析目录常见写法） */
function splitShellSegments(command: string): string[] {
  return command
    .split(/(?:\||&&|;)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 判断 Bash 命令是否匹配安全模式（全局只读）。
 * 允许纯只读段的管道/串联（如 `ls | head`），禁止写结构。
 */
export function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (hasWriteStructure(trimmed)) return false
  if (isDangerousCommand(trimmed)) return false
  const segments = splitShellSegments(trimmed)
  if (segments.length === 0) return false
  return segments.every(
    (seg) =>
      !isDangerousCommand(seg) && SAFE_BASH_PATTERNS.some((pattern) => pattern.test(seg)),
  )
}

/**
 * 判断命令是否为危险命令
 *
 * 使用 token-based 前缀匹配：命令按空白分割为 tokens，
 * 检查前 N 个 token 是否与某条 DANGEROUS_COMMANDS 条目完全相等。
 *
 * 相比 startsWith 的改进：
 * - `del` 不再误匹配 `delta`、`rms` 等
 * - `rm` 不再误匹配 `rmdir`（rmdir 单独列出）
 * - `fetch` 不再误匹配 `git fetch`（第一个 token 是 git）
 * - `sc` 不再误匹配 `scala`、`scp` 等
 */
export function isDangerousCommand(command: string): boolean {
  const tokens = command.trim().toLowerCase().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === '') return false
  return DANGEROUS_COMMANDS.some((dc) => {
    const dcTokens = dc.toLowerCase().split(/\s+/)
    if (tokens.length < dcTokens.length) return false
    return dcTokens.every((t, i) => tokens[i] === t)
  })
}

/** 写操作工具名称 */
export const WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

/** automation MCP 只读工具（auto 模式下免确认） */
export const AUTOMATION_MCP_READ_TOOLS: readonly string[] = [
  'mcp__automation__list_automations',
  'mcp__automation__get_automation',
]

/** automation MCP 写操作工具（auto 模式下需用户确认） */
export const AUTOMATION_MCP_MUTATION_TOOLS: readonly string[] = [
  'mcp__automation__create_automation',
  'mcp__automation__update_automation',
  'mcp__automation__delete_automation',
  'mcp__automation__run_automation_now',
]

/** 解析 MCP 工具名：mcp__server__tool → { server, tool } */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__')
  if (parts[0] !== 'mcp' || parts.length < 3) return null
  return { server: parts[1]!, tool: parts.slice(2).join('__') }
}

export function isAutomationReadTool(toolName: string): boolean {
  return AUTOMATION_MCP_READ_TOOLS.includes(toolName)
}

export function isAutomationMutationTool(toolName: string): boolean {
  return AUTOMATION_MCP_MUTATION_TOOLS.includes(toolName)
}

/**
 * 判断工具是否为写操作（auto 模式下需用户确认）
 */
export function isWriteTool(toolName: string, input: Record<string, unknown>): boolean {
  if (WRITE_TOOLS.includes(toolName)) return true
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return !isSafeBashCommand(command)
  }
  return false
}

/** 会话外影响 / 后台执行类工具（自动审批模式下需用户确认） */
export const HIGH_RISK_PROACTIVE_TOOLS: readonly string[] = [
  'Task',
  'REPL',
  'Workflow',
  'ScheduleWakeup',
  'Monitor',
  'PushNotification',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
]

/** 只读类内置工具（自动审批模式下免确认） */
export const AUTO_MODE_READ_ONLY_TOOLS: readonly string[] = [
  'Skill',
  'TaskList',
  'TaskGet',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]

/**
 * 项目内只读 Bash 命令模式（auto 模式下，cwd 内 + 只读 → 免询问）。
 * 含 Unix 与 Windows 常见读操作（分析目录时 Pi 常走 Bash 而非 Read）。
 */
const PROJECT_LOCAL_READ_ONLY_BASH_PATTERNS: readonly RegExp[] = [
  // Unix / Git Bash
  /^cat\b/i,
  /^find\b/i,
  /^echo\b/i,
  /^sed\s+-n\b/i, // sed -n 静默打印（无 -i 原地编辑）
  /^awk\b/i,
  /^sort\b/i,
  /^uniq\b/i,
  /^cut\b/i,
  /^tr\b/i,
  /^diff\b/i,
  /^grep\b/i,
  /^rg\b/i,
  /^head\b/i,
  /^tail\b/i,
  /^wc\b/i,
  /^file\b/i,
  /^stat\b/i,
  /^tree\b/i,
  /^du\b/i,
  /^df\b/i,
  /^ls\b/i,
  /^pwd$/i,
  /^cd\b/i, // 仅切换目录；与后续只读段串联时常见（`cd src && ls`）
  // Windows cmd / PowerShell 只读
  /^dir\b/i,
  /^type\b/i,
  /^Get-ChildItem\b/i,
  /^gci\b/i,
  /^Get-Content\b/i,
  /^gc\b/i,
  /^Get-Item\b/i,
  /^gi\b/i,
  /^Select-String\b/i,
  /^Get-Location\b/i,
  /^gl\b/i,
]

/**
 * 判断路径 token 是否在 cwd 外
 *
 * - 绝对路径（Unix `/`、Windows 盘符 `C:`、家目录 `~`）→ 检查是否以 cwd 为前缀
 * - 父目录路径（`..`）→ 视为 cwd 外（保守，避免越界）
 * - 相对路径（`./foo`、`foo.txt`）→ 视为 cwd 内
 */
function isPathOutsideCwd(token: string, cwd: string): boolean {
  // 去掉常见引号包裹
  const raw = token.replace(/^['"]|['"]$/g, '')
  if (!raw) return false
  const isAbsolute =
    raw.startsWith('/') || raw.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(raw)
  if (!isAbsolute && !raw.startsWith('..')) return false
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const normalizedToken = raw.replace(/\\/g, '/')
  // 以 cwd 为前缀（含等价）视为 cwd 内
  if (
    normalizedToken === normalizedCwd ||
    normalizedToken.startsWith(normalizedCwd + '/') ||
    // Windows 盘符大小写不敏感
    normalizedToken.toLowerCase() === normalizedCwd.toLowerCase() ||
    normalizedToken.toLowerCase().startsWith(normalizedCwd.toLowerCase() + '/')
  ) {
    return false
  }
  return true
}

/** 单段命令：是否匹配项目内只读模式 + 路径均在 cwd 内 */
function isProjectLocalReadOnlySegment(segment: string, cwd: string): boolean {
  const trimmed = segment.trim()
  if (!trimmed) return false
  if (isDangerousCommand(trimmed)) return false
  const matchesPattern =
    PROJECT_LOCAL_READ_ONLY_BASH_PATTERNS.some((p) => p.test(trimmed)) ||
    SAFE_BASH_PATTERNS.some((p) => p.test(trimmed))
  if (!matchesPattern) return false
  const tokens = trimmed.split(/\s+/).slice(1) // 跳过命令本身
  for (const token of tokens) {
    if (!token) continue
    // Unix 选项：-la / --help（//UNC 不跳过）
    if (token.startsWith('-') && !token.startsWith('//')) continue
    // Windows 开关：/s /b /ah（单段字母数字，不是 /etc/passwd 这类绝对路径）
    if (/^\/[a-zA-Z0-9]+$/i.test(token)) continue
    if (isPathOutsideCwd(token, cwd)) return false
  }
  return true
}

/**
 * 判断 Bash 命令是否为「项目内只读」（cwd 内 + 只读命令）
 *
 * 用于 auto 模式下免询问放行。规则：
 * 1. 必须提供 cwd（否则无法判断路径边界，保守拒绝）
 * 2. 无写结构（重定向 / $() / -exec / -delete）
 * 3. 每一段（| / && / ; 拆分）均为只读模式
 * 4. 参数路径不越出 cwd（绝对路径必须以 cwd 为前缀；`..` 视为越界）
 *
 * 注意：管道与 && 本身不视为危险（`ls | head`、`cd src && ls` 可放行）。
 */
export function isProjectLocalReadOnlyBash(command: string, cwd?: string): boolean {
  const trimmed = command.trim()
  if (!cwd) return false // 未提供 cwd 无法判断路径边界，保守拒绝
  if (!trimmed) return false
  if (hasWriteStructure(trimmed)) return false
  if (isDangerousCommand(trimmed)) return false
  const segments = splitShellSegments(trimmed)
  if (segments.length === 0) return false
  return segments.every((seg) => isProjectLocalReadOnlySegment(seg, cwd))
}

/**
 * 自动审批模式下是否可静默放行
 *
 * - Read / Glob / Grep 等 SAFE_TOOLS：永远静默放行（读操作默认授权）
 * - 安全 Bash（ls/git status 等）
 * - 项目内只读 Bash（cat/find/type/dir… 且路径在 cwd 内）
 *
 * 其余工具（写文件、危险命令、MCP 变更等）走 PermissionBanner。
 *
 * @param cwd 可选，传入会话 cwd 后会扩展放行「项目内只读 Bash」
 */
export function isAutoModeAutoAllowTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): boolean {
  // 工具名大小写不敏感（防止模型/适配层变体）
  const name =
    toolName === 'bash' || toolName === 'BASH'
      ? 'Bash'
      : toolName.length > 0
        ? toolName[0]!.toUpperCase() + toolName.slice(1)
        : toolName

  if (SAFE_TOOLS.includes(name) || SAFE_TOOLS.includes(toolName)) return true
  if (AUTO_MODE_READ_ONLY_TOOLS.includes(name) || AUTO_MODE_READ_ONLY_TOOLS.includes(toolName)) {
    return true
  }
  if (isAutomationReadTool(toolName) || isAutomationReadTool(name)) return true

  if (name === 'Bash' || toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (isSafeBashCommand(command)) return true
    if (cwd && isProjectLocalReadOnlyBash(command, cwd)) return true
  }
  return false
}

/**
 * 自动审批模式下是否必须弹出 TAgent 权限横幅
 */
export function requiresAutoModeConfirmation(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string
): boolean {
  if (toolName === 'AskUserQuestion') return false
  return !isAutoModeAutoAllowTool(toolName, input, cwd)
}

/**
 * TAgent 权限模式 → 传给 Claude Agent SDK 的 permissionMode
 *
 * 「自动审批」与「完全自动」的决策全部由 TAgent canUseTool 完成。
 * 若 SDK 仍用原生 auto，内置 classifier 可能在 canUseTool 之前硬拒高风险工具并终止任务。
 * 因此这两档统一映射为 default，保证每次工具调用都先进入 TAgent 审批链路。
 */
export function resolveSdkPermissionModeForTAgent(
  mode: TAgentPermissionMode
): TAgentPermissionMode | 'default' {
  if (mode === 'auto' || mode === 'bypassPermissions') {
    return 'default'
  }
  return mode
}
