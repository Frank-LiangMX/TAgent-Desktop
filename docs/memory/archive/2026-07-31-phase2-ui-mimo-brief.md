# Phase 2.3 UI 移植任务（mimo deepseek-v4-flash）

## 目标
把 TAgent_General 的记忆 UI 移植到 Desktop，挂到 Rail 一级入口「记忆」。

## 源
`F:\TAgent_General\apps\electron\src\renderer\components\memory\`
- MemoryMonitorPanel.tsx
- MemoryGraph.tsx
- StageQueueCard.tsx
- NudgeToast.tsx

## 目标
`F:\TAgent-Desktop\apps\electron\src\renderer\components\memory\`（新建目录）

## Desktop 适配（必须）

1. **路径别名**：Desktop 没有 `@/`，用相对路径：
   - `cn` → `../../lib/utils`
   - UI 组件从 `@tagent/ui` 导入（AppTooltip / Tooltip 等）
   - **不要** import `@/atoms/app-mode`、`@/components/app-shell/Panel`、`detectIsMac` 等 General 专属

2. **mode**：没有 topLevelModeAtom。MemoryMonitorPanel 默认 `mode='general'`，可本地 state 切换 general/ta（简单 tabs 即可）。

3. **electronAPI**：preload 已暴露（勿再改 preload 除非缺方法）：
   - initMemoryLayers, getMemoryStats, searchMemorySessions, listRecentMemorySessions
   - getMemoryMdContent, getMemoryCorrections
   - getStageQueue, acceptStageAll, rejectStageAll, acceptStageOne, rejectStageOne
   - getGraphData, getPendingNudges, respondNudge, onNudgeEvent
   若 App.tsx 的 Window.electronAPI 类型声明缺这些，**补上类型**。

4. **Rail 挂载**：
   - `Rail.tsx`：`RailItem` 加 `'memory'`，上胶囊加 Brain/Database 图标（phosphor `@phosphor-icons/react` 已有）
   - `App.tsx`：`activeRail` 支持 memory；`activeRail==='memory'` 时 main 渲染 `<MemoryMonitorPanel />`
   - 设置仍走对话框，插件仍是 plugins

5. **NudgeToast**：
   - 依赖 `sonner`（已在 package.json）
   - 在 App 根挂 `<Toaster />`（从 sonner）
   - 在 App 或 Chat 顶层 `useEffect` 订阅 `window.electronAPI.onNudgeEvent`，收到 `nudges` 后调 `showNudgeToasts`

6. **MemoryGraph**：
   - 依赖 `d3-force` `d3-scale` **已安装**
   - GET_GRAPH_DATA 目前返回空图，Graph 空态友好即可

7. **样式**：用 Tailwind + 现有 md-text / muted-foreground 类，不要依赖 General 独有 CSS。没有 `Panel` 组件就用普通 `div` + `className` 铺满 main。

8. **react-markdown / remark-gfm**：根 package 可能有（检查）；没有就纯文本展示 L0-L5，不要为 markdown 大改依赖。

## 验证
```
cd F:\TAgent-Desktop\apps\electron && bun run typecheck
```
通过。写 `.context/phase2-ui-mimo-result.md` 说明改了哪些文件。

## 不要做
- 不要改 main 记忆服务逻辑
- 不要 git commit / push
- 不要动 Phase 3/4
