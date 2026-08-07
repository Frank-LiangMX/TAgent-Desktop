# 交接续：2026-08-07 白天残留摸底（F/G/H）

> 接 `HANDOFF-2026-08-07.md`。昨夜 `369d6f7` A–E 代码仍在；今日用户反馈三残留，只读摸底完成。

## 用户症状 ↔ 结论

| ID | 用户说 | 结论 | 下一步 |
|----|--------|------|--------|
| F | 思考块有时立刻消失 | **bug**：默认 **full** 模式 `ThinkingActivityRow` 无 settle，`live→false` 瞬间 body 卸成 4 行预览。concise 的 D 已修好，**没覆盖 full**。数据层 E 完好，落盘有 thinking。 | **可修**：把 D 的 settle+panel 移植到 `ProcessGroupView.ThinkingActivityRow` |
| G | 思考段后无阶段性总结落盘 | **非 bug**：输出风格 prompt **禁止**工具过程旁白 → 模型思考后直连 tool，无 text；B 渲染路径正确但收不到输入。 | **产品裁定**：A 改契约承认「计数灰字=总结」/ B 松绑 prompt 允许一句短文 |
| H | Chat 让选但无选项，随后没选 | **缺功能**：`AskUserQuestion` 权限放行，但 `request_user_dialog` 控制帧被 `sdkMessageToIR` **丢弃**；无选项 UI / 无 control_response 回灌。另：常被误送进通用权限横幅。 | **大**：接 SDK dialog 全链路；或 **止损**：软拒+中文引导改口 |

## FINDINGS

- `REGRESS-F-FINDINGS.md`
- `REGRESS-G-FINDINGS.md`
- `REGRESS-2026-08-07-RESIDUAL-SPEC.md`
- `REGRESS-H-FINDINGS.md`

## 建议派工顺序（待用户确认）

1. **F**（小、体验立刻好）→ brief 实现 settle 移植  
2. **H 止损或全链路**（用户痛点大；全链路工作量大）  
3. **G** 等产品拍板 A/B  

## 派工约定

继续本机 `kscc -p --dangerously-skip-permissions`，勿用 Cursor Task。
