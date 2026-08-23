/**
 * 协作室「待确认续跑」列表（P2-1）。
 *
 * 纯展示组件：渲染 `listLocalCollaborationContinuations` 派生的可观察项，供
 * `CollaborationRoomsPage` 在时间线上方挂载。把渲染逻辑从页面抽出，便于最小渲染测。
 *
 * - blocked_run：出「确认继续」按钮 → onConfirmResume(runId)（页面调 confirm-resume-blocked IPC，
 *   主进程新建 turn，新 runId/fence，不复活旧 fence）；
 * - pending_approval / depth_stop：只读提示，下钻到时间线既有审批 / 深度停止卡片；
 * - awaiting_peer / awaiting_user / mailbox_outbox：纯观察态。
 *
 * 与远程 FusionRoomRemotePage 的续跑块共用同一份 label map（@tagent/shared），避免文案漂移。
 */
import type {
  LocalCollaborationContinuationItem,
  LocalCollaborationContinuationKind,
} from "@tagent/shared";
import { localCollaborationContinuationKindLabel } from "@tagent/shared";

/**
 * 非 blocked_run 的可观察 continuation → 只读提示文案。
 * blocked_run 由「确认继续」按钮直接处理；pending_approval / depth_stop 的实际操作在时间线
 * 既有卡片，故仅提示下钻；其余为纯观察态。
 */
export function continuationReadonlyHint(
  kind: LocalCollaborationContinuationKind,
): string {
  switch (kind) {
    case "pending_approval":
      return "请使用下方审批卡片处理";
    case "depth_stop":
      return "请使用下方深度停止卡片继续";
    case "awaiting_user":
      return "等待用户审批（见下方审批卡片）";
    case "awaiting_peer":
      return "等待成员回复";
    case "mailbox_outbox":
      return "未投递消息（重启已尝试安全重投）";
    default:
      return "";
  }
}

export interface CollaborationContinuationListProps {
  continuations: LocalCollaborationContinuationItem[];
  /** 正在确认继续的 blocked run id（loading 态） */
  resumingRunId: string | null;
  /** 按 run id 记录的确认继续失败原因（error 态） */
  resumeErrorByRun: Record<string, string>;
  /** 确认继续一个 blocked run（页面调 confirm-resume-blocked IPC） */
  onConfirmResume: (runId: string) => void;
}

export function CollaborationContinuationList({
  continuations,
  resumingRunId,
  resumeErrorByRun,
  onConfirmResume,
}: CollaborationContinuationListProps): JSX.Element | null {
  if (continuations.length === 0) return null;
  return (
    <div className="collab-continuations shrink-0 border-b border-border/60 bg-amber-500/5 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
        <span className="inline-block size-1.5 rounded-full bg-amber-500" />
        待确认续跑 · {continuations.length}
      </div>
      <ul className="flex flex-col gap-1">
        {continuations.map((item) => {
          const itemId =
            item.refs?.runId ?? item.refs?.envelopeId ?? item.id;
          const tail = itemId.slice(-8);
          const hint = continuationReadonlyHint(item.kind);
          const isBlocked = item.kind === "blocked_run";
          const runId = item.refs?.runId ?? item.id;
          const error = isBlocked ? resumeErrorByRun[runId] : undefined;
          const busy = isBlocked && resumingRunId === runId;
          return (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-background/60 px-2 py-1 text-[11px]"
            >
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                {localCollaborationContinuationKindLabel[item.kind]}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={item.summary}
              >
                {item.summary}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                #{tail}
              </span>
              {isBlocked ? (
                <button
                  type="button"
                  data-run-id={runId}
                  className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  onClick={() => onConfirmResume(runId)}
                  disabled={busy}
                >
                  {busy ? "确认中…" : "确认继续"}
                </button>
              ) : hint ? (
                <span className="text-muted-foreground" data-hint={item.kind}>
                  {hint}
                </span>
              ) : null}
              {error ? (
                <span
                  className="w-full text-[10px] text-destructive"
                  title={error}
                >
                  {error}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
