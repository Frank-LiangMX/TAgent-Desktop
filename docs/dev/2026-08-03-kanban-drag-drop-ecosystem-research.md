# 桌面看板拖拽依赖生态调研

> 调研日期：2026-08-03  
> 关联：桌面看板依赖验证 / 任务 B 撰写摘要输入  
> 项目栈：React 18 + Electron + Tailwind CSS + Radix UI + Jotai + Motion  
> 存放位置：docs/dev/（临时调研，可定期清理）

---

## 1. 项目约束与场景

TAgent-Desktop 看板 UI 需要在 Electron 桌面应用中实现**列视图任务板**，核心交互：
- 列间拖拽移任务（如「待办 → 执行中 → 完成」）
- 列内拖拽排序
- 多列水平滚动 / 垂直滚动
- 依赖已安装的 `motion`（原 framer-motion）做动画增强

后台已有 SQLite kanban 数据层、IPC 通道、类型定义（见 `packages/shared/src/types/kanban.ts`）。本次只调研**前端拖拽 UI 依赖**。

---

## 2. 候选依赖清单

### 2.1 核心拖拽库

| 库名 | 版本 | License | 最近更新 | React 支持 | 类型 |
|------|------|---------|----------|-----------|------|
| **@dnd-kit/core** | 6.3.1 | MIT | 2024-12 | ✅ 一等公民 | 底层引擎 |
| **@dnd-kit/sortable** | 10.0.0 | MIT | 同步 | ✅ 预设 | 排序扩展 |
| **@hello-pangea/dnd** | 18.0.1 | Apache-2.0 | 2025-02 | ✅ 专为 React | 高层封装 |
| **@atlaskit/pragmatic-drag-and-drop** | 2.0.1 | Apache-2.0 | 2026-06 | ✅（可选绑定） | 框架无关核心 |
| **react-beautiful-dnd** | 13.1.1 | Apache-2.0 | 2022-08 ⚠️ 停维 | ✅ | 高层封装 |
| **sortablejs** | 1.15.7 | MIT | 2026-02 | 需 react-sortablejs | Vanilla JS |
| **react-dnd** | 16.0.1 | MIT | 2022-04 ⚠️ 停滞 | ✅ | 底层引擎 |
| **react-sortable-hoc** | 2.0.0 | MIT | 2020 ⛔ 停维 | ✅ | 高层封装 |

### 2.2 Kanban 专用组件库

| 库名 | 版本 | License | 最近更新 | 状态 |
|------|------|---------|----------|------|
| **@asseinfo/react-kanban** | 2.2.0 | MIT | 2022-04 | ⚠️ 停维 |
| **@caldwell619/react-kanban** | 0.0.12 | MIT | 2025-02 | 🔶 社区 fork |
| **react-trello** | 2.2.11 | MIT | 2022-06 | ⛔ 停维 |

### 2.3 动画 & 辅助库（项目已有）

| 库名 | 版本 | 用途 |
|------|------|------|
| **motion** | 12.43.0 | 动画（framer-motion 继任者，已在用） |
| **lucide-react** | 0.460.0 | 图标 |
| **tailwindcss** | 3.4.17 | 样式 |
| **jotai** | 2.17.1 | 状态管理 |
| **@phosphor-icons/react** | 2.1.10 | 补充图标 |

---

## 3. 对比分析

### 3.1 @dnd-kit（推荐 ⭐）

```
包结构：@dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities + @dnd-kit/accessibility
GitHub：clauderic/dnd-kit（~13k stars）
维护者：Claudéric Demers（Shopify 前员工）
```

**优点：**
- 现代架构：使用 Pointer Events + CSS Transform，兼容 Electron 的 Chromium 渲染
- 无障碍一流：内置键盘操作、屏幕阅读器支持（ARIA）
- 可定制性极高：传感器可拔插（Pointer/Keyboard/Touch/Mouse），碰撞检测算法可换
- 10.0 版 sortable 预设覆盖列排序场景
- TypeScript 原生支持，类型优秀
- 与 `motion` 动画库兼容（可结合 `useSortable` + `motion.div` 做布局动画）
- 包体积小：core ~15KB gzip，sortable ~5KB gzip

**缺点：**
- 学习曲线略陡：需要理解 `DndContext` / `SortableContext` / `useSortable` 三层抽象
- 官方无看板示例，需要自己组合：列 = 水平 sortable 容器，每列内 = 垂直 sortable 容器
- 社区示例以 list 为主，看板示例需自行搜索

**桌面端适配：**
- Pointer Events → Electron Chromium 完美支持
- 无障碍键盘导航 → Electron 快捷键不冲突
- 无 DOM 测量兼容问题（Electron 内浏览器环境一致）

---

