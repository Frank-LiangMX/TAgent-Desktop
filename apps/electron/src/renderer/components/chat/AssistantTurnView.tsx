/**
 * AssistantTurnView — 一轮助手主线（对齐 General 的 turn 分层）
 *
 * - 模型铭牌 ×1
 * - 过程区：运行中始终展开，直接看到思考/工具活动（不是只显示步数）
 * - 回答区：一段正文（与流式互斥）
 */
import {
  Message,
  MessageContent,
  MessageLoading,
  MessageResponse,
} from '@tagent/ui'
import { ProcessGroupView } from './ProcessGroupView'
import {
  buildTurnPresentation,
  type SessionRenderTurn,
} from './session-turn-model'
import { MessageView } from './MessageView'

interface AssistantTurnViewProps {
  turn: Extract<SessionRenderTurn, { kind: 'assistant-turn' }>
  /** 当前会话仍在跑且本 turn 是最新一轮（含工具间隙） */
  isLiveTurn?: boolean
}

export function AssistantTurnView({
  turn,
  isLiveTurn = false,
}: AssistantTurnViewProps): JSX.Element {
  const subagentItems = turn.items.filter(
    (it) => it.message?.type === 'assistant' && it.message.parentToolUseId,
  )
  const mainItems = turn.items.filter(
    (it) => !(it.message?.type === 'assistant' && it.message.parentToolUseId),
  )
  const presentation = buildTurnPresentation({ ...turn, items: mainItems })

  // 运行中：过程区按 live 处理（展开 + 实时思考/工具）
  const processLive = isLiveTurn || presentation.isStreaming

  const answerText =
    presentation.answerTexts[0] ??
    (presentation.isStreaming ? presentation.streamingText : undefined)

  const showAnswerShell =
    Boolean(answerText?.trim()) ||
    (processLive && presentation.process.length === 0 && !answerText)

  return (
    <div className="agent-turn flex flex-col gap-3">
      {presentation.modelId && (
        <div className="agent-turn-title">{presentation.modelId}</div>
      )}

      {presentation.process.length > 0 && (
        <div className="agent-turn-process">
          <ProcessGroupView process={presentation.process} isLive={processLive} />
        </div>
      )}

      {subagentItems.map((it) =>
        it.message ? (
          <div key={it.key}>
            <MessageView message={it.message} />
          </div>
        ) : null,
      )}

      {showAnswerShell && (
        <Message from="assistant">
          <MessageContent>
            {answerText?.trim() ? (
              <MessageResponse>{answerText}</MessageResponse>
            ) : processLive ? (
              <MessageLoading />
            ) : null}
          </MessageContent>
        </Message>
      )}
    </div>
  )
}
