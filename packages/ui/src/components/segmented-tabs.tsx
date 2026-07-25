import * as React from 'react'

import { cn } from '@/lib/utils'

interface SegmentedTabsContextValue {
  value: string
  onValueChange: (value: string) => void
}

const SegmentedTabsContext = React.createContext<SegmentedTabsContextValue | null>(null)

function useSegmentedTabsContext(component: string): SegmentedTabsContextValue {
  const context = React.useContext(SegmentedTabsContext)
  if (!context) {
    throw new Error(`${component} 必须在 SegmentedTabs 内使用`)
  }
  return context
}

export interface SegmentedTabsProps {
  value: string
  onValueChange: (value: string) => void
  className?: string
  children: React.ReactNode
}

/** 横向分段 Tab：内容自适应，轻量轨 + item 抬升选中 */
function SegmentedTabs({
  value,
  onValueChange,
  className,
  children,
}: SegmentedTabsProps): React.ReactElement {
  return (
    <SegmentedTabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn('ui-segmented-tabs', className)} role="tablist">
        {children}
      </div>
    </SegmentedTabsContext.Provider>
  )
}

export interface SegmentedTabsItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'value'
> {
  value: string
}

const SegmentedTabsItem = React.forwardRef<HTMLButtonElement, SegmentedTabsItemProps>(
  ({ value, className, children, disabled, onClick, ...props }, ref) => {
    const { value: activeValue, onValueChange } = useSegmentedTabsContext('SegmentedTabsItem')
    const active = activeValue === value

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={active}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented || disabled) return
          onValueChange(value)
        }}
        className={cn(
          'ui-segmented-tabs-item',
          active && 'ui-segmented-tabs-item--active',
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)
SegmentedTabsItem.displayName = 'SegmentedTabsItem'

export { SegmentedTabs, SegmentedTabsItem }
