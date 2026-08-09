# Findings · 外观页加载动画图鉴（扫全仓放进预览）

> 对应 brief：`docs/dev/ux/LOADER-GALLERY-APPEARANCE-brief.md`
> 现状（改动前）：外观 →「加载动画」仅预览 **有机形变**（`LoaderPreview`）+ **三瓣螺旋**（`ThreePetalSpiral`）两格。
> 本轮：扫全仓正式加载动画组件，全部挂进该预览区，做成图鉴网格（含补漏的运行胶囊，共 7 格）。

---

## 一、本轮改动（文件级）

| 文件 | 改动 |
|---|---|
| `apps/electron/src/renderer/components/settings/SettingsPage.tsx` | `AppearanceSettings` 加载动画区由 2 格改为 6 格图鉴网格；新增 `Spinner / LoadingIndicator / MessageLoading / AddonLoader` 引入与挂载；更新该行描述文案 |
| `apps/electron/src/renderer/styles/loader-preview.css` | `.tagent-loader-preview-stage` 由 flex 改 grid；新增 `.tagent-loader-preview-frame`（统一预览画框）、`.tagent-loader-preview-usage`（用途行）；新增 `[data-disabled]` 下对点阵网格 / 弹跳点 / 附加光环的统一暂停规则 |
| `packages/ui/styles/spinner.css` | **新增**：`Spinner` 组件的 SpinKit Grid 样式（仓库原本缺失，见 §六） |
| `apps/electron/src/renderer/styles/globals.css` | 新增 `@import '@tagent/ui/styles/spinner.css'` 与 `@import '@tagent/ui/styles/addon-loader.css'` |

**未做**：未改 Chat 真实加载绑定（`Chat.tsx` / `AssistantTurnView.tsx` 仍用 `MessageLoading`，原样未动）；未改任何 ui 组件 API；未从零 invent 新动画（`spinner.css` 是补齐既有组件已声明的 SpinKit Grid）；**未 commit**。

---

## 二、纳入图鉴（6 个正式组件）

每格 = 预览画框（92px 统一基线）+ 中文名 + 一行用途。

| # | 组件 | 中文名 | 路径 | 预览入参 | 暂停方式（开关关） | 用途标签 |
|---|---|---|---|---|---|---|
| 1 | `LoaderPreview` | 有机形变 | `apps/electron/src/renderer/components/settings/SettingsPage.tsx`（本地组件，样式 `loader-preview.css`） | `disabled={!loaderEnabled}` | 组件 `data-disabled` → CSS `animation-play-state: paused`（既有） | 外观页 · 默认 |
| 2 | `ThreePetalSpiral` | 三瓣螺旋 | `packages/ui/src/components/three-petal-spiral.tsx` | `size={40} active={loaderEnabled}` | `active=false` → 只渲染静态首帧、不启动 rAF（既有） | 轻量 · 默认 |
| 3 | `Spinner` | 点阵网格 | `packages/ui/src/components/spinner.tsx` | `size="default"` | 图鉴 `[data-disabled] .spinner .spinner-cube` → `paused`（新增） | 通用等待 · 默认 |
| 4 | `LoadingIndicator` | 带标签指示器 | `packages/ui/src/components/loading-indicator.tsx` | `label="思考中"`（`animated` 默认 true，未开 `showElapsed`） | 内嵌 `Spinner`，同上 CSS 暂停 | 可附计时 · 默认 |
| 5 | `MessageLoading` | 消息弹跳点 | `packages/ui/src/components/message/index.tsx` | 无参 | 图鉴 `[data-disabled] .animate-bounce` → `paused`（新增） | 消息中 · 占位 |
| 6 | `AddonLoader` | 附加光环 | `packages/ui/src/components/addon-loader/index.tsx` | `size={80} fontSize="1em"`（缩小，避免撑破布局） | 图鉴 `[data-disabled] .ui-addon-loader__ring/__letter` → `paused`（新增） | 重操作 · 附加 |
| 7 | `ComposerRunTimer` | 运行胶囊 | `apps/electron/.../chat/ComposerRunTimer.tsx` | 图鉴固定 `startedAt`（约 12s 前）实时走字；frame 内 `position:static` | `[data-disabled]` 暂停 `__orb` / `__char` | 会话 · 输入框上方计时 |

