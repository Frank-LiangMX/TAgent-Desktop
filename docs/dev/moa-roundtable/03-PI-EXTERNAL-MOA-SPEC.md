# 03 · Pi / 外部渠道 MoA（会诊）

> **状态**：已实现（见 FIX-NOTES §9）· 待手测  

> **动机**：kscc 会诊已闭环；仅用外部渠（DeepSeek / OpenAI / Anthropic 兼容等）的用户也要能会诊，否则产品能力被锁死在内网。  
> **宪章**：`docs/plans/multi-runtime/05-moa-and-kscc.md` §3.3  
> **不变式**：同场不混核（一席 kscc + 一席外部）——本期不做。

---

## 1. 产品口径

| 项 | 决定 |
|---|---|
| 入口 | 与 kscc 相同：发送键旁 ▾「发送方式」→ 会诊本条（one-shot） |
| 会话 | 同会话；不写 sticky `moa:*`；选择器仍显示真实模型 |
| UI | 复用 `MoaRoundtableCard` / 席位 Sheet / 历史注入 |
| 范围 | **仅当前渠道**内的 enabled 模型组班；禁止跨渠席位 |
| 弱圆桌 | 渠道仅 1 个 enabled 模型：菜单仍可出「同模多角色」预置（文案标明），两参考席同 modelId、不同 system 角色提示；或隐藏会诊（实现选前者，便于单模外部用户也能用） |

---

## 2. 运行时分流

```
resolveMoADispatch / one-shot
  → validate 预置席位 ⊆ 当前 channel.models(enabled)
  → runMoaTurn(ctx)
       if channel.provider === 'kscc-internal'
         → 现有 spawnKsccBare 路径（不变）
       else
         → Pi HTTP 直连路径（createHttpDirectStreamFn / streamSimple，tools 语义=无工具）
```

- 编排层（并行参考 → fail-open → 汇总 → 圆桌卡事件 → 落盘 final）与 kscc **共用** `runMoaTurn` 骨架。
- 仅「单席怎么跑完一段纯文本」抽象为 seat runner：
  - `runKsccSeat(...)`（现有）
  - `runPiHttpSeat(...)`（新增：解密 apiKey + provider + baseUrl + modelId → 收集 assistant 文本）

**禁止**：外部渠误走 `spawnKsccBare`；kscc 误把外部 modelId 塞给 bare。

---

## 3. 预置解析（按渠道）

新增纯函数（建议 `@tagent/shared` 或 `moa-dispatch`）：

`resolveConsultPresetsForChannel(channel, storedPresets): MoAPreset[]`

| 渠道 | 行为 |
|---|---|
| kscc-internal | 现有 `listMoaPresets()`，再 `validateMoAPresetForChannel` 过滤不可用 |
| 外部且 enabled≥2 | 优先：stored 预置中席位全部命中本渠的；若无 → **合成**一条 `id: channel-default`：「默认会诊」，参考=前 2 个互异 enabled，汇总=`defaultModelId` 或第一个 |
| 外部且 enabled=1 | 合成 `id: channel-same-model`：「同模多角色」，两参考同 modelId + 不同 name/system（怀疑者/实操者），汇总=同一 modelId；菜单 trailing 标明「同模」 |

合成预置**不写** `moa-presets.json`（ephemeral），除非用户日后做 CRUD。

---

## 4. 门禁变更

放宽 `validateMoAPresetForChannel`：

- **删除**「仅 kscc-internal」硬拒（或改为：kscc 预置不能用在外部、外部合成预置不能用在 kscc——按 preset 来源 / 席位是否属于当前渠判定）。
- **保留**：参考≥2、每个参考/汇总 `findEnabledModel(channel, id)`。
- UI：`SendSplitButton` / Chat 拉预置时改为 `resolveConsultPresetsForChannel`；外部无可用预置则退回单发送键（与现逻辑一致）。

---

## 5. 历史 / 取消 / 落盘

与 `02-SESSION-UX-SPEC` 对齐：

- `buildHistoryForTurn` 共用  
- AbortSignal 取消未完成席  
- 圆桌卡 `moa_roundtable` 事件；final assistant 落盘（补齐 `message.role` 若顺手）  
- one-shot 不写 sticky `moa:*`

---

## 6. 验收

1. DeepSeek（或任意 ≥2 模型外部渠）会话：▾ 出现会诊 → 发本条 → 圆桌卡进度 → 汇总结论；选择器仍为真实模型。  
2. 会诊能引用前文（历史注入）。  
3. 仅 1 模型外部渠：仍可「同模多角色」会诊，菜单有「同模」提示。  
4. kscc 会诊回归：行为与现网一致。  
5. 单测：`resolveConsultPresetsForChannel`；Pi seat runner mock HTTP；dispatch 外部渠不再因 provider 硬拒。  
6. **不做**：跨渠混席、外部预置 CRUD 设置页、汇总席工具、ACP 圆环。

---

## 7. 风险

- 外部 API 费用：菜单副文案一行「将按预置席位分别计费」。  
- provider 映射：复用 `createHttpDirectStreamFn` / pi-adapter 已有 provider→pi-ai 映射，勿另起一套。  
- 超时：对齐 `timeoutMsPerSeat`；HTTP 首包超时勿用 30min 默认（会诊席用预置 timeout）。
