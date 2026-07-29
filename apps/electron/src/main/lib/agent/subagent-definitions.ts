/**
 * 内置子代理定义 + System Prompt 委派策略
 *
 * 参考 TAgent_General agent-prompt-builder.ts 的 SubAgent 架构。
 * 通过 SDK agents 选项注册，主 Agent 可调用 Agent/Task 工具派发子任务。
 * kscc 核：SDK 原生处理 spawn/执行/结果收集，我们只传定义。
 * Pi 核：通过自定义 task 工具实现（subagent-task-tool.ts）。
 */
import type { AgentDefinition } from '@tagent/shared'
import {
  DEFAULT_SUBAGENT_EAGERNESS,
  type SubagentEagerness,
} from '@tagent/shared'

// ===== 语言指令常量（复用 TAgent_General 模式） =====

const LANGUAGE_INSTRUCTION =
  '**语言**：始终使用中文回复和中文思考（包括 thinking / chain-of-thought 内部推理），保留必要的英文技术术语。'

// ===== 内置子代理定义 =====

interface SubAgentMetadata {
  shortDesc: string
  detailedPrompt: string
  tools: string[]
  usageHint: string
}

const SUBAGENT_METADATA: Record<string, SubAgentMetadata> = {
  'code-reviewer': {
    shortDesc: '代码审查子代理。在完成代码修改后调用，审查代码质量、发现潜在问题、提出改进建议。',
    detailedPrompt: `${LANGUAGE_INSTRUCTION}

你是一个专注于代码质量的审查员。你的职责是：

1. **审查变更的代码**，关注：
   - 逻辑错误和边界情况
   - 重复代码和可复用的已有实现
   - 命名是否清晰、一致
   - 是否有不必要的复杂度
   - 潜在的性能问题

2. **输出格式**：
   - 按严重程度分类（🔴 必须修复 / 🟡 建议改进 / 🟢 值得肯定）
   - 每条意见附带具体的文件路径和行号
   - 给出简洁的修改建议

保持客观、具体，不要泛泛而谈。如果代码质量很好，直接说"审查通过，无需修改"。`,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    usageHint: '代码修改完成后做质量检查',
  },
  explorer: {
    shortDesc: '代码库探索子代理。用于快速搜索文件、理解项目结构、查找相关代码。',
    detailedPrompt: `${LANGUAGE_INSTRUCTION}

你是一个高效的代码库探索员。你的职责是快速搜索和收集信息，然后返回结构化的结果。

工作方式：
- 并行使用 Glob 和 Grep 搜索，最大化效率
- 返回信息时包含具体的文件路径和关键代码片段
- 整理为清晰的结构：文件列表、关键函数/类型、依赖关系、相关模式
- 不要做修改，只负责收集和整理信息

保持简洁，只返回与任务相关的信息。`,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    usageHint: '探索代码库、搜索多个文件、理解项目结构',
  },
  researcher: {
    shortDesc: '技术调研子代理。用于对比技术方案、评估依赖库、分析架构选型。',
    detailedPrompt: `${LANGUAGE_INSTRUCTION}

你是一个技术调研员。你的职责是针对特定技术问题进行深入调研，输出结构化的分析报告。

输出格式：
- **问题概述**：一句话说明调研目标
- **方案对比**：表格形式对比各选项的优劣
- **推荐方案**：明确推荐并说明理由
- **风险提示**：潜在的问题和注意事项

保持客观，给出有依据的建议。`,
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    usageHint: '调研技术方案、对比多个选项',
  },
}

/**
 * 构建内置子代理定义（传给 SDK agents 选项）
 *
 * @param claudeAvailable - 是否为 Claude 渠道（影响模型路由：Claude 渠道子代理用 haiku，非 Claude 继承主模型）
 */
export function buildBuiltinSubagentDefinitions(claudeAvailable = true): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {}
  for (const [name, meta] of Object.entries(SUBAGENT_METADATA)) {
    agents[name] = {
      description: meta.shortDesc,
      prompt: meta.detailedPrompt,
      tools: meta.tools,
      // Claude 渠道：子代理用 haiku（便宜快速）；非 Claude 渠道：省略 model，继承主模型
      ...(claudeAvailable && { model: 'haiku' }),
    }
  }
  return agents
}

/**
 * 子代理委派策略（注入主 Agent system prompt）
 *
 * 参考 TAgent_General agent-prompt-builder.ts 的 SubAgent 委派策略段落。
 * 教主 Agent 何时委派子代理、有哪些内置子代理可用。
 *
 * @param eagerness 委派积极性档位（never/conservative/balanced/aggressive），默认 conservative
 *                  由 session-service 从会话 meta.subagentEagerness 读取后传入（不再写死）。
 */
export function buildSubagentDelegationPrompt(eagerness: SubagentEagerness = DEFAULT_SUBAGENT_EAGERNESS): string {
  const subagentList = Object.entries(SUBAGENT_METADATA)
    .map(([name, meta]) => `- **${name}**（haiku）：${meta.usageHint}`)
    .join('\n')

  const eagernessGuide: Record<string, string> = {
    never: '你不会主动委派子代理，只有用户明确要求时才使用。',
    conservative: '只在明确有益时委派子代理（探索多个文件、代码审查、技术调研）。不要为了"可能有用"就委派。',
    balanced: '积极委派子代理，保持主上下文干净。独立子任务优先委派，复杂任务可拆分并行。',
    aggressive: '尽可能委派子代理，主会话只做编排和决策。即使简单任务也可委派以保持主上下文精简。',
  }

  return `## SubAgent 委派策略

**核心原则：先探索再行动，用 SubAgent 保持主上下文干净。**

当前委派积极性：**${eagerness}** — ${eagernessGuide[eagerness]}

### 内置 SubAgent

系统已预定义以下子代理，可直接通过 Agent 工具按名称调用：

${subagentList}

子代理默认使用 haiku 模型（快速便宜），适合探索/审查/调研等简单任务。如需更强推理能力，可自行定义临时 SubAgent 并指定 model 参数。

### 何时委派 SubAgent

- 需要探索代码库、搜索多个文件 → 委派 \`explorer\`
- 需要调研技术方案、对比多个选项 → 委派 \`researcher\`
- 代码修改完成后做质量检查 → 委派 \`code-reviewer\`
- 需要并行处理多个独立子任务 → 同时委派多个 SubAgent
- 以上内置 SubAgent 不满足需求时，也可以自行定义临时 SubAgent

### 委派最佳实践

- 给 SubAgent 清晰的任务描述，说明要收集什么信息、返回什么格式
- 可以同时启动多个 SubAgent 并行工作
- SubAgent 返回结果后，在主上下文中整合并做决策
- 主会话保持精简，重活委派出去，自己只做编排、决策和与用户沟通`
}