### 3.2 @hello-pangea/dnd（备选 ⭐）

```
GitHub：hello-pangea/dnd（~4k stars）
维护者：Hello Pangea 团队
API 兼容：react-beautiful-dnd 的 drop-in replacement
```

**优点：**
- react-beautiful-dnd 的活跃 fork，API 与之 100% 兼容
- 开箱即用的看板体验：`<DragDropContext>` + `<Droppable>` + `<Draggable>` 直接映射看板语义
- 社区看板示例丰富（原 rbdnd 教程/模板可直接复用）
- 动画流畅：自带拖拽过程中的位移动画
- 支持 React 18 StrictMode

**缺点：**
- 底层仍基于 `react-beautiful-dnd` 设计（`react-dom` 直接操作，非 Pointer Events）
- 内部使用 `@hello-pangea/dnd` 的 `useDraggable` 不完全可定制（不如 dnd-kit 灵活）
- Apache-2.0 协议（MIT 项目可兼容，但需保留 NOTICE）
- 包体积较大（~100KB gzip，包含样式与动画）
- 与 `motion` 的布局动画结合需小心，自带动画可能冲突

**桌面端适配：**
- Electron Chromium 直接支持（基于 `react-dom` 的拖拽实现）
- 自定义传感器支持有限（不像 dnd-kit 可替换 Pointer/Keyboard 传感器）
- 虚拟列表场景需额外处理（react-window 配合需三方方案）

---

### 3.3 @atlaskit/pragmatic-drag-and-drop

```
GitHub：atlassian/pragmatic-drag-and-drop
维护者：Atlassian（Jira/Trello 团队）
```

**优点：**
- 性能极致：Atlassian 为 Trello/Jira 板设计，原生支持 1000+ 卡片场景
- 框架无关核心 + 可选 React 绑定（`@atlaskit/pragmatic-drag-and-drop-react-strict-mode`）
- 内存安全：基于 `NativeDrag` + 自定义 memory adapter
- 持续活跃：Atlassian 内部重度使用，2026-06 还在发版
- 支持混合拖拽（列表内 + 跨列表 + 排序）

**缺点：**
- 生态小：npm 下载量远低于 dnd-kit（约 1/50）
- 文档分散于 Atlassian Design System，外部使用指南少
- API 变动频繁（v1→v2 不到两年），小团队跟随成本高
- 包名在 `@atlaskit` scope 下，可能有 Atlassian Design Token 依赖警告
- TypeScript 类型定义深度绑定 Atlassian 内部设计系统

**桌面端适配：**
- 基于浏览器原生拖拽 API，Electron 下表现一致
- 但原生拖拽在 Electron 的透明窗口/无边框模式下可能有 ghost image 兼容问题

---

### 3.4 react-beautiful-dnd（⛔ 不推荐）

- **已归档停维**（Atlassian 官方声明）。React 18 StrictMode 有已知 bug 不修。
- 仅作 API 参考。实际使用应选 `@hello-pangea/dnd`。

---

### 3.5 sortablejs + react-sortablejs

```
vanilla: sortablejs v1.15.7（MIT，2026-02 更新）
binding: react-sortablejs v6.1.4（MIT）
```

**优点：**
- 框架无关，市面上最成熟的纯 JS 排序库
- 极简 API：`new Sortable(el, { group: 'shared', animation: 150 })`
- 天然支持多列分组拖拽（`group` 配置即看板语义）
- 包体积极小（~5KB gzip）
- 移动端/触屏支持极好

**缺点：**
- React 绑定 `react-sortablejs` 是社区维护，非官方
- 与 React 虚拟 DOM 同步困难：直接操作 DOM 节点，React 状态更新容易不同步
- 无障碍需自行实现
- 与 `motion` 动画冲突风险高
- 看板级 UI（列标题、卡片模板、空态）需全部手写

**桌面端适配：**
- 纯 DOM 操作，Electron 完全兼容
- 但 React 状态同步需大量胶水代码（`onUpdate` 回调中手动更新 Jotai atom）

---

### 3.6 react-dnd（⚠️ 不推荐）

- 最后更新 2022-04，维护停滞
- API 设计老旧（基于 HTML5 Backend / Touch Backend）
- 与现代 React hooks 风格不匹配
- TypeScript 类型复杂（高阶组件 + 多层泛型）

---

### 3.7 Kanban 专用组件库（⚠️ 不推荐）

- **@asseinfo/react-kanban**：2022 年停维，React 18 兼容问题
- **@caldwell619/react-kanban**：社区 fork，下载量极低（< 1k/周），风险高
- **react-trello**：停维，基于 react-beautiful-dnd 旧版

**结论：Kanban 专用库普遍停维，不建议作为核心依赖。看板 UI 应用核心拖拽库自行搭建，保证可控性。**

