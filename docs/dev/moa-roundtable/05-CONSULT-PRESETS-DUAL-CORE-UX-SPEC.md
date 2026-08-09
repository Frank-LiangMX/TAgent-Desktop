# 05 · 会诊班底双核设置 UX

> **状态**：V3 已落地（外部合并为 `external` 池；UI 去左侧竖线）  
> **简报**：`IMPLEMENT-CONSULT-V3-EXTERNAL-MERGE-brief.md` · 笔记 `IMPLEMENT-FIX-NOTES.md` §13  
> **背景**：运行时 Pi/外部会诊已有；设置曾按「一供应商一 pill」拆班底。用户要：**kscc | 外部** 两档，外部合并；视觉去 AI 左边条。

---

## 1. 产品原则

| 原则 | 说明 |
|---|---|
| **双档，不按供应商** | 设置顶栏仅 **kscc 内网** / **外部渠道**。外部存盘 `channelId = 'external'`（`MOA_EXTERNAL_SCOPE_ID`），不按 DeepSeek/Mimo 等各建一套。 |
| **运行时按当前渠校验席位** | ▾ 解析时：取本档 stored → 再要求席位全部属于**当前会话渠道**且 enabled；混了别家模型的班底在本渠不可用则过滤；空 → 合成兜底。 |
| **同场不混核** | 一张班底内不混 kscc 席 + 外部席（既有不变式）。 |
| **无自定义 → 合成兜底** | 外部会话无可用 stored 时，▾ 仍用 `channel-default` / `channel-same-model`。 |
| **设置可配覆盖合成** | 用户在对应档保存 ≥1 条且席位对本渠可用的班底后，▾ 优先用 stored。 |

视觉（对照 ui-ux-pro-max Flat / Minimal）：

- **禁止**名册行左侧 accent 竖条、大渐变卡、悬停抬升阴影。  
- 层级靠字重 / 间距 / hairline 分隔；pill 选中用描边 + 字重 + 浅 fill，非整颗紫/纯黑块。

---

## 2. 交互（设置 → Agent 行为 → 会诊）

```
┌ 会诊 ─────────────────────────────────────┐
│  [ kscc 内网 ]  [ 外部渠道 ]   ← 仅两档     │
│                                             │
│ （随档切换列表与模型下拉）                   │
│  [名册行…] [添加预置]                         │
└─────────────────────────────────────────────┘
```

1. **顶部两档 pill**（不是每供应商一 pill）  
   - kscc 内网 / 外部渠道。  
   - 当前档决定：列表数据、模型下拉、空态文案、落盘 `channelId`。  

2. **kscc 档**  
   - 行为 ≈ 现网 CRUD；模型下拉 = kscc 渠 enabled；`channelId` = kscc 真实 id。  

3. **外部渠道档**  
   - 模型下拉 = **所有已启用非 kscc 渠**的 enabled 模型 **按 id 去重合并**。  
   - 合并后仅 1 模：允许同模多角色；UI 提示。  
   - 合并 0 模：禁用新建。  
   - 空列表：说明未自定义时 ▾ 合成 + CTA「基于当前模型生成一版并编辑」（`buildExternalScopeDraftPreset`）。  
   - 落盘 `channelId = 'external'`。  

4. **编辑器**  
   - 同页编辑；模型源随档变。  
   - 保存写入该档 `channelId`；席位须落在当前档模型列表内。  

5. **发送旁 ▾**  
   - `resolveConsultPresetsForChannel(当前会话渠, stored)`：双档过滤 + 本渠席位可用性；不跨渠点选班底。  

---

## 3. 数据

```ts
export const MOA_EXTERNAL_SCOPE_ID = 'external'

interface MoAPreset {
  // …既有字段
  /** kscc 档 = kscc 渠 id；外部档 = 'external' */
  channelId: string
}
```

- `listMoaPresets()` 全量；设置 UI 按档滤；resolve 按档再按当前渠可用性滤。  
- 迁移：无 `channelId` → kscc id；遗留真实非 kscc 渠 id → `'external'`。  
- `synthetic` 仍不落盘。  

---

## 4. 不做（本包）

- 一张班底混双核席位  
- 跨会话渠强制可用混供应商席位（运行时仍按当前渠校验）  
- 圆桌/班组真表单  

---

## 5. 验收

1. 顶栏只有「kscc 内网」「外部渠道」。  
2. DeepSeek 会话 ▾ 能吃 `channelId=external` 且席位均在本渠启用的班底。  
3. 名册无左侧竖线；无大渐变抬升卡。  
4. 单测：迁移外部合并 + resolve 双档 + `buildExternalScopeDraftPreset`。  

---

## 6. 拍板记录

采用：**双档 pill + `channelId` 哨兵 `external`**（V3）。  
废弃：每供应商一 pill / 备选「内网|外部」下再选具体渠。  
