import * as React from 'react'

export interface InertRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  inactive: boolean
}

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (!ref) continue
      if (typeof ref === 'function') {
        ref(value)
      } else {
        ;(ref as React.MutableRefObject<T | null>).current = value
      }
    }
  }
}

export function useInertElement<T extends HTMLElement>(inactive: boolean): React.RefObject<T> {
  const ref = React.useRef<T>(null)

  React.useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', inactive)
  }, [inactive])

  return ref
}

/**
 * React 18 类型尚未声明 inert；通过 DOM 属性确保隐藏区域无法被键盘或辅助技术聚焦。
 */
export const InertRegion = React.forwardRef<HTMLDivElement, InertRegionProps>(function InertRegion(
  { inactive, ...props },
  forwardedRef
) {
  const inertRef = useInertElement<HTMLDivElement>(inactive)

  return (
    <div {...props} ref={mergeRefs(inertRef, forwardedRef)} aria-hidden={inactive || undefined} />
  )
})
