/**
 * SDK auto-memory 废目录（Phase 2.4 防线）
 *
 * SDK 的 autoMemoryEnabled: false 在部分版本是空壳，LLM 仍可能按内置 system prompt
 * 主动 Write memory/*.md。主防线是 MEMORY_MANAGEMENT_RULES 反向指令；
 * 此处把 autoMemoryDirectory 重定向到 os.tmpdir() 废目录作兜底，
 * 即使 LLM 不听话也不会污染 ~/.tagent[-dev]/memory/。
 *
 * 见 .context/memory-phase2-global-l5-port.md §2.4。
 */
import * as os from 'node:os'
import * as path from 'node:path'

/** SDK auto-memory 写入的废目录（跨平台 tmp） */
export function getDiscardedMemoryDir(): string {
  return path.join(os.tmpdir(), 'tagent-discarded-memory')
}