> **补漏（2026-08-09）**：首轮扫描把「运行中胶囊」误归为聊天浮层未纳入；用户指出后补进图鉴第 7 格。

> `LoadingIndicator` 与 `Spinner` 共用 SpinKit Grid 内核（前者 = 后者 + 标签 + 可选计时）。二者均为 brief 候选清单中独立列出的正式组件，故均纳入；视觉差异为「是否带 思考中 标签」。本轮预览未开 `showElapsed`，避免设置面板内出现永久计时的 interval（计时能力在用途行注明「可附计时」）。

---

## 三、跳过清单（不纳入图鉴，及原因）

### 1. 临时等待图标（`Loader2` / `CircleNotch` / `RefreshCw` + `animate-spin`）
brief 明确排除「随处 `Loader2` / `CircleNotch` + `animate-spin` 的临时等待图标」。全仓命中 13 处，均为内联图标、非可复用加载组件：

- `components/updater/UpdateBanner.tsx`、`components/settings/UpdateChecker.tsx`（`Loader2 .upd-spin`）
- `components/chat/ConciseTimelineView.tsx`、`components/chat/ProcessGroupView.tsx`（`CircleNotch animate-spin`）
- `components/memory/StageQueueCard.tsx`、`components/memory/MemoryMonitorPanel.tsx`（多处 `Loader2 animate-spin`）
- `components/roles/RolesPage.tsx`（`CircleNotch animate-spin`）
- `components/settings/PluginStoreSettings.tsx`、`components/settings/ChannelsSettings.tsx`、`components/settings/McpSettings.tsx`、`components/settings/AgentBehaviorSettings.tsx`
- `components/chat/SessionErrorBanner.tsx`、`components/chat/Chat.tsx`、`components/dock/FilePreviewPane.tsx`
- `styles/updater.css`（`@keyframes upd-spin`，配套上面图标）

### 2. status-pulse 点
- `StreamingIndicator`（`packages/ui/src/components/message/index.tsx`）：单点 `animate-pulse`，属 brief 排除的「status-pulse 点」。

### 3. 进度条 / scroll thumb / skeleton
- `scroll-progress-container`、`scroll-minimap`：滚动进度/缩略，非加载动画语义。
- `MessageAttachmentImage` 的图片占位（`animate-pulse` 灰块）：skeleton 占位，无独立「加载动画」语义。
- `PendingRichBlock`（`message/index.tsx`）：富内容生成占位条 + 单点 `animate-pulse`，属占位/skeleton，不纳入。

---

## 四、各格视觉（截图级文字说明）

开关开（`loaderAnimationEnabledAtom = true`）时：

1. **有机形变**：44px 圆盘，`--primary` 色系渐变光晕；内部 7 个模糊多边形各自旋转 + 整体 `contrast` 脉动，呈现有机形变/呼吸。配色跟随主题色系，深浅自适应。
2. **三瓣螺旋**：40px SVG，`--primary` 单色；82 颗粒子沿内旋轮线（hypotrochoid）曲线拖尾流动，整组缓慢旋转 + 呼吸缩放，形成三瓣螺旋轨迹。
3. **点阵网格**：24px（text-base）3×3 方阵，`muted-foreground` 色；9 格以错峰 delay 做 `scale(1→0→1)` 波浪收缩（SpinKit Grid，从左下向右上扫）。
4. **带标签指示器**：24px 3×3 点阵 + 右侧「思考中」文字（`text-xs muted-foreground`），inline 排列；动画同点阵网格。
5. **消息弹跳点**：3 颗 6px 圆点（`muted-foreground/40`），`animate-bounce` 上下弹跳，`0/0.15s/0.3s` 错峰。
6. **附加光环**：80px 圆环，`--primary` 系 inset `box-shadow` 三色光环旋转 + 中段切色；中心「加载中」逐字 `translateY/scale` 跳动（缩小版，原默认 180px）。

开关关（`loaderAnimationEnabledAtom = false`）时：全部预览 **暂停 + 变淡**（`opacity: 0.5`），具体暂停见 §五。

---

## 五、开关暂停预览语义（保持与现一致）

