# REGRESS-O Brief — live 打字机总结「立刻消失」是 UI remount，不是数据丢

> 用户 2026-08-08：**打字机打出思考/阶段总结 → 立刻消失**；消息完成后**重启**看执行块内部是正常的。  
> 判断：数据层已有（M/N/commit），**渲染层把可见节点卸掉/换 key**。  
> 派工：`kscc -p --dangerously-skip-permissions`

## 根因假设（优先验证，极可能成立）

### O1 — stream→commit 换 key → NarrativeRow / SmoothStream remount（主嫌）

1. live：`holdStreamInProcess` 用 process key **`stream-text`** 打字机（`NarrativeRow`）
2. `tool_start`：`commitStreamTextToLastAssistant` 写入 message content，清 `streamState.text`
3. 下一帧：同一段文案变成 key **`text-${ownerKey}-${i}`** → React **卸载旧树、挂新树**
4. 新 `NarrativeRow` `seed=''` 起步；若一帧空内容 + REGRESS-N「无内容 return null」→ **秒空**；或打字机重来一截再被下一事件打断
5. 重启后只走落盘 message → key 稳定 → 执行块里「又正常了」

### O2 — 思考从 ThinkingFold 掉进折叠 stage.steps（次嫌）

中段思考并入 `work_stage.steps` 后，`WorkStageFold` **默认 `open=false`**，live 只露底栏「正在思考…」，**正文打字机不再外露**（注释写明「收起态不外挂思考」）。用户观感=总结消失；展开/重启后在执行块内可见。

### O3 — `isLastSegment` / `lastNarrativeKey` 切换导致旧 fold `isLive=false` + 空帧

次要；先修 O1/O2。

## 产品要求

- live 正在打的总结/思考**不得因 commit 或并入 stage 而视觉消失**
- 允许折进阶段，但须**连续**：同 key 或交接无空帧；或 live 时 stage 自动展开显示正在写的 thinking/progress
- 重启后与 live 终态一致（已基本满足，勿回退数据层）

## 必改

1. **稳定 key（O1）**：`buildTurnPresentation` / timeline：段间 progress 从 stream 迁到 message 时，**保持同一 React key**（例如内容指纹 `progress-${hash}` 或固定 `stream-text` 直到 turn 内该段结束）。`NarrativeRow` remount 不得清空已显示字符（可把 `displayedContent` 抬到父级或 seed 初始=已有全文）。
2. **live 思考可见（O2）**：正在流式的 stage 内 thinking：要么保持独立 ThinkingFold 直到该段 idle settle，要么 `WorkStageFold` 在 `stageActive && 末步为 thinking` 时自动展开并显示正文打字机（不要只扫光「正在思考…」）。
3. vitest + 必要时 RTL：模拟 stream-text → commit 同文 → **key 不变**或 displayed 不回落空。
4. 写 `REGRESS-O-FINDINGS.md`；更新 `HANDOFF-2026-08-08.md` 一句。
5. 不碰 MoA；不 commit。

## 主要文件

- `session-turn-model.ts`（process text key）
- `concise-timeline-model.ts`（narrative key）
- `ConciseTimelineView.tsx`（NarrativeRow / WorkStageFold / ThinkingFold）
- `stream-item-model.ts`（只读 commit 时机）

## 验收

1. 手测：concise 下段间总结打字机播出后**持续可见**直到被下一段合理替换，禁止闪空。
2. 中段思考 live 可见全文或稳定折进，禁止「打完就没、只有重启展开执行块才有」。
3. 相关 vitest 绿。

## 交付

FINDINGS + 改动列表 + 测试摘要 + 手测步骤（stdout）。
