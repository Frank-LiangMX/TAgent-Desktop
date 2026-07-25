# TAgent Design System

> 本文件是 `@tagent/ui` 包的设计规范。**写任何 UI 代码前必读本文件。**
>
> 修改 token：编辑 `packages/ui/src/tokens/*.ts` → `bun run --filter @tagent/ui tokens:generate` → globals.css + tailwind.config.js 自动同步。
>
> **Liquid Glass / 高透玻璃外部参考与 Agent 约束**（技法映射、禁止项、侧栏×主区血泪备忘）：  
> [`docs/ui/liquid-glass-ui-reference-for-agents.md`](../../docs/ui/liquid-glass-ui-reference-for-agents.md)  
> 主参考站：https://freefrontend.com/css-liquid-glass/

---

## 核心原则

1. **改一处全局生效**：所有视觉 token（颜色/圆角/阴影/间距/字号/动效）定义在 `packages/ui/src/tokens/`，通过生成器同步到 CSS 变量和 Tailwind 配置。改 token 一处，全局自动更新。
2. **组件从 `@tagent/ui` import**：`import { Button } from '@tagent/ui'`。不要从 `@/components/ui/xxx` 新增 import（兼容期保留旧路径，但新代码必须用 `@tagent/ui`）。
3. **禁止硬编码视觉值**：颜色（`#fff` / `rgb(...)`）、圆角（`rounded-[14px]`）、阴影、间距。必须用 token 类或 Tailwind 语义类。
4. **新组件放 packages/ui**：`packages/ui/src/components/`，不放 `apps/electron/src/renderer/components/ui/`。
5. **主题 × 材质双轴**：主题只定 hue / primary / 近中性 surface；材质（`frosted` 默认 / 高级 `glass`·`soft`）只换光学表（blur / 阴影 / press）。**高级材质是可选档位，不是另一套颜色产品。**

### 三级字色（全材质共用）

| 类 / 变量 | 用途 |
|-----------|------|
| `.md-text` / `--md-on-surface` | 正文、主标题 |
| `.md-text-variant` / `--md-on-surface-variant` | 次要说明、图标默认 |
| `.md-text-faint` / `--md-on-surface-faint` | 时间戳、弱标签、分组标题 |

避免新增 `text-foreground/40` 一类零散透明度。

### 按压语义 `.ui-pressable`（`styles/pressable.css`）

- 语义全材质共用；光学读 `--press-scale` / `--press-shadow`（在 `glass.css` 材质表）
- **frosted**：轻 scale，无粘土 inset
- **soft**：更强 scale + neu-in 式 inset
- **glass**：最轻 scale，无粘土 inset
- 选中态（`session-list-item-active` 等）不施加 press 阴影

### 胶囊 Switch（全局唯一）

