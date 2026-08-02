# 桌面看板依赖验证 — 最终摘要

> 基于调研报告：[2026-08-03-kanban-drag-drop-ecosystem-research.md](./2026-08-03-kanban-drag-drop-ecosystem-research.md)  
> 交付日期：2026-08-03

---

## 推荐方案

**核心依赖：@dnd-kit（v6 core + v10 sortable + utilities）**

TAgent-Desktop 看板 UI 的拖拽依赖推荐 **@dnd-kit**，无需引入任何第三方 Kanban 组件库。架构上采用双层 SortableContext 嵌套：外层水平容器承载列间拖拽，内层垂直容器承载列内排序。

---

## 关键对比结论

### 为何选 @dnd-kit 而非 @hello-pangea/dnd？

| 维度 | @dnd-kit（首选） | @hello-pangea/dnd（备选） |
|------|-----------------|--------------------------|
| **底层机制** | Pointer Events + CSS Transform，现代标准 | react-dom 直接 DOM 操作，沿袭 rbdnd 旧设计 |
| **可定制性** | 传感器/碰撞算法完全可拔插 | 传感器体系受限，定制需 hack |
| **motion 兼容** | ✅ 各自控制不同阶段，无冲突 | ⚠️ 自带动画可能与 motion.layout 冲突 |
| **包体积** | ~20KB gzip（core+sortable） | ~100KB gzip |
| **协议** | MIT | Apache-2.0（需保留 NOTICE） |

@hello-pangea/dnd 的唯一优势是 API 与 react-beautiful-dnd 兼容，适合已有 rbdnd 代码需要快速迁移的场景，但本项目从零搭建看板，不享受此红利。

### 其余候选为何排除？

- **@atlaskit/pragmatic-drag-and-drop**：Atlassian 内部生态绑定深，外部文档少，API 变动频繁（v1→v2 不到两年），小团队跟随风险高。
- **react-beautiful-dnd**：2022 年 Atlassian 官方归档停维，React 18 StrictMode 已知 bug 不修。
- **react-dnd / react-sortable-hoc**：均已停滞维护，API 老旧。
- **sortablejs + react-sortablejs**：纯 DOM 操作与 React 虚拟 DOM 同步困难，需大量胶水代码。
- **Kanban 专用库**（react-kanban、react-trello 等）：全部停维，不推荐作为核心依赖。

---

## 桌面端集成要点

1. **传感器选型**：使用 `PointerSensor`（`activationConstraint: { distance: 5 }` 防误触）+ `KeyboardSensor`，在 Electron Chromium 环境完全原生支持。
2. **碰撞检测**：选用 `closestCorners`，实现列边界的自然吸附效果。
3. **双层嵌套**：外层 `SortableContext` + `horizontalListSortingStrategy`（列拖拽），内层 `SortableContext` + `verticalListSortingStrategy`（卡片排序）。
4. **状态同步**：拖拽结束（`onDragEnd`）→ 乐观更新 Jotai atom → 异步 IPC 写 SQLite，保证 UI 即时响应与数据最终一致。
5. **与 motion 共存**：dnd-kit 负责拖拽中实时位移（CSS Transform），motion 负责拖拽结束后的 `layout` 过渡动画，互不冲突。
6. **无障碍**：ARIA 键盘导航与 Electron 应用快捷键体系无冲突。

---

## 安装命令

```bash
cd apps/electron
bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

> @dnd-kit/accessibility 已内置在 core 中，无需显式安装。

---

**结论：基于 @dnd-kit 自建看板组件，不引入 Kanban 专用库。方案可控、轻量、与现代 React + Electron 技术栈完美契合。**
