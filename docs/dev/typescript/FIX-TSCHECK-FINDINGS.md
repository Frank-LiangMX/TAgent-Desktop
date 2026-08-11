# FIX-TSCHECK 结果：apps/electron TypeScript 检查清零

> 对应 brief：`docs/dev/typescript/FIX-TSCHECK-brief.md`
> 仓库根：`F:/TAgent-Desktop` ｜ 分支：`main` ｜ 日期：2026-08-11

## 跑法

仓库 `apps/electron/package.json` 的 `typecheck` 脚本是 `tsc --noEmit`（`apps/electron/tsconfig.json`，`include: ["src/**/*"]`，继承根 `tsconfig.json`：`strict + noUncheckedIndexedAccess + noFallthroughCasesInSwitch` 等）。

本机 Git bash 沙箱会 fork 失败（见 memory），故关沙箱用绝对路径直跑 TypeScript 5.9.3：

```bash
node node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p apps/electron/tsconfig.json
```

修前修后均用同一命令。

## 修前 / 修后摘要

| | 修前 | 修后 |
|---|---|---|
| `error TS` 条数 | **22** | **0** |
| 退出码 | 2 | 0 |
| 涉及文件 | 4 | 0 |

**修前 22 条错误（按文件）**：

1. `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts` — 4 条 TS2532（`obs.calls[0]` / `pi[1]` 在 `noUncheckedIndexedAccess` 下为 `T | undefined`，属性访问报 possibly undefined）
   - 行 454 / 468 / 469 / 495
2. `apps/electron/src/main/lib/agent/no-progress-guard.ts` — 2 条
   - 行 175 TS2532：`s[0].toLowerCase()`（`s[0]` possibly undefined）
   - 行 230 TS2322：`parts[0]`（`string | undefined` 不可赋给 `string`）
3. `apps/electron/src/main/lib/agent/no-progress-replay.test.ts` — 15 条
   - 行 98–101 TS18048：`warnDecision` possibly undefined（4）
   - 行 114–116 TS18048：`last` possibly undefined（3）
   - 行 126–129 TS2532：循环里 `pi.decisions[i]` / `kscc.decisions[i]` possibly undefined（8，每行两侧各一）
4. `apps/electron/src/main/lib/ipc/session-service.ts` — 1 条 TS2322
   - 行 1701：`NoProgressEvent` 不可赋给 `{ type: string; [key: string]: unknown }`（缺索引签名）

**修后**：0 条，`tsc --noEmit -p apps/electron/tsconfig.json` 干净通过（exit 0）。

## 改动文件列表（4 个，全部仅类型/窄补丁，零运行时行为变更）

### 1. `apps/electron/src/main/lib/agent/no-progress-guard.ts`
- **行 175**：`s[0].toLowerCase()` → `s.charAt(0).toLowerCase()`。
  正则 `/^[A-Za-z]:[\\/]/` 已保证 `s` 以盘符开头（长度 ≥ 3），`charAt(0)` 与 `s[0]` 取同一字符，但 `charAt` 返回 `string`（越界返回 `''`，此处不会越界），无需断言即类型安全。运行时等价。
- **行 230**：`{ server: parts[0], ... }` → `{ server: parts[0]!, ... }`。
  上一行 `if (parts.length < 2) return undefined` 已保证 `parts.length >= 2`，`parts[0]` 必存在；`!` 为纯编译期断言，无运行时影响。

### 2. `apps/electron/src/main/lib/agent/no-progress-replay.test.ts`（测试夹具）
- 行 97：`r.decisions[2]` → `r.decisions[2]!`（前置 `replay` 已塞入 ≥3 条 decision）。
- 行 113：`r.decisions[r.decisions.length - 1]` → 同上加 `!`。
- 行 125–130：循环体改为先 `const kd = kscc.decisions[i]!` / `const pd = pi.decisions[i]!` 解构，再断言 `pd.*` / `kd.*`。两侧 `!` 收掉 8 条 TS2532，比 8 处内联 `!` 更可读。`!` 均为编译期，运行时与原内联访问等价。

### 3. `apps/electron/src/main/lib/adapters/pi/pi-agent-adapter.event-ir.test.ts`（测试夹具）
- 行 454 / 468 / 469：`obs.calls[0].xxx` → `obs.calls[0]!.xxx`（前置 `expect(obs.calls).toHaveLength(1)` 已保证 `calls[0]` 存在）。
- 行 495：`pi[1].kind` → `pi[1]!.kind`（`run` 返回 3 元素数组，`pi[1]` 必存在）。

### 4. `apps/electron/src/main/lib/ipc/session-service.ts`
- 行 1700–1707：`onNoProgressEvent` 回调里 `sendPayload(..., { kind: 'tagent_event', event })` 的 `event`（`NoProgressEvent`）加 `as unknown as { type: string; [key: string]: unknown }`。
  - **根因**：`sendPayload` 形参类型 `TAgentDesktopStreamPayload`，其 `tagent_event` 变体的 `event` 是松散信封 `{ type: string; [key: string]: unknown }`（见 `packages/shared/src/types/tagent-message.ts:136`）。`NoProgressEvent`（`packages/shared/src/types/no-progress.ts:159`）结构上满足该信封（`type: 'no_progress'` 是 string，其余键值均可赋给 `unknown`），仅缺索引签名声明，故不可直接赋值。
  - **为何不在 `NoProgressEvent` 上加索引签名**：那样会永久放宽该共享事件类型（任意键访问返回 `unknown`，丢失 7 个已知属性的拼写纠错能力），且与仓库惯例不一致——同类的 `MoARoundtableEvent` 也不带索引签名，靠「以新鲜字面量传入」拿到隐式索引签名。本处是唯一以**类型化变量**传入信封的点，故就地窄断言比例恰当；渲染层（`Chat.tsx:1538`）本就用松散信封 + 自行 `as` 收窄，与 `NoProgressEvent` 解耦，不受影响。
  - **为何 `as unknown as` 双层**：单层 `as` TS 报「neither type sufficiently overlaps」（索引签名缺失），TS 自己提示需经 `unknown` 中转。纯类型转换，不改运行时对象。

## 验收勾选

- [x] 记录最初 `tsc` 错误条数与文件列表（22 条 / 4 文件，见上）
- [x] 修完后再跑同一命令：错误数下降，**已清零 0**（exit 0）
- [x] 无需产品决策的遗留项（全部 22 条均已消，无 TODO 残留）
- [x] 改动文件列表 + 修前/修后摘要（见上）
- [x] 未改产品行为（全部为编译期断言/类型转换，运行时等价）
- [x] 未 `git commit` / `push`（仅改工作区）
- [x] 未动 `apps/electron/.procs.txt`（仍为会话开始时的未跟踪文件，未修改）

## 复跑命令

```bash
node node_modules/.bun/typescript@5.9.3/node_modules/typescript/bin/tsc --noEmit -p apps/electron/tsconfig.json
# 期望：无输出，exit 0
```

## 备注

- 22 条全部位于 brief 列出的 4 个基线文件（`no-progress-guard.ts` / `no-progress-replay.test.ts` / `pi-agent-adapter.event-ir.test.ts` / `session-service.ts`），与 settings/MOA 无关，系 no-progress guard / pi adapter 收尾遗留。
- 修前 22 与 memory `electron-tsc-baseline-errors` 记录一致；本次按 brief 要求全部清零。下次跑若数量/文件变化再重新评估。
- 仅修 `apps/electron` 工作区（其 `tsconfig.json` `include` 仅 `src/**/*`）；未跑 `bun run --filter='*' typecheck` 全量（不在 brief 范围）。
