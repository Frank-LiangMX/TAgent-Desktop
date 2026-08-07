# REGRESS-H 摸底 Brief — 对照 TAgent_General 选项卡，决定移植 vs 重写

> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §H  
> 用户裁定：**要有选项卡**（迟早做）；1.0 在 `F:\TAgent_General` 已有，UI 风格可能不符，需改造；问总监是重头捏还是参考。  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮只读摸底 + 写移植规格**，不改代码、不 commit。

## 总监倾向（写进 FINDINGS 供确认）

**默认：参考 / 移植 General，不重头捏交互语义。**  
理由：SDK 协议（`request_user_dialog` / `control_response`）、问题/选项数据模型、回灌答案形状已有现成路径；Desktop 缺的是接线 + 视觉。重捏易漏超时/取消/多题/pending 跨 tab。  
UI：可按 Desktop 现有 `PermissionBanner` 视觉语言改造 General 组件，不必 1:1 抄旧皮。

## 必答（两边都要 path:line）

### A. General（`F:\TAgent_General`）

1. AskUserQuestion / 选项卡组件文件在哪？入口、props、多题/多选如何建模？
2. 主进程/宿主如何收 SDK `request_user_dialog`（或等价）并弹卡？答案如何 `control_response` 回灌？
3. 超时、取消、未选语义？
4. UI 依赖（Ink？React DOM？自研？）能否直接搬进 Electron renderer，还是只能抽逻辑？

### B. Desktop（`F:\TAgent-Desktop`）

1. 对照 `REGRESS-H-FINDINGS.md`：断点是否仍是 `sdkMessageToIR` 丢 `control_request` + 无 IPC + 无组件？
2. 最近似可抄的 UI 壳：`PermissionBanner` 链路（preload / atoms / sync）能否复用模式？
3. 类型 stub：`AskUserRequest` / `ASK_USER_RESPOND` 与 General / SDK 是否对齐？

### C. 移植方案（写进规格草案）

给出推荐切片（最小可点选一轮）：

1. 主进程：识别 `control_request`/`request_user_dialog` → pending Map → IPC  
2. preload + renderer：Banner/面板（**基于 General 哪几个文件改造**）  
3. 答案 → `control_response`  
4. `checkPermission`：AskUserQuestion 直通 allow、不进通用权限横幅  
5. UI 改造清单：色板/字号/圆角对齐 Desktop，保留交互（点选、确认、取消）

明确：**不建议**从零设计选项交互；**建议**抽 General 的状态机/协议适配 + Desktop 皮。

## 交付

1. `docs/dev/core-loop/REGRESS-H-GENERAL-PORT-FINDINGS.md`（对照表 + 推荐方案）  
2. `docs/dev/core-loop/REGRESS-H-implement-brief.md`（下一轮实现用，可直接派工）  
3. stdout 中文：移植哪些文件、改哪些皮、工作量档（S/M/L）

禁止改业务代码、禁止 commit。可 `--add-dir F:\TAgent_General`。
