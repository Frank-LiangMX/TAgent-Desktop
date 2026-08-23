import { useEffect, useState } from "react";

export interface PersistedSessionMeta {
  id: string;
  title?: string;
  workspaceId?: string;
  channelId?: string;
  modelId?: string;
  botProfileIds?: string[];
  fusionRoomId?: string;
}

/**
 * Tab 只保存打开状态和少量展示字段；会话成员等配置必须从主进程持久化元数据恢复。
 */
export function usePersistedSessionMeta(
  sessionId: string | undefined,
): PersistedSessionMeta | null {
  const [meta, setMeta] = useState<PersistedSessionMeta | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const handleMetaChanged = (event: Event): void => {
      const changedSessionId = (
        event as CustomEvent<{ sessionId?: string }>
      ).detail?.sessionId;
      if (changedSessionId === sessionId) {
        setRevision((value) => value + 1);
      }
    };
    window.addEventListener("tagent:session-meta-changed", handleMetaChanged);
    return () =>
      window.removeEventListener(
        "tagent:session-meta-changed",
        handleMetaChanged,
      );
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    setMeta(null);
    if (!sessionId)
      return () => {
        disposed = true;
      };

    void window.electronAPI
      .listSessions()
      .then((items) => {
        if (disposed) return;
        const found = items.find((item) => {
          if (!item || typeof item !== "object") return false;
          return (item as { id?: unknown }).id === sessionId;
        });
        setMeta((found as PersistedSessionMeta | undefined) ?? null);
      })
      .catch(() => {
        if (!disposed) setMeta(null);
      });

    return () => {
      disposed = true;
    };
  }, [sessionId, revision]);

  return meta;
}