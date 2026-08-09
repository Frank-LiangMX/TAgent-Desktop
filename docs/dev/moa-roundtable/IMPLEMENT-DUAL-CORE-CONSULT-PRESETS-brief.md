# Brief · 会诊班底双核设置（channelId + 渠道选择器）

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 规格：`docs/dev/moa-roundtable/05-CONSULT-PRESETS-DUAL-CORE-UX-SPEC.md`（必读）  
> 现码：`AgentBehaviorSettings.tsx`、`moa-preset.ts` / `moa-preset-service.ts`、`resolveConsultPresetsForChannel`、Chat ▾

## 目标

设置 → Agent 行为 → 会诊：顶部 **适用渠道** 切换；班底按 `channelId` 存盘；Pi/外部可配；无自定义仍合成兜底。

## 必做

1. **类型 / 校验**（`moa-preset.ts`）  
   - `MoAPreset.channelId: string`（必填于落盘；synthetic 可不带）  
   - `isValidMoAPreset`：要求非空 `channelId`（或迁移后再校验）  
   - `MoAPresetsFile.version` → `2`；提供 `migrateMoAPresetsV1toV2(presets, ksccChannelId)`  
   - `resolveConsultPresetsForChannel`：stored 先按 `p.channelId === channel.id`（兼容旧无字段视为 kscc），再跑现有可用性/合成逻辑  

2. **服务**（`moa-preset-service.ts`）  
   - 读文件时若 version&lt;2 或条目缺 channelId：绑到当前唯一 `kscc-internal` 渠道 id，写回 v2  
   - `validateMoAPresetList` / `writeMoaPresets`：整单校验含 channelId；保存时剥离 synthetic  
   - 单测：迁移、按渠过滤、外部有/无自定义  

3. **UI**（`AgentBehaviorSettings.tsx` + 必要 CSS）  
   - 会诊区顶：渠道 Select（kscc 置顶，其余 enabled 外部渠）  
   - 列表/新建/编辑/模型下拉 **只对应当前选中渠**  
   - 外部 0 模：禁新建 + 文案；1 模：允许同模多角色并提示；空列表：说明合成兜底 +「基于当前模型生成并编辑」CTA（生成一条 channel-default 或 same-model 形态的 draft 进编辑器，保存后带 channelId）  
   - 文案改掉「仅用于 kscc」→ 随选中渠说明  

4. **▾ / 主进程**  
   - 确认 `resolveConsultPresetsForChannel` + session-service 外部路径吃带 channelId 的 stored；无需在 ▾ 里跨渠选班底  

5. **文档**  
   - FIX-NOTES §12；`00-MASTER` / `05` 状态 → 已实现待手测  

## 验收

对照 SPEC §5；相关 vitest 绿；typecheck 无新增错；禁止 commit；同场不混核。

## 不做

班组/圆桌真表单；跨渠混席；改发送旁交互为跨渠选班底。
