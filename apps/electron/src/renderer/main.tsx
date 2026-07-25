/**
 * TAgent-Desktop renderer 入口
 * 当前阶段：最小空壳，后续接入会话页（从 TAgent 搬 AgentView 等）。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
