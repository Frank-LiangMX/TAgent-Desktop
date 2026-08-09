# REGRESS-O FINDINGS — live 打字机总结「立刻消失」是 UI remount / 折叠吞，不是落盘丢数据

> 日期：2026-08-08 ｜ 工作区：`C:\Users\loumi\Desktop\AI\TAgent-Desktop` ｜ 分支 `main`（未 commit）
> 规格：`docs/dev/core-loop/REGRESS-O-ui-swallow-brief.md`
> 用户原话：**打字机出思考总结立刻消失；完成后重启执行块内部正常 → UI remount/折叠吞掉，不是落盘丢数据。**
> 层：投影 `concise-timeline-model.ts` / 视图 `ConciseTimelineView.tsx` / commit `stream-item-model.ts`（只读）
> 范围：仅改 concise 时间线（投影 key + 视图 live 思考 + 测试 + 文档）；**未动任何 MoA 文件**；未 commit。

---

## 0. 根因一句话

**concise 段间 progress / 中段思考的 React key 在 live→落盘交接时改变 → `NarrativeRow` / 思考行被卸载重挂（seed 回 `''`）/ 被折进默认 `open=false` 的 stage 看不见；数据已落盘（M/N 已钉），重启走稳定 key 的落盘 message 故「又正常了」。**

- **O1（主嫌，已修）**：narrative 的 React key 跟着过程条目 key 走——live 只在 `streamState` 时 `holdStreamInProcess` 推 key=`stream-text` 的过程条目（`session-turn-model.ts:739-774`），下一帧 partial 快照带 text 块到达、`streamState.text` 被清（`stream-item-model.ts:77-84` `shouldClearStreamText`）→ 过程条目 key 换成 `text-${owner}-${i}`（`session-turn-model.ts:544`）。旧 `pushNarrative`（`concise-timeline-model.ts`）把 narrative key 直接取自该过程条目 key → `NarrativeRow` 卸载重挂 → 新实例 `seed=''`（`ConciseTimelineView.tsx:819-821`）→ REGRESS-N「无内容 return null」秒空（`:779`）+ 打字机重来一截。
- **O2（次嫌，已修）**：中段思考按 REGRESS-J(J3) 并入 `work_stage.steps`（`concise-timeline-model.ts:581-589`），`WorkStageFold` 默认 `open=false`（`ConciseTimelineView.tsx:466`），live 只露底栏「正在思考…」扫光（`getLiveStatusFromSteps`，`concise-timeline-model.ts:345-356`），**正文打字机不外露**——用户观感「打完就没、只有重启展开执行块才有」。

---

## 1. 取证（带行号）

### O1：narrative key 为何在 stream→commit 换 key？

1. **live 段间 progress 只活在 `streamState`**：`buildTurnPresentation` concise+live 时 `holdStreamInProcess = Boolean(isActive && streamText)`（`session-turn-model.ts:739-741`）；若过程区尚无 text 块（`lastTextIdx=-1`，partial 快照滞后或跨段首 delta），推 `{type:'text', key:'stream-text', text: streamText}`（`:769-773`）。
2. **过程条目 key 随快照换**：partial 快照带 text 块到达后，text 走 `allBlocks` 主循环进 process，key=`text-${ownerKey}-${blockIndex}`（`session-turn-model.ts:544`）；同时 `streamState.text` 被 `applySdkMessageToStreamState`/`shouldClearStreamText` 清空（`stream-item-model.ts:77-84`）→ `holdStreamInProcess` 因 `streamText=''` 不再推 `stream-text`。同一段文案的**过程条目 key 由 `stream-text` 换成 `text-${owner}-${i}`**。
3. **旧 narrative key 跟着过程条目 key 走**：旧 `pushNarrative(segments, cur.key, ...)` 新推时 `segments.push({kind:'narrative', key, ...})`（改前 `concise-timeline-model.ts:492`）——`key` 即过程条目 key。于是同一段 narrative 在帧 A=`stream-text`、帧 B=`text-${owner}-${i}` → `ConciseTimelineView` `<NarrativeRow key={seg.key}>`（`:118` / `:131`）**换 key → React 卸旧树挂新树**。
4. **重挂 → 秒空 + 重播**：新 `NarrativeRow` `useState(() => !isStreaming && text.trim().length>0 ? text : '')`（`:819-821`），live `isStreaming=true` → `seed=''`；`useEffect` 里若 `isOneShotTextJump(0, next.length)`（`>40` 字整段落盘）走 `armOneShot`（`:835-844`），先 `setSeed('')` 再 rAF 喂全文——**一帧 `seed=''` → `NarrativeSmoothBody` progress 分支「无内容 return null」（`:779`）= 秒空**，随后打字机从头重来。跨段短 progress（≤40 字，非 one-shot）同样有「`seed=''` 初渲染 → useSmoothStream 交一帧空」的闪空。
5. **重启正常**：历史轮 `isLive=false`，narrative 只来自落盘 message 的 text 块，key 恒为 `text-${owner}-${i}`（单源、无 `stream-text` 帧）→ 不 remount；且 `!isStreaming && text` → `seed=全文`（instant，不重播）→「执行块里又正常了」。**这正是用户判定的「UI remount 吞掉，不是落盘丢数据」**。

