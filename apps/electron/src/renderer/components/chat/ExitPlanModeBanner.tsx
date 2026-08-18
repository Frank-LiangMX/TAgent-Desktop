/**
 * ExitPlanModeBanner — Agent ExitPlanMode 计划审批横幅
 *
 * 视觉对齐 AskUserQuestionBanner（玻璃、全宽、不透明正文）；复用 ask-user-card 材质。
 * 展示 plan 正文（Markdown）+ allowedPrompts + 四选项：
 * 1. 批准并完全自动执行 — 切换到 bypassPermissions
 * 2. 批准并自动审批 — 切换到 auto
 * 3. 拒绝计划 — deny（Agent 收到拒绝原因，可改计划继续）
 * 4. 提供修改意见 — 自由输入反馈回灌模型
 *
 * 键盘：↑↓ 选择，Enter 确认，数字键 1-4 快速选择；反馈框内 Enter 提交、Esc 取消。
 *
 * 移植自 TAgent_General ExitPlanModeBanner；Desktop 化：@phosphor-icons + AppTooltip + 玻璃卡 + plan 正文。
 */
import { useAtom } from 'jotai'
import { AnimatePresence, motion } from 'motion/react'
import Markdown from 'react-markdown'
import {
  ArrowUp,
  Check,
  FileText,
  MessageSquare,
  Send,
  ShieldCheck,
  X,
} from '@phosphor-icons/react'
import * as React from 'react'

import type { ExitPlanModeAction, ExitPlanAllowedPrompt } from '@tagent/shared'

import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'
import { allPendingExitPlanRequestsAtom } from '../../atoms/exit-plan-atoms'

/** 选项定义 */
interface PlanOption {
  action: ExitPlanModeAction
  label: string
  description: string
  icon: React.ReactNode
  tone: 'default' | 'danger'
}

const PLAN_OPTIONS: PlanOption[] = [
  {
    action: 'approve_auto',
    label: '批准并完全自动执行',
    description: '后续工具调用全部自动允许',
    icon: <Check size={13} weight="bold" />,
    tone: 'default',
  },
  {
    action: 'approve_edit',
    label: '批准并自动审批',
    description: '使用 SDK 自动审批器判断后续操作',
    icon: <ShieldCheck size={13} weight="bold" />,
    tone: 'default',
  },
  {
    action: 'deny',
    label: '拒绝计划',
    description: '直接拒绝，Agent 不会执行计划',
    icon: <X size={13} weight="bold" />,
    tone: 'danger',
  },
  {
    action: 'feedback',
    label: '提供修改意见',
    description: '告诉 Agent 需要调整什么',
    icon: <MessageSquare size={13} weight="bold" />,
    tone: 'default',
  },
]

interface ExitPlanModeBannerProps {
  sessionId: string
}

