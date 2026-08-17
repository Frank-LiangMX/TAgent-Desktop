/**
 * MessageQueue — 运行中排队消息面板
 *
 * 放在底栏栈内、composer 上方。每条消息各自可：
 * - 默认：本场运行结束后按序发送（排队）
 * - 引导：不打断，夹进这次运行
 * - 编辑：移回输入框继续改
 * - 移除 / 面板清空
 */
import { motion, AnimatePresence } from 'motion/react'
import { X, ListNumbers, ArrowBendDownLeft, PencilSimple } from '@phosphor-icons/react'
import { AppTooltip } from '@tagent/ui'

export interface QueueItem {
  text: string
  selection: { channelId: string; modelId: string }
  moaOneShotPresetId?: string
  moaDiscussionPresetId?: string
}

interface MessageQueueProps {
  queue: QueueItem[]
  onRemove: (index: number) => void
  onClear: () => void
  /** 引导指定条目 */
  onSteer?: (index: number) => void
  /** 编辑：取出填回输入框 */
  onEdit?: (index: number) => void
  busy?: boolean
  running?: boolean
}

export function MessageQueue({
  queue,
  onRemove,
  onClear,
  onSteer,
  onEdit,
  busy = false,
  running = false,
}: MessageQueueProps): JSX.Element {
  const remeasureComposerTop = (): void => {
    window.dispatchEvent(new CustomEvent('tagent:composer-top-remeasure'))
  }

  return (
    <AnimatePresence
      onExitComplete={() => {
        remeasureComposerTop()
      }}
    >
      {queue.length > 0 && (
        <motion.div
          key="message-queue"
          initial={{ opacity: 0, y: 12, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: 8, height: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          onAnimationComplete={remeasureComposerTop}
          className="message-queue pointer-events-auto overflow-hidden"
        >
          <div className="message-queue-panel">
            <div className="message-queue-panel__head">
              <div className="message-queue-panel__title">
                <ListNumbers size={14} weight="regular" aria-hidden />
                <div className="message-queue-panel__title-copy">
                  <span>队列中 {queue.length} 条</span>
                  <span className="message-queue-panel__hint">
                    默认结束后按序发送，点引导可夹进这次运行
                  </span>
                </div>
              </div>
              <div className="message-queue-panel__actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onClear}
                  className="message-queue-panel__btn"
                >
                  清空
                </button>
              </div>
            </div>
            <div className="message-queue-panel__list scrollbar-thin">
              {queue.map((item, i) => (
                <div key={`${item.text.slice(0, 20)}-${i}`} className="message-queue-panel__row">
                  <span className="message-queue-panel__idx">{i + 1}.</span>
                  <span className="message-queue-panel__text" title={item.text}>
                    {item.text}
                  </span>
                  <div className="message-queue-panel__row-actions">
                    {onSteer && running ? (
                      <AppTooltip label="夹进这次运行：当前工具结束后就会带上，不用等整场结束" side="top">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onSteer(i)}
                          className="message-queue-panel__icon-btn message-queue-panel__steer-btn"
                          aria-label="引导此消息"
                        >
                          <ArrowBendDownLeft size={14} weight="regular" aria-hidden />
                          <span>引导</span>
                        </button>
                      </AppTooltip>
                    ) : null}
                    {onEdit ? (
                      <AppTooltip label="编辑此消息" side="top">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onEdit(i)}
                          className="message-queue-panel__icon-btn"
                          aria-label="编辑此消息"
                        >
                          <PencilSimple size={13} weight="regular" />
                        </button>
                      </AppTooltip>
                    ) : null}
                    <AppTooltip label="删除此消息" side="top">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRemove(i)}
                        className="message-queue-panel__icon-btn"
                        aria-label="删除此消息"
                      >
                        <X size={13} weight="regular" />
                      </button>
                    </AppTooltip>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
