# Brief · 外观页加载动画图鉴（扫全仓放进预览）

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 现状：外观 →「加载动画」仅预览 **有机形变**（`LoaderPreview`）+ **三瓣螺旋**（`ThreePetalSpiral`）。  
> 目标：把仓库里**正式的加载动画组件**都挂进该预览区。

## 扫什么（纳入图鉴）

优先 `@tagent/ui` 与 electron 里**有命名、可复用**的加载视觉：

| 候选（已知） | 路径线索 |
|---|---|
| LoaderPreview / 有机形变 | `SettingsPage` + `loader-preview.css` |
| ThreePetalSpiral | `packages/ui/.../three-petal-spiral.tsx` |
| Spinner | `packages/ui/.../spinner.tsx` |
| LoadingIndicator | `packages/ui/.../loading-indicator.tsx` |
| MessageLoading | `packages/ui/.../message` |
| AddonLoader | `packages/ui/.../addon-loader` |

再全仓扫：`*loader*` / `*spinner*` / `MessageLoading` / `animate-spin` 专用组件（非临时 `Loader2` 图标）。

**不纳入图鉴**（可写 FINDINGS 说明）：

- 随处 `Loader2` / `CircleNotch` + `animate-spin` 的临时等待图标  
- 进度条 / scroll thumb / status-pulse 点  
- skeleton 占位（若无独立「加载动画」语义）

## 产品行为（本轮）

1. 外观页「加载动画」区改为 **图鉴网格**：每格 = 预览 + 中文名 + 可选一行用途（默认/附加/消息中…）。  
2. 顶栏 Switch `loaderAnimationEnabledAtom` 语义保持：**关则全部预览暂停/灰掉**（与现一致）。  
3. **本轮仍可不接管真实加载场景**（`feature-flags` 注释已说明）；若已有「选用哪个 loader」存储则接上，否则只做图鉴，FINDINGS 记「选型持久化后置」。  
4. AddonLoader 体积大：预览用缩小 `size`（如 72–96），勿撑破布局。  
5. 样式延用/扩展 `tagent-loader-preview-*`，勿做成渠道列表。

## 产出

1. 改 `AppearanceSettings`（`SettingsPage.tsx`）+ 必要 CSS。  
2. 写 `docs/dev/ux/LOADER-GALLERY-APPEARANCE-FINDINGS.md`：纳入清单、跳过清单、截图级文字说明。  
3. typecheck 无新增错；禁止 commit。

## 不做

改 Chat 真实加载绑定、大改 ui 组件 API、加一堆新动画从零 invent。