export function ExitPlanModeBanner({
  sessionId,
}: ExitPlanModeBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingExitPlanRequestsAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [focusedIdx, setFocusedIdx] = React.useState(0)
  const [showFeedback, setShowFeedback] = React.useState(false)
  const [feedbackText, setFeedbackText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const request = requests[0] ?? null
  const plan = typeof request?.plan === 'string' ? request.plan : ''

  // Refs：确保 keydown handler 始终读最新值，消除闭包过期
  const focusedIdxRef = React.useRef(focusedIdx)
  focusedIdxRef.current = focusedIdx
  const feedbackTextRef = React.useRef(feedbackText)
  feedbackTextRef.current = feedbackText
  const handleActionRef = React.useRef<((action: ExitPlanModeAction) => void) | null>(null)

  // 切请求时重置状态
  React.useEffect(() => {
    setFocusedIdx(0)
    setShowFeedback(false)
    setFeedbackText('')
  }, [request?.requestId])

  const remeasureComposerTop = (): void => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }

  const handleAction = async (action: ExitPlanModeAction): Promise<void> => {
    if (submitting || !request) return
    setSubmitting(true)
    try {
      await window.electronAPI.respondExitPlanMode({
        requestId: request.requestId,
        action,
        feedback: action === 'feedback' ? feedbackText.trim() : undefined,
      })
      // 乐观出队
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
    } catch (error) {
      console.error('[ExitPlanModeBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  handleActionRef.current = handleAction

  /** 关闭审批横幅 & 终止 Agent（X）。stopAgent → run 级 abort → exitPlanService 兜底 deny 解挂 */
  const handleDismiss = (): void => {
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    window.electronAPI.stopAgent(sessionId).catch(console.error)
  }

  // 键盘导航：只在 requestId 变化时重建 handler，内部通过 ref 读最新值
  React.useEffect(() => {
    if (!request) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curFocusIdx = focusedIdxRef.current

      // 反馈输入框内：仅 Enter 提交（输入法组合中跳过），Esc 收起
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (feedbackTextRef.current.trim()) handleActionRef.current?.('feedback')
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowFeedback(false)
          setFocusedIdx(3)
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const count = PLAN_OPTIONS.length
        const next =
          e.key === 'ArrowDown' ? (curFocusIdx + 1) % count : (curFocusIdx - 1 + count) % count
        setFocusedIdx(next)
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        const option = PLAN_OPTIONS[curFocusIdx]
        if (!option) return
        if (option.action === 'feedback') setShowFeedback(true)
        else handleActionRef.current?.(option.action)
      } else if (e.key >= '1' && e.key <= '4') {
        const idx = parseInt(e.key) - 1
        const option = PLAN_OPTIONS[idx]
        if (!option) return
        setFocusedIdx(idx)
        if (option.action === 'feedback') setShowFeedback(true)
        else handleActionRef.current?.(option.action)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  if (!request) return null

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key={request.requestId}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          onAnimationComplete={remeasureComposerTop}
          className="session-permission-banner pointer-events-auto overflow-hidden"
        >
          <div className="ask-user-card exit-plan-card">
            {/* 顶栏 */}
            <header className="ask-user-card__head">
              <div className="ask-user-card__head-left">
                <span className="ask-user-card__icon" aria-hidden>
                  <FileText size={15} weight="duotone" />
                </span>
                <div className="ask-user-card__titles">
                  <span className="ask-user-card__title">Agent 计划待审批</span>
                  <span className="ask-user-card__meta">选择如何继续</span>
                </div>
              </div>
              <div className="ask-user-card__head-right">
                {requests.length > 1 ? (
                  <AppTooltip label={`另有 ${requests.length - 1} 份计划`} side="top">
                    <span className="ask-user-card__queue">+{requests.length - 1}</span>
                  </AppTooltip>
                ) : null}
                <AppTooltip label="关闭并终止 Agent" side="top">
                  <button
                    type="button"
                    className="ask-user-card__icon-btn"
                    onClick={handleDismiss}
                    aria-label="关闭并终止 Agent"
                  >
                    <X size={14} weight="bold" />
                  </button>
                </AppTooltip>
              </div>
            </header>

            {/* plan 正文（Markdown） */}
            {plan.trim() ? (
              <div className="exit-plan-card__plan">
                <Markdown>{plan}</Markdown>
              </div>
            ) : null}

            {/* allowedPrompts 展示 */}
            {request.allowedPrompts.length > 0 ? (
              <AllowedPromptsList prompts={request.allowedPrompts} />
            ) : null}

            {/* 选项列表 */}
            <div className="ask-user-card__body">
              <div className="exit-plan-options" role="listbox" aria-label="计划审批选项">
                {PLAN_OPTIONS.map((option, idx) => {
                  const isFocused = focusedIdx === idx
                  return (
                    <button
                      key={option.action}
                      type="button"
                      role="option"
                      aria-selected={isFocused}
                      className={cn(
                        'exit-plan-opt',
                        option.tone === 'danger' && 'is-danger',
                        isFocused && 'is-focused',
                      )}
                      onClick={() => {
                        if (option.action === 'feedback') setShowFeedback(true)
                        else void handleAction(option.action)
                      }}
                      disabled={submitting}
                    >
                      <span className="exit-plan-opt__idx">{idx + 1}</span>
                      <span className="exit-plan-opt__icon" aria-hidden>
                        {option.icon}
                      </span>
                      <span className="exit-plan-opt__body">
                        <span className="exit-plan-opt__label">{option.label}</span>
                        <span className="exit-plan-opt__desc">{option.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 反馈输入框 */}
              {showFeedback ? (
                <div className="exit-plan-feedback">
                  <input
                    type="text"
                    className="exit-plan-feedback__input"
                    placeholder="输入修改意见…"
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        e.stopPropagation()
                        if (feedbackText.trim()) void handleAction('feedback')
                      }
                    }}
                    autoFocus
                    disabled={submitting}
                  />
                  <button
                    type="button"
                    className="exit-plan-feedback__send"
                    onClick={() => void handleAction('feedback')}
                    disabled={submitting || !feedbackText.trim()}
                    aria-label="发送修改意见"
                  >
                    <Send size={13} weight="bold" />
                    发送
                  </button>
                </div>
              ) : null}
            </div>

            <footer className="ask-user-card__foot">
              <span className="ask-user-card__hint">
                <ArrowUp size={11} weight="bold" />↓ 选择 · Enter 确认 · 1-4 快速选择
              </span>
            </footer>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** allowedPrompts 展示列表 */
function AllowedPromptsList({ prompts }: { prompts: ExitPlanAllowedPrompt[] }): React.ReactElement {
  return (
    <div className="exit-plan-prompts">
      <p className="exit-plan-prompts__title">计划需要的权限：</p>
      <div className="exit-plan-prompts__chips">
        {prompts.map((p, idx) => (
          <span key={idx} className="exit-plan-prompts__chip">
            {p.prompt}
          </span>
        ))}
      </div>
    </div>
  )
}
