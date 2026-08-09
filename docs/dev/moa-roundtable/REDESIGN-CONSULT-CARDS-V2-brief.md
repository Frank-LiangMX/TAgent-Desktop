# Brief · 会诊设置视觉 V2（去掉「汇」流程图）

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 用户反馈截图：卡片灰、流程图（双芯片 → 汇 → 汇总）难看、占空。  
> **功能零回归**（渠道选择 / CRUD / channelId）；只改布局与 CSS。

## 诊断（必须改掉）

1. **伪流程图**：左右参考 chip + 「汇」圆 + 箭头 = 像未完成示意图，又矮又碎。  
2. **卡太大**：每条班底像海报，列表两行就占满屏。  
3. **渠道条悬空**：适用渠道像临时控件，没和标题区咬合。  
4. **占位轨抢戏**：圆桌大虚线框压视觉重心。  

## 定调 V2

**名册行（roster）**，不是流程图。

```
┌ 会诊                              [+ 添加预置] ┐
│ kscc 内网 │ DeepSeek │ …     ← 渠道作分段 pill，不要「适用渠道」标签+宽 Select
│ 2 个预置 · 2 启用                              │
│                                                │
│ ┃ 默认会诊  内置                    [开关]     │
│   架构师 glm-5.2 · 实战派 kimi-k2.5 → 汇总 glm-5.2
│   超时 120s                    编辑   删除     │
│ ─────────────────────────────────────────────  │
│ �5.2
│   超时 120s                    编辑   删除     │
│ ─────────────────────────────────────────────  │
│ ┃ 省并发  内置                      [开关]     │
│   …                                            │
└────────────────────────────────────────────────┘
圆桌 · 即将推出（一行字，不要大虚线盒）
班组 · 即将推出（一行字）
```

### 硬规则

1. **删除**座位流程图 DOM：`汇` 圆、箭头、`agent-behavior-seats` 分叉布局。改成**一行** `seat · model` 用间隔点/`→` 连接（纯文字+轻 chip 可选，但单行）。  
2. **列表**：轻分隔行或极薄底，**不要**大圆角灰卡片堆叠；左侧 2px `primary` 竖条区分启用态即可。  
3. **渠道**：`agent-behavior-channel-pills` 横滑 pill（kscc 置顶）；当前选中实心/描边用 foreground 中性色，**少用大面积紫底按钮**（添加预置可用 outline/secondary）。  
4. **班组/圆桌**：合并到页底 `agent-behavior-upcoming` 两行小字，去掉大虚线 `track` 盒。  
5. **密度**：单条班底高度目标 ≤ ~72px（不含编辑展开）。  
6. 深浅跟 settings-shell；无新霓虹、无 emoji、无多层阴影。

## 必做文件

- `AgentBehaviorSettings.tsx`（PresetRow 结构）  
- `agent-behavior-settings.css`  
- 短 FINDINGS：`REDESIGN-CONSULT-CARDS-V2-FINDINGS.md`

## 验收

- [ ] 截图级：无「汇」圆、无箭头流程图  
- [ ] 渠道为 pill 段，非宽 Select+标签  
- [ ] 圆桌非大虚线框  
- [ ] CRUD / channelId 行为不变；typecheck 无新增错；不 commit  
