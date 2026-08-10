# SLICE-5 · CLI 工人能力画像 + 委派 Agent 路由（require/prefer）

> 总监 brief。`kscc -p` 实现（建议 `--model glm-5.2 --permission-mode acceptEdits`）。**勿 git commit**。
> 前提：SLICE-1~4 已合入（CLI 工人池 + 四 runner + resolve-backend + 设置页）。
> 命名与决策以本 brief 为准；内部 id / bin / IPC 契约形状只做字段扩展，兼容旧配置。

## 目标

1. 每个 CLI 工人可携带**能力画像**：cost（成本档）/ reasoning（推理强度）/ modalities（含 vision）/ goodFor（适合场景一句话）。
2. 主 Agent 的 `task` 工具新增可选 `require` / `prefer` 参数，路由按能力**过滤 + 打分**，不再只按数组顺序。
3. task 工具描述注入启用池的「能力卡」，让主 Agent 能自选 `cli` + `require` / `prefer`（对齐交接文档 P2「委派 prompt 注入 CLI 能力卡」）。

## 边界（本刀不做）

- **不做 C3 设置 UI**（下一刀 SLICE-6）；本刀只加契约与读取，UI 后续补。
- 不做会话级工人选择器（P2，后续）。
- 不做多模态附件进 CLI 的传输管线（P2，后续）——本刀只给 vision 字段与过滤，附件路径后续再接。
- 不接 ACP；不做 Hermes 长驻/画布；不引入第五个硬默认开关。
- 不改 `task` 既有参数语义（`cli` 显式指定仍优先）。

## C1 · 契约（packages/shared/src/types/cli-workers.ts）

新增类型：

```ts
export type CliReasoning = 'low' | 'medium' | 'high'
export type CliModality = 'text' | 'vision'

export interface CliWorkerCapability {
  /** 粗略相对成本档：1 最便宜 ~ 5 最贵 */
  cost: 1 | 2 | 3 | 4 | 5
  reasoning: CliReasoning
  /** 输入模态；缺省 ['text']，显式含 'vision' 才支持视觉 */
  modalities?: CliModality[]
  /** 适合场景一句话（注入能力卡给主 Agent 自选用） */
  goodFor?: string
}
```

- `CliWorkerEntry` 增加 `capability?: CliWorkerCapability`（可选；旧配置缺省合法）。
- seed 四工人补能力默认：
  - kscc: `{ cost: 3, reasoning: 'high', goodFor: '跨层接线 / 编排 / 复杂实现' }`
  - grok: `{ cost: 2, reasoning: 'medium', goodFor: '探索 / 对照 / 草稿实现' }`
  - codex: `{ cost: 4, reasoning: 'high', goodFor: '长任务 / 深改造' }`
  - mimo: `{ cost: 1, reasoning: 'low', goodFor: '单测 / 机械改动 / 小包' }`
  （modalities 均缺省 = text-only）
- `isValidCliWorkersConfig` / `validateCliWorkersConfig` 扩展校验：capability 存在时 cost ∈ 1..5 整数、reasoning ∈ 枚举、modalities 数组元素 ∈ 枚举（允许重复无妨但建议去重）、goodFor 可选字符串。

新增纯函数（本文件，无 node 依赖）：

```ts
export interface CliCapabilityRequire {
  vision?: boolean
  reasoningMin?: CliReasoning
}
export interface CliCapabilityPrefer {
  costMax?: 1 | 2 | 3 | 4 | 5
  goodFor?: string
}

/** 无 capability 的旧条目按中性折算，避免旧文件整体垫底/顶格 */
export function resolveWorkerCapability(w: CliWorkerEntry): CliWorkerCapability

/** 硬性过滤：require.vision=true 需 modalities 含 'vision'；reasoningMin 按 low<medium<high 比较 */
export function workerSupportsRequire(
  w: CliWorkerEntry,
  require?: CliCapabilityRequire | null,
): boolean

/** 软性打分：cost 越低分越高（6-cost）；prefer.goodFor 关键词命中 worker.goodFor 加 3 分；无匹配返回 0 */
export function workerPreferScore(
  w: CliWorkerEntry,
  prefer?: CliCapabilityPrefer | null,
): number
```

