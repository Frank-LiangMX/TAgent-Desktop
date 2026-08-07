# REGRESS-H Brief — Chat 下「请选择」但无选项 UI，随后当未选

> 规格：`REGRESS-2026-08-07-RESIDUAL-SPEC.md` §H  
> 派工：本机 `kscc -p --dangerously-skip-permissions`  
> **本轮默认只读摸底**；根因明确可最小修。

## 现象

Chat 模式会话：模型让用户选择（疑似 `AskUserQuestion` / 权限选项 / 子代理确认）。  
**实际没有弹出选项**；随后反馈「你没选」→ 子代理/本轮失败。

## 必答（带 path:line）

1. Chat 下 `AskUserQuestion`（或同类）实际走哪条 canUseTool 路径？是否被误拦、软 deny、或走了 askRenderer？
2. 主进程如何把问答变成 `ask_user_request` 事件？渲染层哪个组件消费并渲染选项？
3. 何种条件导致 **request 已发出但 UI 不挂载**？（executionMode、displayMode、pending 被清、IPC 通道、Banner 盖住、z-index、仅 Work 挂载等）
4. 「未选择」文案从哪来？超时自动 deny？空 answers 回灌？interrupt 竞态？
5. 与 REGRESS-A（Chat Write + interrupt）是否互相踩：硬拦/interrupt 误伤 AskUserQuestion？

## 假设

- H1：AskUserQuestion 进了 deny/interrupt，未进交互 UI
- H2：事件发出，但 Chat.tsx / 某面板未订阅或条件渲染 false
- H3：options 解析失败（空数组 / schema 变了）→ UI 空壳，超时当未选
- H4：子代理（Task）路径另套权限，主会话不弹卡

## 交付

写 `docs/dev/core-loop/REGRESS-H-FINDINGS.md`：根因 + 复现路径 + 最小修建议。不 commit。
