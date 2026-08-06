# REGRESS-D Brief — 思考链流式滚动跟随 + 结束后优雅折成「思考了 Ns」且可再打开

> 对照：Cursor 执行链；`CURSOR-CONCISE.md`  
> 派工：本机 `kscc -p --dangerously-skip-permissions`（禁止 Cursor Task）

## 现象（用户原话）

1. 思考链流式时是**展开的**，但在**滚动容器**里，底下不断输出却**滚动不跟随** → 看不见最新思考。
2. 思考完成后**没有**阶段性总结观感（应对齐 Cursor 灰字「思考了 Ns / 思考了片刻」）。
3. 该阶段结束后思考过程**瞬间消失**；结束后也**再也看不到**思考链（或以为看不到）。

## 根因（已定位，直接修）

1. **滚动不跟随**：`chat.css` `.agent-concise-fold__body` 有 `max-height: 220px; overflow: auto`，`ThinkingFold` 流式往 body 追加文字，**没有**把 scrollTop 钉到底。
2. **瞬间消失**：`ConciseTimelineView.tsx` `ThinkingFold`：
   ```ts
   useEffect(() => {
     if (isLive) setOpen(true)
     else if (wasLive.current && !isLive) setOpen(false) // ← 秒折，body 整段卸载
   }, [isLive])
   ```
   且 `{open ? body : null}` → 折起时正文从 DOM 删掉，无过渡；用户体感「秒没」。
3. **「再也看不到」**：折起后本应留下可点的「思考了 Ns」头；若 settle 太硬 + 无过渡，像消失。另：REGRESS-C 把中段思考埋进 `work_stage.steps`，折叠阶段摘要行**不提示有思考**，点开阶段才看得到——首轮 ThinkingFold 必须始终可点开回看全文。

## 必改（仅 concise ThinkingFold + 必要 CSS；full 零回归）

### A. 流式滚动跟随

- `ThinkingFold` body 加 `ref`；`isLive` 且 `displayedContent` 增长时，若用户未上翻（距底部阈值内，如 40px），`scrollTop = scrollHeight`。
- 用户主动上滚离开底部 → 暂停跟随；回到底部或再次 live 新段可恢复。
- 可选：思考块接近视口底部时，轻量 `scrollIntoView({ block: 'nearest' })` 让聊天主列表也跟得上（勿强行抢滚动打断阅读）。

### B. live→idle 优雅折进（禁止秒卸）

- **禁止** live→idle 立刻 `setOpen(false)`。
- 改为：结束先保持展开 **1.5–2.5s settle**（或短高度过渡），再收到「思考了 Ns / 思考了片刻」摘要行；折叠用 CSS max-height/opacity 过渡，**不要**无动画 `null` 卸 body。
- 折起后：**摘要头常驻**，点击可再展开看完整思考（内容仍在 props / 模型里，不得丢）。
- 用户在 settle 期间手动点收起 → 尊重用户，取消强制展开。

### C. 阶段性总结可见

- idle 后头栏必须是 `formatThinkingSummary(durationSec)`（思考了片刻 / 思考了 Ns），扫光停。
- 验收：思考结束后用户**不点开**也能看到这行灰字总结；点开能回看全文。

### D. 与 REGRESS-C 边界

- 不回退「阶段内普通思考进 steps」；但 **leading / 独立 ThinkingFold** 必须满足 A–C。
- 若独立 ThinkingFold 在工具开始后 `isLive` 变 false：走 B 的 settle，**不要**整段 segment 被删。

## 主要文件

- `ConciseTimelineView.tsx`（`ThinkingFold`）
- `apps/electron/src/renderer/styles/chat.css`（fold body 过渡；可加 `.is-collapsing`）
- 可选 vitest / 轻量 hook 测「距底跟随」纯函数
- `docs/dev/core-loop/CURSOR-CONCISE.md` 补一条思考 settle 验收

## 不做

- 不改 permission / REGRESS-A/B 流式双源 / 主进程 IR
- 不强制改 full ProcessGroupView（若 concise 修好即可；full 有同类秒折可顺手对齐但非必须）
- 不 commit / push

## 验收

1. live 长思考超过 220px：最新字始终在 fold 可视底（未手动上滚时）。
2. 思考结束 → settle → 折成「思考了 Ns/片刻」；**不**瞬间空白。
3. 折起后点击仍能展开全文；整轮结束后仍在。
4. concise 相关 vitest 绿；typecheck 绿。

## 交付

`REGRESS-D-FINDINGS.md`（短）+ 改动文件 + vitest/手测步骤 stdout。
