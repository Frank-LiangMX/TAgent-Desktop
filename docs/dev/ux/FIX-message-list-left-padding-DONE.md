# FIX：消息区左侧加内边距避让 ScrollMinimap 刻度 — DONE

> 日期：2026-08-11
> brief：`FIX-message-list-left-padding-brief.md`

## 结论

消息列表容器 `ConversationContent` 的左右内边距由对称 `px-4`（16/16）改为非对称 `pl-7 pr-4`（28/16）。左侧 +12px 正好越过 ScrollMinimap 常驻刻度右沿（open 按钮 25px / base 刻度 22px），正文不再被刻度压；右侧保持 16px，thumb 仍藏在 padding 内不挤正文。左右视觉由「左贴边、右显大」改善为「左略大、接近右」。未改正文字号、未动 rail/thumb 几何。

## 改动

| 文件 | 位置 | 前 | 后 | 说明 |
| --- | --- | --- | --- | --- |
| `apps/electron/src/renderer/components/chat/Chat.tsx` | `ConversationContent` className（行 2415） | `session-conversation-pad px-4 pt-2 pb-44` | `session-conversation-pad pl-7 pr-4 pt-2 pb-44` | 左内边距 16→28px，右 16px 不变；tailwind-merge 覆盖库组件默认 `px-8` |

数值（ConversationContent 计算后 padding）：

- `padding-left`：16px → **28px**（+12）
- `padding-right`：16px → **16px**（不变）
- `padding-top` / `padding-bottom`：`pt-2`=8px / `pb-44`=176px，不变

依据测距（相对 Conversation 左边，均 px）：

- 左 rail 常驻：open 按钮 9~25、base 刻度 12~22、focus 刻度（hover）12~30。
- 右 thumb：0~10，滚动/悬停显现，藏于 16px padding 内。
- 现 `pl-7`=28 > 常驻右沿 25 → 不压；focus 30 仅 2px 临时重叠。

## 验证

- `node ../../node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → EXIT=0（本机 bunx 双 fork，按惯例 node 直跑）。
- `node ../../node_modules/vitest/vitest.mjs run src/renderer/components/chat/turn-presentation.vitest.test.ts src/renderer/components/chat/thinking-fold-lazy-mount.test.tsx` → 2 files / 24 tests passed（无 Chat.tsx 渲染快照测试，无任何测试断言 `ConversationContent` padding 或 `session-conversation-pad`；所跑为最接近的渲染/逻辑测试，作整体健康检查）。
- 人工视觉验收待跑：窄窗 thread 撑满时正文左 28 / 右 16、刻度不再压正文；宽窗 thread 居中左右接近。
