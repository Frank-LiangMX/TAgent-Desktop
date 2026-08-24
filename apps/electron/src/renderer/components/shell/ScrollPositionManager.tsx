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
  pickViewportAnchor,
  pinScrollerToBottom,
  restoreViewportAnchor,
  type ViewportAnchor,
} from "./scroll-anchor";
import {
  compensateScrollForHeightDelta,
  hasSavedMidPosition,
  shouldFollowContentGrowth,
  shouldRepinScrollerToBottom,
  targetScrollTop,
} from "./scroll-position";

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>();
/** 已发送但首个主线 assistant 内容尚未到达：只记录意图，不允许收缩/增长 observer 立刻钉旧底部。 */
const pendingBottomIntentCache = new Set<string>();
const bottomIntentCache = new Set<string>();

/** 供 Chat 打开会话时判断是否需要为中间位恢复拉满历史挂载 */
export function peekSessionScrollDistance(id: string): number | undefined {
  return scrollPositionCache.get(id);
}

/** 新一轮发送后只记录“稍后跟随最新内容”的意图，等待首个主线 assistant 内容到达。 */
export function markSessionAtBottom(id: string): void {
  pendingBottomIntentCache.add(id);
  // An explicit send supersedes a stale mid-scroll snapshot. The pending
  // intent still waits for the new message DOM before writing scrollTop.
  scrollPositionCache.set(id, 0);
  bottomIntentCache.delete(id);
}

/** 首个主线 assistant 内容已到达：此时才把本轮视为贴底并覆盖旧的中间位缓存。 */
export function activateSessionAtBottom(id: string): void {
  if (!pendingBottomIntentCache.has(id)) return;
  pendingBottomIntentCache.delete(id);
  scrollPositionCache.set(id, 0);
  bottomIntentCache.add(id);
}

