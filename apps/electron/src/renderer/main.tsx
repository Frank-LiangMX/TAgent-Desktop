/**
 * TAgent-Desktop renderer 入口
 * 当前阶段：最小空壳，后续接入会话页（从 TAgent 搬 AgentView 等）。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ThemeInitializer } from './components/ThemeInitializer'
import './styles/globals.css'

// ===== 焦点诊断：捕获全局错误 + 监控所有输入框焦点变化（排查间歇性输入失败 bug）=====
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    console.error('[诊断 window.error]', e.message, e.error?.stack ?? '', e.filename, e.lineno)
  })
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[诊断 unhandledrejection]', e.reason)
  })
  // 捕获所有 focus 变化（focusin 冒泡，能抓到所有输入框）
  window.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement
    const isInput = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    if (isInput) {
      console.log(`[诊断 focusin] ${t.tagName} type=${(t as HTMLInputElement).type ?? ''} name=${(t as HTMLInputElement).name ?? ''} readonly=${t.getAttribute('readonly') ?? ''} disabled=${(t as HTMLInputElement).disabled ?? ''}`)
    } else if (t.tagName === 'BUTTON' || t.tagName === 'SELECT') {
      // 非输入控件获焦，可能是焦点被抢的真凶——打印文本/位置
      const txt = (t.textContent ?? '').trim().slice(0, 30)
      const rect = t.getBoundingClientRect()
      console.log(`[诊断 focusin] ${t.tagName} text="${txt}" 位置=(${Math.round(rect.x)},${Math.round(rect.y)})`)
    }
  })
  window.addEventListener('focusout', (e) => {
    const t = e.target as HTMLElement
    const isInput = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    if (isInput) {
      // microtask 后读 activeElement，看焦点被谁抢走（定位重渲染丢焦点的真凶）
      Promise.resolve().then(() => {
        const ae = document.activeElement
        const aeSig = ae ? `${ae.tagName}#${ae.id}.${ae.className?.toString?.().slice(0, 40)}` : 'null'
        console.log(`[诊断 focusout] ${t.tagName}（失去焦点）→ 焦点去了: ${aeSig}`)
      })
    }
  })
  // 监听全局 mousedown（capture 阶段），看输入框点击是否被 preventDefault
  window.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement
    const isInput = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
    if (isInput) {
      console.log(`[诊断 mousedown] ${t.tagName} defaultPrevented=${e.defaultPrevented}`)
    }
  }, true)
  // 定时打印 activeElement，捕捉焦点被抢走的时刻
  let lastActive: string | null = null
  setInterval(() => {
    const el = document.activeElement
    const sig = el ? `${el.tagName}#${el.id}.${el.className?.toString?.().slice(0, 30)}` : 'null(body)'
    if (sig !== lastActive) {
      lastActive = sig
      console.log(`[诊断 activeElement 变化] → ${sig}`)
    }
  }, 1000)
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeInitializer>
      <App />
    </ThemeInitializer>
  </React.StrictMode>
)
