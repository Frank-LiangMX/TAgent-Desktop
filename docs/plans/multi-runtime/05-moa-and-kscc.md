# 05 — MoA 会诊与 kscc 模型池

> 所属：[multi-runtime](./README.md)  
> 关联：ADR-0004  
> 拍板：D4, D5, D14  
> 代码：`packages/pi-core/src/moa-orchestrator.ts`  

---

## 1. 经典 MoA 是什么

```
用户议题
   ├─ Seat A（模型/角色）并行独立回答 ─┐
   ├─ Seat B …                        ├─► Aggregator 汇总 → 最终结论
   └─ Seat C …                        ─┘
```

| 问题 | 答案 |
| --- | --- |
| 是否并行？ | **是**（参考层） |
| 第一轮是否互相同步交流？ | **默认否** |
| 多轮辩论？ | 可选 `rounds ≥ 2`（看 peers 摘要再修订） |
| 与看板区别 | 同题多答 vs 不同任务交付 |
| 与 @ 区别 | 交卷会诊 vs 群聊插话 |

现有实现：`runReferenceModels` + `buildAggregatorPrompt`；参考层 `tools: []`。

---

## 2. 模型与班底控制权

优先级（高→低）：

1. 用户本轮点名模型/模板  
2. 用户保存的班底模板  
3. 角色 `modelPool`  
4. 主会话在 **启用参与池** 内自动挑（多样性+成本）  
5. 池不够 → 降级并说明  

主会话 **不得** 调用未接渠道/未启用模型。

### 2.1 设置项（产品）

- **圆桌参与池**：勾选可上场的 modelId（按渠道）  
- **默认汇总模型**  
- **预置模板**：默认会诊 / 省并发 / 长上下文  
- **是否允许 Agent 自动提议 MoA**（默认建议「要确认」）  
- **是否允许 Agent 改模板内模型**（默认否）  

---

## 3. kscc 渠道（D14）

### 3.1 为什么特殊

`kscc-internal` seed 即带多模型（见 `KSCC_DEFAULT_MODELS`）：

- glm-5.1 / glm-5.2  
- kimi-k2.5 / k2.6  
- mimo-v2.5 / mimo-v2.5-pro  

**用户不必先接三个外部 API** 才能 MoA。  
一渠多模 + OAuth = 默认会诊首选池。

### 3.2 kscc 默认策略

| 项 | 建议 |
| --- | --- |
| 主会话在 kscc | 会诊默认全 kscc 内 modelId |
| 默认模板 | 参考：glm-5.2 + kimi-k2.5；汇总：glm-5.2 或 mimo-pro |
| 席位数 | 默认 2 参考 + 1 汇总；勿默认 6 席 |
| 多样性 | 参考席模型尽量互异；避免三席同 glm 踩并发降智 |
| 上下文 | 只喂议题+摘要；尊重 safeContextLimit |
| enabled < 2 参考 | 降级单模型或提示启用更多模型 |
| 跨外部 | 默认不跳；高级混合显式 |

### 3.3 外部渠道用户

- 仅 1 模型：弱圆桌（同模多角色）须标明；或引导用 kscc 开会诊  
- 多外部模型：可在参与池跨渠（成本自负；实现期再定合规文案）  

### 3.4 与看板跨渠规则

对齐 1.0 精神：kscc 看板工人不随意跳外部付费渠；会诊同渠优先。

---

## 4. 角色化 MoA（目标形态）

```ts
interface MoARoundtableConfig {
  topic: string
  seats: Array<{ roleId: string; modelId?: string }>
  rounds: number              // 1 = 经典
  aggregatorRoleId: string    // 如 moa-synthesizer
  allowToolsOnAggregator: boolean
  timeoutMsPerSeat: number
}
```

内置 MoA 向角色（可仅 `runtimeModes: ['moa-seat']`）：

- `moa-synthesizer`  
- `moa-skeptic`  
- `moa-operator`  

业务席从库借：analyst / reviewer / security-* 等。

SeatPlanner：manual | by-tags | preset-crew | diverse-models。

---

## 5. UI 与可见性

见 [06](./06-ux-visibility-and-layout.md)。摘要：

- 主会话：圆桌进度卡 + 结论  
- 点席位：该 run 全文  
- 默认不进侧栏会话列表  
- 结论 CTA：`按此建看板` / 复制  

---

## 6. 与 1.0 Hermes borrow 的关系

General `2026-07-03-hermes-borrow-plan` **评审缓做完整 MoA**（成本、与看板/SubAgent 重叠）。

Desktop **重开但收窄**：

- 定位：决策增强 / 会诊，不替代看板  
- 默认 kscc 池降成本  
- UI 与 SubAgent 共用 ChildRun  

不恢复「无场景的大而全 MoA runtime」为 P0。

---

## 7. 失败与降级

| 情况 | 行为 |
| --- | --- |
| 单席超时/失败 | fail-open；卡上标失败；汇总带残缺 |
| 全席失败 | 明确错误；可回退主会话单模型 |
| 用户取消 | 杀未完成 run |
| Chat 中点「建看板」 | 先要求用户确认切 Work（若尚未 Work） |

---

## 8. 修订

| 日期 | 说明 |
| --- | --- |
| 2026-08-02 | 初版 |
