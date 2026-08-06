/**
 * MathView — math/latex 围栏渲染（复用项目已有 KaTeX 栈）
 *
 * 把围栏内容包成块级公式 $$…$$ 走 react-markdown + remarkMath + rehypeKatex。
 */
import * as React from 'react'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'

import { RichFrame } from './RichFrame'

interface MathViewProps {
  code: string
  variant?: 'default' | 'pane'
}

export function MathView({ code, variant = 'default' }: MathViewProps): React.ReactElement {
  const content = React.useMemo(() => `$$\n${code}\n$$`, [code])

  return (
    <RichFrame
      title="Math"
      copyValue={code}
      fullscreen
      fullscreenTitle="Math"
      splitKind={variant === 'default' ? 'math' : undefined}
      variant={variant}
    >
      <div className="rich-math px-3 py-2.5 text-foreground/90">
        <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
          {content}
        </Markdown>
      </div>
    </RichFrame>
  )
}
