/**
 * 新会话页 / 欢迎页共用的居中落地壳。
 *
 * 「页面元素自己单独的动画」式入场（对齐 react-bits 风格），非整页位移：
 * kicker → 标题(BlurText 逐词模糊渐现) → composer(上滑+淡入) → 提示词(错落淡入)
 * 各元素按 delay 错开，页面像被「逐件搭起来」。欢迎形态与 compose 形态共用，
 * 故两页切换时新页元素各自重新入场。
 *
 * 纯展示型：composer（输入框或欢迎按钮）由外层传入，状态留在 Chat / App。
 */
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Sparkles } from 'lucide-react'
import BlurText from './BlurText'

/** 默认提示词（welcome / compose 两种形态共用） */
const DEFAULT_SUGGESTIONS = ['梳理项目结构', '定位并修复问题', '设计并实现新功能']

/** 应用统一缓动 + 各元素入场基础时长 */
const EASE = [0.16, 1, 0.3, 1] as const

interface NewConversationLandingProps {
  /** Chat 构建好的 <ChatInput footer=…/>（含模型选择器 + 发送钮），或欢迎形态的 <WelcomeStart> */
  composer: ReactNode
  /** 输入框下方的工作区选择容器（仅 compose 形态传入；welcome 形态不传） */
  workspaceSlot?: ReactNode
  /** 可点击提示词；不传用默认 */
  suggestions?: string[]
  /** 点击提示词：welcome 形态 = 进入 compose；compose 形态 = 填入输入框 */
  onPickSuggestion: (text: string) => void
  /** 返回欢迎页（仅新会话页 compose 形态传入；welcome 形态不传 → 无返回钮） */
  onBack?: () => void
}

export function NewConversationLanding({
  composer,
  workspaceSlot,
  suggestions = DEFAULT_SUGGESTIONS,
  onPickSuggestion,
  onBack,
}: NewConversationLandingProps): JSX.Element {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-4">
      {onBack && (
        <motion.button
          type="button"
          className="absolute left-4 top-4 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={onBack}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3, ease: EASE, delay: 0.05 }}
        >
          <ArrowLeft className="size-3.5" />
          返回
        </motion.button>
      )}

      <div className="w-full max-w-[760px]">
        <motion.p
          className="mb-6 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
          initial={{ opacity: 0, filter: 'blur(8px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.04 }}
        >
          TAgent workspace
        </motion.p>

        <div className="mb-6 text-center">
          <BlurText
            text="从一个清晰的目标开始。"
            className="justify-center text-xl font-semibold text-foreground/90"
            delay={90}
            direction="bottom"
            stepDuration={0.4}
          />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.28 }}
        >
          {composer}
        </motion.div>

        {/* 工作区选择：输入框下方独立容器（仅 compose 形态） */}
        {workspaceSlot && (
          <motion.div
            className="mt-3"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE, delay: 0.4 }}
          >
            {workspaceSlot}
          </motion.div>
        )}

        {suggestions.length > 0 && (
          <motion.div
            className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-3"
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: { transition: { staggerChildren: 0.07, delayChildren: 0.52 } },
            }}
          >
            {suggestions.map((s) => (
              <motion.button
                key={s}
                type="button"
                className={
                  'group flex items-center gap-2.5 rounded-xl border border-border/55 bg-muted/25 ' +
                  'px-3.5 py-3 text-left text-xs text-muted-foreground transition-all ' +
                  'hover:border-border hover:bg-accent hover:text-foreground hover:shadow-sm'
                }
                onClick={() => onPickSuggestion(s)}
                variants={{
                  hidden: { opacity: 0, y: 12, filter: 'blur(4px)' },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: { duration: 0.42, ease: EASE },
                  },
                }}
              >
                <span
                  className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15"
                  aria-hidden="true"
                >
                  <Sparkles className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 leading-relaxed">{s}</span>
              </motion.button>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  )
}
