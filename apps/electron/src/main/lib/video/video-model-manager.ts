import { createHash } from 'node:crypto'
import { cp, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { getVideoModelsDir, getVideoModelPreferencesPath, getVideoRuntimeDir } from '../config/config-paths'
import { readJsonSafe, writeJsonAtomic } from '../atomic-json'

export type WhisperModelId = 'base' | 'small'
export interface WhisperModelDefinition {
  id: WhisperModelId
  label: string
  bytes: number
  url: string
  sha256: string
  filename: string
}

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelDefinition> = {
  base: {
    id: 'base', label: 'Base', bytes: 147951465,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sha256: '2f62d18b50c3f3feafbf990eec23a93d319660b1efbdd3fff55e52b7cde2e374', filename: 'ggml-base.bin',
  },
  small: {
    id: 'small', label: 'Small', bytes: 487601967,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: 'edd29d67e70b000132af65205b99bb774b77abc13d10103e14f80ce2242913e1', filename: 'ggml-small.bin',
  },
}

export const WHISPER_RUNTIME = {
  bytes: 8573270,
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
  version: 'b5130',
} as const

export interface WhisperModelStatus {
  selected: WhisperModelId
  models: Array<WhisperModelDefinition & { installed: boolean; size?: number }>
  downloading?: { id: WhisperModelId; receivedBytes: number; totalBytes: number }
  runtime: { installed: boolean; version: string; size?: number }
  downloadingRuntime?: { receivedBytes: number; totalBytes: number }
}

const selected = { value: (readJsonSafe<{ selected?: WhisperModelId }>(getVideoModelPreferencesPath(), {}).selected ?? 'base') as WhisperModelId }

function persistSelected(): void {
  writeJsonAtomic(getVideoModelPreferencesPath(), { selected: selected.value })
}

function modelPath(id: WhisperModelId): string {
  return join(getVideoModelsDir(), WHISPER_MODELS[id].filename)
}

export function getWhisperModelPath(id: WhisperModelId = selected.value): string {
  return modelPath(id)
}

function runtimeExecutablePath(): string {
  return join(getVideoRuntimeDir(), 'whisper-cli.exe')
}

async function installed(id: WhisperModelId): Promise<{ installed: boolean; size?: number }> {
  try {
    const info = await stat(modelPath(id))
    return { installed: info.isFile(), size: info.size }
  } catch {
    return { installed: false }
  }
}

export async function getWhisperModelStatus(): Promise<WhisperModelStatus> {
  const models = await Promise.all(Object.values(WHISPER_MODELS).map(async (definition) => ({
    ...definition,
    ...(await installed(definition.id)),
  })))
  const runtime = await installedRuntime()
  return { selected: selected.value, models, runtime }
}

async function installedRuntime(): Promise<{ installed: boolean; version: string; size?: number }> {
  try {
    const info = await stat(runtimeExecutablePath())
    return { installed: info.isFile(), version: WHISPER_RUNTIME.version, size: info.size }
  } catch {
    return { installed: false, version: WHISPER_RUNTIME.version }
  }
}

export function getWhisperRuntimePath(): string | undefined {
  return runtimeExecutablePath()
}

export function setWhisperModel(id: WhisperModelId): void {
  if (!WHISPER_MODELS[id]) throw new Error('不支持的 Whisper 模型')
  selected.value = id
  persistSelected()
}

export function getSelectedWhisperModel(): WhisperModelDefinition {
  return WHISPER_MODELS[selected.value]
}

export async function downloadWhisperModel(
  id: WhisperModelId,
  onProgress?: (progress: { id: WhisperModelId; receivedBytes: number; totalBytes: number }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const definition = WHISPER_MODELS[id]
  if (!definition) throw new Error('不支持的 Whisper 模型')
  const target = modelPath(id)
  const temporary = `${target}.part`
  const response = await fetch(definition.url, {
    redirect: 'follow',
    signal,
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'TAgent-Desktop Whisper Model Downloader' },
  })
  if (!response.ok || !response.body) throw new Error(`Whisper 模型下载失败：HTTP ${response.status}`)
  const totalBytes = Number(response.headers.get('content-length') ?? definition.bytes)
  const file = await open(temporary, 'w')
  const reader = response.body.getReader()
  let receivedBytes = 0
  const hash = createHash('sha256')
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      const buffer = Buffer.from(chunk.value)
      receivedBytes += buffer.length
      hash.update(buffer)
      await file.write(buffer)
      onProgress?.({ id, receivedBytes, totalBytes })
    }
  } finally {
    reader.releaseLock()
    await file.close()
  }
  if (hash.digest('hex') !== definition.sha256) {
    await rm(temporary, { force: true })
    throw new Error('Whisper 模型校验失败，文件可能已损坏')
  }
  await rename(temporary, target)
  selected.value = id
  persistSelected()
}

export async function downloadWhisperRuntime(
  onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void,
  signal?: AbortSignal,
): Promise<void> {
  const directory = getVideoRuntimeDir()
  const archive = join(directory, `whisper-${WHISPER_RUNTIME.version}.zip.part`)
  const response = await fetch(WHISPER_RUNTIME.url, { redirect: 'follow', signal, headers: { 'User-Agent': 'TAgent-Desktop Whisper Runtime Downloader' } })
  if (!response.ok || !response.body) throw new Error(`Whisper 语音引擎下载失败：HTTP ${response.status}`)
  const totalBytes = Number(response.headers.get('content-length') ?? WHISPER_RUNTIME.bytes)
  const file = await open(archive, 'w')
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let receivedBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value?.byteLength) continue
      const buffer = Buffer.from(chunk.value)
      receivedBytes += buffer.length
      hash.update(buffer)
      await file.write(buffer)
      onProgress?.({ receivedBytes, totalBytes })
    }
  } finally {
    reader.releaseLock()
    await file.close()
  }
  if (hash.digest('hex') !== WHISPER_RUNTIME.sha256) {
    await rm(archive, { force: true })
    throw new Error('Whisper 语音引擎校验失败，文件可能已损坏')
  }
  const extractDir = join(directory, `.extract-${Date.now()}`)
  await mkdir(extractDir, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('tar', ['-xf', archive, '-C', extractDir], { windowsHide: true, timeout: 120_000 }, (error) => error ? reject(error) : resolve())
    })
    const executable = await findFile(extractDir, 'whisper-cli.exe')
    if (!executable) throw new Error('语音引擎压缩包中没有找到 whisper-cli.exe')
    const runtimeSourceDir = dirname(executable)
    for (const entry of await readdir(runtimeSourceDir, { withFileTypes: true })) {
      await cp(join(runtimeSourceDir, entry.name), join(getVideoRuntimeDir(), entry.name), { recursive: true, force: true })
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
    await rm(archive, { force: true }).catch(() => {})
  }
}

async function findFile(directory: string, filename: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return path
    if (entry.isDirectory()) {
      const found = await findFile(path, filename)
      if (found) return found
    }
  }
  return undefined
}
