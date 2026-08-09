# Brief · 设置「Agent 行为」+ 会诊班底 CRUD

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 规格：`docs/dev/moa-roundtable/04-AGENT-BEHAVIOR-SETTINGS-SPEC.md`（必读）

## 目标

设置页新增 **Agent 行为** tab：内含班组/会诊/圆桌三节；本轮只做会诊 stored 预置 CRUD + 另两节占位。

## 必做

1. **SettingsPage**：`SettingsTab` 增 `agent`；核心组插入「渠道」与「关于」之间；`AgentBehaviorSettings` 组件（可新文件 `AgentBehaviorSettings.tsx`）。  
2. **IPC**：`AGENT_IPC_CHANNELS.SAVE_MOA_PRESETS` + preload `saveMoaPresets` + App 类型；handler 调 `writeMoaPresets`，校验失败拒写并抛/返中文错。  
3. **moa-preset-service**：必要时导出校验错误信息（整单合法才写）；更新文件头注释「已有 UI CRUD」。  
4. **会诊 UI**：列表 + 新建/编辑 + 启用开关 + 参考席增删 + 汇总模型 + 超时；model 下拉吃 kscc-internal enabled 模型（读现有 channels API）。  
5. **FIX-NOTES §11** + `00-MASTER` 条目；相关单测。

## 验收

对照 SPEC §3；跑 vitest 相关 + electron typecheck 不增新债。禁止 commit / 禁止做班组圆桌真表单。

## 参考现码

- `SettingsPage.tsx`、`ChannelsSettings.tsx`  
- `moa-preset-service.ts`、`packages/shared/src/types/moa-preset.ts`  
- `LIST_MOA_PRESETS` IPC 接线方式  
