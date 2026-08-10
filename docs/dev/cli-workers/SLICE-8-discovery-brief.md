# SLICE-8 · 启动自动探测 + 动态工人池（只列本机实际安装的 CLI）

> 总监 brief。`kscc -p` 实现（建议 `--model glm-5.2 --permission-mode acceptEdits`）。**勿 git commit**。
> 前提：SLICE-5~7 已合入。
> 背景：当前 seed 写死 kscc/grok/codex/mimo，不装也占位（探测后显示「未找到」）；本机有 opencode 等却不被发现。本刀改成「启动时后台探测 PATH，工人池 = 本机实际安装 + 用户自定义」。

## 目标

1. 新增**发现目录**（已知 coding CLI 清单：id / bin 候选 / 是否有 runner / 默认能力），覆盖 kscc、grok、codex、mimo、**opencode**（opencode 暂无 runner，先「已检测·暂不支持派工」，runner 下一刀 SLICE-9）。
2. 应用启动时（`app.whenReady`）后台执行**探测 + 对账（reconcile）**：首次无配置文件 → 落盘 = 仅本机已安装的目录项；已有配置文件 → 增补新发现的、移除「目录项 + 默认 bin + 未安装」的占位行；用户自定义 bin / 自定义 id 一律保留。
3. 设置页「检测本机」按钮改为先对账再探测；无 runner 的工人显示「已检测·暂不支持派工」且**不参与 task 路由**。
4. Windows 探测补强：支持 WindowsApps 执行别名（Store 安装的 codex）与 npm 全局 shim（.ps1/.cmd）。

## 边界（本刀不做）

- **不做 opencode runner**（SLICE-9：先按 cli-probe 方式探测其 JSON/流式输出协议，再写 runner+observer）。
- 不改 cli-workers.json 契约字段（不新增持久化字段；`supported` 由 id 对照目录推导）。
- 不自动删除用户自定义工人；不自动删除用户改过 bin 的目录工人。
- 不改 require/prefer 路由语义（只把「无 runner」从候选中剔除）。

## 实现

### 1. 发现目录 + SUPPORTED 归位（packages/shared/src/types/cli-workers.ts）

```ts
export interface CliWorkerDiscoveryEntry {
  id: string
  /** bin 候选（按序探测，首个命中者采用） */
  bins: string[]
  /** 是否有对应 runner；false = 仅显示「已检测·暂不支持派工」，不参与路由 */
  supported: boolean
  defaultModel?: string
  capability?: CliWorkerCapability
}

export const CLI_WORKER_DISCOVERY_CATALOG: CliWorkerDiscoveryEntry[] = [
  { id: 'kscc', bins: ['kscc'], supported: true, defaultModel: 'glm-5.2', capability: { cost: 3, reasoning: 'high', goodFor: '跨层接线 / 编排 / 复杂实现' } },
  { id: 'grok', bins: ['grok'], supported: true, capability: { cost: 2, reasoning: 'medium', goodFor: '探索 / 对照 / 草稿实现' } },
  { id: 'codex', bins: ['codex'], supported: true, capability: { cost: 4, reasoning: 'high', goodFor: '长任务 / 深改造' } },
  { id: 'mimo', bins: ['mimo'], supported: true, capability: { cost: 1, reasoning: 'low', goodFor: '单测 / 机械改动 / 小包' } },
  { id: 'opencode', bins: ['opencode'], supported: false, capability: { cost: 2, reasoning: 'medium', goodFor: '通用编码 / 多 Agent 协作' } },
]

/** 有 runner 的工人 id（resolve 候选过滤 / run-cli-worker 路由 / UI 徽标共用） */
export const SUPPORTED_CLI_WORKER_IDS: readonly string[] =
  CLI_WORKER_DISCOVERY_CATALOG.filter((e) => e.supported).map((e) => e.id)
```

- `CLI_WORKERS_DEFAULT_SEED` 保留（兼容旧引用），但**新逻辑不再用它做首次落盘**（改为探测结果）。
- `apps/electron/src/main/lib/agent/cli-workers/run-cli-worker.ts`：删除本地 `SUPPORTED_CLI_WORKER_IDS`，改从 `@tagent/shared` 导入；未知 id 提示语列出 `SUPPORTED_CLI_WORKER_IDS`。

