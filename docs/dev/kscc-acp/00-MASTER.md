# kscc 核改造 · context usage 主线

> **状态**：GATE 已结 —— **kscc 1.1.28 无 ACP，当前维持 C**；要 usage 须换含 `--acp` 的 kscc 后再重验  
> **权威调研**：[`docs/plans/2026-08-07-kcwork-kscc-acp-research.md`](../../plans/2026-08-07-kcwork-kscc-acp-research.md)（§2.2 待按 FINDINGS 修正）  
> **总监模式**：只写规格 / 派 kscc(glm-5.2) / 交叉验收，不亲自改核

---

## 1. 问题一句话

kscc 渠道 **context usage 圆环已被砍掉**（`TokenStatsBar.hideContext` / `Chat.tsx` `lockedKind === 'kscc'`）：stream-json 只能捞单次 `usage.input_tokens`，**没有分母 `size`**，百分比不可信。调研以为转 ACP 可拿 `onContextUsage`——但本机 PATH kscc **根本没有 ACP 旗**。

---

## 2. GATE 结论（2026-08-07）

详见 [`GATE-acp-resume-FINDINGS.md`](./GATE-acp-resume-FINDINGS.md)。

| 门 | 结论 |
|---|---|
| `--experimental-acp` / `--acp` | ❌ unknown option（1.1.28） |
| ACP + resume | ❓ kscc 进不了 ACP；KCwork 里 kscc=stream-json+resume，ACP 是另一组后端 |
| context usage 推送 | ❓ 协议层有，kscc 链路上无实证 |

**调研修正**：KCwork「kscc」≠ ACP；ACP 旗现名 `--acp`；捆绑 ACP 是 opencode/`ksoc`，不是 kscc。

---

## 3. 主线取舍（待拍板）

| 选项 | 现状 |
|---|---|
| **A** 转 ACP | **当前不可执行**（无旗）。前置追加：换含 `--acp` 的 kscc → 重跑门 2/3 |
| **B** 只 fork 隔离 | usage 仍无 |
| **C** 不动 | **GATE 推荐默认**；圆环继续藏 |
| **D** IR 下沉 | 不解 usage |
| **E** 换后端（ksgc/ksoc ACP） | 另起评估，会动免费 glm/kimi/mimo 收益链 |

---

## 4. 旁线（勿混）

- soft-reset 首轮误触发：不恢复圆环可信度
- 网关 http 直连：403 死路
- GATE 副作用：探测起过 `ksoc.exe acp`，可能改写了 `~\.config\opencode\opencode.jsonc`（含 sk）——用户可按 FINDINGS 手动清理
