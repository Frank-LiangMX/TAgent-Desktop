import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { MessageResponse } from '../index'
import { TooltipProvider } from '../../tooltip'

describe('MessageResponse 中文标点与正文序号', () => {
  test.each([
    '配置项 category: "collision", enabled: true; 路径 C:\\Work\\foo.ts。',
    '日志原文 "Error: file not found!"，检查后再处理。',
    '参数 --filter="中文", 时间 12:30, 版本 v1.2.3, 数值 1,234.56。',
    '中文说明，使用原来的标点。English sentence: keep it, please!',
  ])('保留中英混排、引文和技术文本的原始标点：%s', (source) => {
    const { container } = render(<MessageResponse>{source}</MessageResponse>)
    expect(container.querySelector('p')?.textContent).toBe(source)
  })

  test('流式追加闭合引号时，不回头改写已经显示的标点', () => {
    const prefix = '检查结果 "通过'
    const full = prefix + '"，继续验证。'
    const { container, rerender } = render(<MessageResponse streaming>{prefix}</MessageResponse>)
    const displayed = container.querySelector('p')?.textContent ?? ''
    expect(displayed).toBe(prefix)
    rerender(<MessageResponse streaming>{full}</MessageResponse>)
    expect(container.querySelector('p')?.textContent?.startsWith(displayed)).toBe(true)
    expect(container.querySelector('p')?.textContent).toBe(full)
    rerender(<MessageResponse>{full}</MessageResponse>)
    expect(container.querySelector('p')?.textContent).toBe(full)
  })

  test('加粗正文序号保留半角句点，复现实际消息的标题与无序列表结构', () => {
    const { container } = render(
      <MessageResponse>{
        '### 你能做的黑盒归因\n\n**1. 看抖动在时间上的分布**\n\n- 是整段持续高频抖, 还是只在快速动作时出现?\n\n**2. 做一个同步对照实验（最关键）**\n\n- 现有六机位布局\n\n**10. 看是否有周期性特征**'
      }</MessageResponse>,
    )

    expect([...container.querySelectorAll('strong')].map(node => node.textContent)).toEqual([
      '1. 看抖动在时间上的分布',
      '2. 做一个同步对照实验（最关键）',
      '10. 看是否有周期性特征',
    ])
    expect(container.textContent).toContain('高频抖,')
    expect(container.textContent).toContain('出现?')
    expect(container.querySelector('ol')).toBeNull()
    expect(container.querySelectorAll('ul')).toHaveLength(2)
  })

  test('普通句尾、标题序号、小数和版本号都保留原文', () => {
    const { container } = render(
      <MessageResponse>{'### 3. 检查版本\n\n当前版本 v1.2.3，数值 3.14. 检查结束.'}</MessageResponse>,
    )

    expect(container.querySelector('h3')?.textContent).toBe('3. 检查版本')
    expect(container.textContent).toContain('v1.2.3')
    expect(container.textContent).toContain('3.14.')
    expect(container.textContent).toContain('检查结束.')
  })

  test('正常 Markdown 有序列表、代码和 URL 不受影响', () => {
    const { container } = render(
      <TooltipProvider>
        <MessageResponse>{'9. **检查布局**\n10. 检查同步\n\n代码 `1. 中文标题`，地址 https://example.com/v1.2.3'}</MessageResponse>
      </TooltipProvider>,
    )

    expect(container.querySelector('ol')?.getAttribute('start')).toBe('9')
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('code')?.textContent).toBe('1. 中文标题')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/v1.2.3')
  })
})
