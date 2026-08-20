/**
 * ScrollPositionManager — 切换会话时保存/恢复滚动位置
 *
 * 解决 StickToBottom 的 spring 动画导致的可见滚动过程 + 强行滚底打断查历史。
 *
 * 原理：
 * - scroll 事件持续保存 distanceFromBottom 到模块级 Map（仅恢复后才开始记，防初始化污染）
 * - useLayoutEffect（绘制前）直接设 scrollTop，不走 scrollToBottom('instant')
 *   （后者内部 requestAnimationFrame，首帧会停在顶部，超过一页就闪）
 * - 有保存的中间位 → 等 restoreReady（虚拟化全挂完）再还原
 * - 无保存 / 本就在底部 → ready 即可钉底，不等全挂
 * - 虚拟化往前补页时按 scrollHeight 差值补偿 scrollTop，避免视口被顶上去
 *
 * 必须放在 <Conversation>（StickToBottom）内部使用。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  compensateScrollForHeightDelta,
  hasSavedMidPosition,
  shouldFollowContentGrowth,
  shouldPreserveBottomIntent,
  shouldRepinScrollerToBottom,
  targetScrollTop,
} from "./scroll-position";

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>();
const bottomIntentCache = new Set<string>();

/** 供 Chat 打开会话时判断是否需要为中间位恢复拉满历史挂载 */
export function peekSessionScrollDistance(id: string): number | undefined {
  return scrollPositionCache.get(id);
}

/** 新一轮发送后应从最新消息继续跟随，清除上一轮可能残留的中间位缓存。 */
export function markSessionAtBottom(id: string): void {
  scrollPositionCache.set(id, 0);
  bottomIntentCache.add(id);
}

