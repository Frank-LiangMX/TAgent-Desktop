import { useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { dynamicBgEnabledAtom } from '../atoms/dynamic-bg'

function parseRgb(raw: string): [number, number, number] {
  const parts = raw.trim().split(/\s+/).map(Number)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

export function useDynamicBackground(): void {
  const enabled = useAtomValue(dynamicBgEnabledAtom)
  const rafRef = useRef(0)
  const startRef = useRef(0)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!enabled) {
      cancelAnimationFrame(rafRef.current)
      overlayRef.current?.remove()
      overlayRef.current = null
      return
    }

    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;'
    document.body.appendChild(el)
    overlayRef.current = el

    const html = document.documentElement

    const readRgb = (name: string): [number, number, number] =>
      parseRgb(getComputedStyle(html).getPropertyValue(name))

    let baseA = readRgb('--scene-a-rgb')
    let baseB = readRgb('--scene-b-rgb')
    let baseC = readRgb('--scene-c-rgb')

    const observer = new MutationObserver(() => {
      baseA = readRgb('--scene-a-rgb')
      baseB = readRgb('--scene-b-rgb')
      baseC = readRgb('--scene-c-rgb')
    })
    observer.observe(html, { attributes: true, attributeFilter: ['class'] })

    startRef.current = performance.now()

    const tick = (now: number) => {
      const t = (now - startRef.current) / 1000

      const aPx = 24 + 22 * (0.5 + 0.5 * Math.sin(t * 0.012))
      const aPy = 6 + 14 * (0.5 + 0.5 * Math.cos(t * 0.01))
      const cPx = 26 + 36 * (0.5 + 0.5 * Math.sin(t * 0.01 + 2.4))
      const cPy = 64 + 30 * (0.5 + 0.5 * Math.cos(t * 0.009 + 3.1))
      const bPx = 64 + 28 * (0.5 + 0.5 * Math.sin(t * 0.008 + 1.2))
      const bPy = 60 + 30 * (0.5 + 0.5 * Math.cos(t * 0.007 + 0.8))

      el.style.background = [
        `radial-gradient(42% 48% at ${aPx}% ${aPy}%, rgb(${baseA[0]} ${baseA[1]} ${baseA[2]} / 0.22) 0%, transparent 60%)`,
        `radial-gradient(40% 46% at ${cPx}% ${cPy}%, rgb(${baseC[0]} ${baseC[1]} ${baseC[2]} / 0.22) 0%, transparent 60%)`,
        `radial-gradient(52% 58% at ${bPx}% ${bPy}%, rgb(${baseB[0]} ${baseB[1]} ${baseB[2]} / 0.22) 0%, transparent 62%)`,
        'transparent',
      ].join(',')

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
      observer.disconnect()
      el.remove()
    }
  }, [enabled])
}