### 2. 启动对账（apps/electron/src/main/lib/agent/cli-workers-service.ts）

新增：

```ts
/** 探测目录 → 返回本机已安装的目录项（按目录顺序；每项记录命中的 bin 绝对路径） */
export function discoverInstalledCliWorkers(): Array<{
  entry: CliWorkerDiscoveryEntry
  resolvedBin: string
}>

/** 启动 / 「检测本机」：探测 + 对账落盘，返回对账后的配置 */
export function discoverAndReconcileCliWorkers(): CliWorkersConfig
```

对账规则：
- **无配置文件**：落盘 = 已安装目录项（`enabled: true`、bin=命中绝对路径、带 defaultModel/capability）+ 总开关 `enabled:false` / `defaultBackend:'in-process'` / `defaultCliId`=首个已安装且 supported 的 id。
- **已有配置文件**：
  - 已安装的目录项缺失 → append（enabled true，带默认能力/模型）。
  - 配置里 id ∈ 目录 且 bin 等于目录默认 bin（未改）且本机未安装 → **移除该行**（不再占位显示「未找到」）。
  - 用户自定义 id（不在目录）、或改过 bin 的目录工人 → 保留不动（找不到时 UI 仍如实显示「未找到」）。
  - 写回用 `writeCliWorkersConfig`（走整单校验 + 原子写 + capability 保留）。
- `listCliWorkersConfig()` 保持纯读（热路径不探测不写盘）；对账只在启动与「检测本机」触发。

### 3. 启动钩子 + PROBE 接线

- `apps/electron/src/main/index.ts` `app.whenReady`：`void discoverAndReconcileCliWorkers()`（不阻塞启动，失败仅 console.warn）。
- `session-service.ts` PROBE handler（`probeCliWorkers` IPC）：先 `discoverAndReconcileCliWorkers()` 再探测返回。

### 4. resolve 过滤无 runner 工人（resolve-backend.ts）

候选池过滤追加：`SUPPORTED_CLI_WORKER_IDS.includes(w.id)`（含显式 preferredCliId 不满足 supported → 回落池内，与 require 不满足同路径）；无 runner 工人永不进入候选。

### 5. 设置页 UI（CliWorkersSettingsSection.tsx）

- 徽标逻辑：`!SUPPORTED_CLI_WORKER_IDS.includes(w.id)` 时——已探测到 → `已检测·暂不支持派工`（is-miss 色）；未探测到 → 保持「未找到」。
- 行内（或名称后）对不支持工人加 `（暂不支持）` 小标，避免用户以为能派工。
- Section description 更新：「工人池 = 启动时自动探测本机已安装的 coding CLI + 手动添加的自定义工人；未找到的目录项不再占位」。

### 6. Windows 探测补强（resolve-bin-on-path.ts）

- `where.exe` 无 .cmd/.exe 命中时，追加 WindowsApps 执行别名兜底：`join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps', name + '.exe')` 存在即返回（Store 安装的 codex 走这里）。
- 保留「优先 .cmd 次 .exe」；`.ps1` npm shim 由既有 .cmd 路径覆盖。

## 验证

- `packages/shared/src/types/cli-workers.test.ts`：目录唯一性/非空、`SUPPORTED_CLI_WORKER_IDS === ['kscc','grok','codex','mimo']`。
- `apps/electron/src/main/lib/agent/cli-workers-service.test.ts`（新增对账用例，mock `discoverInstalledCliWorkers`）：
  - 无文件 → 仅已安装落盘（codex 未装则无 codex 行）。
  - 有文件 → 追加新发现（opencode）、移除「默认 bin + 未安装」占位行、保留自定义 id/改过 bin 的行。
  - 对账后配置通过 `validateCliWorkersConfig`。
- `resolve-backend.test.ts`：池内含 opencode（unsupported）时路由跳过它选 supported；全 unsupported → in-process。
- `apps/electron` typecheck + 全量 `vitest run` 全绿。
- 手测：本机（装有 kscc/grok/codex/mimo/opencode）启动后设置页见 5 行，codex 显示「可用」，opencode 显示「已检测·暂不支持派工」；task 路由只用支持的 4 个。

## 不做 / 下一刀

- SLICE-9：opencode runner + observer（先探测其输出协议，样式对齐 SLICE-4 的 cli-probe）。
- 自定义工人 runner 插件机制（未来）。
