/**
 * 全局 kb_propose_save 确认队列同步
 *
 * 对齐 useExitPlanSync：本 hook 在 App 根挂载一次，
 * - KB_PROPOSE_SAVE_REQUEST → 入 per-session FIFO atom（不区分当前/后台会话）
 * - KB_PROPOSE_SAVE_RESOLVED → 按 requestId 出队（清所有会话中该 requestId）
 *
 * 切会话/切预览 Tab 不丢 pending（atom 全局存活）。
 */
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { allPendingKbProposeSaveRequestsAtom } from "../atoms/kb-propose-save-atoms";

export function useKbProposeSaveSync(): void {
  const setAllRequests = useSetAtom(allPendingKbProposeSaveRequestsAtom);

  useEffect(() => {
    const offRequest = window.electronAPI.onKbProposeSaveRequest((request) => {
      setAllRequests((prev) => {
        const map = new Map(prev);
        const cur = map.get(request.sessionId) ?? [];
        map.set(request.sessionId, [...cur, request]);
        return map;
      });
    });
    const offResolved = window.electronAPI.onKbProposeSaveResolved?.(
      ({ requestId }) => {
        // 协作父会话代答等场景：清理所有会话中的残留请求
        setAllRequests((prev) => {
          let changed = false;
          const map = new Map(prev);
          prev.forEach((requests, sid) => {
            const next = requests.filter((r) => r.requestId !== requestId);
            if (next.length !== requests.length) changed = true;
            if (next.length === 0) map.delete(sid);
            else map.set(sid, next);
          });
          return changed ? map : prev;
        });
      },
    );
    return () => {
      offRequest?.();
      offResolved?.();
    };
  }, [setAllRequests]);
}