export function ScrollPositionManager({
  id,
  ready,
  restoreReady = true,
  layoutKey = 0,
  onSettled,
}: {
  id: string;
  ready: boolean;
  /** 中间位恢复要等内容全挂完；钉底只等 ready */
  restoreReady?: boolean;
  /** 虚拟化可见条数变化时触发顶部补页补偿 */
  layoutKey?: number;
  /** 首次钉底/还原并再吃两帧布局后回调。供打开会话时等钉住再淡入，避免先露出顶部再跳底。 */
  onSettled?: () => void;
}): null {
  const { scrollRef, contentRef, stopScroll, scrollToBottom, state } =
    useStickToBottomContext();
  const restoredRef = useRef(false);
  const settledRef = useRef(false);
  const prevIdRef = useRef(id);
  const prevScrollHeightRef = useRef<number | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;

  // 持续保存滚动位置（仅在恢复完成后才注册，防止初始化/恢复前的自动滚动污染缓存）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !restoredRef.current) return;

    const savePosition = (): void => {
      // 收回历史窗口会产生临时 scroll 事件；在本轮贴底意图仍有效时，
      // 不把这次中间态写回缓存。用户主动上滚则立即解除意图并保存真实位置。
      if (state.escapedFromLock) {
        bottomIntentCache.delete(id);
      } else if (bottomIntentCache.has(id)) {
        scrollPositionCache.set(id, 0);
        return;
      }
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      scrollPositionCache.set(id, distanceFromBottom);
    };
    el.addEventListener("scroll", savePosition, { passive: true });
    return () => el.removeEventListener("scroll", savePosition);
  }, [scrollRef, id, ready, restoreReady, state]);

  // id 变化时重置恢复标记
  useEffect(() => {
    if (id !== prevIdRef.current) {
      const previousId = prevIdRef.current;
      prevIdRef.current = id;
      restoredRef.current = false;
      settledRef.current = false;
      prevScrollHeightRef.current = null;
      bottomIntentCache.delete(previousId);
    }
  }, [id]);

  const pinIfAtBottomIntent = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    // 顶部补历史期间只做 scrollHeight 差值补偿，禁止任何 observer 抢回底部。
    if (!restoreReady) return;
    if (state.escapedFromLock) return;
    if (hasSavedMidPosition(scrollPositionCache.get(id))) return;
    const top = targetScrollTop(el.scrollHeight, el.clientHeight);
    if (Math.abs(el.scrollTop - top) < 2) return;
    el.scrollTop = top;
  };

  const markPending = (): void => {
    scrollRef.current?.setAttribute("data-chat-scroll-pending", "");
  };

  const reveal = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    scrollRef.current?.removeAttribute("data-chat-scroll-pending");
    if (!hasSavedMidPosition(scrollPositionCache.get(id))) {
      void scrollToBottomRef.current("instant");
    }
    onSettledRef.current?.();
  };

  // ready 后恢复位置 — 绘制前同步写 scrollTop，避免首帧停在顶部
  useLayoutEffect(() => {
    if (!ready || restoredRef.current) return;

    const el = scrollRef.current;
    if (!el) {
      const failOpen = window.setTimeout(reveal, 120);
      return () => window.clearTimeout(failOpen);
    }

    const savedDistance = scrollPositionCache.get(id);
    if (hasSavedMidPosition(savedDistance) && !restoreReady) return;

    restoredRef.current = true;
    prevScrollHeightRef.current = el.scrollHeight;
    markPending();

    const top = targetScrollTop(
      el.scrollHeight,
      el.clientHeight,
      savedDistance,
    );
    if (hasSavedMidPosition(savedDistance)) {
      stopScroll();
      el.scrollTop = top;
      requestAnimationFrame(() => {
        el.scrollTop = targetScrollTop(
          el.scrollHeight,
          el.clientHeight,
          savedDistance,
        );
        reveal();
      });
    } else {
      el.scrollTop = top;
      // Dock 首帧 clientHeight 常为 0；藏着再钉两帧，避免先露出顶部。
      // 不把 rAF 绑在 effect cleanup：restoreReady 变化会重跑并因 restoredRef 直接 return。
      // scrollToBottom 只在揭开时调一次：RO / rAF 里反复调会 setIsAtBottom 打转。
      let frames = 0;
      const tick = (): void => {
        if (prevIdRef.current !== id) return;
        pinIfAtBottomIntent();
        frames += 1;
        if (frames < 3) {
          requestAnimationFrame(tick);
          return;
        }
        reveal();
      };
      requestAnimationFrame(tick);
    }
    // 无论 rAF 是否被掐，最多 120ms 必须揭开，避免再出现空白会话。
    const failOpen = window.setTimeout(reveal, 120);
    return () => window.clearTimeout(failOpen);
  }, [ready, restoreReady, id, scrollRef, stopScroll]);

  // 打开当帧：滚动容器自己从 0 高变成实际高度时内容 ResizeObserver 不响，必须盯 scroller。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !ready) return;
    const ro = new ResizeObserver(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      if (
        !shouldRepinScrollerToBottom({
          restored: restoredRef.current,
          settled: settledRef.current,
          hasMidPosition: hasSavedMidPosition(scrollPositionCache.get(id)),
          distanceFromBottom:
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        })
      ) {
        return;
      }
      pinIfAtBottomIntent();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, id, restoreReady, scrollRef]);

  // 旧会话打开后 Markdown / 高亮 / 补页把内容顶高：只写 scrollTop，不调 scrollToBottom。
  // 高亮会连发 RO：合并到每帧最多钉一次，避免同帧多次改 scrollTop 造成微抖。
  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || !ready) return;
    let lastHeight = content.scrollHeight;
    let wasNearBottom = !hasSavedMidPosition(scrollPositionCache.get(id));
    let pinRaf = 0;
    const onScroll = (): void => {
      const dist =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      wasNearBottom = dist <= 40;
    };
    const pinToBottom = (): void => {
      pinRaf = 0;
      const top = targetScrollTop(scroller.scrollHeight, scroller.clientHeight);
      // 流式内容增长和用户上滚可能发生在同一帧：ResizeObserver 已排了钉底 rAF
      // 后，用户才通过滚轮/拖拽离开底部。必须在真正写 scrollTop 前再读一次
      // StickToBottom 的同步逃离标记，否则这条旧 rAF 会把人强行拉回最新输出。
      if (state.escapedFromLock || !wasNearBottom) return;

      if (Math.abs(scroller.scrollTop - top) < 2) return;
      scroller.scrollTop = top;
      wasNearBottom = true;
    };
    const onResize = (): void => {
      if (!restoredRef.current) return;
      // restoreReady=false 表示正在往顶部挂载更早消息；这次增长不是新输出，
      // 视口锚点由下面的 layout effect 负责，不能进入贴底路径。
      if (!restoreReady) return;
      const nextHeight = content.scrollHeight;
      const grew = nextHeight > lastHeight + 1;
      lastHeight = nextHeight;
      // 发送时刚建立的贴底意图要覆盖旧的 wasNearBottom 快照；
      // 否则新一轮首个 delta 会被误判为中间位，内容就会被输入框盖住。
      const hasBottomIntent =
        bottomIntentCache.has(id) && !state.escapedFromLock;
      if (hasBottomIntent) wasNearBottom = true;
      if (
        !shouldFollowContentGrowth({
          hasMidPosition: hasSavedMidPosition(scrollPositionCache.get(id)),
          grew,
          wasNearBottom,
          escapedFromLock: state.escapedFromLock,
        })
      ) {
        return;
      }
      if (pinRaf !== 0) return;
      pinRaf = window.requestAnimationFrame(pinToBottom);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (pinRaf !== 0) window.cancelAnimationFrame(pinRaf);
    };
  }, [ready, id, restoreReady, scrollRef, contentRef, state]);

  // 虚拟化往前补页：内容从顶部长高，绘制前把 scrollTop 顺延，视口不跳
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !restoredRef.current || restoreReady) return;

    const height = el.scrollHeight;
    const prev = prevScrollHeightRef.current;
    if (prev == null) {
      prevScrollHeightRef.current = height;
      return;
    }
    el.scrollTop = compensateScrollForHeightDelta(el.scrollTop, prev, height);
    prevScrollHeightRef.current = height;
  }, [layoutKey, restoreReady, scrollRef]);

  return null;
}
