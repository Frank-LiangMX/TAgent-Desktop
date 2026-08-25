/**
 * 会话滚动位置：同步钉底 / 中间位恢复 / 顶部补页补偿。
 *
 * use-stick-to-bottom 的 scrollToBottom('instant') 会等 rAF，
 * 首帧仍停在 scrollTop=0，超过一页的会话会闪一下旧内容。
 */

/** 距底小于该值视为「在底部」，不按中间位恢复 */
export const MID_SCROLL_THRESHOLD_PX = 5;

/** 用户回到底部时重新建立跟随锁的几何容差。 */
export const FOLLOW_BOTTOM_THRESHOLD_PX = 12;

/** 流式软跟随允许的瞬时偏离，超过后才进行一次硬校正。 */
export const SOFT_FOLLOW_DRIFT_THRESHOLD_PX = 24;

export function shouldUseSoftFollow(args: {
  live: boolean;
  grew: boolean;
  shrunk: boolean;
  hasPendingIntent: boolean;
  followMode: ScrollFollowMode;
  distanceFromBottom: number;
}): boolean {
  return (
    args.live &&
    args.grew &&
    !args.shrunk &&
    !args.hasPendingIntent &&
    args.followMode === "following" &&
    args.distanceFromBottom <= SOFT_FOLLOW_DRIFT_THRESHOLD_PX
  );
}

export type ScrollFollowMode = "following" | "detached";
export type UserScrollIntent = "up" | "down";

/**
 * 会话输出的跟随状态只由用户意图改变：
 * - 用户向上滚动立即解除跟随；
 * - 用户向下滚动并回到底部重新跟随；
 * - 没有用户意图时，布局变化不能改变状态。
 */
export function resolveScrollFollowMode(args: {
  mode: ScrollFollowMode;
  userIntent?: UserScrollIntent;
  distanceFromBottom: number;
  threshold?: number;
}): ScrollFollowMode {
  if (args.userIntent === "up") return "detached";
  if (
    args.userIntent === "down" &&
    args.distanceFromBottom <= (args.threshold ?? FOLLOW_BOTTOM_THRESHOLD_PX)
  ) {
    return "following";
  }
  return args.mode;
}

export function hasSavedMidPosition(
  savedDistance: number | null | undefined,
): boolean {
  return savedDistance != null && savedDistance > MID_SCROLL_THRESHOLD_PX;
}

/** 新一轮发送时，只有原本贴底且用户没有主动上滚，才建立贴底意图。 */
export function shouldPreserveBottomIntent(args: {
  isAtBottom: boolean;
  escapedFromLock: boolean;
}): boolean {
  return args.isAtBottom && !args.escapedFromLock;
}

/** 绘制前应写入的 scrollTop：有中间位则还原，否则钉底 */
export function targetScrollTop(
  scrollHeight: number,
  clientHeight: number,
  savedDistance?: number | null,
): number {
  if (hasSavedMidPosition(savedDistance)) {
    return Math.max(0, scrollHeight - clientHeight - savedDistance!);
  }
  return Math.max(0, scrollHeight - clientHeight);
}

/**
 * 内容从顶部长高（虚拟化往前补旧消息）时，把 scrollTop 顺延同一差值，
 * 视口里看到的内容不变。
 */
export function compensateScrollForHeightDelta(
  scrollTop: number,
  prevHeight: number,
  nextHeight: number,
): number {
  const delta = nextHeight - prevHeight;
  if (delta <= 0) return scrollTop;
  return scrollTop + delta;
}

/**
 * 打开会话时 scroller 从 0 高长到实际高度，内容 ResizeObserver 不响，
 * 要靠盯 scroller 再钉一次。钉住之后绝不能再跟 RO：
 * scrollToBottom → setIsAtBottom 会让 StickToBottom 重渲，列宽/滚动条 1px
 * 抖动再触发 RO，就会 Maximum update depth exceeded。
 */
export function shouldRepinScrollerToBottom(args: {
  restored: boolean;
  settled: boolean;
  hasMidPosition: boolean;
  distanceFromBottom: number;
}): boolean {
  if (!args.restored || args.settled || args.hasMidPosition) return false;
  return args.distanceFromBottom > 2;
}

/** 打开旧会话后 Markdown / 补页把内容顶高：原先贴底则跟着钉，用户已上滑则不动 */
export function shouldFollowContentGrowth(args: {
  hasMidPosition: boolean;
  grew: boolean;
  wasNearBottom: boolean;
  /** 用户已主动上翻时，哪怕本帧还没来得及更新几何距离也不能抢回视口。 */
  escapedFromLock?: boolean;
  /** 新的显式跟随状态；传入后优先于第三方滚动库的 escaped 标记。 */
  followMode?: ScrollFollowMode;
}): boolean {
  if (args.followMode) return args.followMode === "following" && args.grew;
  if (args.hasMidPosition || !args.grew || args.escapedFromLock) return false;
  return args.wasNearBottom;
}
