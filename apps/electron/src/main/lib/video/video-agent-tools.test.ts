import { describe, expect, it } from 'vitest'
import { buildFrameTimestamps, buildPiVideoTools, normalizeSubtitle, validateVideoUrl } from './video-agent-tools'

describe('video-agent-tools', () => {
  it('only accepts public http(s)-style URLs', () => {
    expect(validateVideoUrl('https://example.com/video.mp4').protocol).toBe('https:')
    expect(() => validateVideoUrl('file:///C:/video.mp4')).toThrow('http(s)')
    expect(() => validateVideoUrl('https://user:pass@example.com/video.mp4')).toThrow('账号密码')
  })

  it('creates a bounded set of timestamps across the video', () => {
    expect(buildFrameTimestamps(10)).toEqual([0, 5, 9.75])
    expect(buildFrameTimestamps(1000)).toHaveLength(8)
    expect(buildFrameTimestamps(0)).toEqual([0])
  })

  it('normalizes an embedded SRT/WebVTT subtitle track into readable transcript text', () => {
    expect(normalizeSubtitle('1\n00:00:00,000 --> 00:00:01,000\nHello <i>world</i>\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句')).toBe('Hello world\n第二句')
  })

  it('exposes one read-only video analysis tool to all AgentTool runtimes', () => {
    const tool = buildPiVideoTools({ sessionId: 'test' })[0]
    expect(tool?.name).toBe('video_analyze_url')
    expect(tool?.description).toContain('关键画面')
  })
})
