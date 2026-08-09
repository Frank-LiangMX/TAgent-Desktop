/**
 * MoA 落盘 shape 纯函数（`AUDIT-fresh-session-consult-FINDINGS` · P0 #2）。
 *
 * 会诊汇总席的最终结论由 `run-moa-turn.persistAndPushFinalAssistant` 落盘为本轮主
 * assistant 回答。早期落盘 shape 缺 `message.role`，续聊 resume / IR 重建时角色信号不全
 * （AUDIT 证据：L2 `uuid=moa-agg-…` 但无 `message.role`）。本纯函数集中构造「对齐普通
 * assistant + 补 `message.role`」的 SDKMessage，便于单测断言 shape，也避免落盘处散落字段。
 *
 * 与普通 kscc assistant 对齐的必要字段：顶层 `type:'assistant'`、`message.content`、
 * `message.stop_reason:'end_turn'`（`sdkMessageToIR` 据此判 final 非 partial）、
 * `message.model`、`parent_tool_use_id:null`、`uuid`、`_channelModelId`、`createdAt`；
 * 并补 `message.role:'assistant'`（利于后续 resume / IR 识别角色——普通 SDK assistant 不带
 * 此字段，这里显式补上是会诊落盘的增强）。
 */
import type { SDKMessage } from './agent'

/**
 * 构造 MoA 汇总结论的落盘 SDKMessage（对齐普通 assistant + 补 `message.role`）。
 *
 * @param text 汇总席正文（本轮主回答）
 * @param aggregatorModelId 汇总模型 id（写入 `message.model` + `_channelModelId`，匹配显示名）
 * @param uuid 落盘唯一标识（`moa-agg-<roundtableId>`，渲染层 / resume 据此定位）
 * @param nowMs 落盘时间戳（`Date.now()`）
 */
export function buildMoAFinalAssistantSDKMessage(
  text: string,
  aggregatorModelId: string,
  uuid: string,
  nowMs: number,
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: aggregatorModelId,
    },
    parent_tool_use_id: null,
    uuid,
    createdAt: nowMs,
    _channelModelId: aggregatorModelId,
  } as unknown as SDKMessage
}
