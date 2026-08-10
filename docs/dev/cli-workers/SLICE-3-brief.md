# SLICE-3 · 设置页「本地 CLI 工人」

> 总监 brief。`kscc -p --model glm-5.2` 实现。  
> 依赖 SLICE-1 IPC：`listCliWorkersConfig` / `saveCliWorkersConfig`（已在 electronAPI）。

## 目标

在 **设置 → Agent 行为** 增加一节，让用户开关本地 CLI 子代理（第一期仅 kscc）。

## UI 位置

文件：`apps/electron/src/renderer/components/settings/AgentBehaviorSettings.tsx`  
（可抽 `CliWorkersSettingsSection.tsx` 同目录 import，避免把会诊页撑爆。）

放在 **圆桌·快速之后、班组/即将推出之前**。

结构（对齐现有 SettingsSection / SettingsCard / Switch）：

```
SettingsSection
  title: 本地 CLI 工人
  description: 子代理可选用本机 coding CLI（先支持 kscc）。关闭时与现在一样用进程内子代理。不支持 Hermes 等编排器。

  SettingsCard
    行1：启用本地 CLI 工人  [Switch]  → cfg.enabled
    行2：子代理后端
      Segmented 或 Select：进程内 | 本地 CLI
      → defaultBackend 'in-process' | 'cli'
      （enabled=false 时后端选择可 disabled）
    行3：kscc 工人
      - bin 文本输入（默认 kscc）
      - 默认模型 文本输入（默认 glm-5.2）
      - 该工人 enabled Switch
    保存：任一变更后点「保存」或改完立即 save 整表（与 moa toggle 一致：立即 save 更简单）

  notice：成功/失败中文提示
```

## 逻辑

```ts
const [cfg, setCfg] = useState<CliWorkersConfig | null>(null)
// mount: listCliWorkersConfig()
// toggle enabled:
const next = { ...cfg, enabled: v }
// 若打开 enabled 且 backend 仍是 in-process，可自动把 defaultBackend 设为 'cli'（可选体验）
await window.electronAPI.saveCliWorkersConfig(next)
setCfg(await 再 list 或 save 返回值)
```

- save 失败：中文 error notice（IPC 已抛中文）  
- 不要做「测试连接」按钮也可以（可选：调 run 太重；MVP 可不做测试）  
- **不要**新增 PROBE IPC  

## 文案

- 关闭时副文案：「当前子代理使用进程内引擎。」  
- 打开且 backend=cli：「子代理将尝试 spawn 本机 kscc；不可用时自动回退进程内。」  

## 验收

- [ ] 默认进入设置：开关关、backend 进程内  
- [ ] 打开开关 + 选本地 CLI + 改模型 → 保存 → 重启设置仍在  
- [ ] 不破坏会诊班底 CRUD  
- [ ] 无 git commit  

## 禁止

- 新 Settings 顶层 tab  
- 多 CLI 列表编辑器  
- 改 task / runner  

## 完成后

`docs/dev/cli-workers/SLICE-3-DONE.md` + 可选更新 `docs/dev/cli-workers/00-MVP.md` 使用说明（3～5 行如何开启）。