顶栏 `Switch` 绑 `loaderAnimationEnabledAtom`（`apps/electron/src/atoms/feature-flags.ts`，`atomWithStorage('tagent:loaderAnimation', true)`），语义不变：**关则全部预览暂停/灰掉**。

图鉴舞台 `<div class="tagent-loader-preview-stage" data-disabled={!loaderEnabled}>`。暂停按组件分三类：

- **JS 驱动**：`ThreePetalSpiral` 由 `active={loaderEnabled}` 控制（关 → 静态首帧、不启动 rAF）；`LoaderPreview` 由 `disabled={!loaderEnabled}` 在自身 `data-disabled` 上触发 CSS `paused`。
- **纯 CSS 驱动**：`Spinner` / `LoadingIndicator`（点阵网格）、`MessageLoading`（弹跳点）、`AddonLoader`（光环/字）均无运行态 prop，统一由舞台级规则暂停：
  ```css
  .tagent-loader-preview-stage[data-disabled] .spinner .spinner-cube,
  .tagent-loader-preview-stage[data-disabled] .ui-addon-loader__ring,
  .tagent-loader-preview-stage[data-disabled] .ui-addon-loader__letter,
  .tagent-loader-preview-stage[data-disabled] .animate-bounce { animation-play-state: paused; }
  ```
- **变淡**：`.tagent-loader-preview-stage[data-disabled] .tagent-loader-preview-item { opacity: 0.5 }`（既有，覆盖全部 6 格）。

`prefers-reduced-motion` 降级：`LoaderPreview` 静态外观（既有）；`Spinner` 由新增 `spinner.css` 静态化；`AddonLoader` 由其既有 `@media` 静态化；`ThreePetalSpiral`/`MessageLoading` 走原生降级。

---

## 六、CSS 缺失修复说明（必要 CSS）

挂入图鉴前发现两处样式缺口，本轮补齐（不改组件 API）：

1. **`Spinner` 无样式**：`spinner.tsx` 引用 `.spinner` / `.spinner-cube`，但全仓（排除 `node_modules`）无对应 CSS —— 该组件在 electron 端原本会渲染为 9 个空 div。新增 `packages/ui/styles/spinner.css`，按组件文档「SpinKit Grid、em 缩放、默认约 24px」补齐（`width:1.5em`，方块 `0.4em`，步长 `0.55em`，`@keyframes spinner-grid`，含 `prefers-reduced-motion` 降级）。
2. **`AddonLoader` 样式未在 electron 引入**：`packages/ui/styles/addon-loader.css` 存在但 `globals.css` 未 import。新增该 import，使附加光环在图鉴中正常渲染。

两者均属 brief「必要 CSS」范畴，非「从零 invent 新动画」（SpinKit Grid 为组件已声明动画，`addon-loader.css` 为既有文件仅做引入）。

---

## 七、选型持久化：后置

brief：「若已有『选用哪个 loader』存储则接上，否则只做图鉴，FINDINGS 记『选型持久化后置』」。

- 现状：`feature-flags.ts` 仅有 `loaderAnimationEnabledAtom`（on/off 开关），**无「选用哪个 loader」的存储**。全仓未发现 loader 选型 atom / localStorage key。
- 本轮：图鉴为**纯展示**（`role="list/listitem"`，单元格非按钮、不可选），不接管真实加载场景，亦未新增选型存储。
- 后置：若要落地「选哪个 loader 生效到真实场景」，需新增 `selectedLoaderAtom`（`atomWithStorage`）+ 在 `Chat`/`AssistantTurnView` 等真实加载点按选型分派——**本轮不动真实加载绑定**，留待后续。

---

## 八、typecheck

`apps/electron` 执行 `bun run typecheck`（`tsc --noEmit`）：仅 1 处既有错误，与本轮无关——

```
src/renderer/components/chat/Chat.tsx(658,62): error TS2353: ... 'modelId' does not exist in type ...
```

该错误位于 `Chat.tsx`（本轮未改动，会话开始前即为 `M`），涉及会话更新类型的 `modelId` 字段，与加载动画无关。本轮改动文件（`SettingsPage.tsx` / `globals.css` / `loader-preview.css` / 新增 `spinner.css`）**无新增类型错误**。未 commit。
