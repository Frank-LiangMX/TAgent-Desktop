# Cursor 式简洁时间线

> 日期：2026-08-06（对齐 Cursor：live 滚动态 → 完成折叠 → 展开明细）  
> 范围：仅 `displayMode === 'concise'`；`full` 零回归  
> 代码：`concise-timeline-model.ts` / `ConciseTimelineView.tsx`

---

## 1. 产品目标

```
[运行了 Xm]          ← 最外层容器（对齐 Cursor Worked for）
  ├ 展开：思考了 N 秒 → 进度短总结 → 阶段块 → …
  └ 折叠：过程链隐藏
[最终正文]            ← 始终在容器外；折叠后页面上主要只剩它
```

| 能力 | 行为 |
|------|------|
| 运行容器 | 最新一轮默认展开；用户发下一轮后历史链折叠；过程链相对外层缩进 |
| 过程链 | 思考时长行 + 阶段工作块 + 进度短总结，全部在容器内 |
| 最终正文 | `narrative.final` 在容器外，折叠后仍可见 |
| 阶段块 | live 摘要+滚动态；done 折叠；expand 明细含思考了 N 秒 |
| full | ProcessGroupView 不变 |

---

## 2. 段类型

```ts
WorkStageStep =
  | { kind: 'thinking'; key; thinking }
  | { kind: 'tool'; key; tool; diff?: { add; del } }

ConciseSegment =
  | { kind: 'thinking'; … }           // 仅首轮工具前
  | { kind: 'work_stage'; steps; tools; summary; diffAdd?; diffDel? }
  | { kind: 'narrative'; text; tone: 'progress' | 'final' }
```

---

## 3. 验收

1. live 阶段：摘要 + 底部当前动作；完成后仍在，成折叠块  
2. 展开：思考与工具按时间交错；编辑行可有 `+N -M`  
3. 点击明细行可展开详情  
4. 工具间 text = 进度短总结；尾部 = 最终卡片  
5. vitest `concise-timeline-model` 绿  

---

## 4. 明确不做

- 不改主进程 IR  
- 不做外层「Worked for Xm」大折叠  
- 无 text 时不编造进度文案  
- 完整文件 diff 面板（点击详情目前为 result 摘要截断）  
