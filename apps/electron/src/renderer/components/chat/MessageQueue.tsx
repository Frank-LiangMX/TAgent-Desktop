/**
 * MessageQueue — 运行中排队消息面板
 *
 * 放在底栏栈内、composer 上方（与 PermissionBanner 同级）。
 * 运行中发送的消息先显示在此面板，当前轮结束后自动逐条消费。
 * 每条可单独移除（× 按钮），或一键清空全部。
 */
import { motion, AnimatePresence } from 'motion/react'
import { X, ListNumbers } from '@phosphor-icons/react'

interface QueueItem {
  text: string
  selection: { channelId: string; modelId: string }
}

interface MessageQueueProps {
  queue: QueueItem[]
  onRemove: (index: number) => void
  onClear: () => void
}

export function MessageQueue({ queue, onRemove, onClear }: MessageQueueProps): JSX.Element {
  /** spring 高度稳定后再通知 Chat 重测胶囊/下箭头（避免压在队列卡片上） */
  const remeasureComposerTop = (): void => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }

  return (
    <AnimatePresence>
      {queue.length > 0 && (
        <motion.div
          key="message-queue"
          initial={{ opacity: 0, y: 12, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: 12, height: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          onAnimationComplete={remeasureComposerTop}
          className="pointer-events-auto overflow-hidden"
        >
          <div className="mx-3 mb-2 rounded-2xl border border-border/60 bg-background/80 shadow-lg backdrop-blur-xl">
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ListNumbers size={14} weight="regular" />
                <span>队列中 {queue.length} 条消息</span>
              </div>
              <button
                onClick={onClear}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                清空
              </button>
            </div>
            {/* 消息列表 */}
            <div className="max-h-32 overflow-y-auto px-3 pb-2 scrollbar-none">
              {queue.map((item, i) => (
                <div
                  key={`${item.text.slice(0, 20)}-${i}`}
                  className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-foreground/5"
                >
                  <span className="min-w-5 text-center font-mono text-muted-foreground/60">
                    {i + 1}.
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">
                    {item.text}
                  </span>
                  <button
                    onClick={() => onRemove(i)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
                    aria-label="移除"
                  >
                    <X size={12} weight="regular" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
