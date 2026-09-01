import type { McpServerEntry } from '@tagent/shared'

export type CodexJsonValue =
  | null
  | boolean
  | number
  | string
  | CodexJsonValue[]
  | { [key: string]: CodexJsonValue }

export type CodexThreadConfig = Record<string, CodexJsonValue>

export interface CodexMcpProjectionResult {
  config?: CodexThreadConfig
  skipped: Array<{ name: string; reason: string }>
}

function nonEmptyStrings(values: string[] | undefined): string[] | undefined {
  const normalized = values?.filter(
    (value): value is string =>
      typeof value === 'string' && value.length > 0,
  )
  return normalized && normalized.length > 0 ? normalized : undefined
}

function stringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined
  const entries = Object.entries(value).filter(
    ([key, entry]) =>
      key.length > 0 && typeof entry === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function buildCodexMcpThreadConfig(
  servers: Record<string, McpServerEntry>,
): CodexMcpProjectionResult {
  const projected: Record<string, CodexJsonValue> = {}
  const skipped: CodexMcpProjectionResult['skipped'] = []

  for (const [name, server] of Object.entries(servers)) {
    if (!server.enabled) continue
    if (server.type === 'stdio') {
      const command = server.command?.trim()
      if (!command) {
        skipped.push({ name, reason: 'stdio MCP 缺少 command' })
        continue
      }
      const args = nonEmptyStrings(server.args)
      const env = stringRecord(server.env)
      projected[name] = {
        command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(typeof server.timeout === 'number' && server.timeout > 0
          ? { startup_timeout_sec: server.timeout }
          : {}),
      }
      continue
    }

    if (server.type === 'http') {
      const url = server.url?.trim()
      if (!url) {
        skipped.push({ name, reason: 'HTTP MCP 缺少 url' })
        continue
      }
      const headers = stringRecord(server.headers)
      projected[name] = {
        url,
        ...(headers ? { http_headers: headers } : {}),
      }
      continue
    }

    skipped.push({
      name,
      reason: 'Codex 不支持 TAgent 的 legacy SSE MCP 配置',
    })
  }

  return {
    ...(Object.keys(projected).length > 0
      ? { config: { mcp_servers: projected } }
      : {}),
    skipped,
  }
}