### O2：中段思考为何 live 看不见？

- REGRESS-J(J3) 把中段思考（当前阶段已执行过工具）一律并入 `stage.steps`（`concise-timeline-model.ts:581-589`），**不再升独立 ThinkingFold**（注释 `:576-580`：避免「思考游离 / 拆 stage / 思考→工具切换重排闪」）。
- `WorkStageFold` 默认 `open=false`（`ConciseTimelineView.tsx:466`），`stageActive` 时只靠 `getLiveStatusFromSteps` 在底栏扫光「正在思考…」（`ConciseTimelineView.tsx:509-515` + `concise-timeline-model.ts:345-356`）；思考正文（`StageStepRow` 的 `detailOpen` 详情，`:720-726`）**只在用户点开 stage 再点开该 step 才见**，且详情是 `step.thinking.trim()` 即时全文（非打字机）。
- 故 live 期间中段思考正文打字机**完全不外露**；idle/settle 后仍在折叠 stage 内（展开可见）→ 与用户「完成后重启执行块内部正常」一致。观感=「打完就没」。

### 与 O3 的边界（本轮不修，次要）

- 尾部 text 在 turn 结束后由 `progress` 升 `final`（`concise-timeline-model.ts:635`）：`ConciseTimelineView` 把 final narrative 移出 `processSegs`、单独渲染在 `RunQueueShell` 之外（`:52-57,129-136`）→ 不同父节点，React 必 remount。但升 final 发生在 `isLive=false`（`turn_end` 后），新 `NarrativeRow` `!isStreaming && text` → `seed=全文`（instant），**不闪空**。故 O3 不在本轮「立刻消失」路径，留作次要。

---

## 2. 改动（工作树，未 commit）

| 文件 | 要点 |
|------|------|
| `concise-timeline-model.ts` | **O1**：`pushNarrative`（`:487-507`）narrative key 改用位置下标 `narrative-${index}`（`= segments.filter(narrative).length`），不再取过程条目 key（`stream-text`/`text-${owner}-${i}`）；合并（同 tone 前缀）保留既有 key，不重编。同生长段内其前 thinking/work_stage/前序 narrative 均已落盘不变、新 narrative 只往后追加 → 位置下标稳定 → stream→commit 同段 key 不变 → 不 remount、不闪空。 |
| `ConciseTimelineView.tsx` | **O2**：新增 `LiveThinkingBody`（`:417-441`，`useSmoothStream` 逐字挤出，空帧用 thinking 全文兜底）；`WorkStageFold` 检测 `liveTailThinking = stageActive && 末步为 thinking`（`:481-483`），把末步思考正文打字机常挂在阶段摘要下、**折叠 panel 之外**（`:564-569`，收起也可见），不再只扫光「正在思考…」；末步是思考时底栏扫光让位（`rawLiveStatus`/`statusKeepWhileActive` 排除思考，`:494-498`）。思考结束（工具跟上 / settle）经 `useLiveStatusHold(raw, false)` hold 旧文 → 淡出 → 再折进 `stage.steps`（允许折进但须连续，禁止空帧）。不升独立 ThinkingFold，不回退 J3。 |
| `chat.css` | **O2**：`.agent-concise-stage__live-thinking`（`:1098-1122`，透明度+位移淡出，高度由卸载收避免长思考被裁剪；`prefers-reduced-motion` 关过渡）。 |
| `regress-o-ui-swallow.vitest.test.ts` | 新增 5 用例：O1 段内 / 跨段 / `tool_start` commit 三场景断言 **narrative key 跨 stream→partial→commit 不变且不空**；narrative key 形如 `narrative-${index}` 不泄露过程条目 key；O2 模型契约（中段思考为 stage 末步 step，视图据此外挂打字机）。 |

