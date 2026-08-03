/**
 * dockActivePlate — 为 Dockview 每个 .dv-tabs-container 注入滑动玻璃底板，
 * 对齐原 TabBar 的 app-workspace-tab-active-plate（width/transform 过渡滑动）。
 *
 * Dockview 管 tab DOM，我们不拥有列表渲染；这里在宿主侧观察每个 group 的
 * tabs 容器，测 .dv-tab.dv-active-tab 位置驱动 plate。
 *
 * 注意：.dv-tabs-container 允许非 tab 子节点（dockview 源码已说明），
 * plate 用 pointer-events:none + absolute，不参与拖拽命中。
 */

const PLATE_CLASS = 'app-workspace-tab-active-plate'
const PLATE_ATTR = 'data-dock-active-plate'

/** 确保 container 内有 plate 节点，返回之 */
function ensurePlate(container: HTMLElement): HTMLElement {
  let plate = container.querySelector<HTMLElement>(`:scope > .${PLATE_CLASS}[${PLATE_ATTR}]`)
  if (!plate) {
    plate = document.createElement('div')
    plate.className = PLATE_CLASS
    plate.setAttribute(PLATE_ATTR, '')
    plate.setAttribute('aria-hidden', 'true')
    container.insertBefore(plate, container.firstChild)
  }
  return plate
}

/**
 * 把 plate 对齐到 container 内当前 active tab。
 * 用 getBoundingClientRect + scrollLeft，避免 offsetParent 不是 container 时错位。
 */
function syncPlate(container: HTMLElement): void {
  const plate = ensurePlate(container)
  const active = container.querySelector<HTMLElement>(':scope > .dv-tab.dv-active-tab')
  if (!active) {
    plate.style.opacity = '0'
    return
  }
  const cRect = container.getBoundingClientRect()
  const aRect = active.getBoundingClientRect()
  const left = aRect.left - cRect.left + container.scrollLeft
  plate.style.opacity = '1'
  plate.style.width = `${aRect.width}px`
  plate.style.transform = `translateX(${left}px)`
}

/** 同步 root 下所有 tabs 容器的 plate */
export function syncAllDockActivePlates(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.dv-tabs-container').forEach(syncPlate)
}

/**
 * 挂载 plate 同步：MutationObserver 抓 tab 增删 / active class 切换，
 * ResizeObserver 抓容器尺寸，scroll 抓横向滚动；返回 dispose。
 */
export function mountDockActivePlates(root: HTMLElement): () => void {
  let rafId: number | null = null
  const observed = new WeakSet<Element>()
  const ro = new ResizeObserver(() => {
    // 直接同步（已在 layout 后）
    syncAllDockActivePlates(root)
  })

  const observeNewContainers = (): void => {
    root.querySelectorAll('.dv-tabs-container').forEach((el) => {
      if (observed.has(el)) return
      observed.add(el)
      ro.observe(el)
    })
  }

  const schedule = (): void => {
    if (rafId != null) return
    rafId = window.requestAnimationFrame(() => {
      rafId = null
      observeNewContainers()
      syncAllDockActivePlates(root)
    })
  }

  // 首次立即同步（可能已有 tab）
  schedule()

  const mo = new MutationObserver(schedule)
  mo.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  ro.observe(root)

  const onScroll = (e: Event): void => {
    const t = e.target
    if (t instanceof HTMLElement && t.classList.contains('dv-tabs-container')) {
      schedule()
    }
  }
  // 捕获阶段：tabs-container 自己 scroll（非 bubble 到 root）
  root.addEventListener('scroll', onScroll, true)

  return () => {
    mo.disconnect()
    ro.disconnect()
    root.removeEventListener('scroll', onScroll, true)
    if (rafId != null) window.cancelAnimationFrame(rafId)
  }
}
