import type { AgentRuntimeKind } from '@tagent/shared'
import type { ModelSelection } from '../../atoms/model-selection'

export interface RecoveryTarget extends ModelSelection {
  runtime: AgentRuntimeKind
}

/** A new, explicit continuation turn; never replay the previous task or attachments. */
export const SESSION_RECOVERY_PROMPT = '请从刚才中断的位置继续原任务。先核对已有进度和工具结果，只做尚未完成的部分；不要重复已完成的操作。对结果不明、可能产生外部影响的操作，先核实，无法核实则询问我。'

export async function runSessionRecovery(options: {
  current: RecoveryTarget
  target: RecoveryTarget
  isCurrent: () => boolean
  switchBinding: (target: RecoveryTarget) => Promise<boolean>
  send: (target: RecoveryTarget, prompt: string) => Promise<void>
}): Promise<void> {
  const { current, target, isCurrent, switchBinding, send } = options
  if (!isCurrent()) throw new Error('会话已切换或正在运行，请稍后继续')
  if (current.runtime !== target.runtime || current.channelId !== target.channelId || current.modelId !== target.modelId) {
    if (!await switchBinding(target)) throw new Error('切换未完成，尚未发送继续指令')
  }
  if (!isCurrent()) throw new Error('会话已切换，未发送继续指令')
  await send(target, SESSION_RECOVERY_PROMPT)
}
