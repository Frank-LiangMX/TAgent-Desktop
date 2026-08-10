# SLICE-6 · 设置页 C3：CLI 工人能力画像可编辑

> 总监 brief。`kscc -p` 实现（建议 `--model glm-5.2 --permission-mode acceptEdits`）。**勿 git commit**。
> 前提：SLICE-5 已合入（契约 + 路由 + 能力卡注入已生效，全量测试 1348 通过）。
> 本刀只做设置页 UI，**不改 shared 契约**（`CliWorkerCapability` / `resolveWorkerCapability` / 校验均只读使用）。

## 目标

在「设置 → Agent 行为 → 子代理 → 本机 CLI 工人池」的高级区，为每个工人提供**能力画像编辑**：
成本档（cost）、推理强度（reasoning）、视觉输入（vision 开关）、适用场景（goodFor）。
保存后主会话 `task` 的 require/prefer 路由与能力卡描述立即按新值生效（新会话/新 task 创建时读取）。

## 边界（本刀不做）

- 不改 `packages/shared/src/types/cli-workers.ts` 任何已有类型/函数/校验（SLICE-5 已完成）。
- 不改 IPC（LIST/SAVE/PROBE 形状不变）。
- 不做会话级工人选择器、多模态附件传输（后续 P2）。
- 不在主列表行加能力摘要 UI（保持克制；能力编辑只放高级区）。

## 实现（apps/electron/src/renderer/components/settings/CliWorkersSettingsSection.tsx）

### 1. 引入

从 `@tagent/shared` 增加：

```ts
import {
  resolveWorkerCapability,
  type CliReasoning,
  type CliWorkerCapability,
} from '@tagent/shared'
```

### 2. 能力编辑更新函数

新增 `updateWorkerCapability(id, patch: Partial<CliWorkerCapability>)`，复用现有 `updateWorkerField` 模式：

- 基础 = `resolveWorkerCapability(w)`（旧配置无 capability 时给中性默认 `{ cost: 3, reasoning: 'medium', modalities: ['text'] }`，编辑即落显式字段）。
- 合并 patch 后整体写回 `capability`（保证字段完整，避免残缺对象）。
- 视觉开关处理：`vision: boolean` → `modalities: vision ? ['text', 'vision'] : ['text']`；cost/reasoning/goodFor 直接透传。
- 沿用现有 `setCfg + setDirty(true)`；blur 保存走既有 `handleWorkerBlur`。

```ts
const updateWorkerCapability = useCallback(
  (id: string, patch: Partial<CliWorkerCapability>): void => {
    const cur = cfgRef.current
    if (!cur) return
    setCfg({
      ...cur,
      workers: cur.workers.map((x) =>
        x.id === id
          ? { ...x, capability: { ...resolveWorkerCapability(x), ...patch } }
          : x,
      ),
    })
    setDirty(true)
  },
  [setCfg],
)
```

### 3. 高级区每行加 4 个能力字段

现有高级行布局（`cli-workers-adv-row` + `cli-workers-field`）后追加：

- **成本**：`<select>`，选项 `1 ~ 5`（1 最便宜 ~ 5 最贵），值 = `resolveWorkerCapability(w).cost`，onChange 更新 cost，onBlur 保存。复用 `cli-workers-field-inp` 样式。
- **推理**：`<select>`，选项 low / medium / high（中文标签：低 / 中 / 高），同理。
- **视觉**：`<label className="cli-workers-check">` + checkbox，勾选 = `modalities: ['text','vision']`，不勾 = `['text']`；onChange 直接更新（checkbox 无 blur，保存走 onChange 后调 `handleWorkerBlur` 或直接在 onChange 里 save）。
- **适用场景**：`<input>`（复用 `cli-workers-field-inp`），值 = `resolveWorkerCapability(w).goodFor ?? ''`，onChange 更新 goodFor（空串存 undefined），onBlur 保存。

字段 label 文案：成本 / 推理 / 视觉 / 适用场景。

### 4. 文案与提示

- 「高级（路径 / 模型）」按钮文案改为「高级（路径 / 模型 / 能力）」。
- 工人池 Section description 追加一句：高级里可编辑各工人能力画像（成本 / 推理 / 视觉 / 适用场景），主会话 task 按 require / prefer 挑选。
- 若 CSS 需要：`agent-behavior-settings.css` 追加最小样式（如能力行 select/checkbox 对齐 `.cli-workers-field` 现有风格），不改既有类语义。

## 验证

1. `apps/electron` typecheck 通过（`node apps/electron/node_modules/typescript/bin/tsc --noEmit`）。
2. 全量 `vitest run` 通过（本刀 UI-only，不应破坏既有用例）。
3. 手测清单：
   - 设置 → Agent 行为 → 子代理 → 后端=本机 CLI → 高级：每个工人可见 成本/推理/视觉/适用场景。
   - 改 kscc：cost=2、推理=中、勾视觉、goodFor=「快速原型」→ 失焦/保存提示「已保存」；重新进入设置值仍在。
   - 旧配置（无 capability 字段）打开高级区：显示中性默认（cost 3 / 中 / 无视觉），编辑任意字段后保存，落盘出现 capability 完整对象。
   - 改 goodFor 后新建会话，task 工具描述里的能力卡对应行已更新。

## 不做 / 下一刀

- P2 会话级工人选择器、多模态附件传输。
- 主列表行的能力摘要、能力画像的「require/prefer 快捷示例」等增强。
