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
  useSmoothStream,
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

  // 过程区 live 判定只用会话级 isLiveTurn（来自 Chat 的 running），不用 presentation.isStreaming：
  // 后者在 answerText 落盘即翻 false，且 pi 多轮工具每轮 turn_end 都落盘 → 轮间反复折叠/展开、
  // 思考没输完就被收起。会话级 running 轮间不抖，过程区全程展开直到会话整体结束。
  const processLive = isLiveTurn

  // 回答区用 useSmoothStream 逐字挤出。打字机是否开启跟会话级 isLiveTurn（running）：
  // 流式期 content=streamingText（增长）；turn_end 落盘后 content 切 answerText（同源前缀），
  // useSmoothStream 同实例 isAppend 逐字追完，落盘不重挂、不跳变、不重复。
  // 用 isLiveTurn 而非 presentation.isStreaming：后者落盘即翻 false，会触发 hook 非流式安全网
  // 把 answerText 瞬间全显（回到「一下子全出来」），且多轮工具轮间反复抖。
  // 历史轮次（非 live）isStreaming=false → hook 安全网直接全显示，无逐字动画。
  const answerFull = presentation.answerTexts[0]
  const content = answerFull ?? presentation.streamingText ?? ''
  const needsTypewriter = isLiveTurn || presentation.isStreaming || Boolean(presentation.streamingText)
  const { displayedContent } = useSmoothStream({ content, isStreaming: needsTypewriter })

  const showAnswerShell =
    Boolean(content.trim()) ||
    (processLive && presentation.process.length === 0 && !content)

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
            {displayedContent.trim() ? (
              <MessageResponse>{displayedContent}</MessageResponse>
            ) : processLive ? (
              <MessageLoading />
            ) : null}
          </MessageContent>
        </Message>
      )}
    </div>
  )
}
