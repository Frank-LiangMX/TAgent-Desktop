# 04 · 设置 · Agent 行为（班组 / 会诊 / 圆桌）

> **状态**：已实现（见 FIX-NOTES §11）· 待手测  
> **动机**：会诊班底需 UI 可配；后续班组、圆桌设置同属「Agent 怎么协作」，不宜散落在渠道/通用里。  
> **本轮交付**：新设置 tab + **会诊班底 CRUD**；班组 / 圆桌仅占位。

---

## 1. 信息架构

设置侧栏新增 tab（建议放 **核心** 组，渠道之后）：

| id | 标签 | 说明 |
|---|---|---|
| `agent` | Agent 行为 | 班组、会诊、圆桌等协作策略 |

页内用 `SettingsSection` 分三块（顺序固定）：

1. **班组** — 占位文案：「后续在此配置角色班组 / 派工偏好。」（无表单）  
2. **会诊** — 本轮完整 CRUD（见 §2）  
3. **圆桌** — 占位：「@ 圆桌深度、共享记忆等后续在此配置。」（无表单）

视觉：**勿对齐 ChannelsSettings**（渠道=连接管理）。本页=协作策略板；会诊用座位芯片剧本卡 + `agent-behavior-*` 样式。见 `REDESIGN-AGENT-BEHAVIOR-UI-brief.md`。

---

## 2. 会诊班底 CRUD（本轮）

### 2.1 数据

- 读写 `~/.tagent[-dev]/moa-presets.json`（现有 `moa-preset-service`）  
- **只编辑 stored 预置**；`synthetic` / `channel-default` / `channel-same-model` **不进设置列表**（外部渠现场合成，无落盘）  
- 结构校验继续用 `isValidMoAPreset`（参考≥2、id/name 非空、modelId 非 `moa:` 前缀等）

### 2.2 IPC

| 通道 | 方向 | 说明 |
|---|---|---|
| 已有 `agent:list-moa-presets` | 读 | 不变 |
| **新增** `agent:save-moa-presets` | 写 | 入参 `MoAPreset[]`；主进程 `writeMoaPresets` + 再 `list` 回传；非法条目过滤或整单拒绝（实现选：**整单校验失败则 reject 中文错，不写盘**） |

preload / `Window.electronAPI` / App 手写类型同步补 `saveMoaPresets`。

### 2.3 UI 能力

- 列表：名称、启用开关、参考席摘要（`名·modelId`）、汇总 modelId、超时（若有）  
- **新建** / **编辑**（弹层或内联卡，跟 ChannelsSettings 编辑密度一致即可）  
- 字段：`name`、`enabled`、`references[]`（name + modelId，可增删，最少 2）、`aggregatorModelId`、`timeoutMsPerSeat`（可选，默认 120000）  
- `id`：新建时自动生成稳定 id（如 `custom-<短随机>`）；**seed 的 `default`/`cheap` 允许改内容，不允许改 id**；删除 seed 要二次确认（可删，删光则发送旁 ▾ 仅剩外部合成或空）  
- modelId 下拉：**优先列出 kscc-internal 渠道已启用模型**；若无 kscc 渠，允许手动输入 modelId（并提示「须在会诊时所属渠道启用」）  
- 保存成功后：本页刷新列表；可选 `CustomEvent` / 回调让 Chat 下次打开 ▾ 重拉（最小：Chat 已有挂载拉一次；设置页保存后不强制热刷新 Chat，可文档注明「新开会话或重开菜单前再拉」——实现若易则在保存后 `listMoaPresets` 广播，否则不做）

### 2.4 文案

- Intro：`Agent 行为` / 「配置会诊班底等协作策略」  
- 会诊区副文案：「班底仅用于 kscc 内网会诊；外部渠道按当前模型自动合成。席位无工具，查仓库请用普通发送。」

---

## 3. 验收

1. 设置出现 **Agent 行为** tab；班组/圆桌占位可见。  
2. 会诊：新建 → 保存 → 重启或重开设置仍在；编辑启用/模型 → ▾ 菜单反映（重拉后）。  
3. 非法预置（参考&lt;2）保存失败有中文提示，文件不被脏写。  
4. 单测：`writeMoaPresets` / save IPC 校验（或 service 层）；`isValidMoAPreset` 既有测保留。  
5. typecheck 无新增错；不 commit。

## 4. 不做

- 班组 / 圆桌真实表单  
- 跨渠混席、外部合成预置编辑  
- 设置页大改视觉  
- ACP / 汇总只读工具  
