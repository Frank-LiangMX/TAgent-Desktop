# SLICE-1 · 本地 CLI 工人：配置层（类型 / 落盘 / IPC）

> 总监 brief。本机 `kscc -p --model glm-5.2` 按此实现。  
> **只做配置层**，不接 task、不 spawn CLI、不做设置 UI（UI 在 SLICE-3）。

## 背景

TAgent 要把本机 coding CLI（第一期只 **kscc**）做成可选子代理后端。  
本 slice：用户级配置读写，默认 **关闭**（零行为变化）。

参考实现（必须照抄模式）：

- 类型：`packages/shared/src/types/moa-preset.ts`
- 服务：`apps/electron/src/main/lib/agent/moa-preset-service.ts`
- 路径：`apps/electron/src/main/lib/config/config-paths.ts` 的 `getMoaPresetsPath`
- IPC：`packages/shared/src/types/agent.ts` 的 `AGENT_IPC_CHANNELS` + `session-service.ts` handler
- preload：`apps/electron/src/preload/index.ts`
- App 类型：`apps/electron/src/renderer/App.tsx` 的 `electronAPI`

## 数据契约

文件：`~/.tagent[-dev]/cli-workers.json`（`getConfigDir()` + `cli-workers.json`）

```ts
export type CliWorkerBackend = 'in-process' | 'cli'

export interface CliWorkerEntry {
  id: string              // 第一期固定 'kscc'
  enabled: boolean
  bin: string             // 默认 'kscc'，可绝对路径
  defaultModel?: string   // 如 'glm-5.2'
}

export interface CliWorkersConfig {
  version: 1
  /** 总开关：false 时 task 永远 in-process */
  enabled: boolean
  defaultBackend: CliWorkerBackend
  defaultCliId: string
  workers: CliWorkerEntry[]
}

export interface CliWorkersFile {
  version: 1
  config: CliWorkersConfig  // 或扁平：直接 version+enabled+... 二选一，推荐扁平
}
```

**推荐扁平落盘**（更简单）：

```json
{
  "version": 1,
  "enabled": false,
  "defaultBackend": "in-process",
  "defaultCliId": "kscc",
  "workers": [
    { "id": "kscc", "enabled": true, "bin": "kscc", "defaultModel": "glm-5.2" }
  ]
}
```

### 默认 seed（文件不存在时）

- `enabled: false`
- `defaultBackend: 'in-process'`
- `defaultCliId: 'kscc'`
- `workers: [{ id: 'kscc', enabled: true, bin: 'kscc', defaultModel: 'glm-5.2' }]`

### 校验 `isValidCliWorkersConfig` / `validateCliWorkersConfig`

- version === 1
- enabled / defaultBackend 类型正确
- defaultCliId 非空字符串
- workers 数组；每条 id/bin 非空字符串，enabled boolean
- **deny-list**：`id` 或 `bin` 的 basename 命中 `hermes` / `openclaw`（大小写不敏感）→ **非法**（中文错）
- 非法整单拒写，不脏写（与 moa 一致）

### 导出辅助（给后续 runner 用）

```ts
/** 是否应尝试 CLI 工人（总开关 + backend=cli + 有对应 enabled worker） */
export function shouldUseCliWorker(cfg: CliWorkersConfig): boolean

/** 取 defaultCliId 对应且 enabled 的 worker；无则 null */
export function resolveDefaultWorker(cfg: CliWorkersConfig): CliWorkerEntry | null
```

## 文件清单（必须）

1. `packages/shared/src/types/cli-workers.ts` — 类型 + 校验 + seed + helpers  
2. `packages/shared/src/types/index.ts` — `export * from './cli-workers'`  
3. `packages/shared/src/types/cli-workers.test.ts` — 纯函数单测  
4. `packages/shared/src/types/agent.ts` — `AGENT_IPC_CHANNELS` 增加：
   - `LIST_CLI_WORKERS: 'agent:list-cli-workers'`
   - `SAVE_CLI_WORKERS: 'agent:save-cli-workers'`
5. `apps/electron/src/main/lib/config/config-paths.ts` — `getCliWorkersPath()`  
6. `apps/electron/src/main/lib/agent/cli-workers-service.ts`  
   - `listCliWorkersConfig(): CliWorkersConfig` — 无文件 seed 落盘  
   - `writeCliWorkersConfig(cfg): void` — 校验后 atomic write  
7. `apps/electron/src/main/lib/agent/cli-workers-service.test.ts`  
8. `session-service.ts` — 注册 LIST/SAVE handlers（SAVE 校验失败抛中文 Error）  
9. `preload/index.ts` — `listCliWorkersConfig` / `saveCliWorkersConfig`  
10. `App.tsx` electronAPI 类型补全  

## 验收

- [ ] 无文件时 `list` 返回默认（enabled false）并写出 seed 文件  
- [ ] 合法 save → 再 list 一致  
- [ ] hermes/openclaw 条目 save 失败  
- [ ] 相关 vitest 通过  
- [ ] 不改 task 工具、不改聊天 UI  

## 禁止

- git commit/push  
- 实现 spawn / observer / 设置 UI  
- 接入多个 CLI 逻辑（workers 里只有 kscc seed 即可）  

## 完成后

在 `docs/dev/cli-workers/SLICE-1-DONE.md` 写 5 行：改了哪些文件、如何跑测、遗留问题。
