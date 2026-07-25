/**
 * SpeechButton - 语音输入按钮
 *
 * 通过回调 prop 唤起语音输入功能。
 */

import { MicIcon } from 'lucide-react'
import { useCallback } from 'react'

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@tagent/ui'
import { cn } from '../../lib/utils'

interface SpeechButtonProps {
  /** 点击时的回调（应用层注入实际的语音唤起逻辑） */
  onActivate?: () => void | Promise<void>
  /** 是否禁用 */
  disabled?: boolean
  className?: string
}

export function SpeechButton({
  onActivate,
  disabled = false,
  className,
}: SpeechButtonProps): React.ReactElement {
  const handleClick = useCallback((): void => {
    onActivate?.()
  }, [onActivate])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'relative size-8 transition-all duration-200 text-foreground/60 hover:text-foreground',
            className
          )}
          onClick={handleClick}
          disabled={disabled}
        >
          <MicIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>语音输入</p>
      </TooltipContent>
    </Tooltip>
  )
}
