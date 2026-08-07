# REGRESS-J 实现 Brief — 阶段合并 / settle / 思考入块 / Files+Chip

> 规格：`REGRESS-J-stage-fragment-SPEC.md`  
> 对照用户 5 图。派工：`kscc -p --dangerously-skip-permissions`  
> 与 REGRESS-I 并行：撞 `ConciseTimelineView` / prompt 时**合并**勿覆盖。

## 必做（按优先级）

### 1. 碎阶段（J4/J7）— 主因

`concise-timeline-model.ts`：`cur.type === 'text'` 时 **无条件 `flushStage()`**（约 559–568）→ 每段 progress 短文都切断工具合并 → 「运行了 1 条命令」刷屏。

**修：**

- 短 progress / 非 final text：**不要 flushStage**（或仅当 text「像最终交付」才 flush）；工具继续累进同一 stage。  
- final 正文（回合末 / `tone=final`）才 flush 后外置 narrative。  
- 单测：tool → 短 text → tool → tool，期望 **1 个** work_stage（N≥2 tools），中间短文可作 stage 内注或忽略不拆。

**Prompt（J7）：** `output-style-prompt` 收紧「进度一句」——**不要每段思考都写**；仅阶段切换时偶发一句；禁止思考后必跟旁白。与「多点编号」并存。

**思考升 fold（J3）：** idle 时 `isDeliverableThinking` 升独立 fold 会 `flushStage` 拆阶段。改为：中段思考**默认留 stage.steps**（展开可见全文）；仅 leading / 整轮末大思考保留独立 ThinkingFold。目标：执行块内能找回完整思考。

### 2. 阶段秒折（J2）

`WorkStageFold`：对齐 `ThinkingFold` settle（~1.8s）+ panel 常驻，live→idle 不瞬间卸。

### 3. Files Changed（J5）

`TurnFilesChangedCard.tsx`：`.cpp/.h` 等落到 `kind:'file'` 显示丑点 `·`；`add/del===0` 也只显示 `·`。

- 徽章：按扩展名给可读缩写（C++/H/CS…）或统一文件图标，禁空洞圆点。  
- +/-：查 `extractToolDiff` / `collectTurnEditedFiles` 为何常 0；能解析则显示，不能则隐藏空点勿占位丑。

### 4. FileChip 路径（J6）

解析前 **normalize** `\` `/`（建议 path.posix 或统一 replace）；`basePath` 拼接勿混分隔符。单测：`D:\UnrealTagManager` + `Foo/Bar.h` → 存在性检查用规范化绝对路径。generated.h 可标注生成文件弱提示（可选）。

### 5. 复制按钮（若 I 未修）

`AssistantTurnView`：`processLive`/`isLiveTurn` 时不渲染 `MessageCopyButton`。

## 交付

- `REGRESS-J-FINDINGS.md` + `REGRESS-J-FIX-NOTES.md`  
- vitest：timeline 合并；path normalize；相关 typecheck  
- **不 commit**

## 验收（对照截图）

连续 Bash 多段 → 少「运行了 1 条」刷屏；阶段结束有 settle；思考在阶段展开内；Files Changed 不那么丑且尽量有 +/-；混分隔符 FileChip 误报下降；嘴碎感下降。