---

## 4. 与项目现有栈的兼容性矩阵

| 候选 | React 18 | Electron | Tailwind | Motion | Jotai | Radix UI |
|------|----------|----------|----------|--------|-------|----------|
| **@dnd-kit** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **@hello-pangea/dnd** | ✅ | ✅ | ✅ | ⚠️ 可能冲突 | ✅ | ✅ |
| pragmatic-dnd | ✅ | ⚠️ 透明窗口 | ✅ | ✅ | ✅ | ✅ |
| sortablejs | ✅ | ✅ | ✅ | ⚠️ DOM 冲突 | ⚠️ 手动同步 | ✅ |

---

## 5. 推荐结论

### 首选：@dnd-kit

**理由：**
1. **技术栈完美契合**：React 18 + TypeScript + Electron，dnd-kit 专为现代 React 设计
2. **可定制性最高**：看板 UI 定制需求多（列拖拽 + 排序 + 空态 + 动画），dnd-kit 的传感器/碰撞算法可拔插架构最适合
3. **与 motion 兼容**：dnd-kit 使用 CSS Transform，`motion` 的 `layout` 动画可在拖拽结束后的过渡阶段增强体验（不冲突）
4. **维护活跃**：2024 年底仍在更新，社区庞大
5. **包体积小**：不增加 Electron 打包负担
6. **无障碍规范**：ARIA 键盘导航，满足桌面应用可访问性
7. **MIT 协议**：无额外合规成本

**架构适配：**
- 外层：`DndContext` + `SortableContext`（水平，列间拖拽）
- 内层：每列内 `SortableContext`（垂直，列内排序）
- 传感器：`PointerSensor` + `KeyboardSensor`（Electron 桌面默认指针操作）
- 碰撞检测：`closestCorners`（列边界吸附）

### 备选：@hello-pangea/dnd

**适用场景：** 团队对 react-beautiful-dnd API 熟悉，或需要快速原型且已有很多 rbdnd 示例代码可复用。

**风险：** 与 `motion` 动画并存时需要隔离动画层；包体积大；可定制性受限。

---

## 6. 看板 UI 实现建议

不建议引入完整的 Kanban 组件库。基于 **@dnd-kit** 自建组件：

```
KanbanBoard
├── KanbanColumn                    ← 水平 sortable 容器
│   ├── ColumnHeader (title + count)
│   ├── KanbanTaskCard[]            ← 垂直 sortable 容器
│   │   └── TaskCard (title + role + status badge)
│   └── AddTaskButton
└── NewColumnButton
```

**状态管理：**
- 看板数据存入 Jotai atom（列、任务列表）
- 拖拽结束时触发 `onDragEnd` → 更新 Jotai atom → 触发 IPC 同步到 SQLite
- 乐观更新策略：先更新 UI，异步同步后端

**已选依赖清单（建议）：**

```
@dnd-kit/core        ^6.3.1   ← 核心引擎
@dnd-kit/sortable    ^10.0.0  ← 排序预设
@dnd-kit/utilities   ^3.2.2   ← 工具函数
```

---

## 7. 未考察项（明确排除）

| 排除项 | 原因 |
|--------|------|
| react-grid-layout | 仪表盘网格布局，非看板场景 |
| react-beautiful-dnd（原版） | 已归档 |
| react-dnd | 维护停滞 |
| react-sortable-hoc | 已停止维护 |
| ag-grid / tanstack-table | 数据表，非拖拽 |
| vue.draggable / vuedraggable | Vue 生态，本项目用 React |
| 原生 HTML5 Drag & Drop | Electron 下透明窗口有已知 bug |

---

## 附录 A：npm 快速安装命令

```bash
cd apps/electron
bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

注：项目使用 Bun 作为包管理器（见 `bun.lock`）。`@dnd-kit/accessibility` 已包含在 `@dnd-kit/core` 依赖中，无需显式安装。

## 附录 B：最小 PoC 代码骨架（参考）

```tsx
// KanbanBoard.tsx
import { DndContext, closestCorners, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable'

function KanbanBoard({ columns, tasks }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const handleDragEnd = (event) => {
    const { active, over } = event
    if (!over) return
    // 更新 Jotai atom → IPC 同步
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <SortableContext items={columns.map(c => c.id)} strategy={horizontalListSortingStrategy}>
        <div className="flex gap-4 overflow-x-auto">
          {columns.map(col => <KanbanColumn key={col.id} column={col} tasks={tasks} />)}
        </div>
      </SortableContext>
    </DndContext>
  )
}
```

---

> **结论：首选 @dnd-kit v6 + @dnd-kit/sortable v10。无需第三方 Kanban 组件库。**
