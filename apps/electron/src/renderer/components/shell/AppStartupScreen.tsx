import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import "../../styles/app-startup.css";
import markDark from "../../assets/tagent-mark-dark.png";
import markLight from "../../assets/tagent-mark-light.png";

interface AppStartupScreenProps {
  ready: boolean;
  reducedMotion: boolean;
  onExited: () => void;
}

/** 应用级开屏：只在 renderer 启动阶段存在，不参与会话切换。 */
export function AppStartupScreen({
  ready,
  reducedMotion,
  onExited,
}: AppStartupScreenProps): JSX.Element {
  const mountedAtRef = useRef(Date.now());
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (!ready) return;
    const minimumDuration = reducedMotion ? 0 : 720;
    const elapsed = Date.now() - mountedAtRef.current;
    const timer = window.setTimeout(
      () => onExitedRef.current(),
      Math.max(0, minimumDuration - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, [ready, reducedMotion]);

  return createPortal(
    <main
      className="app-startup"
      data-ready={ready}
      data-reduced-motion={reducedMotion}
      aria-busy={!ready}
      aria-label="正在启动 TAgent"
    >
      <div className="app-startup__wash" aria-hidden="true" />
      <section className="app-startup__panel" aria-live="polite">
        <div className="app-startup__brand">
          <img
            className="app-startup__mark app-startup__mark--light"
            src={markLight}
            alt=""
            aria-hidden="true"
          />
          <img
            className="app-startup__mark app-startup__mark--dark"
            src={markDark}
            alt=""
            aria-hidden="true"
          />
          <span>TAgent</span>
        </div>
        <p className="app-startup__eyebrow">STARTING WORKSPACE</p>
        <h1 className="app-startup__title">正在启动 TAgent</h1>
        <p className="app-startup__description">准备工作区与会话环境</p>
        <div className="app-startup__progress-row">
          <div className="app-startup__progress-track" aria-hidden="true">
            <div className="app-startup__progress-value" data-ready={ready} />
          </div>
          <span className="app-startup__progress-number">
            {ready ? "100%" : "72%"}
          </span>
        </div>
        <p className="app-startup__status">
          <span className="app-startup__status-dot" aria-hidden="true" />
          {ready ? "准备完成" : "正在准备应用环境"}
        </p>
      </section>
    </main>,
    document.body,
  );
}
