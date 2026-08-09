# MoA 产品化 · 实现规格（Phase E 收窄完整版）

> **状态**：实现中  
> **宪章**：`docs/plans/multi-runtime/{05,06,07}.md` · ADR-0004  
> **取经**：`HERMES-STUDIO-TAKEAWAYS.md` T-02（预置挂 picker）  
> **范围**：kscc 核优先完整闭环；~~外部渠 MoA 本期不做~~ **已落地**——见 [`03-PI-EXTERNAL-MOA-SPEC.md`](./03-PI-EXTERNAL-MOA-SPEC.md) 及 `IMPLEMENT-FIX-NOTES.md` §9  
> **不做**：独立房间子系统、自由 DAG、Agent 自动开 MoA 无需确认（确认条可 P1）、多轮辩论 rounds≥2（本期固定 rounds=1）

---

## 1. 用户可见行为（验收故事）

1. 打开 kscc 会话，模型选择器出现分组 **「会诊 · MoA」**（或同组特殊条目），至少有预置：
   - **默认会诊**：参考 `glm-5.2` + `kimi-k2.5`；汇总 `glm-5.2`
   - **省并发**：参考 `glm-5.1` + `mimo-v2.5`；汇总 `glm-5.2`（或同等低成本组合，以启用模型为准）
2. 选中某预置后，触发器显示预置名（如「默认会诊」）；**隐藏 reasoning 滑块**（MoA 会话）。
3. 用户照常发一条消息 → 主时间线出现 **圆桌卡**（进行中：席位状态；完成：综合结论默认展开 + 各方可点）。
4. 点席位 → 抽屉/侧滑看该席全文（失败席标失败原因）。
5. 汇总结论作为本轮 assistant 主回答；参考席全文**不**刷满主线。
6. 完成卡上有 CTA：**复制**；**按此建看板**（若当前 Chat → 先确认切 Work，对齐 05 §7）。
7. 取消发送中：未完成席位被中止，卡标已取消。
8. 参考席全失败 → 主线明确错误，可提示切回单模型。

---

## 2. 数据契约

### 2.1 预置

```ts
/** 存 ~/.tagent/moa-presets.json；缺省 seed 写入 */
interface MoAPreset {
  id: string                 // 如 'default' | 'cheap'
  name: string               // UI 显示名
  enabled: boolean
  /** 参考席：至少 2；modelId 必须属于 kscc-internal 且 enabled */
  references: Array<{ name: string; modelId: string }>
  aggregatorModelId: string
  /** 单席超时 ms，默认 120_000 */
  timeoutMsPerSeat?: number
}
```

虚拟 modelId 约定：`moa:<presetId>`（如 `moa:default`）。  
**禁止**把 `moa:*` 传给真实 kscc `--model` / `setModel`。

### 2.2 会话 meta

- `modelId: 'moa:<id>'` 表示本会话当前选会诊预置（与普通 modelId 同一字段）。
- `channelId` 仍为 kscc-internal 渠道。
- 上下文窗口分母：取 **汇总模型** 的 `contextWindow` / `safeContextLimit`（对齐 Hermes `resolveMoaAggregator`）。

### 2.3 面板 IR / 流事件（建议）

在 panel JSONL / 推渲染的 payload 中增加可序列化结构（名称可微调，但语义固定）：

```ts
type MoASeatStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

interface MoARoundtablePanel {
  kind: 'moa_roundtable'
  presetId: string
  presetName: string
  topic: string
  seats: Array<{
    seatId: string
    name: string
    modelId: string
    role: 'reference' | 'aggregator'
    status: MoASeatStatus
    text?: string
    error?: string
    latencyMs?: number
  }>
  phase: 'references' | 'aggregating' | 'done' | 'error' | 'cancelled'
}
```

推送节奏：开跑 → 每席状态变更 → aggregating → done（带结论 text 在 aggregator 席或并列 `finalText`）。

---

## 3. 运行时钩子（主路径）

**切入点**：`session-service.ts` `sendMessage` 在 `resolveModel` 之后：

```
if (isMoaModelId(modelId)) {
  → runMoaTurn(...)   // 新模块，勿塞爆 session-service
  → return（不走普通 adapter.prompt / 勿对 kscc setModel(moa:…)）
}
```