规则：
- `resolveWorkerCapability`：有 capability 直接返回；缺省按 `{ cost: 3, reasoning: 'medium', modalities: ['text'] }`。
- `workerPreferScore`：`costMax` 不参与打分（它是上限约束，见 C2 候选过滤）；打分仅 cost + goodFor 命中。

## C2 · 路由

### taskSchema（apps/electron/src/main/lib/adapters/pi/subagent-task-tool.ts）

`taskSchema` 新增可选参数：

```ts
require: Type.Optional(Type.Object({
  vision: Type.Optional(Type.Boolean()),
  reasoningMin: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
}))
prefer: Type.Optional(Type.Object({
  costMax: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)])),
  goodFor: Type.Optional(Type.String()),
}))
```

描述注入：把现有 `cliHint` 替换为**能力卡**，格式（每启用工人一行）：

```
CLI 工人能力卡（按优先级）：
  kscc — cost 3 · reasoning high · text · 跨层接线 / 编排 / 复杂实现
  grok — cost 2 · reasoning medium · text · 探索 / 对照 / 草稿实现
...
可用参数：cli 指定其一；require 硬性（vision / reasoningMin）；prefer 软性（costMax / goodFor）。
```

### resolve-backend（apps/electron/src/main/lib/agent/cli-workers/resolve-backend.ts）

`ResolveTaskSubagentBackendOptions` 增加：

```ts
require?: CliCapabilityRequire | null
prefer?: CliCapabilityPrefer | null
```

解析顺序（保持「不整单失败」精神）：

1. 总开关 / backend≠cli / 无启用工人 → in-process（不变）。
2. 显式 `preferredCliId`：启用且本机可用且满足 require → 用之；不满足 require 或本机不可用 → console.warn 后回落池内（继续 3），不报错给主 Agent。
3. 候选 = 启用池按优先级，先 `workerSupportsRequire` 过滤（含 `prefer.costMax`：cost > costMax 也剔除——costMax 视为硬上限），再按 `workerPreferScore` 降序、同分保持数组顺序。
4. 从排序后候选逐个找本机 bin 可用者；全挂 → in-process。
5. 无 require/prefer 时行为与现状完全一致（按优先级取第一个本机可用）。

新增导出 `listEnabledCliWorkerCards(): string`（复用 `listCliWorkersConfig` + `resolveWorkerCapability`，关闭/未启用时返回空串），供 task 工具描述注入。`execute` 把 `params.cli / params.require / params.prefer` 传给 `resolveTaskSubagentBackend`。

## 验证

- `packages/shared/src/types/cli-workers.test.ts` 新增：
  - capability 校验（cost 越界 / reasoning 非法 / modalities 非法 / 缺省合法）
  - `resolveWorkerCapability` 缺省折算
  - `workerSupportsRequire`：vision 过滤、reasoningMin（low→high 链）、无 require 恒 true
  - `workerPreferScore`：cost 低分高、goodFor 命中加分、无 capability 中性兜底
- `apps/electron/src/main/lib/agent/cli-workers/resolve-backend.test.ts` 新增：
  - require vision 剔除不支持者
  - reasoningMin 过滤
  - prefer.costMax 硬上限剔除 + cost 打分排序
  - 显式 cli 不满足 require → 回落池内满足者
  - 全不满足 → in-process
- 全量 `vitest run` + `apps/electron` typecheck 全绿；`git status` 确认无意外改动文件。

## 验收标准

- 旧配置（无 capability 字段）加载/校验/路由不回归。
- 有 require 时绝不选中不支持视觉/推理不足的工人；prefer 只影响同合格候选中排序。
- task 工具描述能看到启用池能力卡；主 Agent 可据此指定 `cli` 或 `require/prefer`。

## 不做 / 下一刀

- SLICE-6：设置页 C3（每工人可编辑 cost / reasoning / vision / goodFor + 保存校验）。
- P2 会话级工人选择器、多模态附件传输。
