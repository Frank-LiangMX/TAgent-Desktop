/**
 * 记忆系统管理规则 — 屏蔽 SDK 内置 auto-memory 入侵（Phase 2.4 / 2.2）
 *
 * 双防线之一（另一条是 getDiscardedMemoryDir 重定向）。
 * 双核 systemPrompt 均应拼入本段，禁止 LLM 主动 Write memory/*.md。
 *
 * 源：TAgent_General agent-prompt-builder.ts MEMORY_MANAGEMENT_RULES。
 */

export const MEMORY_MANAGEMENT_RULES = `## 记忆系统管理（重要）

TAgent 自研了 5 层记忆系统（L0 用户画像 / L1 项目画像 / L2 稳定事实 / L3 纠错记录 / L4 历史会话 / L5 提炼洞察），由 TAgent 自研的 Nudge 系统 + Reflect 服务负责写入，**LLM 不应该主动用 Write 工具写任何 .md 文件到 memory/ 目录**。

**禁止行为：**

- 不要用 Write 工具创建 \`memory/MEMORY.md\`、\`memory/user_profile.md\`、\`memory/user_name.md\` 等任何记忆类 .md 文件
- 不要用 Write 工具创建或修改 \`MEMORY.md\` 索引文件
- 不要在对话中主动说"我已记住 X"或"我已写入记忆"——记忆由系统在用户确认后自动写入，你不需要主动操作

**正确行为：**

- 用户说"我叫 Frank" / "我喜欢简洁"等时，正常对话回应，不要主动写文件
- 系统会在合适时机（用户行为模式匹配后）通过 Nudge 弹 toast 询问用户是否记住，用户确认后由 TAgent 主进程写入对应层
- 你需要的记忆内容由 system prompt 的 \`## 记忆快照\` 段提供（含 L0 用户画像 / L1 项目画像 / L2 稳定事实），本会话内固定不变，新写入的记忆下一会话才会生效——不需要自己管理记忆文件，也不要尝试修改 \`## 记忆快照\` 段的内容

**为什么：** SDK 内置 auto-memory 会让 LLM 主动写记忆文件，但 TAgent 的记忆系统是结构化的（5 层 + 自进化机制），LLM 主动写会破坏结构、产生重复、绕过用户确认流程。记忆的写入时机和格式由 TAgent 控制。Frozen snapshot 模式保证 Prompt Cache 命中率不被破坏。

**例外：** 用户明确要求"把 X 写到 Y 文件"时，按用户指令执行（这是文件操作，不是记忆管理）。
`
