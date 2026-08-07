/**
 * AskUserQuestionBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 多问题用顶部 Tab 切换，选项竖向排列。
 * 填写进度持久化在 askUserDraftsAtom，切换预览 Tab / 分屏后仍保留。
 * 键盘：↑↓ 选择选项，Enter 确认当前问题（最后一题提交，否则翻页）。
 *
 * 移植自 TAgent_General AskUserBanner.tsx，换 Desktop PermissionBanner 视觉皮
 * （motion.div session-permission-banner + rounded-2xl border backdrop-blur-xl）。
 * 预览降级为纯文本（Desktop 未装 react-markdown；option.preview 直接 <pre>）。
 * 机制见 REGRESS-H-GENERAL-PORT-FINDINGS / REGRESS-H-implement-brief。
 */
import { useAtom } from 'jotai'
import { Send, X } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import * as React from 'react'

import type { AskUserQuestion } from '@tagent/shared'

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@tagent/ui'
import {
  allPendingAskUserRequestsAtom,
  askUserDraftsAtom,
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
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    clearDrafts(requests.map((r) => r.requestId))
    window.electronAPI.stopAgent(sessionId).catch(console.error)
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
    updater: (prev: Map<number, AskUserQuestionDraft>) => Map<number, AskUserQuestionDraft>
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
      // 乐观出队；主进程 respond 后会再推 ASK_USER_RESOLVED 幂等清理
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

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key={request.requestId}
          initial={{ opacity: 0, y: 16, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: 16, height: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="session-permission-banner pointer-events-auto overflow-hidden"
        >
          <div className="mx-3 mb-2 rounded-2xl border border-border/60 bg-background/80 p-3 shadow-lg backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">TAgent 需要你的输入</span>
              <div className="flex items-center gap-1.5">
                {requests.length > 1 && (
                  <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex size-5 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
                      onClick={handleDismiss}
                    >
                      <X className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>关闭并终止 Agent</TooltipContent>
                </Tooltip>
              </div>
            </div>

            {questions.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {questions.map((q, idx) => {
                  const isActive = idx === activeTab
                  const ans = getAnswer(idx)
                  const hasAnswer =
                    ans.selected.length > 0 || (ans.showCustom && ans.customText.trim().length > 0)
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all outline-none ${
                        isActive
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : hasAnswer
                            ? 'bg-primary/15 text-primary'
                            : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground'
                      }`}
                      onClick={() => setActiveTabByState(idx)}
                    >
                      {`${idx + 1}-${q.multiSelect ? '多选' : '单选'}：${q.header || `问题 ${idx + 1}`}`}
                    </button>
                  )
                })}
              </div>
            )}

            <div className="mt-2">
              <QuestionCard
                question={currentQuestion}
                questionIndex={activeTab}
                answer={getAnswer(activeTab)}
                focusedIndex={focusedOptIdx}
                showBadge={questions.length === 1}
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

            <div className="mt-2 flex items-center justify-end gap-1.5">
              <span className="mr-auto text-[10px] text-muted-foreground/40">
                {`↑↓ 选择 · Enter ${isLastTab ? '确认' : '下一个'}`}
              </span>
              {isLastTab && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSubmit}
                  disabled={submitting || !hasValidAnswers}
                  className="h-7 px-3 text-xs"
                >
                  <Send className="mr-1 size-3" />
                  确认
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
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
  tabIndex: number
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
  questionIndex,
  answer,
  focusedIndex,
  showBadge,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onSubmit,
}: {
  question: AskUserQuestion
  questionIndex: number
  answer: AskUserQuestionDraft
  focusedIndex: number
  showBadge: boolean
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
    <div className="space-y-2">
      <div className="space-y-1">
        {showBadge && (
          <span className="inline-flex shrink-0 items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-sm">
            {`${questionIndex + 1}-${question.multiSelect ? '多选' : '单选'}${question.header ? `：${question.header}` : ''}`}
          </span>
        )}
        <p className="text-sm text-foreground">{question.question}</p>
      </div>

      <div className="flex flex-col gap-1">
        {question.options.map((option, idx) => {
          const isSelected = answer.selected.includes(option.label)
          const isFocused = focusedIndex === idx
          return (
            <button
              key={option.label}
              type="button"
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-all outline-none ${
                isSelected
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.08]'
              }${isFocused ? ' ring-2 ring-primary/50 ring-offset-1 ring-offset-transparent' : ''}`}
              onClick={() => onToggleOption(option.label)}
            >
              <span
                className={`shrink-0 text-[10px] ${isSelected ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}
              >
                {idx + 1}
              </span>
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <span
                  className={`text-[11px] ${isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                >
                  {option.description}
                </span>
              )}
            </button>
          )
        })}

        <button
          type="button"
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-all outline-none ${
            answer.showCustom
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'bg-foreground/[0.04] text-foreground/80 hover:bg-foreground/[0.08]'
          }${focusedIndex === optionCount ? ' ring-2 ring-primary/50 ring-offset-1 ring-offset-transparent' : ''}`}
          onClick={onToggleCustom}
        >
          <span
            className={`shrink-0 text-[10px] ${answer.showCustom ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}
          >
            {optionCount + 1}
          </span>
          <span className="font-medium">其他...</span>
        </button>
      </div>

      {answer.showCustom && (
        <input
          type="text"
          className="w-full rounded-lg bg-foreground/[0.04] px-3 py-2 text-xs transition-colors placeholder:text-muted-foreground/40 focus:bg-foreground/[0.08] focus:outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="输入自定义答案..."
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
      )}

      {previewContent && (
        <pre className="mt-2 max-h-60 overflow-auto rounded-xl bg-foreground/[0.04] p-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/80">
          {previewContent}
        </pre>
      )}
    </div>
  )
}
