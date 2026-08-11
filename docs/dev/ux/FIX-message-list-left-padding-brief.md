# Brief：消息区左侧加内边距避让 ScrollMinimap 刻度

> 日期：2026-08-11
> 执行：本地 `kscc / glm-5.2` 窄修

## 现象

消息列表左边太贴边：左侧叠着 ScrollMinimap 刻度/minimap 条，正文起点几乎压在刻度上；右侧边距反而显得更大。用户要求给消息区左侧稍微加边距（不是改正文字号），让左右视觉更均衡。

## 根因

- 消息列表容器 `ConversationContent`（`Chat.tsx:2415`）className 为 `session-conversation-pad px-4 pt-2 pb-44`。`px-4` = 左右各 16px（经 tailwind-merge 覆盖库组件默认 `px-8`）。`session-conversation-pad` 是空 hook class，全仓无 CSS 定义，不产生任何 padding。
- 内层 `.tagent-thread`（`chat.css:13-16`）`max-width:1037px + margin-inline:auto` 居中、自身无左右 padding，所以左右边距完全由外层 `px-4` 决定。
- `ScrollMinimap`（`packages/ui/.../scroll-minimap/index.tsx`）是 `absolute inset-0` 浮层：
  - 左侧 rail 常驻：`left-2.5`（10px）起、`w-7`（28px）宽；open 按钮 x 9~25px、base 刻度 x 12~22px、focus 刻度（hover）x 12~30px。
  - 右侧 thumb：`right-0`、宽 10px，滚动/悬停才显现，藏在 16px padding 内、不挤正文。
- 现状 `px-4` → 正文左 16px，被常驻 rail（到 25px）压住 → 贴边感；正文右 16px，thumb 不挤 → 右侧纯留白 16px 显得更大。

## 修复（最小改动）

`Chat.tsx:2415` 的对称 `px-4` 拆成非对称 `pl-7 pr-4`：

- `padding-left`：16px → 28px（+12px），正好越过常驻 rail 右沿（open btn 25px / base 刻度 22px），正文不再被刻度压；focus 刻度（hover 临时扩到 30px）仅 2px 临时重叠，无感。
- `padding-right`：16px → 16px（不变），右侧 thumb 仍在 padding 内不挤正文。
- tailwind-merge 会让 `pl-7 pr-4` 覆盖库组件默认 `px-8`，`pt-2 pb-44` 覆盖默认 `py-4`，行为与原 `px-4` 一致，仅左内边距增大。

宽窗（thread 居中）不受影响：`margin-inline:auto` 仍对称居中于内容区，thread 左右到窗口边距 = `pl+A` / `pr+A`，左比右大约 12px（A 为 auto 余量）。窄窗（thread 撑满）thread 左 28 / 右 16，左略大、避开 rail。

## 验收

1. 窄窗（thread 撑满）：正文左侧不再被刻度条压，左侧留白 28px、右侧 16px，左略大、接近右。
2. 宽窗（thread 居中）：正文左右到窗口边距接近，左比右大约 12px（避让 rail），无贴边感。
3. hover 刻度（focus 扩到 30px）不产生可见遮挡。
4. 右侧滚动 thumb 行为、`ConversationScrollButton`、minimap 面板位置不变。
5. `tsc --noEmit` 退 0；相关渲染/逻辑测试不回归。

## 不做

- 不改正文字号 / 行高 / 气泡宽度。
- 不动右侧 thumb 宽度与位置。
- 不动 ScrollMinimap rail 的 `left-2.5` / `w-7` / 刻度尺寸。
- 不动 `.tagent-thread` 的 `max-width` / 居中方式。
- 不给 `session-conversation-pad` 补 CSS（保持空 hook，避免引入未定义行为）。