`runMoaTurn` 职责：

1. 解析预置；校验参考/汇总模型均在当前 kscc 渠道 enabled；不足 2 参考 → 降级报错文案。
2. 落盘/推送 user 消息（与现核一致，kscc 双写规则照旧）。
3. 推送初始 `moa_roundtable` 卡（references pending）。
4. `runReferenceModels`（可增强现有 `moa-orchestrator.ts`：进度回调 `onSeatUpdate`；取消用 AbortSignal）。
5. 任一带失败 fail-open；全失败 → error 卡 + session_error，结束。
6. 汇总：用汇总 modelId **单独**跑一轮（kscc bare 或现有 adapter 一次性 prompt），system/user 用 `buildAggregatorPrompt`；**参考席 tools:[]**；汇总默认 **允许只读工具**（Read 等）——若现有 bare 工具接线成本高，本期允许汇总 **纯文本无工具**，在 FIX-NOTES 标明，下轮再开。
7. 流式汇总文本推主 assistant；同时更新卡 phase=done。
8. 支持 `abort`：与现 SessionRuntime 取消对齐，杀掉未完成 bare 进程。

**锁核**：MoA 仅 kscc；会话已 lock external 时选择器不展示 MoA；误发则抛中文错。

**热切**：从 `moa:x` 切回普通模型 / 互切预置 = 只改 meta.modelId，不调用 kscc `setModel('moa:…')`。

---

## 4. UI

| 件 | 位置 | 说明 |
|---|---|---|
| ModelSelector MoA 分组 | `ModelSelector.tsx` | 读预置列表；选中 → `onSelect({ channelId: ksccId, modelId: 'moa:…' })` |
| 隐藏 ReasoningSlider | ModelSelector / Chat | `isMoaModelId(selection.modelId)` |
| `MoaRoundtableCard` | 新组件，挂进主时间线渲染（`AssistantTurnView` 或 turn 投影） | 06 §3 示意 |
| 席位详情 | Drawer / 现有 sheet 模式 | 只读全文 |
| CTA | 卡底 | 复制；建看板（调现有看板创建 + Chat→Work 确认条） |

复用 SubAgent 卡片视觉可以，但 **purpose 语义是 moa-seat**，不要冒充 Task 工具卡。

---

## 5. 设置（E1 最小）

- Seed 两个预置即可；设置页完整 CRUD 可同 PR 做简单列表，或仅 JSON seed + 代码常量（须在 FIX-NOTES 写明）。
- 「圆桌参与池」完整设置页可 P1；本期用预置内写死的 modelId，发送前校验 enabled。

---

## 6. 测试与验收

**单测（必做）**

- `isMoaModelId` / 解析 presetId
- `buildAggregatorPrompt` 含失败席标记（已有可补）
- ModelSelector / selection：`moa:default` 在 resolve 逻辑中可用（mock channels）
- session-service 分支：moa modelId **不**调用 `setModel('moa:…')`（mock）
- 圆桌卡状态机：pending→ok / fail-open / all-fail / cancel（纯函数测）

**手工 / 脚本**

- kscc 会话选「默认会诊」发短问题，见卡 + 结论
- typecheck 相关包通过

**命令（实现者跑）**

```text
cd apps/electron && bun run typecheck
# 视新增测例路径
bunx vitest run <moa 相关测例>
```

---

## 7. 本轮不做

- ACP / context usage 圆环  
- @ 防递归（T-01）另包  
- rounds≥2 辩论  
- ~~外部渠道 MoA~~（已落地，见 `03-PI-EXTERNAL-MOA-SPEC.md`）
- 把 MoA 做成第五套独立 runtime / 独立 gc_* 房间表  

---

## 8. 派工顺序

1. **mimo `aicode/MiniMax-M3`**：按 [`IMPLEMENT-brief.md`](./IMPLEMENT-brief.md) 落地主链路 + 单测  
2. **kscc `glm-5.2`**：补洞、UI 抛光、E4 CTA、回归 typecheck（见后续 `IMPLEMENT-kscc-followup-brief.md`，mimo 交卷后由总监开）
