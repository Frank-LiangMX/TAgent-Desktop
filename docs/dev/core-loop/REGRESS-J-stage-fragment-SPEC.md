# REGRESS-J 规格 — concise 阶段碎裂 / 秒折 / 思考游离 / FilesChanged / FileChip

> 日期：2026-08-07  
> 用户截图 5 张 + 口述。与 REGRESS-I（闪烁/复制按钮）并行，本规格管**阶段结构与视觉**。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`

## 症状 ↔ 期望

| # | 用户说 | 期望（对齐 Cursor） |
|---|--------|---------------------|
| J1 | 阶段排版乱；一张图里「运行中」下又一个「运行了 1 条命令」叠碎 | 同一活跃阶段一条灰字摘要；展开才见步骤 |
| J2 | 阶段执行结束**秒折叠**，像突然消失 | 对齐思考 settle：结束后 hold ~1.5–2s 再折，可再点开 |
| J3 | 阶段有思考，但思考块不在执行块内，找不到完整思考 | **中段思考进 `work_stage.steps`**；不要动辄升独立 ThinkingFold 打断阶段；点开阶段能回看思考全文 |
| J4 | 太多「运行了 1 条命令」行 | **合并相邻同阶段工具**：连续 Bash/探索不应每条命令一个 stage；progress 短文不应每句都 `flushStage` |
| J5 | Files Changed：图标丑、无 +/- | 用正经文件图标或扩展名；显示 add/del（已有 `diffAdd`/`diffDel` 数据则露出） |
| J6 | FileChip「不存在」；路径 `D:\foo/bar` 混用分隔符 | 规范化路径再 resolve；generated.h 等生成文件可弱化「不存在」或按项目规则解析 |
| J7 | 只要思考就输出总结 → 一思考+一命令=一阶段，嘴碎 | **收紧**：非必要不吐段间 progress 短文；UI 侧：无实质工具合并前的纯短文不要拆 stage；trivial/短思考不单独成段 |

## 根因假设（须取证）

1. **碎 stage**：`buildConciseTimeline` 遇 `narrative`/独立 thinking 就 `flushStage` → 每工具一阶段（见 `concise-timeline-model.ts` 循环）。松绑「一句进度」后模型更爱插 text → 更碎。  
2. **思考游离**：`isDeliverableThinking` idle 后升独立 fold，或 leading/独立 fold 与 stage 双轨。  
3. **秒折**：`WorkStageFold` live→idle 无 settle（对比 `ThinkingFold` 已有）。  
4. **FileChip**：拼接 `basePath + relative` 未统一 `/` `\`。  
5. **Files Changed**：`TurnFilesChangedCard` 用圆点占位，未渲染 diff。

## 本轮不做

- 不重做整套 concise  
- 不 commit（除非用户说）  
- AskUserQuestion（H）另轨

## 派工切片

| 切片 | 内容 | 产出 |
|------|------|------|
| J-A | 阶段合并 + 思考留在 stage + 少拆 stage（模型 prompt 收紧 + timeline 规则） | FINDINGS + 改动 |
| J-B | WorkStageFold settle 不秒折 | 改动 |
| J-C | Files Changed 图标 +/- | 改动 |
| J-D | FileChip 路径规范化 | 改动 |

可一个 kscc 串行；与 REGRESS-I 撞文件时合并。

## 验收

1. 连续多条 Bash：多数情况 **一条**「运行了 N 条命令」，不是 N 条「运行了 1 条」。  
2. 阶段结束有 settle，非瞬间空白。  
3. 阶段内思考可在展开 steps 看到全文。  
4. Files Changed 有可读图标 + +/-（有数据时）。  
5. 常见 `D:\proj\a/b.ts` 混分隔符能 resolve；误报「不存在」明显下降。  
6. 段间 progress 不再几乎每工具一句拆舞台（prompt + 规则双控）。
