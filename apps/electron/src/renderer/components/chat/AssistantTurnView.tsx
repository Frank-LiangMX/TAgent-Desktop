/**
 * AssistantTurnView — 一轮助手 turn 的干净主线
 *
 * - 模型铭牌只在顶部出现一次
 * - 工具 / 思考收进 ProcessGroupView
 * - 最终回答 + 流式输出在过程组外
 */
import {
  Message,
  MessageContent,
  MessageLoading,
  MessageResponse,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
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
  // 子代理消息仍走 MessageView 折叠（独立 item）
  const subagentItems = turn.items.filter(
    (it) => it.message?.type === 'assistant' && it.message.parentToolUseId,
  )
  const mainItems = turn.items.filter(
    (it) => !(it.message?.type === 'assistant' && it.message.parentToolUseId),
  )
  const presentation = buildTurnPresentation({ ...turn, items: mainItems })

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

      {/* 子代理卡片（如有） */}
      {subagentItems.map((it) =>
        it.message ? (
          <div key={it.key}>
            <MessageView message={it.message} />
          </div>
        ) : null,
      )}

      {(presentation.answerTexts.length > 0 ||
        presentation.isStreaming ||
        presentation.streamingText ||
        presentation.streamingThinking) && (
        <Message from="assistant">
          <MessageContent>
            {presentation.answerTexts.map((text, i) => (
              <MessageResponse key={`ans-${i}`}>{text}</MessageResponse>
            ))}

            {presentation.isStreaming && presentation.streamingThinking && (
              <Reasoning isStreaming defaultOpen>
                <ReasoningTrigger />
                <ReasoningContent>{presentation.streamingThinking}</ReasoningContent>
              </Reasoning>
            )}

            {presentation.isStreaming && presentation.streamingText && (
              <MessageResponse>{presentation.streamingText}</MessageResponse>
            )}

            {presentation.isStreaming &&
              !presentation.streamingText &&
              !presentation.streamingThinking &&
              presentation.process.length === 0 &&
              presentation.answerTexts.length === 0 && <MessageLoading />}
          </MessageContent>
        </Message>
      )}
    </div>
  )
}
