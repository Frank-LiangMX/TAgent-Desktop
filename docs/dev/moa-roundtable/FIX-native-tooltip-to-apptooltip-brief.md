# Brief · 前端原生 title tooltip → AppTooltip

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 主题组件：`packages/ui/src/components/tooltip.tsx` 的 **`AppTooltip`**（玻璃胶囊 `.session-glass-tooltip`）。App 根已有 `TooltipProvider`。

## 目标

扫 **Electron 渲染层 + `@tagent/ui` 里会进桌面壳的交互面**，把**浏览器原生 `title=` 悬停气泡**全部换成 `AppTooltip`，视觉统一。

## 范围

| 做 | 不做 |
|---|---|
| DOM 属性 `title="…"` / `title={…}` 用作 hover 提示的 | 组件 **prop** 名叫 `title` 的（`SettingsSection` / `Dialog` / `AlertDialog` / `EditorSection` / `ChannelGroup` / `RichFrame` 内容标题等） |
| `apps/electron/src/renderer/**/*.tsx` | iframe 的 `title=`（无障碍名，保留） |
| `packages/ui/src/**/*.tsx` 中图标按钮 / 工具条上的原生 title | 纯截断展示、无 hover 意图且极长路径——优先仍改 AppTooltip `multiline`；若改动会破坏布局则记 FINDINGS 跳过 |

## 改法

```tsx
// 前
<button title="复制" onClick={...}><Copy /></button>

// 后
<AppTooltip label="复制">
  <button type="button" onClick={...}><Copy /></button>
</AppTooltip>
```

- 从 `@tagent/ui` import `AppTooltip`（已 export）。  
- trigger 须是**单一 ReactElement**；必要时包一层 `<span className="inline-flex">`。  
- 长路径 / 错误全文：`multiline`。  
- 保留原有 `aria-label`（可与 label 同文）。  
- **删掉**对应 `title=`，避免双气泡。

## 已知命中（起点，须全量再扫）

renderer：`Chat.tsx` 结束跟随、`SubagentEntryCard`、`SubagentDetailView`、`SpeakerHeader`、`MessageView`、`MentionText`、`TurnFilesChangedCard`、`AskUserQuestionBanner`、`PermissionBanner`、`SessionErrorBanner`、`TokenStatsBar`、`StageQueueCard`、`StatusTicker`、`RolesPage`、`UpdateBanner`、`FilePreviewPane`（非 iframe）、`ChannelsSettings`/`McpSettings`/`PluginStoreSettings`/`SettingsPage` 里**真正的 DOM title**（如 `settings-env-value`、`<p title=`）等。

ui：`MermaidBlock`、`RichFrame` 工具钮、`DataTableView`、`attachment-preview-item`、`scroll-minimap` 等。

## 验收

1. 写 `docs/dev/ux/FIX-native-tooltip-FINDINGS.md`（无目录则建）：改了哪些文件、跳过哪些（含理由）、剩余原生 title 清单（应为空或仅 iframe/prop）。  
2. 改完后 `rg`/`grep` 抽样：renderer 交互按钮无残留 hover-`title`（允许列出白名单）。  
3. 不破坏现有 AppTooltip 用法；不改 Tooltip 视觉 token。  
4. 相关 typecheck 无新增错；可跑窄测。禁止 commit。

## 不做

大改布局、换 Tooltip 实现、动 preload/主进程。
