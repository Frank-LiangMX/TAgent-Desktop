/** Stateful destinations survive loading; no timed event replay is needed. */
export interface KnowledgeNavigation {
  requestId: number;
  knowledgeBaseId?: string;
  documentId?: string;
}

export const KNOWLEDGE_LEAVE_EVENT = "tagent:before-leave-knowledge";

export function confirmKnowledgeLeave(): boolean {
  return window.dispatchEvent(
    new Event(KNOWLEDGE_LEAVE_EVENT, { cancelable: true }),
  );
}
