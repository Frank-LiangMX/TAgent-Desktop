# 实现 brief · MoA 预置挂模型选择器（完整闭环 · mimo 首包）

> **执行者**：`mimo run -m aicode/MiniMax-M3 --dangerously-skip-permissions`  
> **工作目录**：`C:\Users\loumi\Desktop\AI\TAgent-Desktop`  
> **规格**：必读 [`01-MOA-PRODUCT-SPEC.md`](./01-MOA-PRODUCT-SPEC.md) + `docs/plans/multi-runtime/05-moa-and-kscc.md` + `06` §3  
> **现有库**：`packages/pi-core/src/moa-orchestrator.ts`（`runReferenceModels` / `buildAggregatorPrompt`）  
> **产出**：改代码 + 单测；交卷写 [`IMPLEMENT-FIX-NOTES.md`](./IMPLEMENT-FIX-NOTES.md)

---

## 目标

把 MoA 做成 **可点的会诊预置**：选 `moa:<id>` → 发消息 → 主区圆桌卡 + 汇总结论。kscc 完整闭环。

---

## 建议落地顺序（可微调，但勿跳验收）

### A. 共享类型与预置存储

- `packages/shared`：`MoAPreset`、`isMoaModelId`、`parseMoaPresetId`、`moaModelId(presetId)`
- seed 默认预置（default / cheap），落 `~/.tagent/moa-presets.json` 或等价；提供 load/save
- 导出给 main + renderer（preload/IPC 若需要：`listMoaPresets`）

### B. ModelSelector

- kscc 可用时展示「会诊 · MoA」分组，条目绑定 `modelId: moa:<id>`，`channelId` = 当前/默认 kscc 渠道
- 选中 MoA 时隐藏 ReasoningSlider
- external 锁定会话不显示 MoA

### C. 运行时 `runMoaTurn`

- 新文件建议：`apps/electron/src/main/lib/agent/moa-turn.ts`（或 `runtime/moa-turn.ts`）
- `session-service.sendMessage`：检测 moa modelId → 走 `runMoaTurn`，**禁止** `setModel('moa:…')`
- 增强 `moa-orchestrator`：进度回调、AbortSignal；保持参考席 `tools: []`
- 汇总跑通（允许本期汇总无工具，须在 FIX-NOTES 写明）
- 推送 `moa_roundtable` 状态到渲染层（走现有 `sendPayload` / panel 双写习惯）

### D. UI 圆桌卡

- `MoaRoundtableCard`：进行中 / 完成 / 错误 / 取消
- 接入主时间线（哪条 turn 挂卡：与本轮 user 对齐）
- 席位详情只读
- CTA：复制；「按此建看板」能调起现有流程或先打桩为确认切 Work + 调用现有 create board API（能通就通，不能通写清缺口）

### E. 单测 + typecheck

见 SPEC §6。交卷前必须跑过。

---

## 禁止

- 改 hermes-studio  
- 引入 ACP SDK  
- 把 @ 圆桌/看板重做进本包  
- 伪造「已跑多模型」的假 UI（无运行时）  
- git commit / push（除非用户另令；本 brief 默认不 commit）  
- 使用 Cursor 云端子代理

---

## 交卷格式（IMPLEMENT-FIX-NOTES.md）

1. 改动文件列表  
2. 行为说明（如何触发）  
3. 已知缺口（留给 kscc 跟进）  
4. 测试命令与结果  
5. 未做项对照 SPEC §7  

返回总监：先 5 行摘要 + FIX-NOTES 路径。

---

## 验收清单

- [ ] 选择器可见 MoA 预置且可选  
- [ ] 发消息出圆桌卡 + 汇总结论（kscc）  
- [ ] `moa:*` 从不传给 kscc setModel/--model  
- [ ] MoA 时隐藏 reasoning 滑块  
- [ ] 单测 + typecheck 有记录  
- [ ] FIX-NOTES 诚实列出缺口  