export function ScrollPositionManager({
  id,
  ready,
  restoreReady = true,
  layoutKey = 0,
  live = false,
  onSettled,
}: {
  id: string;
  ready: boolean;
  /** 中间位恢复要等内容全挂完；钉底只等 ready */
  restoreReady?: boolean;
  /** 虚拟化可见条数变化时触发顶部补页补偿 */
  layoutKey?: number;
  /** 流式期间由本组件独占主滚动跟随，避免与外层 smooth resize 抢控制。 */
  live?: boolean;
  /** 首次钉底/还原并再吃两帧布局后回调。供打开会话时等钉住再淡入，避免先露出顶部再跳底。 */
  onSettled?: () => void;
}): null {
  const { scrollRef, contentRef, stopScroll, scrollToBottom, state } =
    useStickToBottomContext();
  const restoredRef = useRef(false);
  const settledRef = useRef(false);
  const prevIdRef = useRef(id);
  const prevScrollHeightRef = useRef<number | null>(null);
  const viewportAnchorRef = useRef<ViewportAnchor | null>(null);
  const wasLiveRef = useRef(live);
  const escapedRef = useRef(state.escapedFromLock);
  escapedRef.current = state.escapedFromLock;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;

  // 主滚动协调器唯一的钉底出口：清掉 StickToBottom spring 后再写 floor。
  // 注意：不能调用 stopScroll()，它的语义是用户主动脱离跟随，会把
  // escapedFromLock 设为 true，导致后续流式增长永远不再贴底。
  const pinToBottomRef = useRef((): void => {});
  pinToBottomRef.current = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    if (state) {
      state.animation = undefined;
      state.velocity = 0;
      state.accumulated = 0;
    }
    // 流式期间只直接写入滚动位置，不调用第三方 scrollToBottom：后者会
    // 每帧 setIsAtBottom，触发 React 重渲染，造成逐字输出时的顿挫。
    pinScrollerToBottom(el);
    el.setAttribute("data-chat-scroll-owner", "coordinator");
  };

  // use-stick-to-bottom 自带的 content ResizeObserver 也会在高度变化时调用
  // scrollToBottom。它与本协调器同时存在会形成第二个自动滚动控制者；挂载后断开，
  // 用户滚轮/按钮仍可使用第三方 API，但自动布局只由本组件处理。
  useLayoutEffect(() => {
    state.resizeObserver?.disconnect();
  }, [ready, state]);

  const rememberViewportAnchor = (): void => {
    const el = scrollRef.current;
    if (!el || !escapedRef.current) {
      viewportAnchorRef.current = null;
      return;
    }
    const anchor = pickViewportAnchor(el);
    if (anchor) viewportAnchorRef.current = anchor;
  };

  // 持续保存滚动位置（仅在恢复完成后才注册，防止初始化/恢复前的自动滚动污染缓存）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !restoredRef.current) return;

    const savePosition = (): void => {
      // 收回历史窗口会产生临时 scroll 事件；在本轮贴底意图仍有效时，
      // 不把这次中间态写回缓存。用户主动上滚则立即解除意图并保存真实位置。
      const hasPendingIntent = pendingBottomIntentCache.has(id);
      if (state.escapedFromLock && !hasPendingIntent) {
        pendingBottomIntentCache.delete(id);
        bottomIntentCache.delete(id);
      } else if (hasPendingIntent) {
        // 发送后收回虚拟化窗口会让 scrollTop 被浏览器向上夹回，
        // use-stick-to-bottom 会把这次内部布局滚动误判为用户上滑。
        // 真实的向上滚轮/键盘操作会在下面的输入监听中取消意图。
        return;
      } else if (bottomIntentCache.has(id)) {
        scrollPositionCache.set(id, 0);
        return;
      }
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      scrollPositionCache.set(id, distanceFromBottom);
    };
    el.addEventListener("scroll", savePosition, { passive: true });
    const cancelOnUserInput = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        pendingBottomIntentCache.delete(id);
        bottomIntentCache.delete(id);
      }
    };
    const cancelOnKeyboard = (event: KeyboardEvent): void => {
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home"
      ) {
        pendingBottomIntentCache.delete(id);
        bottomIntentCache.delete(id);
      }
    };
    el.addEventListener("wheel", cancelOnUserInput, { passive: true });
    el.addEventListener("keydown", cancelOnKeyboard);
    return () => {
      el.removeEventListener("scroll", savePosition);
      el.removeEventListener("wheel", cancelOnUserInput);
      el.removeEventListener("keydown", cancelOnKeyboard);
    };
  }, [scrollRef, id, ready, restoreReady, state]);

  // id 变化时重置恢复标记
  useEffect(() => {
    if (id !== prevIdRef.current) {
      const previousId = prevIdRef.current;
      prevIdRef.current = id;
      restoredRef.current = false;
      settledRef.current = false;
      prevScrollHeightRef.current = null;
      pendingBottomIntentCache.delete(previousId);
      bottomIntentCache.delete(previousId);
    }
  }, [id]);

  const pinIfAtBottomIntent = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const hasBottomIntent =
      pendingBottomIntentCache.has(id) || bottomIntentCache.has(id);
    // 顶部补历史期间只做 scrollHeight 差值补偿，禁止任何 observer 抢回底部。
    if (!restoreReady) return;
    // An explicit send overrides stale lock and mid-position state until the
    // user scrolls upward and the input handlers cancel the pending intent.
    if (state.escapedFromLock && !hasBottomIntent) return;
    if (!hasBottomIntent && hasSavedMidPosition(scrollPositionCache.get(id))) {
      return;
    }
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
  // 流式结束时只由协调器收口：阅读中恢复锚点，贴底中瞬时钉底。
  useLayoutEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;
    if (!wasLive || live) return;
    const el = scrollRef.current;
    if (!el) return;
    if (escapedRef.current) {
      stopScroll();
      restoreViewportAnchor(el, viewportAnchorRef.current);
      el.setAttribute("data-chat-scroll-owner", "coordinator");
      return;
    }
    pinToBottomRef.current();
  }, [live, scrollRef, stopScroll]);

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
      rememberViewportAnchor();
    };
    const pinToBottom = (): void => {
      pinRaf = 0;
      const top = targetScrollTop(scroller.scrollHeight, scroller.clientHeight);
      const hasBottomIntent =
        pendingBottomIntentCache.has(id) || bottomIntentCache.has(id);
      // 流式内容增长和用户上滚可能发生在同一帧：ResizeObserver 已排了钉底 rAF
      // 后，用户才通过滚轮/拖拽离开底部。必须在真正写 scrollTop 前再读一次
      // StickToBottom 的同步逃离标记，否则这条旧 rAF 会把人强行拉回最新输出。
      if (state.escapedFromLock && !hasBottomIntent) return;
      if (!wasNearBottom && !hasBottomIntent) return;

      if (Math.abs(scroller.scrollTop - top) < 2) return;
      // 直接写 scrollTop 不会清除 use-stick-to-bottom 的 escapedFromLock。
      // 只在本轮发送意图仍有效且仍被旧 lock 挡住时调用一次 instant，后续流式
      // 增长继续走低开销的 pinToBottomRef，避免逐字输出触发 React 重渲染。
      if (hasBottomIntent && state.escapedFromLock) {
        void scrollToBottomRef.current("instant");
      }
      pinToBottomRef.current();
      wasNearBottom = true;
    };
    const onResize = (): void => {
      if (!restoredRef.current) return;
      // restoreReady=false 表示正在往顶部挂载更早消息；这次增长不是新输出，
      // 视口锚点由下面的 layout effect 负责，不能进入贴底路径。
      if (!restoreReady) return;
      const nextHeight = content.scrollHeight;
      const shrunk = nextHeight < lastHeight - 1;
      const grew = nextHeight > lastHeight + 1;
      lastHeight = nextHeight;

      // 流式结束、过程折叠和虚拟化收缩统一走同一个协调器。
      if (shrunk) {
        // 发送后收回虚拟化窗口只是旧内容收缩；首个 assistant 内容还没到达前，
        // 不要把这个旧 DOM 的底部当成本轮底部。
        if (pendingBottomIntentCache.has(id)) {
          // 保留自然布局结果，等首个主线 assistant 内容到达后再统一钉底。
        } else if (escapedRef.current) {
          stopScroll();
          restoreViewportAnchor(scroller, viewportAnchorRef.current);
        } else {
          pinToBottomRef.current();
        }
      }
      // 发送时刚建立的贴底意图要覆盖旧的 wasNearBottom 快照；
      // 否则新一轮首个 delta 会被误判为中间位，内容就会被输入框盖住。
      const hasBottomIntent =
        pendingBottomIntentCache.has(id) || bottomIntentCache.has(id);
      if (hasBottomIntent) {
        wasNearBottom = true;
      }
      if (
        !shouldFollowContentGrowth({
          hasMidPosition: hasSavedMidPosition(scrollPositionCache.get(id)),
          grew,
          wasNearBottom,
          // A pending send is an explicit follow-bottom override. Once the
          // intent is activated, escapedFromLock protects a user's upward scroll.
          escapedFromLock: state.escapedFromLock && !hasBottomIntent,
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
  }, [ready, id, restoreReady, scrollRef, contentRef, state, stopScroll]);

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
