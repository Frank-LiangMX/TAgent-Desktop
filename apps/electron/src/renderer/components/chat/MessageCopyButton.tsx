/**
 * 消息工具条图标按钮：复制（仅图标 + hover tooltip）
 */
import { useCallback, useState } from 'react'
import { Check, Copy } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'

export function MessageCopyButton({
  text,
  className,
}: {
  text: string
  className?: string
}): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const plain = text.trim()
  const onCopy = useCallback(async () => {
    if (!plain) return
    try {
      await navigator.clipboard.writeText(plain)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      console.warn('[MessageCopyButton] clipboard failed:', err)
    }
  }, [plain])

  if (!plain) return null

  return (
    <AppTooltip label={copied ? '已复制' : '复制'} side="top">
      <button
        type="button"
        className={cn('msg-icon-btn', copied && 'msg-icon-btn--done', className)}
        onClick={() => void onCopy()}
        aria-label={copied ? '已复制' : '复制'}
      >
        {copied ? (
          <Check className="size-3.5 shrink-0" weight="bold" />
        ) : (
          <Copy className="size-3.5 shrink-0" weight="bold" />
        )}
      </button>
    </AppTooltip>
  )
}