权威实现：`packages/ui/src/components/switch.tsx` + `packages/ui/styles/switch.css`。  
视觉：Uiverse [average-monkey-56](https://uiverse.io/Shoh2008/average-monkey-56) 笑脸滑块；**开态渐变跟 `--primary` 主题色**，关态轨道 / 拇指 / 脸用语义 token。材质（glass/soft）只微调阴影，不改结构。

```tsx
import { Switch, SettingsToggle } from '@tagent/ui'

// 设置 / 表单（--size 24px）
<Switch checked={on} onCheckedChange={setOn} />

// 工具栏 / 紧凑浮层（--size 20px）
<Switch size="sm" checked={on} onCheckedChange={setOn} />

// 设置行（左 label + 右 Switch）
<SettingsToggle label="启用" checked={on} onCheckedChange={setOn} />
```

| 规则 | 说明 |
|------|------|
| ✅ 必须 | `import { Switch } from '@tagent/ui'` |
| ✅ 尺寸 | 只用 `size="default" \| "sm"`，改 `--ui-switch-size` |
| ✅ 主题色 | 开态 `--ui-switch-on-from/to` 绑 primary，勿写死粉紫 |
| ❌ 禁止 | 业务侧写 `h-4 w-7` / 自绘 track+thumb / 液态 GSAP 复刻 |
| ❌ 禁止 | 新增本地 `*Toggle` 复刻胶囊（日夜 `tagent-daynight-toggle` 除外） |

---

## Token 清单

### 圆角 Token（`packages/ui/src/tokens/radius.ts`）

| Token 名 | CSS 变量 | 值 | 用途 |
|---|---|---|---|
| `glass-input` | `--radius-glass-input` | 24px | `.chat-input-glass` 聊天输入框 |
| `glass-sidebar` | `--radius-glass-sidebar` | 12px | `.session-glass-sidebar` / `.session-list-item-active` 侧栏列表项 |
| `glass-rail` | `--radius-glass-rail` | 12px | `.session-glass-rail` 导航栏 |
| `glass-tab` | `--radius-glass-tab` | 14px | 顶部标签上边圆角（下边保持直角） |
| `glass-chip` | `--radius-glass-chip` | 6px | `.session-glass-chip` 芯片 |
| `glass-modal` | `--radius-glass-modal` | 20px | `.session-glass-modal` 模态框 |
| `glass-modal-lg` | `--radius-glass-modal-lg` | 24px | `.session-glass-modal-lg` 大模态框 |
| `glass-popover` | `--radius-glass-popover` | 12px | `.session-glass-popover` 弹出层 / Select·Dropdown |
| `glass-sticky` | `--radius-glass-sticky` | 12px | `.session-glass-sticky` 吸顶元素 |
| `glass-tooltip` | `--radius-glass-tooltip` | 10px | `.session-glass-tooltip` Tooltip |

**Tailwind 类映射**：`rounded-glass-tooltip` → `border-radius: var(--radius-glass-tooltip)`

### 颜色 Token（`packages/ui/src/tokens/colors.ts`）

颜色 token 当前阶段只定义 Tailwind 映射（指向现有 CSS 变量），CSS 变量定义在 `apps/electron/src/renderer/styles/globals.css` 的 `:root` 和 `.theme-*` 块。

| Tailwind 类 | CSS 变量 | 用途 |
|---|---|---|
| `bg-background` / `text-foreground` | `--background` / `--foreground` | 主背景/前景 |
| `bg-primary` / `text-primary-foreground` | `--primary` / `--primary-foreground` | 主色/主色文字 |
| `bg-muted` / `text-muted-foreground` | `--muted` / `--muted-foreground` | 次要背景/文字 |
| `bg-accent` / `text-accent-foreground` | `--accent` / `--accent-foreground` | 强调色 |
| `bg-destructive` | `--destructive` | 危险色 |
| `bg-card` / `text-card-foreground` | `--card` / `--card-foreground` | 卡片 |
| `bg-popover` / `text-popover-foreground` | `--popover` / `--popover-foreground` | 弹出层 |
| `bg-dialog` | `--dialog` | 对话框 |
| `bg-tooltip` / `text-tooltip-foreground` | `--tooltip` / `--tooltip-foreground` | Tooltip |
| `border-border` / `border-input` | `--border` / `--input` | 边框/输入框边框 |

**完整列表见 `packages/ui/src/tokens/colors.ts` 的 `tailwindColorTokens`。**

#### Scene 弥散环境色 Token

除语义色外，`ThemeColors` 还定义三个 **scene 弥散环境色** token，由每个 `ThemeName` 自带（`colors.ts` 的 `SCENE` 表），供窗口底层弥散渐变消费：

| Token | CSS 变量 | 用途 |
|---|---|---|
| `scene-base` | `--scene-base` | 弥散渐变基底色（窗口底色：浅色瓷白 / 深色深底） |
| `scene-ambient-a/b/c` | `--scene-ambient-*` | 三组环境光色的 HSL 兼容别名 |
| `scene-base-rgb` | `--scene-base-rgb` | 最终原型的近中性整窗基底 |
| `scene-a/b/c-rgb` | `--scene-*-rgb` | 主光、对位补光与空气塑形光的 RGB 三元组 |
| `scene-a/b/c-pos/size/strength` | `--scene-*-*` | 每套主题独立的光位、覆盖范围与强度 |
| `glass-rgb` | `--glass-rgb` | 供 frosted / glass / soft 共同消费的近无色瓷玻璃基色 |

窗口底层 `html.tagent-app-shell-window` 只消费 `--surface-role-scene-fill`。该角色在 `styles/surface-roles.css` 中用 **主题 token**（`--scene-*-pos/size/strength/rgb`）驱动 A/B/C 对置光 + 全屏 base 线性洗，结构对齐 layout-direction-study 的均匀场（禁止硬编码贴角大光斑）。main/workspace 保持透明背景层，不做浮岛。换主题只改 hue/强度，不改分布公式；材质只改变透明度、模糊、边缘与阴影。生成器自动把 scene 字段产出到 `:root` / `.dark` / `.theme-*`。

长会话顶部定位器、用户消息气泡、消息刻度预览与会话状态条分别消费 `--surface-role-turn-locator-*`、`--surface-role-message-user-*`、`--surface-role-message-minimap-*`、`--surface-role-session-status-*`，不得在业务 CSS 中按主题或材质重定义一套蓝白 / accent 面板。用户气泡是中性玻璃板（对齐原型 `--role-message-user-*`），禁止染 primary。

### 阴影 / 间距 / 字号 / 动效 Token

动效使用 `packages/ui/src/tokens/motion.ts` 的语义 Token：`duration-instant/fast/control/panel/scene` 与 `ease-enter/exit/spatial`。空间层级使用 `surface-role.ts` 注册的十类 `SurfaceRole`，光学映射统一定义在 `styles/surface-roles.css`。业务组件不要自行发明 z-index 或按材质分支。

---

## 组件清单（30 个）

所有组件从 `@tagent/ui` import：

```tsx
import { Button, Dialog, Tooltip, Popover } from '@tagent/ui'
```

### 表单输入（8 个）
| 组件 | 用途 |
|---|---|
| `Button` | 按钮，支持 variant（default/outline/ghost/destructive/link）+ size |
| `Input` | 单行输入框 |
| `SearchInput` | 统一搜索框；`variant`: default / muted / glass / plain / **capsule**（侧栏玻璃外形 + Uiverse clever-panda-6 Nebula focus） |
| `Textarea` | 多行输入框 |
| `Switch` | **全局唯一**主题色笑脸胶囊（Uiverse average-monkey-56）：`size="default"\|"sm"`。业务禁止本地造 track/thumb |
| `PlayPauseToggle` | Play / Pause 图标切换（Uiverse wet-rabbit-81 适配，受控/非受控） |
| `Slider` | 滑块 |
| `Label` | 表单标签 |

### 浮层（6 个）
| 组件 | 用途 |
|---|---|
| `Tooltip` + `TooltipTrigger` + `TooltipContent` | hover 提示，跟随主题 |
| `Popover` + `PopoverTrigger` + `PopoverContent` | 点击弹出，含交互 |
| `Dialog` + `DialogTrigger` + `DialogContent` | 模态对话框 |
| `AlertDialog` | 确认对话框 |
| `Sheet` | 侧滑抽屉 |
| `DropdownMenu` | 右键/下拉菜单 |

### 反馈（6 个）
| 组件 | 用途 |
|---|---|
| `Alert` + `AlertTitle` + `AlertDescription` | 内联警示信息 |
| `Badge` | 徽章/标签 |
| `Spinner` | 默认轻量加载（3×3 点阵） |
| `LoadingIndicator` | 带标签/计时的加载指示器 |
| `AddonLoader` | **附加动画**（Uiverse bright-lizard-8）：旋转光环 + 逐字跳动，强视觉占位；非默认 Spinner |
| `Toaster`（薄包装在 `@/components/ui/sonner`） | toast 通知容器，theme 自动注入 |

#### 附加动画 vs 默认加载

| 类型 | 组件 | 何时用 |
|------|------|--------|
| 默认 | `Spinner` / `LoadingIndicator` / `ThreePetalSpiral` | 按钮内、列表、行内、常规等待 |
| **附加动画** | `AddonLoader` | 全屏/大卡片「生成中」、首次初始化等需要更强视觉时 |

```tsx
import { AddonLoader } from '@tagent/ui'

// 附加动画：主题色光环 + 逐字跳动
<AddonLoader text="生成中" size={160} className="text-foreground" />
```

### 导航（4 个）
| 组件 | 用途 |
|---|---|
| `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` | 标签页（Radix 标准） |
| `SegmentedTabs` + `SegmentedTabsItem` | 横向分段 Tab（`--surface-role-tab-*`，与工作区标签同族） |
| `ScrollArea` | 自定义滚动区域 |
| `ContextMenu` | 右键菜单 |

### 选择（2 个）
| 组件 | 用途 |
|---|---|
| `Select` + `SelectTrigger` + `SelectContent` + `SelectItem` | 下拉选择 |
| `Command` | 命令面板（基于 cmdk） |

### 布局 / 其他（5 个）
| 组件 | 用途 |
|---|---|
| `Separator` | 分隔线 |
| `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent` | 折叠面板 |
| `ScrollProgressContainer` | 滚动进度容器 |
| `ThreePetalSpiral` | 三瓣螺旋加载动画 |
| `ImageLightbox` | 图片灯箱预览 |

### 富内容（2 个，独立导出）
| 组件 | 用途 |
|---|---|
| `CodeBlock` | 代码块（Shiki 高亮） |
| `MermaidBlock` | Mermaid 图表 |

### 设置原语（10 个，`packages/ui/src/components/settings/`）
| 组件 | 用途 |
|---|---|
| `SettingsSection` | 区块容器（title + description + action 插槽） |
| `SettingsCard` | 圆角卡片（玻璃底 + 自动分隔线） |
| `SettingsRow` | 左右结构行（label + ? tooltip + 右侧控件插槽） |
| `SettingsToggle` | 开关（左 label + 右 Switch） |
| `SettingsSelect` | 下拉选择（左 label + 右 200px Select） |
| `SettingsInput` | 文本输入（左 label + 右 200px Input） |
| `SettingsSecretInput` | 密码输入（API Key 专用，带显隐切换） |
| `SettingsTextarea` | 多行文本（左 label + 右 280px Textarea） |
| `SettingsSegmentedControl` | 分段选择（左 label + 右 SegmentedTabs） |
| `FieldLabel` | label + ? 图标 tooltip（上述组件的内部构建块，也可单独使用） |

**视觉规范**：
- 所有设置原语都是**左右结构**（label 左，控件右），统一 `ROW_CLASS`
- `description` 默认隐藏到 `?` 图标 tooltip，避免满屏文字
- 卡片圆角引用 `--radius-glass-modal` token（20px），跟模态框/浮层一致
- 调用方写 `<SettingsCard><SettingsRow .../></SettingsCard>` 即可，不需要拼 className

### Hook（1 个）
| Hook | 用途 |
|---|---|
| `useSmoothStream` | 流式文本平滑输出 |

### 样式类（玻璃系列，定义在 `packages/ui/styles/glass.css`）
| 类名 | 用途 |
|---|---|
| `session-glass` | 强玻璃浮层（聊天输入框 / 用户消息置顶条） |
| `session-glass-sidebar` | 侧栏浮岛玻璃（轻量，rail/chip 共享） |
| `session-list-item-active` | 侧栏单行列表项选中态（玻璃底 + 圆角 + 折射层 + dark/material 适配）。**调用方写这一个类即可**，无需再拼 `session-glass session-glass-sidebar rounded-glass-sidebar`。圆角跟随 `--radius-glass-sidebar` token |
| `settings-card` | 设置页圆角卡片容器（玻璃底 + 顶部高光 + dark 适配）。圆角引用 `--radius-glass-modal` token（20px） |
| `session-glass-modal` / `session-glass-modal-lg` | 模态框玻璃 |
| `session-glass-popover` | 弹出层玻璃 |
| `session-glass-tooltip` | Tooltip 玻璃 |
| `session-glass-surface` | 弹窗 / 菜单 / 选项浮层通用玻璃 |
| `session-glass-sticky` | 吸顶元素玻璃 |
| `session-glass-toast` | sonner Toast 玻璃卡片（大圆角 20px + 玻璃底 + 高光，与模态框/设置卡片同款） |

**主题色覆盖**：业务侧 `globals.css` 的 4 个主题（ocean / forest / slate-light / slate-dark）通过 `.theme-xxx .session-list-item-active` 选择器覆盖背景色，调用方无需额外处理。

---

## 使用规范

### 必须做

```tsx
// ✅ 从 @tagent/ui import
import { Button, Dialog, DialogContent } from '@tagent/ui'

// ✅ 颜色用 token 类
<div className="bg-background text-foreground border border-border">

// ✅ 圆角用 token 类（glass 系列）
<div className="rounded-glass-tooltip">

// ✅ Tooltip 标准用法
<Tooltip>
  <TooltipTrigger asChild>
    <Button>Hover</Button>
  </TooltipTrigger>
  <TooltipContent>提示文案</TooltipContent>
</Tooltip>

// ✅ 搜索框统一用 SearchInput（variant: default | muted | glass | plain；size: sm | md | lg）
import { SearchInput } from '@tagent/ui'

<SearchInput placeholder="搜索…" />
<SearchInput variant="glass" size="sm" value={q} onChange={…} />
<SearchInput variant="plain" trailing={<kbd>⌘K</kbd>} onClear={() => setQ('')} />

// ✅ 横向分段 Tab 统一用 SegmentedTabs
import { SegmentedTabs, SegmentedTabsItem } from '@tagent/ui'

<SegmentedTabs value={tab} onValueChange={setTab}>
  <SegmentedTabsItem value="mcp" className="gap-1">MCP</SegmentedTabsItem>
  <SegmentedTabsItem value="skill" className="gap-1">Skill</SegmentedTabsItem>
</SegmentedTabs>
```

### 禁止做

```tsx
// ❌ 硬编码颜色
<div className="bg-[#fff] text-[rgb(0,0,0)]">

// ❌ 硬编码圆角
<div className="rounded-[14px]">

// ❌ 从 @/components/ui 新增 import（兼容期保留旧路径，但新代码禁用）
import { Button } from '@/components/ui/button'

// ❌ 新组件放 apps/electron/src/renderer/components/ui/
//    应放 packages/ui/src/components/
```

---

## 新增组件流程

1. 在 `packages/ui/src/components/` 新建 `xxx.tsx`
2. 在 `packages/ui/src/index.ts` 加 `export * from './components/xxx'`
3. 更新本文件 `## 组件清单`
4. `bun run typecheck` 通过
5. `bun run dev` 视觉抽查
6. 业务代码用 `import { Xxx } from '@tagent/ui'`

---

## Token 修改流程

1. 编辑 `packages/ui/src/tokens/*.ts`（如改 `radius.ts` 的 `glass-tooltip` 值）
2. 运行 `bun run --filter @tagent/ui tokens:generate`（或 `bun run dev` 会自动跑 predev 钩子）
3. 生成器自动更新 `__generated__/tokens.css` 和 `__generated__/tailwind-theme.js`
4. globals.css 和 tailwind.config.js 通过 @import / import 自动同步
5. 全局所有用到该 token 的地方自动更新

**不需要**手动改 globals.css 或 tailwind.config.js。

---

## 材质 × 主题（双轴正交）

> **目标架构**（ADR-0005 Accepted）：见  
> `docs/plans/2026-07-12-material-surface-token-architecture.md`、  
> `docs/plans/2026-07-12-material-md-surface-system.md`、  
> `docs/decisions/0005-material-surface-token-architecture.md`。  
> **新代码必须走 surface / MD 角色 token**；禁止再给高透基类叠 frosted 补丁。

### 材质轴（`html[data-material]`）

| 值 | 用户入口 | 目标观感 |
|----|----------|----------|
| `frosted` | 高级材质 **关**（默认） | 柔和 Material Design · **实色不透明**；**M3 surface 阶梯** |
| `glass` | 高级材质开 → 高透玻璃 | 高透 / 强 blur / 折射高光 |
| `soft` | 高级材质开 → 轻拟态 | 近不透明 + 内外高光阴影 |

- 运行时：`apps/electron/src/renderer/atoms/advanced-material.ts` → `applyAdvancedMaterialToDOM`
- **MD 角色**（`packages/ui/styles/md-surface.css`）：`--md-surface-container-*` / `--md-primary-container` / `--md-state-hover` / `--md-elevation-*` / `--md-shape-*` / `--md-type-*`
- **材质桥接**（`glass.css`）：`--surface-bg*` / `--hover-fill` / `--session-glass-strong` 映射到 MD 角色
- 表面类**只读 token**；**禁止**大面积用 `muted` 当面板底
- 过渡期 `html.material-frosted` class 仅兼容；**新 CSS 禁止再依赖**

### 普通材质表面用法（速查）

| 场景 | 用 |
|------|-----|
| 主内容画布 | `--md-surface` |
| 侧栏岛 / panel | `--md-surface-container-low` |
| 会话 well / 近白卡 | `--md-surface-container-lowest` |
| chip / 搜索槽 | `--md-surface-container` |
| 列表选中 | `--md-primary-container` |
| hover | `--md-state-hover`（不透明） |
| 次要文字 | `--md-on-surface-variant` |

### 主题轴（颜色）

#### 主题命名约定

`.theme-{name}-{light|dark}` class，应用到 `<html>` 元素。

现有 6 主题（× light/dark = 12 个变体）+ 默认 light/dark：
- 默认 `:root`（light）/ `.dark`（dark）
- `.theme-ocean-light/dark`（晴空碧海 / 苍穹暮色）
- `.theme-forest-light/dark`（森息晨光 / 森息夜语）
- `.theme-slate-light/dark`（云朵舞者）
- `.theme-orange-light/dark`
- `.theme-purple-light/dark`（莫兰迪夜）

#### 主题切换实现

- 状态管理：`apps/electron/src/renderer/atoms/theme.ts`（jotai atoms）
- DOM 操作：`applyThemeToDOM()` 在 `<html>` 上 toggle `dark` + `theme-{style}` class
- localStorage 缓存：`tagent-theme-mode` / `tagent-theme-style`

#### 颜色 token 与主题的关系

语义色权威源：`packages/ui/src/tokens/colors.ts` → 生成器产出 `tokens/__generated__/tokens.css`（`:root` / `.dark` / `.theme-*`）。  
Tailwind 通过 `hsl(var(--xxx))` 引用。  
业务侧 `globals.css` 仍可放材质装饰变量、shell 光斑等非语义色。

**禁止**：主题选择器修改 `--surface-blur` 或写死某主题的高透/拟态阴影（破坏正交）。

#### 主题轴 × 材质轴职责（scene token 后）

- **主题轴**：负责色相（primary / 语义色）+ **scene 环境光**（`--scene-*` 三元组）。
- **材质轴**：只负责 frosted / glass / soft 光学（blur / 透明度 / 边缘 / 阴影 / press），不改色相。
- **glass 色散**：左侧消费 `--primary`，右侧消费 `--scene-ambient-a`（`packages/ui/styles/glass.css`），不再写死跨主题紫 `hsl(260 …)`。
- **业务组件**：不按主题分支、不加页面级背景覆盖；窗口背景统一由 scene 层 + surface token 提供，AppShell 面板浮在 scene 背景之上。

---

## session-glass-* 类

定义在 `packages/ui/styles/glass.css`，被 `globals.css` `@import`。表面样式圆角引用 `--radius-glass-*` token。

修改圆角：改 `packages/ui/src/tokens/radius.ts` → 跑生成器 → 全局自动更新。

修改 blur / 透明度 / 高光 / 阴影：

- **改** `packages/ui/styles/glass.css` 顶部的 `--surface-*` / `[data-material]` 表
- 表面类（`session-glass-*` / `settings-card` / toast）只读 token
- 业务壳：`components/app-shell/app-shell.css` 维护 scene / 三个并列主平面 / overlay 布局契约，表面只读 surface token；`panel-glass` / `content-glass` / `btw-*` 继续按各自场景消费 token。禁止恢复 `content-base-plate` 多节点描边或在 `globals.css` 追加 AppShell 覆盖。
- AppShell 形状层级固定为：主导航 / 工作区 / 检查器 24px，内层输入区与浮动工具条 16–18px，列表行与图标按钮 10–12px；头像、状态点和微型状态切换才使用 full pill。主区域必须并列对齐，禁止用负 margin 制造无语义叠加。

---

## 兼容期说明

`apps/electron/src/renderer/components/ui/*.tsx` 现在是 re-export 存根（`export * from '@tagent/ui'`），保留是为了兼容现有 30+ 处业务代码的 `from '@/components/ui/xxx'` import。

新代码必须用 `from '@tagent/ui'`。后续可选优化：全量替换业务 import 路径后删除存根。

**例外**：`apps/electron/src/renderer/components/ui/sonner.tsx` 是薄包装（读 jotai theme atom 注入给纯展示 `Toaster`），不是 re-export。业务代码仍用 `from '@/components/ui/sonner'` 拿薄包装版。
