/**
 * Pi task 的 Agent 目录解析。
 *
 * 这里只决定显式 profile 是否可被 Pi 调用，以及它对应的宿主执行形态；
 * 不启动进程、不读取 API Key，也不改变旧 subagent_type / cli 路由。
 */
import {
  listAgentProfiles,
  type AgentProfile,
} from '../../agent/agent-catalog-service'

export type PiTaskCatalogRuntime = 'in-process' | 'official'
export type PiTaskOfficialRuntime = 'codex' | 'claude-code'

export interface PiTaskAgentSelection {
  profile: AgentProfile
  runtime: PiTaskCatalogRuntime
  /** runtime=official 时传给 official delegated runner 的 runtime。 */
  officialRuntime?: PiTaskOfficialRuntime
  /** fixed profile 的工作区；其它策略由调用方继承当前工作区。 */
  workspacePath?: string
}

/**
 * 按 profile runtime 映射现有执行入口。
 * `custom-cli` 没有独立字段时使用 profile id，便于与同名 CLI worker 配置衔接。
 */
function resolveRuntime(profile: AgentProfile): Pick<PiTaskAgentSelection, 'runtime' | 'officialRuntime'> {
  if (profile.runtime === 'pi') return { runtime: 'in-process' }

  throw new Error('当前仅支持 Pi 内核，请将 Agent 预设改为 Pi')
}

/**
 * 读取并解析 Pi task 指定的 profile。
 * 只有 enabled 且 allowPiTask 的 profile 可被显式调用；未指定 agent 返回 null。
 */
export function resolvePiTaskAgent(agentId?: string | null): PiTaskAgentSelection | null {
  const requestedId = agentId?.trim()
  if (!requestedId) return null

  const profile = listAgentProfiles().find((candidate) => candidate.id === requestedId)
  if (!profile) throw new Error(`未知的 Agent profile：「${requestedId}」`)
  if (!profile.enabled) throw new Error(`Agent「${requestedId}」已禁用，不能被 Pi task 调用`)
  if (!profile.allowPiTask) throw new Error(`Agent「${requestedId}」未允许被 Pi task 调用`)

  if (profile.workspacePolicy === 'temporary') {
    throw new Error(`Agent「${profile.name}」使用 temporary workspace，不能作为子代理派发`)
  }
  return {
    profile,
    ...resolveRuntime(profile),
    ...(profile.workspacePolicy === 'fixed' && profile.workspacePath
      ? { workspacePath: profile.workspacePath }
      : {}),
  }
}
