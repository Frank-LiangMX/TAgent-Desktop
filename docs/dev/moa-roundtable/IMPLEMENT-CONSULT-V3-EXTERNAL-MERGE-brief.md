# Brief · 会诊 V3：外部渠合并 + 去 AI 竖线

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 用户纠正：① **外部渠道合并**，不要一供应商一会诊；② **不要左侧竖线**（AI 味）。  
> Skill 参考：Flat / Minimal — 层级靠字重与间距，**禁止**装饰性左边条、大渐变卡、紫霓虹。

## A. 产品：双池，不是按供应商

设置会诊顶部分段 **仅两档**：

| 档 | 存盘 `channelId` | 模型下拉 |
|---|---|---|
| **kscc 内网** | 真实 kscc-internal 渠道 `id`（与现 seed 一致） | 该渠 enabled 模型 |
| **外部渠道** | 哨兵常量 **`external`**（导出 `MOA_EXTERNAL_SCOPE_ID = 'external'`） | **所有已启用非 kscc 渠**的 enabled 模型 **按 id 去重合并** |

运行时 `resolveConsultPresetsForChannel(channel, stored)`：

- `kscc-internal` → 只取 `channelId === kscc.id`（及 v1 无字段兼容）  
- 其它 provider → 只取 `channelId === 'external'`，再按**当前会话渠道**做 `presetSeatsUsableInChannel`；不可用则过滤；若空 → 现有合成兜底  

迁移：已落盘的非 kscc `channelId`（DeepSeek 等真实 id）→ 改写为 `external`。

UI：删「每个供应商一个 pill」；`isExternal` 池下空态/1 模提示按 **合并模型列表** 算（任一外部渠合计）。

## B. 视觉（对照 skill）

1. **删除** `.agent-behavior-row::before` / `--on` 左边 2px 竖条及一切 accent bar。  
2. 列表：纯分隔线（`border-bottom` hairline），无卡片渐变、无 hover 抬升阴影。  
3. 启用态：用字色/「已启用」小标签或 Switch，**不用**色条。  
4. 分段 pill：选中用 **描边+字重** 或浅 `settings-chip-fill`，避免整颗纯黑/紫块（可保留轻微对比）。  
5. 座位行保持单行文字；层级：标题 13–14px semibold，座位 11–12px muted。

## C. 验收

- [ ] 顶栏只有「kscc 内网」「外部渠道」两档  
- [ ] DeepSeek 会话 ▾ 能吃 `channelId=external` 且模型在本渠启用的班底  
- [ ] 无左侧竖线 class/样式  
- [ ] 相关单测更新（scope external、迁移、resolve）  
- [ ] FIX-NOTES 短节 + 不 commit  

## 不做

跨 kscc/外部混席；班组圆桌真表单。
