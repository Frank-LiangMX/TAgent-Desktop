# REGRESS-J FIX-NOTES — 外科式改动与验证

> 对 `REGRESS-J-stage-fragment-SPEC.md` 逐项落地。沿用 REGRESS-F/G/H/I 的未提交改动，未覆盖、未 commit/push。

## J1 / J4 — 碎阶段主因

- **文件**：`apps/electron/src/renderer/components/chat/concise-timeline-model.ts`
  - 新增 `SHORT_PROGRESS_MAX_CHARS = 20` + `isShortProgressText(text)`（`~346-360`）。
  - text 分支（`~582-597`）：idle + 非回合末 + 短 progress 时 `continue`（不 flushStage、不拆），工具持续累进同一 work_stage；回合末/无工具轮/较长实质叙述才 `flushStage` 后外置 narrative。
- **新增单测**（concise-timeline-model.vitest.test.ts）：
  - `短 progress 短文不拆 stage：tool → 短 text → tool → tool = 1 个 work_stage`
  - `较长的实质叙述仍作为阶段边界：work_stage | narrative | work_stage`

## J2（阶段秒折）

- **文件**：`apps/electron/src/renderer/components/chat/ConciseTimelineView.tsx`
  - 新增 `WORK_STAGE_SETTLE_MS = 1800`；`WorkStageFold` 换成 settle 效果：`stageActive` 激活时武装、结束时 hold 约 1.8s 再 `setOpen(false)`（对齐 ThinkingFold）；`handleToggle` 取消待执行 settle，尊重用户手动展开。
  - panel 已常驻（grid 0fr↔1fr，见 `chat.css:390-398`），折起后仍可点开明细。

## J3（思考入块，不再游离）

- **文件**：`apps/electron/src/renderer/components/chat/concise-timeline-model.ts`（thinking 分支 `502-567`）
  - 中段思考（`stageSteps.some(tool)`）**一律**入 `stage.steps`（live/idle 一致，key=cur.key 稳定不 remount）。
  - 仅「无活跃 stage（leading / 尾轮边界大思考）」才进独立 fold；否则普通思考跳过。
  - `isDeliverableThinking` 收敛为「无活跃 stage」时的兜底判据。

## J5（Files Changed 图标 + ±）

- **文件**：`apps/electron/src/renderer/components/chat/TurnFilesChangedCard.tsx`
  - `FILE_EXT_LABEL`：扩展名→缩写（.cpp→C++/.h→H/.ts→TS/.cs→CS/.java→JAVA/.md→MD…），未知扩展回退文件名首字母，杜绝 `·`。
  - `add/del===0` 不再渲染 `·` 占位。
- **文件**：`apps/electron/src/renderer/components/chat/concise-timeline-model.ts`
  - `extractToolDiff` 放宽：先试成队 `+N -M`，否则单边识别 `+N` 或 `-M`；都没有才 `undefined`（UI 据此隐藏）。
- **CSS**：`apps/electron/src/renderer/styles/chat.css` `.agent-files-changed__badge` width 自适应（`min-width:16px;padding:0 3px`），容纳 C++/JAVA/SWIFT 这类长缩写。

## J6（FileChip 规范化路径）

- **文件**：`packages/shared/src/utils/file-path.ts`
  - 新增 `normalizeFilePathSeparators`（反斜杠→`/`）与 `joinBasePath(base, relative)`（归一拼接绝对路径）。
  - ` existsCacheKey` 入参先归一 → 混用分隔符的同一文件命中同一缓存键。
- **文件**：`packages/ui/src/components/file-path-chip/index.tsx`
  - `displayPath` 改用 `joinBasePath` / `normalizeFilePathSeparators`，不再拼出 `D:\UnrealTagManager/Foo/Bar.h` 混分隔符。
- **新增单测**（packages/shared/src/utils/file-path.test.ts）：`normalize`、`joinBasePath('D:\\UnrealTagManager','Foo/Bar.h')→'D:/UnrealTagManager/Foo/Bar.h'`、`existsCacheKey` 分隔符等价。

## J7（prompt 收紧）

- **文件**：`packages/shared/src/utils/output-style-prompt.ts`（仅改第 15 行）
  - 由「每段思考之后…可写一句」→「工具阶段切换时**偶发**一句；非每段思考后必配；思考后禁止机械接旁白；连续同类工具不写」。REGRESS-I 的「多点编号」改动保留未动。

## J6-item（复制按钮）：**跳过** — `AssistantTurnView.tsx:299/395` 已是 `!processLive && (copyText || endFooter)`，REGRESS-I 已修，未重复改。

## 测试

- 更新既有用例（配合新规格，未删除）：
  - `concise-timeline-model.vitest.test.ts`：`shows per-thinking duration`、`lifts mid-run deliverable thinking to …`、REGRESS-I 的 `live 时 deliverable…idle 后升独立 fold′` → 中段 deliverable 留在 stage（合并 work_stage）；新增 J1/J4 两条 + 前两条提级为 J3 语义。
  - `regress-b-progress-live.vitest.test.ts`：`isLive=false` 两处断言改为「idle 短段间 progress 收敛进合并 work_stage、仅保留 final」；live 断言不变。

## 验证

- **vitest（单测）**：`npx vitest run apps/electron/src/renderer/components/chat/concise-timeline-model.vitest.test.ts packages/shared/src/utils/file-path.test.ts` → **全绿**（concise 26、file-path 21；process-group 36 不变）。
- **全量**：`npx vitest run` → **81 个 test 文件、793 用例全部通过**。
- **typecheck**：`apps/electron/node_modules/.bin/tsc.exe --noEmit -p apps/electron` → **exit 0**；同工具 `-p packages/shared`、`-p packages/ui` → **exit 0**（本机 `npx tsc` 会被误导装载 npm 无关包，改用 node_modules 内 tsc.exe）。
- 未 commit / push / stash。

## 风险与未做

- 分隔符归一后**缓存键格式**从「原样」变为「`/` 归一」，进程外旧缓存不迁移（仅影响进程内 Map，安全）。
- `extractToolDiff` 单边识别可能对含 `-数字`（如 `foo-2`）的编辑结果轻微误取 del；正常编辑结果结构（`+N -M` / `+N` / `removed M`）解析更完整。
- 未跑 GUI 人工视觉确认（数据/类型层已锁）；J2 settle 与 J5 徽章观感建议人工跑一轮对准。