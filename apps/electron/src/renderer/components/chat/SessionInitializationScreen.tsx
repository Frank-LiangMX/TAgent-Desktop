import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import markDark from "../../assets/tagent-mark-dark.png";
import markLight from "../../assets/tagent-mark-light.png";
import "../../styles/session-initialization.css";

export type SessionInitializationStage =
  "checking" | "history" | "settings" | "error";

type StageItem = {
  id: Exclude<SessionInitializationStage, "error">;
  label: string;
};

const STAGES: StageItem[] = [
  { id: "checking", label: "检查会话状态" },
  { id: "history", label: "恢复对话记录" },
  { id: "settings", label: "准备会话配置" },
];

const STAGE_PROGRESS: Record<SessionInitializationStage, number> = {
  checking: 18,
  history: 52,
  settings: 78,
  error: 78,
};

function stageIndex(stage: SessionInitializationStage): number {
  return STAGES.findIndex((item) => item.id === stage);
}

export function SessionInitializationScreen({
  sessionTitle,
  stage,
  reducedMotion,
  onRetry,
  completed = false,
  onExited,
}: {
  sessionTitle: string;
  stage: SessionInitializationStage;
  reducedMotion: boolean;
  onRetry: () => void;
  completed?: boolean;
  onExited?: () => void;
}): JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (!completed) return;
    const timer = window.setTimeout(
      () => onExitedRef.current?.(),
      reducedMotion ? 0 : 520,
    );
    return () => window.clearTimeout(timer);
  }, [completed, reducedMotion]);

  useEffect(() => {
    if (stage === "error") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  const currentIndex = stageIndex(stage);
  const progress = completed ? 100 : STAGE_PROGRESS[stage];

  return createPortal(
    <main
      className="session-initialization"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-completed={completed ? "true" : "false"}
      aria-busy={!completed && stage !== "error"}
    >
      <div className="session-initialization__wash" aria-hidden="true" />
      <section className="session-initialization__panel" aria-live="polite">
        <div className="session-initialization__brand">
          <img
            className="session-initialization__mark session-initialization__mark--light"
            src={markLight}
            alt=""
          />
          <img
            className="session-initialization__mark session-initialization__mark--dark"
            src={markDark}
            alt=""
          />
          <span>TAgent</span>
        </div>

        {stage === "error" ? (
          <>
            <p className="session-initialization__eyebrow">SESSION PAUSED</p>
            <h1 className="session-initialization__title">会话暂时无法打开</h1>
            <p className="session-initialization__description">
              读取「{sessionTitle || "当前会话"}
              」时遇到问题。可以重试，已打开的其他会话不会受到影响。
            </p>
            <button
              className="session-initialization__retry"
              type="button"
              onClick={onRetry}
            >
              重试打开
            </button>
          </>
        ) : (
          <>
            <p className="session-initialization__eyebrow">
              INITIALIZING SESSION
            </p>
            <h1 className="session-initialization__title">正在准备会话</h1>
            <p className="session-initialization__description">
              {sessionTitle || "当前会话"} 即将就绪
            </p>

            <div className="session-initialization__progress-row">
              <div
                className="session-initialization__progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
                aria-label="会话初始化进度"
              >
                <span
                  className="session-initialization__progress-value"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="session-initialization__progress-number">
                {progress}%
              </span>
            </div>

            <div className="session-initialization__stages">
              {STAGES.map((item, index) => {
                const stageCompleted = completed || index < currentIndex;
                const active = !completed && item.id === stage;
                return (
                  <div
                    className="session-initialization__stage"
                    data-active={active ? "true" : "false"}
                    data-completed={stageCompleted ? "true" : "false"}
                    key={item.id}
                  >
                    <span
                      className="session-initialization__stage-icon"
                      aria-hidden="true"
                    >
                      {stageCompleted ? "✓" : active ? "" : "·"}
                    </span>
                    <span>{item.label}</span>
                    {active ? (
                      <span className="session-initialization__stage-state">
                        进行中
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <p className="session-initialization__footnote">
              {elapsedSeconds > 0
                ? `已等待 ${elapsedSeconds} 秒`
                : "首次打开可能需要一点时间"}
            </p>
          </>
        )}
      </section>
    </main>,
    document.body,
  );
}
