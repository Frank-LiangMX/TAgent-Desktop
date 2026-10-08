import type { TAgentMessage } from '@tagent/shared'

/** Only an unfinished snapshot from the failed request may be discarded. */
export function discardReconnectPartial<T extends { message?: TAgentMessage; streamUuid?: string }>(
  items: T[], uuid: string,
): T[] {
  return items.filter((item) => !(
    item.message?.type === 'assistant' &&
    !item.message.parentToolUseId &&
    item.message._partial === true &&
    (item.message.uuid === uuid || item.streamUuid === uuid)
  ))
}
