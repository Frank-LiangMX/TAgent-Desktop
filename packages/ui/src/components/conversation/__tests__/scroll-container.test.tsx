import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { Conversation, ConversationContent } from '../index'

/**
 * StickToBottom 只在挂载时探一次 getComputedStyle 决定要不要注入 overflow:auto。
 * Dockview 的 onlyWhenVisible 会把非可见面板的 DOM 摘出文档，探测因此失效，
 * 导致后台标签的会话页永远滚不动。滚动性必须由我们自己的 class 保证。
 */
describe('ConversationContent 滚动容器', () => {
  test('滚动元素自带 overflow-y-auto，不依赖挂载时的样式探测', () => {
    const { container } = render(
      <Conversation>
        <ConversationContent>
          <div>消息</div>
        </ConversationContent>
      </Conversation>
    )

    const scrollEl = container.querySelector('.will-change-scroll-position')
    expect(scrollEl).not.toBeNull()
    expect(scrollEl).toHaveClass('overflow-y-auto')
  })

  test('即使容器在脱离文档的子树里挂载，滚动 class 依然在', () => {
    // 模拟 Dockview 摘掉面板 DOM 的情形：挂载点不在 document 内
    const detached = document.createElement('div')

    const { container } = render(
      <Conversation>
        <ConversationContent>
          <div>消息</div>
        </ConversationContent>
      </Conversation>,
      { container: detached }
    )

    expect(document.contains(detached)).toBe(false)
    expect(container.querySelector('.will-change-scroll-position')).toHaveClass(
      'overflow-y-auto'
    )
  })
})
