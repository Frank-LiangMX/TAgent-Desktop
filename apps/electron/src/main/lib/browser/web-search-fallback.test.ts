import { describe, expect, it } from 'vitest'
import { assessWebSearchFallback, buildBrowserFallbackContext } from './web-search-fallback'

describe('web search fallback policy', () => {
  it('正常搜索结果不触发浏览器回退', () => {
    expect(assessWebSearchFallback([
      {
        tool_name: 'WebSearch',
        tool_input: { query: '今日金价' },
        tool_response: '结果 1：黄金价格 https://example.com/gold\n来源：Example，更新时间：2026-08-20。该搜索结果包含国际现货、国内品牌金价、期货报价、历史变化、来源链接和页面更新时间，可用于交叉核验实时信息，不应只根据单一摘要下结论。',
      },
    ])).toBeUndefined()
  })

  it('空结果触发 Bing 浏览器回退', () => {
    const decision = assessWebSearchFallback([
      { tool_name: 'WebSearch', tool_input: { query: '今日金价' }, tool_response: [] },
    ])
    expect(decision?.targetUrl).toBe('https://www.bing.com/search?q=%E4%BB%8A%E6%97%A5%E9%87%91%E4%BB%B7')
    expect(decision?.reason).toContain('没有返回内容')
  })

  it('网页失败触发原 URL 回退并生成浏览器指令', () => {
    const decision = assessWebSearchFallback([
      { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/app' }, tool_response: { isError: true, error: 'blocked' } },
    ])
    expect(decision?.targetUrl).toBe('https://example.com/app')
    expect(buildBrowserFallbackContext(decision!)).toContain('browser_open')
  })

  it('非网页工具不参与判断', () => {
    expect(assessWebSearchFallback([
      { tool_name: 'Read', tool_input: { path: 'README.md' }, tool_response: '' },
    ])).toBeUndefined()
  })
})