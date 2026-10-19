import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { getSelectedWhisperModel, getWhisperModelPath, getWhisperModelStatus, getWhisperRuntimePath } from './video-model-manager'

const execFileAsync = promisify(execFile)
const MAX_VIDEO_BYTES = 250 * 1024 * 1024
const MAX_FRAMES = 8
const FRAME_WIDTH = 768
const DOWNLOAD_TIMEOUT_MS = 120_000
const ANALYSIS_TIMEOUT_MS = 30_000
const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000

export const VIDEO_SYSTEM_PROMPT = '## 视频链接分析\n当用户提供视频链接并询问视频内容、摘要、讲解或某时间点时，优先调用 video_analyze_url。不要只读取网页标题或页面正文来猜测视频内容。工具会返回视频元数据、关键画面和可用的字幕/语音转写；如果工具提示未提供音频转写，必须明确说明结论主要来自关键画面，不能假装听到了音频。'

type TextBlock = { type: 'text'; text: string }
type ImageBlock = { type: 'image'; data: string; mimeType: string }
type ToolContent = TextBlock | ImageBlock

export interface VideoToolContext {
  sessionId: string
}

interface VideoProbe {
  duration: number
  width?: number
  height?: number
  format?: string
  hasSubtitle: boolean
}

function piResult(content: ToolContent[], details: unknown = {}): AgentToolResult<unknown> {
  return { content, details }
}

function mcpResult(content: ToolContent[], isError = false): { content: ToolContent[]; isError?: boolean } {
  return isError ? { content, isError: true } : { content }
}

function asText(text: string): TextBlock {
  return { type: 'text', text }
}

export function validateVideoUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('视频地址不是有效的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http(s) 视频链接')
  }
  if (url.username || url.password) {
    throw new Error('不接受带账号密码的视频链接')
  }
  return url
}

export function buildFrameTimestamps(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0]
  const count = Math.min(MAX_FRAMES, Math.max(3, Math.ceil(duration / 90)))
  if (count === 1) return [0]
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1)
    return Math.max(0, Math.min(duration - 0.25, duration * ratio))
  })
}

