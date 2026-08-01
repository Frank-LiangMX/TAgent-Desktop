/**
 * 首页无项目时的引导页：引导用户打开第一个项目目录。
 *
 * 与 NewConversationLanding 同族（kicker → 标题 → 行动 → 特性卡错落入场），
 * 玻璃主卡复用 welcome.css 的浮岛语言，与欢迎页「新建会话」卡形成序列感。
 */
import { useState } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { motion } from 'motion/react'
import {
  ArrowRight,
  BrainCircuit,
  FolderGit2,
  FolderOpen,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Button, Input } from '@tagent/ui'
import { DEFAULT_USER_NAME } from '@tagent/shared'
import { userProfileAtom, saveUserProfileAtom } from '../../atoms/user-profile'
import BlurText from './BlurText'

/** 应用统一缓动 + 各元素入场基础时长（对齐 NewConversationLanding） */
const EASE = [0.16, 1, 0.3, 1] as const

const FEATURES = [
  { icon: FolderGit2, title: '项目即工作区', desc: '会话、文件与工具都绑定在这个目录内' },
  { icon: BrainCircuit, title: '记忆按项目隔离', desc: '上下文与记忆随项目独立组织' },
  { icon: ShieldCheck, title: '权限边界清晰', desc: '危险操作与目录外访问需确认' },
]

interface ProjectOnboardingProps {
  onOpenProject: () => void
}

export function ProjectOnboarding({ onOpenProject }: ProjectOnboardingProps): JSX.Element {
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const saveUserProfile = useSetAtom(saveUserProfileAtom)
  const [nameInput, setNameInput] = useState('')
  const [savedName, setSavedName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 新用户（未设置称呼）时展示称呼引导 */
  const isNewUser = userProfile.userName === DEFAULT_USER_NAME

  const handleSaveName = async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const updated = await saveUserProfile({ userName: trimmed })
      setUserProfile(updated)
      setSavedName(trimmed)
    } catch (error) {
      console.error('[引导页] 保存称呼失败:', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-4">
      <div className="w-full max-w-[680px]">
        <motion.p
          className="mb-6 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
          initial={{ opacity: 0, filter: 'blur(8px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.04 }}
        >
          TAgent workspace
        </motion.p>

        <div className="mb-4 text-center">
          <BlurText
            text="打开一个项目目录，开始你的工作。"
            className="justify-center text-xl font-semibold text-foreground/90"
            delay={90}
            direction="bottom"
            stepDuration={0.4}
          />
        </div>

        {/* 新用户称呼引导：您希望我怎么称呼您 */}
        {isNewUser && (
          <motion.div
            className="mx-auto mb-6 max-w-[440px] rounded-2xl border border-border/55 bg-muted/25 p-4"
            initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.22 }}
          >
            {savedName ? (
              <p className="flex items-center justify-center gap-1.5 text-center text-[13px] font-medium text-foreground/85">
                <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
                好的，{savedName}！开始工作吧
              </p>
            ) : (
              <>
                <p className="text-center text-[13px] font-medium text-foreground/85">
                  您希望我怎么称呼您？
                </p>
                <div className="mt-3 flex gap-2">
                  <Input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveName()
                    }}
                    placeholder="输入称呼，如：小唐"
                    autoFocus
                    className="h-9 flex-1"
                  />
                  <Button
                    size="sm"
                    className="h-9 shrink-0"
                    onClick={() => void handleSaveName()}
                    disabled={saving || !nameInput.trim()}
                  >
                    {saving ? '保存中…' : '好的'}
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        )}

        <motion.p
          className="mx-auto mb-8 max-w-[440px] text-center text-[13px] leading-relaxed text-muted-foreground"
          initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.45, ease: EASE, delay: 0.3 }}
        >
          选择一个本地代码目录作为工作区，Agent 将在其中阅读、修改并执行任务
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.4 }}
        >
          <button type="button" className="onboarding-open" onClick={onOpenProject}>
            <span className="onboarding-open__icon" aria-hidden="true">
              <FolderOpen className="size-5" />
            </span>
            <span className="onboarding-open__copy">
              <strong>打开项目目录</strong>
              <small>选择包含代码的本地文件夹即可开始</small>
            </span>
            <ArrowRight className="onboarding-open__arrow size-5" aria-hidden="true" />
          </button>
        </motion.div>

        <motion.div
          className="mt-7 grid grid-cols-1 gap-2.5 sm:grid-cols-3"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.07, delayChildren: 0.62 } },
          }}
        >
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <motion.div
              key={title}
              className="flex items-start gap-2.5 rounded-xl border border-border/55 bg-muted/25 px-3.5 py-3"
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
                className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground/85">{title}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                  {desc}
                </span>
              </span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  )
}
