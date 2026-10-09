import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { MessageResponse } from '../index'
import { TooltipProvider } from '../../tooltip'

describe('MessageResponse 中文标点与正文序号', () => {
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
    expect(container.textContent).toContain('高频抖，')
    expect(container.textContent).toContain('出现？')
    expect(container.querySelector('ol')).toBeNull()
    expect(container.querySelectorAll('ul')).toHaveLength(2)
  })

  test('普通句尾仍转换，标题序号、小数和版本号保留', () => {
    const { container } = render(
      <MessageResponse>{'### 3. 检查版本\n\n当前版本 v1.2.3，数值 3.14. 检查结束.'}</MessageResponse>,
    )

    expect(container.querySelector('h3')?.textContent).toBe('3. 检查版本')
    expect(container.textContent).toContain('v1.2.3')
    expect(container.textContent).toContain('3.14.')
    expect(container.textContent).toContain('检查结束。')
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
