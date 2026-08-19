/**
 * AskUserQuestionBanner — Agent AskUserQuestion 交互式问答
 *
 * 机制：多题 Tab、草稿 atom 持久化、↑↓ / Enter 键盘流（与 General 移植一致）。
 * 视觉：与输入框 / MessageQueue 同宽、同玻璃填色；不叠第二层 backdrop-filter，避免字糊。
 */
import { useAtom, useSetAtom } from 'jotai'
import { ArrowUp, ChatCircleDots, Check, X } from '@phosphor-icons/react'
import { motion, AnimatePresence } from 'motion/react'
import * as React from 'react'

import type { AskUserQuestion } from '@tagent/shared'

import { AppTooltip } from '@tagent/ui'
import { cn } from '../../lib/utils'
import {
  allPendingAskUserRequestsAtom,
  askUserDraftsAtom,
  askUserDismissedAtAtom,
  type AskUserQuestionDraft,
  type AskUserRequestDraft,
} from '../../atoms/ask-user-atoms'

const EMPTY_ANSWER: AskUserQuestionDraft = { selected: [], customText: '', showCustom: false }

interface AskUserQuestionBannerProps {
  sessionId: string
}

export function AskUserQuestionBanner({
  sessionId,
}: AskUserQuestionBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingAskUserRequestsAtom)
  const [drafts, setDrafts] = useAtom(askUserDraftsAtom)
  const setAskUserDismissedAt = useSetAtom(askUserDismissedAtAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [submitting, setSubmitting] = React.useState(false)

  const request = requests[0] ?? null
  const questions = request?.questions ?? []
  const requestDraft = request ? drafts.get(request.requestId) : undefined
  const activeTab =
    questions.length > 0
      ? Math.min(Math.max(requestDraft?.activeTab ?? 0, 0), questions.length - 1)
      : 0
  const focusedOptIdx = requestDraft?.focusedOptIdx ?? -1
  const answers = requestDraft?.answers ?? createInitialDraft(questions).answers
  const isLastTab = activeTab >= questions.length - 1

  const activeTabRef = React.useRef(activeTab)
  activeTabRef.current = activeTab
  const questionsRef = React.useRef(questions)
  questionsRef.current = questions
  const focusedOptIdxRef = React.useRef(focusedOptIdx)
  focusedOptIdxRef.current = focusedOptIdx
  const submitRef = React.useRef<(() => void) | null>(null)
  const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAutoAdvanceTimer = React.useCallback((): void => {
    if (autoAdvanceTimerRef.current != null) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }, [])

  React.useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer])

  React.useEffect(() => {
    clearAutoAdvanceTimer()
    if (!request || questions.length === 0) return
    setDrafts((prev) => {
      const current = prev.get(request.requestId)
      if (current && current.activeTab >= 0 && current.activeTab < questions.length) return prev
      const map = new Map(prev)
      map.set(request.requestId, createInitialDraft(questions))
      return map
    })
  }, [request?.requestId, questions, clearAutoAdvanceTimer, setDrafts])

  React.useEffect(() => {
    if (!request || questions.length === 0) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curTab = activeTabRef.current
      const qs = questionsRef.current
      const curFocusIdx = focusedOptIdxRef.current
      const q = qs[curTab]
      if (!q) return
      const itemCount = q.options.length + 1
      const lastTab = curTab >= qs.length - 1

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (lastTab) submitRef.current?.()
          else setActiveTabByState((prev) => prev + 1)
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const nextIdx =
          curFocusIdx === -1
            ? e.key === 'ArrowDown'
              ? 0
              : itemCount - 1
            : e.key === 'ArrowDown'
              ? (curFocusIdx + 1) % itemCount
              : (curFocusIdx - 1 + itemCount) % itemCount
        setFocusedOptIdxByState(nextIdx)
        if (nextIdx < q.options.length) {
          const opt = q.options[nextIdx]
          if (opt) toggleOptionByState(curTab, q, opt.label)
        } else {
          toggleCustomByState(curTab)
        }
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        if (lastTab) submitRef.current?.()
        else setActiveTabByState((prev) => prev + 1)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  const handleDismiss = (): void => {
    const ids = requests.map((r) => r.requestId)
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    clearDrafts(ids)
    // 关闭只表示「未选择」：软 deny 回灌给 Agent，保持当前轮运行，由 Agent 决定后续。
    // 记 dismiss 时间戳：Chat 据此在短窗口内把随后迟到的 abort（[Request interrupted by user]）
    // 视作关窗副作用而非用户停止，不 recordCompletion('stopped') / 不硬停。
    setAskUserDismissedAt((prev) => {
      const map = new Map(prev)
      map.set(sessionId, Date.now())
      return map
    })
    void (async () => {
      try {
        for (const requestId of ids) {
          await window.electronAPI.askUserDismiss(requestId)
        }
      } catch (err) {
        console.error(err)
      }
    })()
  }

  if (!request) return null

  const getAnswer = (idx: number): AskUserQuestionDraft => answers.get(idx) ?? EMPTY_ANSWER

  function updateCurrentDraft(updater: (draft: AskUserRequestDraft) => AskUserRequestDraft): void {
    if (!request) return
    setDrafts((prev) => {
      const current = prev.get(request.requestId) ?? createInitialDraft(questions)
      const map = new Map(prev)
      map.set(request.requestId, updater(current))
      return map
    })
  }

  function updateAnswers(
    updater: (prev: Map<number, AskUserQuestionDraft>) => Map<number, AskUserQuestionDraft>,
  ): void {
    updateCurrentDraft((draft) => ({ ...draft, answers: updater(draft.answers) }))
  }

  function setActiveTabByState(update: number | ((prev: number) => number)): void {
    updateCurrentDraft((draft) => {
      const rawNext = typeof update === 'function' ? update(draft.activeTab) : update
      const maxTab = Math.max(questions.length - 1, 0)
      const nextTab = Math.min(Math.max(rawNext, 0), maxTab)
      return {
        ...draft,
        activeTab: nextTab,
        focusedOptIdx: -1,
        answers: ensureAnswerForTab(draft.answers, questions, nextTab),
      }
    })
  }

  function setFocusedOptIdxByState(nextIdx: number): void {
    updateCurrentDraft((draft) => ({ ...draft, focusedOptIdx: nextIdx }))
  }

  function clearDrafts(requestIds: string[]): void {
    setDrafts((prev) => {
      const map = new Map(prev)
      requestIds.forEach((requestId) => map.delete(requestId))
      return map
    })
  }

  function toggleOptionByState(qIdx: number, q: AskUserQuestion, label: string): void {
    updateAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      const selected = q.multiSelect
        ? cur.selected.includes(label)
          ? cur.selected.filter((s) => s !== label)
          : [...cur.selected, label]
        : [label]
      map.set(qIdx, { ...cur, selected, showCustom: false, customText: '' })
      return map
    })
  }

  function toggleCustomByState(qIdx: number): void {
    updateAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      map.set(qIdx, {
        ...cur,
        showCustom: !cur.showCustom,
        selected: cur.showCustom ? cur.selected : [],
      })
      return map
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const answersRecord: Record<string, string> = {}
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        if (!q) continue
        const answer = getAnswer(i)
        const key = q.question || String(i)
        if (answer.showCustom && answer.customText.trim()) {
          answersRecord[key] = answer.customText.trim()
        } else if (answer.selected.length > 0) {
          answersRecord[key] = answer.selected.join(', ')
        }
      }
      await window.electronAPI.askUserRespond({
        requestId: request.requestId,
        answers: answersRecord,
      })
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
      clearDrafts([request.requestId])
    } catch (error) {
      console.error('[AskUserQuestionBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  submitRef.current = handleSubmit

  const hasValidAnswers = questions.some((_, idx) => {
    const a = getAnswer(idx)
    return a.selected.length > 0 || (a.showCustom && a.customText.trim().length > 0)
  })

  const currentQuestion = questions[activeTab]
  if (!currentQuestion) return null

  const goNextTab = (): void => {
    if (!isLastTab) setActiveTabByState((prev) => prev + 1)
  }

  const answeredCount = questions.reduce((n, _, idx) => {
    const a = getAnswer(idx)
    return a.selected.length > 0 || (a.showCustom && a.customText.trim()) ? n + 1 : n
  }, 0)

  const remeasureComposerTop = (): void => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key={request.requestId}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onAnimationComplete={remeasureComposerTop}
          className="session-permission-banner pointer-events-auto"
        >
          <div className="ask-user-card">
            {/* 顶栏 */}
            <header className="ask-user-card__head">
              <div className="ask-user-card__head-left">
                <span className="ask-user-card__icon" aria-hidden>
                  <ChatCircleDots size={15} weight="duotone" />
                </span>
                <div className="ask-user-card__titles">
                  <span className="ask-user-card__title">需要你的选择</span>
                  {questions.length > 1 ? (
                    <span className="ask-user-card__meta">
                      {answeredCount}/{questions.length} 已答
                    </span>
                  ) : (
                    <span className="ask-user-card__meta">
                      {currentQuestion.multiSelect ? '可多选' : '单选'}
                      {currentQuestion.header ? ` · ${currentQuestion.header}` : ''}
                    </span>
                  )}
                </div>
              </div>
              <div className="ask-user-card__head-right">
                {requests.length > 1 ? (
                  <AppTooltip label={`另有 ${requests.length - 1} 组问题`}>
                    <span className="ask-user-card__queue">
                      +{requests.length - 1}
                    </span>
                  </AppTooltip>
                ) : null}
                <AppTooltip label="关闭，未选择（Agent 自行默认继续）" side="top">
                  <button
                    type="button"
                    className="ask-user-card__icon-btn"
                    onClick={handleDismiss}
                    aria-label="关闭，未选择（Agent 自行默认继续）"
                  >
                    <X size={14} weight="bold" />
                  </button>
                </AppTooltip>
              </div>
            </header>

            {/* 多题步进：细段 + 短标题，不用实心 chip 墙 */}
            {questions.length > 1 ? (
              <div className="ask-user-card__steps" role="tablist" aria-label="问题列表">
                {questions.map((q, idx) => {
                  const isActive = idx === activeTab
                  const ans = getAnswer(idx)
                  const hasAnswer =
                    ans.selected.length > 0 || (ans.showCustom && ans.customText.trim().length > 0)
                  return (
                    <button
                      key={idx}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={cn(
                        'ask-user-step',
                        isActive && 'is-active',
                        hasAnswer && !isActive && 'is-done',
                      )}
                      onClick={() => setActiveTabByState(idx)}
                    >
                      <span className="ask-user-step__num">{idx + 1}</span>
                      <span className="ask-user-step__label">
                        {q.header?.trim() || `问题 ${idx + 1}`}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            <div className="ask-user-card__body">
              <QuestionCard
                question={currentQuestion}
                answer={getAnswer(activeTab)}
                focusedIndex={focusedOptIdx}
                showModeBadge={questions.length > 1}
                onToggleOption={(label) => {
                  toggleOptionByState(activeTab, currentQuestion, label)
                  if (!currentQuestion.multiSelect && !isLastTab) {
                    clearAutoAdvanceTimer()
                    autoAdvanceTimerRef.current = setTimeout(() => {
                      autoAdvanceTimerRef.current = null
                      setActiveTabByState((prev) => prev + 1)
                    }, 150)
                  }
                }}
                onToggleCustom={() => toggleCustomByState(activeTab)}
                onCustomTextChange={(text) =>
                  updateAnswers((prev) => {
                    const map = new Map(prev)
                    const cur = map.get(activeTab) ?? EMPTY_ANSWER
                    map.set(activeTab, { ...cur, customText: text })
                    return map
                  })
                }
                onSubmit={isLastTab ? handleSubmit : goNextTab}
              />
            </div>

            <footer className="ask-user-card__foot">
              <span className="ask-user-card__hint">
                ↑↓ 选择 · Enter {isLastTab ? '确认' : '下一题'}
              </span>
              <div className="ask-user-card__actions">
                {!isLastTab ? (
                  <button
                    type="button"
                    className="ask-user-card__btn ask-user-card__btn--ghost"
                    onClick={goNextTab}
                    disabled={!hasAnswerFor(getAnswer(activeTab))}
                  >
                    下一题
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ask-user-card__btn ask-user-card__btn--primary"
                    onClick={() => void handleSubmit()}
                    disabled={submitting || !hasValidAnswers}
                  >
                    <ArrowUp size={13} weight="bold" />
                    {submitting ? '提交中…' : '确认'}
                  </button>
                )}
              </div>
            </footer>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function hasAnswerFor(a: AskUserQuestionDraft): boolean {
  return a.selected.length > 0 || (a.showCustom && a.customText.trim().length > 0)
}

function createInitialDraft(questions: readonly AskUserQuestion[]): AskUserRequestDraft {
  return {
    activeTab: 0,
    focusedOptIdx: -1,
    answers: ensureAnswerForTab(new Map(), questions, 0),
  }
}

function ensureAnswerForTab(
  answers: Map<number, AskUserQuestionDraft>,
  questions: readonly AskUserQuestion[],
  tabIndex: number,
): Map<number, AskUserQuestionDraft> {
  if (answers.has(tabIndex)) return answers
  const firstOpt = questions[tabIndex]?.options[0]
  if (!firstOpt) return answers
  const map = new Map(answers)
  map.set(tabIndex, { ...EMPTY_ANSWER, selected: [firstOpt.label] })
  return map
}

function QuestionCard({
  question,
  answer,
  focusedIndex,
  showModeBadge,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onSubmit,
}: {
  question: AskUserQuestion
  answer: AskUserQuestionDraft
  focusedIndex: number
  showModeBadge: boolean
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onSubmit: () => void
}): React.ReactElement {
  const optionCount = question.options.length
  const previewOption =
    focusedIndex >= 0 && focusedIndex < optionCount
      ? question.options[focusedIndex]
      : question.options.find((o) => answer.selected.includes(o.label))
  const previewContent = previewOption?.preview

  return (
    <div className="ask-user-q">
      <div className="ask-user-q__prompt">
        {showModeBadge ? (
          <span className="ask-user-q__badge">
            {question.multiSelect ? '多选' : '单选'}
            {question.header ? ` · ${question.header}` : ''}
          </span>
        ) : question.header ? (
          <span className="ask-user-q__badge">{question.header}</span>
        ) : null}
        <p className="ask-user-q__text">{question.question}</p>
      </div>

      <div className="ask-user-q__options" role="listbox" aria-multiselectable={question.multiSelect}>
        {question.options.map((option, idx) => {
          const isSelected = answer.selected.includes(option.label)
          const isFocused = focusedIndex === idx
          return (
            <button
              key={option.label}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={cn(
                'ask-user-opt',
                isSelected && 'is-selected',
                isFocused && 'is-focused',
              )}
              onClick={() => onToggleOption(option.label)}
            >
              <span className="ask-user-opt__mark" aria-hidden>
                {question.multiSelect ? (
                  isSelected ? (
                    <Check size={11} weight="bold" />
                  ) : null
                ) : (
                  <span className={cn('ask-user-opt__radio', isSelected && 'is-on')} />
                )}
              </span>
              <span className="ask-user-opt__idx">{idx + 1}</span>
              <span className="ask-user-opt__body">
                <span className="ask-user-opt__label">{option.label}</span>
                {option.description ? (
                  <span className="ask-user-opt__desc">{option.description}</span>
                ) : null}
              </span>
            </button>
          )
        })}

        <button
          type="button"
          role="option"
          aria-selected={answer.showCustom}
          className={cn(
            'ask-user-opt',
            answer.showCustom && 'is-selected',
            focusedIndex === optionCount && 'is-focused',
          )}
          onClick={onToggleCustom}
        >
          <span className="ask-user-opt__mark" aria-hidden>
            {question.multiSelect ? (
              answer.showCustom ? (
                <Check size={11} weight="bold" />
              ) : null
            ) : (
              <span className={cn('ask-user-opt__radio', answer.showCustom && 'is-on')} />
            )}
          </span>
          <span className="ask-user-opt__idx">{optionCount + 1}</span>
          <span className="ask-user-opt__body">
            <span className="ask-user-opt__label">其他</span>
            <span className="ask-user-opt__desc">自定义输入</span>
          </span>
        </button>
      </div>

      {answer.showCustom ? (
        <input
          type="text"
          className="ask-user-q__custom"
          placeholder="输入你的答案…"
          value={answer.customText}
          onChange={(e) => onCustomTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.stopPropagation()
              onSubmit()
            }
          }}
          autoFocus
        />
      ) : null}

      {previewContent ? (
        <pre className="ask-user-q__preview">{previewContent}</pre>
      ) : null}
    </div>
  )
}
