import {
  ArrowRight,
  ChatsCircle,
  FolderOpen,
} from '@phosphor-icons/react'

interface WelcomePageProps {
  onNewSession: () => void
  onOpenProject: () => void
}

export function WelcomePage({
  onNewSession,
  onOpenProject,
}: WelcomePageProps): JSX.Element {
  return (
    <div className="welcome-page">
      <section className="welcome-stage" aria-labelledby="welcome-title">
        <div className="welcome-copy">
          <p className="welcome-kicker">TAgent workspace</p>
          <h1 id="welcome-title">从一个清晰的目标开始。</h1>
          <p>
            创建会话，让 Agent 阅读项目、修改代码并完成验证。
            你的工作过程会保留在左侧，随时可以继续。
          </p>
        </div>

        <button
          type="button"
          className="welcome-start"
          onClick={() => onNewSession()}
        >
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
          <button
            type="button"
            className="welcome-project"
            onClick={onOpenProject}
          >
            <FolderOpen size={15} weight="regular" aria-hidden="true" />
            打开其他项目
          </button>
        </div>

        <div className="welcome-prompts" aria-label="任务示例">
          <span>可以从这里开始</span>
          <p>梳理项目结构　·　定位并修复问题　·　设计并实现新功能</p>
        </div>
      </section>
    </div>
  )
}
