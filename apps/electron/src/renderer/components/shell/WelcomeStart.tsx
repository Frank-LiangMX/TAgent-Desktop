/**
 * 新会话页 welcome 形态的「新建会话」入口（无标签引导态的 composer 内容）。
 *
 * 复用 styles/welcome.css 的 .welcome-start 玻璃浮岛按钮——与 compose 形态的
 * .chat-input-glass 输入框同为玻璃浮岛，视觉上是「同一页的两种形态」。
 * 标题 / 提示词由 NewConversationLanding 提供，本组件只管行动入口。
 */
import { ArrowRight, ChatsCircle, FolderOpen } from '@phosphor-icons/react'

interface WelcomeStartProps {
  onNewSession: () => void
  onOpenProject: () => void
}

export function WelcomeStart({
  onNewSession,
  onOpenProject,
}: WelcomeStartProps): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" className="welcome-start" onClick={onNewSession}>
        <span className="welcome-start__icon" aria-hidden="true">
          <ChatsCircle size={20} weight="regular" />
        </span>
        <span className="welcome-start__copy">
          <strong>新建会话</strong>
          <small>开始描述你想完成的工作</small>
        </span>
        <ArrowRight
          size={18}
          weight="regular"
          className="welcome-start__arrow"
          aria-hidden="true"
        />
      </button>

      <div className="welcome-support">
        <button type="button" className="welcome-project" onClick={onOpenProject}>
          <FolderOpen size={15} weight="regular" aria-hidden="true" />
          打开其他项目
        </button>
      </div>
    </div>
  )
}