async function downloadVideo(url: URL, directory: string): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'TAgent-Desktop video analyzer' },
  })
  if (!response.ok) throw new Error(`视频下载失败：HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_VIDEO_BYTES) throw new Error('视频超过 250 MB，暂不支持自动分析')
  if (!response.body) throw new Error('视频响应没有可读取的数据')

  const contentTypeHeader = response.headers.get('content-type') ?? ''
  const contentType = contentTypeHeader.split(';')[0]?.trim() ?? ''
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    const html = await response.text()
    const embedded = extractEmbeddedVideoUrl(html, response.url || url.toString())
    if (!embedded) {
      throw new Error('这是视频分享页，不是可直接下载的视频地址；当前页面可能需要登录或平台专用解析。')
    }
    const embeddedUrl = new URL(embedded, response.url || url.toString())
    if (embeddedUrl.toString() === url.toString()) {
      throw new Error('分享页没有提供可直接读取的视频地址')
    }
    return downloadVideo(embeddedUrl, directory)
  }

  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    if (!chunk) continue
    total += chunk.byteLength
    if (total > MAX_VIDEO_BYTES) throw new Error('视频超过 250 MB，暂不支持自动分析')
    chunks.push(Buffer.from(chunk))
  }
  const extension = contentType.startsWith('video/') ? `.${contentType.slice('video/'.length).replace('x-', '')}` : extname(url.pathname) || '.video'
  const path = join(directory, `source${extension.replace(/[^a-z0-9.]/gi, '')}`)
  await writeFile(path, Buffer.concat(chunks))
  return path
}

function extractEmbeddedVideoUrl(html: string, baseUrl: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
    /<video[^>]+src=["']([^"']+)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    const candidate = match?.[1]
    if (!candidate) continue
    try {
      const resolved = new URL(candidate, baseUrl)
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString()
    } catch {
      // 忽略页面中的坏链接，继续尝试下一种嵌入格式。
    }
  }
  return undefined
}

async function probeVideo(path: string): Promise<VideoProbe> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_entries', 'format=duration,format_name:stream=width,height,codec_type', path,
    ], { timeout: ANALYSIS_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('未找到 FFmpeg/FFprobe。请先安装 FFmpeg，并确保 ffmpeg 和 ffprobe 已加入系统 PATH。')
    throw error
  }
  const value = JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> }
  const video = value.streams?.find((stream) => stream.codec_type === 'video')
  const duration = Number(value.format?.duration ?? 0)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长')
  return { duration, width: video?.width, height: video?.height, format: value.format?.format_name, hasSubtitle: Boolean(value.streams?.some((stream) => stream.codec_type === 'subtitle')) }
}

async function extractSubtitle(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:s:0', '-f', 'srt', 'pipe:1',
    ], { timeout: ANALYSIS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const text = normalizeSubtitle(String(stdout))
    return text || undefined
  } catch {
    return undefined
  }
}

async function transcribeAudio(path: string, directory: string): Promise<string | undefined> {
  const runtime = getWhisperRuntimePath()
  const status = await getWhisperModelStatus()
  if (!runtime || !status.runtime.installed) return undefined
  const audioPath = join(directory, 'audio.wav')
  const outputPrefix = join(directory, 'transcript')
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', audioPath,
    ], { timeout: ANALYSIS_TIMEOUT_MS, windowsHide: true })
    await execFileAsync(runtime, [
      '-m', getWhisperModelPath(getSelectedWhisperModel().id), '-f', audioPath,
      '-l', 'auto', '-osrt', '-of', outputPrefix,
    ], { timeout: TRANSCRIPTION_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    const output = await readFile(`${outputPrefix}.srt`, 'utf8')
    return normalizeSubtitle(String(output)) || undefined
  } catch {
    return undefined
  }
}


export function normalizeSubtitle(raw: string): string {
  return raw
    .replace(/^WEBVTT.*$/gim, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->.*$/gm, '')
    .replace(/^\d{2}:\d{2}[,.]\d{3}\s+-->.*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 40_000)
}

async function extractFrame(path: string, timestamp: number): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', timestamp.toFixed(2), '-i', path,
    '-frames:v', '1', '-vf', `scale=${FRAME_WIDTH}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { timeout: ANALYSIS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', windowsHide: true })
  return stdout as Buffer
}

async function analyzeVideo(rawUrl: string): Promise<{ content: ToolContent[]; details: Record<string, unknown> }> {
  const url = validateVideoUrl(rawUrl)
  const directory = await mkdtemp(join(tmpdir(), 'tagent-video-'))
  try {
    const path = await downloadVideo(url, directory)
    const file = await stat(path)
    const probe = await probeVideo(path)
    const subtitle = probe.hasSubtitle ? await extractSubtitle(path) : undefined
    const transcript = subtitle ?? await transcribeAudio(path, directory)
    const timestamps = buildFrameTimestamps(probe.duration)
    const content: ToolContent[] = [asText(JSON.stringify({
      ok: true,
      url: url.toString(),
      durationSeconds: Math.round(probe.duration * 10) / 10,
      duration: `${Math.floor(probe.duration / 60)}分${Math.round(probe.duration % 60)}秒`,
      resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : undefined,
      format: probe.format,
      downloadedBytes: file.size,
      sampledAtSeconds: timestamps.map((value) => Math.round(value * 10) / 10),
      audioTranscript: transcript ?? '未提供。当前版本没有可读取的字幕轨道，且本地语音引擎或模型尚未准备好，不能据此判断未显示在画面中的语音内容。',
      transcriptSource: subtitle ? 'embedded-subtitle' : transcript ? 'local-whisper' : undefined,
      subtitleAvailable: Boolean(subtitle),
      instruction: '请根据这些关键画面回答用户的问题；按时间顺序说明画面变化，并标注无法从画面确认的内容。',
    }, null, 2))]
    if (transcript) content.push(asText(`\n视频字幕/转写内容：\n${transcript}`))
    for (let index = 0; index < timestamps.length; index += 1) {
      try {
        const frame = await extractFrame(path, timestamps[index]!)
        content.push(asText(`\n关键帧 ${index + 1}/${timestamps.length}，时间 ${timestamps[index]!.toFixed(1)} 秒`))
        content.push({ type: 'image', data: frame.toString('base64'), mimeType: 'image/jpeg' })
      } catch (error) {
        content.push(asText(`关键帧 ${index + 1} 提取失败：${error instanceof Error ? error.message : String(error)}`))
      }
    }
    return { content, details: { url: url.toString(), duration: probe.duration, frameCount: timestamps.length } }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export async function handleVideoAnalyzeUrl(args: Record<string, unknown>): Promise<{ content: ToolContent[]; isError?: boolean }> {
  try {
    const rawUrl = typeof args.url === 'string' ? args.url : ''
    if (!rawUrl.trim()) throw new Error('请提供视频 URL')
    const result = await analyzeVideo(rawUrl)
    return mcpResult(result.content)
  } catch (error) {
    return mcpResult([asText(`视频分析失败：${error instanceof Error ? error.message : String(error)}`)], true)
  }
}

export function buildPiVideoTools(_ctx: VideoToolContext): AgentTool[] {
  return [{
    name: 'video_analyze_url',
    label: '分析视频链接',
    description: '下载并分析一个公开可访问的视频链接，返回视频时长、关键时间点、关键画面和可用的字幕/本地语音转写。用户询问视频讲了什么、总结视频或解释视频内容时使用。若结果明确提示没有转写，不要把画面推断成听到的语音。',
    parameters: Type.Object({ url: Type.String({ description: '公开可访问的 http(s) 视频链接' }) }),
    execute: async (_id, params, signal) => {
      if (signal?.aborted) return piResult([asText('视频分析已取消')])
      const result = await handleVideoAnalyzeUrl(params as Record<string, unknown>)
      return piResult(result.content, { isError: result.isError === true })
    },
  }]
}

export async function injectVideoMcpServer(mcpServers: Record<string, unknown>): Promise<void> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')
  mcpServers.video = sdk.createSdkMcpServer({
    name: 'video',
    version: '1.0.0',
    tools: [sdk.tool(
      'video_analyze_url',
      '下载公开视频链接并返回关键帧、字幕或本地语音转写供模型分析。',
      { url: z.string() },
      async (args: Record<string, unknown>) => handleVideoAnalyzeUrl(args),
      { annotations: { readOnlyHint: true } },
    )],
  })
}
