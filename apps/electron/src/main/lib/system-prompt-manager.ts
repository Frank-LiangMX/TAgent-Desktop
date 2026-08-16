/**
 * 系统提示词管理服务
 *
 * 管理 Chat 模式可选用的 system prompt CRUD。
 * 存储在 ~/.tagent[-dev]/system-prompts.json
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  BUILTIN_DEFAULT_ID,
  BUILTIN_DEFAULT_PROMPT,
  type SystemPrompt,
  type SystemPromptConfig,
  type SystemPromptCreateInput,
  type SystemPromptUpdateInput,
} from '@tagent/shared'
import { getSystemPromptsPath } from './config/config-paths'
import { getUserProfile } from './user-profile-service'

/** 默认配置 */
function getDefaultConfig(): SystemPromptConfig {
  return {
    prompts: [{ ...BUILTIN_DEFAULT_PROMPT }],
    defaultPromptId: BUILTIN_DEFAULT_ID,
    appendDateTimeAndUserName: true,
  }
}

/** 读取配置文件 */
function readConfig(): SystemPromptConfig {
  const filePath = getSystemPromptsPath()
  if (!existsSync(filePath)) return getDefaultConfig()

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as SystemPromptConfig
    const builtinIndex = data.prompts.findIndex((p) => p.id === BUILTIN_DEFAULT_ID)
    if (builtinIndex === -1) {
      data.prompts.unshift({ ...BUILTIN_DEFAULT_PROMPT })
    } else {
      // 内置正文始终与源码同步，避免文件残留旧版
      data.prompts[builtinIndex] = { ...BUILTIN_DEFAULT_PROMPT }
    }
    return {
      prompts: data.prompts,
      defaultPromptId: data.defaultPromptId,
      appendDateTimeAndUserName: data.appendDateTimeAndUserName ?? true,
    }
  } catch (error) {
    console.error('[系统提示词] 读取配置失败:', error)
    return getDefaultConfig()
  }
}

/** 写入配置文件 */
function writeConfig(config: SystemPromptConfig): void {
  const filePath = getSystemPromptsPath()
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (error) {
    console.error('[系统提示词] 写入配置失败:', error)
    throw new Error('写入系统提示词配置失败')
  }
}

/** 获取系统提示词配置 */
export function getSystemPromptConfig(): SystemPromptConfig {
  return readConfig()
}

/** 创建自定义提示词 */
export function createSystemPrompt(input: SystemPromptCreateInput): SystemPrompt {
  const config = readConfig()
  const now = Date.now()
  const prompt: SystemPrompt = {
    id: randomUUID(),
    name: input.name.trim() || '新提示词',
    content: input.content,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  }
  config.prompts.push(prompt)
  writeConfig(config)
  return prompt
}

/** 更新提示词（内置不可编辑） */
export function updateSystemPrompt(id: string, input: SystemPromptUpdateInput): SystemPrompt {
  const config = readConfig()
  const index = config.prompts.findIndex((p) => p.id === id)
  if (index === -1) throw new Error(`提示词不存在: ${id}`)
  const prompt = config.prompts[index]!
  if (prompt.isBuiltin) throw new Error('内置提示词不可编辑')
  if (input.name !== undefined) prompt.name = input.name
  if (input.content !== undefined) prompt.content = input.content
  prompt.updatedAt = Date.now()
  writeConfig(config)
  return prompt
}

/** 删除提示词（内置不可删；删默认则回退内置） */
export function deleteSystemPrompt(id: string): void {
  const config = readConfig()
  const prompt = config.prompts.find((p) => p.id === id)
  if (!prompt) throw new Error(`提示词不存在: ${id}`)
  if (prompt.isBuiltin) throw new Error('内置提示词不可删除')
  config.prompts = config.prompts.filter((p) => p.id !== id)
  if (config.defaultPromptId === id) config.defaultPromptId = BUILTIN_DEFAULT_ID
  writeConfig(config)
}

/** 更新追加日期时间和用户名开关 */
export function updateAppendSetting(enabled: boolean): void {
  const config = readConfig()
  config.appendDateTimeAndUserName = enabled
  writeConfig(config)
}

/** 设置默认提示词（null → 内置） */
export function setDefaultPrompt(id: string | null): void {
  const config = readConfig()
  if (id !== null) {
    const exists = config.prompts.some((p) => p.id === id)
    if (!exists) throw new Error(`提示词不存在: ${id}`)
  }
  config.defaultPromptId = id ?? BUILTIN_DEFAULT_ID
  writeConfig(config)
}

/**
 * 解析当前默认提示词正文（供主会话 Chat 注入）。
 * 含可选「当前时间 / 用户名」附录。
 */
export function resolveDefaultSystemPromptMessage(): string {
  const config = readConfig()
  const id = config.defaultPromptId ?? BUILTIN_DEFAULT_ID
  const prompt = config.prompts.find((p) => p.id === id) ?? BUILTIN_DEFAULT_PROMPT
  let message = prompt.content.trim()
  if (!message) return ''
  if (config.appendDateTimeAndUserName) {
    const userName = getUserProfile().userName?.trim() || '用户'
    const dateTimeStr = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
    })
    message += `\n\n---\n当前时间: ${dateTimeStr}\n用户名: ${userName}`
  }
  return message
}

/** 包装为 system append 段落（空内容返回空串） */
export function buildUserSystemPromptAppend(): string {
  const body = resolveDefaultSystemPromptMessage()
  if (!body) return ''
  return `## 用户系统提示词\n\n${body}`
}
