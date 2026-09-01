export interface CodexAdditionalNetworkPermissions {
  enabled: boolean | null
}

export type CodexFileSystemAccessMode = 'read' | 'write' | 'deny'

export interface CodexFileSystemSandboxEntry {
  path: unknown
  access: CodexFileSystemAccessMode
}

export interface CodexAdditionalFileSystemPermissions {
  read: string[] | null
  write: string[] | null
  globScanMaxDepth?: number
  entries?: CodexFileSystemSandboxEntry[]
}

export interface CodexRequestPermissionProfile {
  network: CodexAdditionalNetworkPermissions | null
  fileSystem: CodexAdditionalFileSystemPermissions | null
}

export interface CodexPermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  environmentId: string | null
  startedAtMs: number
  cwd: string
  reason: string | null
  permissions: CodexRequestPermissionProfile
}

export interface CodexGrantedPermissionProfile {
  network?: CodexAdditionalNetworkPermissions
  fileSystem?: CodexAdditionalFileSystemPermissions
}

export interface CodexPermissionsRequestApprovalResponse {
  permissions: CodexGrantedPermissionProfile
  scope: 'turn' | 'session'
  strictAutoReview?: boolean
}

export interface CodexPermissionSummary {
  hasNetwork: boolean
  hasFileRead: boolean
  hasFileWrite: boolean
  input: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStringArrayOrNull(value: unknown): string[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value)) return undefined
  if (!value.every((entry) => typeof entry === 'string')) return undefined
  return value
}

function parseFileSystemEntries(
  value: unknown,
): CodexFileSystemSandboxEntry[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const entries: CodexFileSystemSandboxEntry[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const access = entry.access
    if (access !== 'read' && access !== 'write' && access !== 'deny') {
      return undefined
    }
    entries.push({ path: entry.path, access })
  }
  return entries
}

function parseFileSystemPermissions(
  value: unknown,
): CodexAdditionalFileSystemPermissions | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const read = parseStringArrayOrNull(value.read)
  const write = parseStringArrayOrNull(value.write)
  if (read === undefined || write === undefined) return undefined
  const entries = parseFileSystemEntries(value.entries)
  if (value.entries !== undefined && entries === undefined) return undefined
  const globScanMaxDepth =
    typeof value.globScanMaxDepth === 'number'
      ? value.globScanMaxDepth
      : undefined
  return {
    read,
    write,
    ...(globScanMaxDepth !== undefined ? { globScanMaxDepth } : {}),
    ...(entries !== undefined ? { entries } : {}),
  }
}

export function parseCodexPermissionsRequestApprovalParams(
  value: unknown,
): CodexPermissionsRequestApprovalParams | undefined {
  if (!isRecord(value) || !isRecord(value.permissions)) return undefined
  if (
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.itemId !== 'string' ||
    (value.environmentId !== null &&
      typeof value.environmentId !== 'string') ||
    typeof value.startedAtMs !== 'number' ||
    typeof value.cwd !== 'string' ||
    (value.reason !== null && typeof value.reason !== 'string')
  ) {
    return undefined
  }

  const networkValue = value.permissions.network
  let network: CodexAdditionalNetworkPermissions | null
  if (networkValue === null) {
    network = null
  } else if (
    isRecord(networkValue) &&
    (networkValue.enabled === null ||
      typeof networkValue.enabled === 'boolean')
  ) {
    network = { enabled: networkValue.enabled }
  } else {
    return undefined
  }

  const fileSystem = parseFileSystemPermissions(
    value.permissions.fileSystem,
  )
  if (fileSystem === undefined) return undefined

  return {
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    environmentId: value.environmentId,
    startedAtMs: value.startedAtMs,
    cwd: value.cwd,
    reason: value.reason,
    permissions: { network, fileSystem },
  }
}

function describeFileSystemPath(value: unknown): string {
  if (!isRecord(value)) return String(value ?? '')
  if (value.type === 'path' && typeof value.path === 'string') {
    return value.path
  }
  if (
    value.type === 'glob_pattern' &&
    typeof value.pattern === 'string'
  ) {
    return value.pattern
  }
  if (value.type === 'special' && isRecord(value.value)) {
    return typeof value.value.kind === 'string'
      ? `[${value.value.kind}]`
      : '[special]'
  }
  return JSON.stringify(value)
}

export function summarizeCodexPermissionRequest(
  params: CodexPermissionsRequestApprovalParams,
): CodexPermissionSummary {
  const fileSystem = params.permissions.fileSystem
  const entryReads =
    fileSystem?.entries
      ?.filter((entry) => entry.access === 'read')
      .map((entry) => describeFileSystemPath(entry.path)) ?? []
  const entryWrites =
    fileSystem?.entries
      ?.filter((entry) => entry.access === 'write')
      .map((entry) => describeFileSystemPath(entry.path)) ?? []
  const readPaths = [...(fileSystem?.read ?? []), ...entryReads]
  const writePaths = [...(fileSystem?.write ?? []), ...entryWrites]
  const hasNetwork = params.permissions.network?.enabled === true
  return {
    hasNetwork,
    hasFileRead: readPaths.length > 0,
    hasFileWrite: writePaths.length > 0,
    input: {
      ...(params.reason ? { reason: params.reason } : {}),
      cwd: params.cwd,
      ...(hasNetwork ? { network: '允许访问网络' } : {}),
      ...(readPaths.length > 0 ? { readPaths } : {}),
      ...(writePaths.length > 0 ? { writePaths } : {}),
    },
  }
}

export function buildCodexPermissionsRequestApprovalResponse(
  params: CodexPermissionsRequestApprovalParams,
  allow: boolean,
): CodexPermissionsRequestApprovalResponse {
  return {
    permissions: allow
      ? {
          ...(params.permissions.network
            ? { network: params.permissions.network }
            : {}),
          ...(params.permissions.fileSystem
            ? { fileSystem: params.permissions.fileSystem }
            : {}),
        }
      : {},
    scope: 'turn',
  }
}
