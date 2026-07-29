/**
 * AssistantTurnView — 一轮助手主线
 *
 * 布局：
 * 1. 模型铭牌 ×1
 * 2. 过程区：运行中展开看思考/工具；结束后可折叠
 * 3. 一段回答：落盘与流式互斥
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
}

export function AssistantTurnView({ turn }: AssistantTurnViewProps): JSX.Element {
  const subagentItems = turn.items.filter(
    (it) => it.message?.type === 'assistant' && it.message.parentToolUseId,
  )
  const mainItems = turn.items.filter(
    (it) => !(it.message?.type === 'assistant' && it.message.parentToolUseId),
  )
  const presentation = buildTurnPresentation({ ...turn, items: mainItems })

  const answerText =
    presentation.answerTexts[0] ??
    (presentation.isStreaming ? presentation.streamingText : undefined)

  const showAnswerShell =
    Boolean(answerText?.trim()) ||
    (presentation.isStreaming &&
      presentation.process.length === 0 &&
      !answerText)

  return (
    <div className="agent-turn flex flex-col gap-3">
      {presentation.modelId && (
        <div className="agent-turn-title">{presentation.modelId}</div>
      )}

      {presentation.process.length > 0 && (
        <div className="agent-turn-process">
          <ProcessGroupView
            process={presentation.process}
            isStreaming={presentation.isStreaming}
          />
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
            ) : (
              <MessageLoading />
            )}
          </MessageContent>
        </Message>
      )}
    </div>
  )
}
