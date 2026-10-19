import { useLayoutEffect, useRef } from "react";

/** Animate the existing DOM so navigation never remounts forms or discards drafts. */
export function useWorkbenchMotion(
  key: string,
  ready = true,
  selector?: string,
) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const target = selector
      ? root?.querySelector<HTMLElement>(selector)
      : root?.firstElementChild;
    if (!ready || !(target instanceof HTMLElement) || !target.animate) return;
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (preference?.matches) return;
    const style = getComputedStyle(root!);
    const rawDuration = style
      .getPropertyValue("--motion-duration-panel")
      .trim();
    const duration = rawDuration.endsWith("ms")
      ? parseFloat(rawDuration)
      : rawDuration.endsWith("s")
        ? parseFloat(rawDuration) * 1000
        : 320;
    const animation = target.animate(
      [
        { opacity: 0.65, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: Number.isFinite(duration) ? duration : 320,
        easing:
          style.getPropertyValue("--motion-ease-enter").trim() ||
          "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    );
    const cancel = () => animation.cancel();
    preference?.addEventListener?.("change", cancel);
    return () => {
      cancel();
      preference?.removeEventListener?.("change", cancel);
    };
  }, [key, ready, selector]);
  return ref;
}
