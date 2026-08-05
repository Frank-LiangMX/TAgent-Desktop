import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom 不实现 ResizeObserver，而 use-stick-to-bottom 等组件挂载即用它。
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

// jsdom 也不实现 IntersectionObserver。FilePathChip 等组件靠它做「进入视口才查询」的懒加载，
// 测试环境里没有真实布局，直接当作立刻可见，否则相关逻辑永远不会触发。
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  } as unknown as typeof IntersectionObserver
}

afterEach(() => {
  cleanup()
})