**未动**：`stream-item-model.ts`、`session-turn-model.ts`、`Chat.tsx`、所有 MoA 文件。`buildTurnPresentation` 的过程条目 key（`stream-text`/`text-${owner}-${i}`）**刻意保留**——它服务于过程区去重 / 单真源，不是 narrative 的 React key 源；narrative key 现与过程条目 key 解耦。

---

## 3. 为何位置下标稳定（不重编 / 不互撞）

- narrative 在段列表中的位置由其前的 thinking / work_stage / 前序 narrative 决定。同一生长段内，其前节点均已落盘（committed）不变；新 narrative 只往后追加 → 该段的 `segments.filter(narrative).length` 在帧 A（`stream-text`）/帧 B（`text-${owner}-${i}`）/帧 C（commit）三帧相同 → `narrative-${index}` 不变。
- 后续新段 narrative 取更大 index，不动既有；filler 被吞（`isFillerProgressText`）live/idle 同套（REGRESS-N 已钉），不引起 index 漂移。
- key 前缀 `narrative-` 与 thinking（`think-`）、work_stage（`stage-`）不撞；`processSegs`（progress narrative）与 `finalSegs`（final narrative）分属不同父节点，index 全局唯一故无同父冲突。
- O3 尾段 progress→final 跨父节点必 remount，但 `isLive=false` → `seed=全文`，不闪空（见 §1 末）。

---

## 4. 测试

```bash
npx vitest run apps/electron/src/renderer/components/chat/   # 10 files / 171 tests 全绿（含新增 5）
cd apps/electron && bun run typecheck                          # tsc --noEmit 0 错
```

- 新增 `regress-o-ui-swallow.vitest.test.ts` 5 用例全绿；现有 `regress-b-progress-live` / `concise-timeline-model` / `turn-presentation` / `stream-item-model` 等均不受影响。
- 关键用例「段内 stream-text → partial 带 text，同段 narrative key 不变且不空」：改前会因 key `stream-text` → `text-u1-0` 失败，改后两帧均为 `narrative-0` 通过——**反向证伪根因**。

---

## 5. 手测（验收，需 rebuild + 重启排除 build-lag）

1. `bun install`（如需）→ rebuild + 重启 TAgent-Desktop → 新会话 **concise** 模式。
2. 发「长思考 → 工具 → 段间短总结 → 工具 → …」型任务：
   - **验收 1（O1）**：段间总结打字机播出后**持续可见**直到被下一段合理替换，**禁止闪空 / 禁止重播一截**（partial 快照到达不再卸掉 NarrativeRow）。
   - **验收 2（O2）**：中段思考 live **可见正文打字机**（阶段摘要下一行逐字挤出，不只有「正在思考…」扫光）；工具跟上后思考 hold→淡出折进 stage，展开 stage 仍可见全文；**禁止「打完就没、只有重启展开执行块才有」**。
   - **验收 3**：重启 / 切回会话后与 live 终态一致（执行块内 narrative / 思考均在）。
3. 失败时抓该轮 live `.messages.jsonl`（`~/.tagent*/projects/<proj>/session-*.messages.jsonl`）+ 截图，对照 §1 两个根因。

---

## 6. 风险 / 未尽

- O2 的 `LiveThinkingBody` 与 `StageStepRow` 末步思考在 stage 展开（`open=true`）时会同时出现「打字机正文 + step 行标签」——轻度冗余但可读，未自动展开 stage（避免每段思考→工具来回 expand/collapse 的抖动）；若观感拥挤可后续把 step 行末步思考折叠为纯标签。
- O2 视图行为（打字机可见 / hold→淡出）未加 RTL 渲染测试：chat 目录现有测试均为 node 环纯函数测试，渲染 `ConciseTimelineView` 需 jsdom + mock rAF/`Intl.Segmenter` + `@tagent/ui` Message 组件，成本高且脆；按 brief「vitest + 必要时 RTL」取舍，O1 key 稳定（核心回归）已用真 reducer 在模型层钉死，O2 落手测（§5 验收 2）。
- 未实机回归（无本机 live DOM/JSONL 复现条件）；build-lag 是 REGRESS-K/N 反复踩的坑，手测前务必确认运行 App 含本轮改动。
