# GATE · kscc ACP 握手 + resume + context usage 前置验证

> **角色**：只读探测 / 落盘结论，**不改 TAgent 业务代码**  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`C:\Users\loumi\Desktop\AI\TAgent-Desktop`  
> **权威背景**：`docs/plans/2026-08-07-kcwork-kscc-acp-research.md` §6–§7、`docs/dev/kscc-acp/00-MASTER.md`

---

## 目标

回答三个决策门问题（每个必须有命令原文 + 退出码 / 关键输出片段作证据）：

1. **本机 PATH 上的 `kscc` 是否支持 `--experimental-acp`？**  
   （调研当日 help 未列出该旗；可能是隐式旗、版本过旧、或仅 KCwork 捆绑包有。）
2. **ACP 模式下 `--resume <sid>` 是否仍可用？**（保住则转 ACP 净赚；保不住则要用自管上下文换 usage）
3. **ACP 会话是否会推 context usage？**（事件名可能是 `acp_context_usage` / SDK `onContextUsage`，data 形状期望含 `used` + `size`）

---

## 允许做的事

- 读 `docs/plans/2026-08-07-kcwork-kscc-acp-research.md`、本 brief、`00-MASTER.md`
- 跑 `kscc --version`、`kscc --help`、带旗试验命令
- 若存在 KCwork 安装目录（常见 `D:\Program Files\KCwork\` 或用户机其它路径），**只读**比对捆绑 `kscc` 版本与 `--help`（不要改安装目录）
- 用临时工作目录做 ACP 最小握手（stdio JSON-RPC / 或 `@agentclientprotocol/sdk` 一次性脚本均可）；产出写到 `docs/dev/kscc-acp/` 或系统 temp，**不要**污染用户真实会话目录以外的产品数据
- 写结论到 `docs/dev/kscc-acp/GATE-acp-resume-FINDINGS.md`

## 禁止

- 改 `apps/`、`packages/`、产品配置、`.claude/settings.json` 里的 sk
- 提交 git、push
- 大段重写调研文档（最多在 FINDINGS 末尾加一行「建议更新调研 §7 勾选」）
- 为「看起来像成功」而伪造事件；拿不到就写拿不到 + 原因

---

## 建议探测步骤（可按环境裁剪，但结论三项都要覆盖）

### A. 版本与旗面

```text
where.exe kscc
kscc --version
kscc --help
# 试隐式旗（help 可能不列）
kscc --experimental-acp --help
# 或短跑看报错是否「unknown option」
```

若 PATH kscc 无该旗：再查 KCwork 捆绑二进制（若存在）版本差；记录路径对比。

### B. 最小 ACP 握手（无 resume）

在 temp 目录起一次 ACP 会话，确认能建立 session、收到至少一条 agent 更新或 initialize 成功响应。  
超时 / 未知协议 → 记失败原因，不要死循环。

### C. resume 共存

1. 先用**现行稳态**（非 ACP，如 `-p` + stream-json 或项目惯用 resume 路径）跑一句极短 prompt，记下 `session_id`
2. 再尝试：`kscc --experimental-acp --resume <同一 sid> …`（或 ACP initialize 带 resume 字段——以实测协议为准）
3. 发第二句「上一句我说了什么？」类探测，看是否记得上下文  
   - 记得 → resume 活  
   - 不记得 / 报错 / 新 sid → resume 死或语义变了

### D. context usage 事件

在 ACP 会话中观察 stdout / SDK 回调：是否出现含 `used`+`size`（或等价字段）的 usage 推送。  
没有 → 明确写「本版本 ACP 无 usage 推送」或「需更多轮次才推」+ 证据。

---

## 验收（FINDINGS 必须含）

文件：`docs/dev/kscc-acp/GATE-acp-resume-FINDINGS.md`

| 项 | 要求 |
|---|---|
| 结论表 | 三门各一行：✅/❌/❓ + 一句话 |
| 证据 | 关键命令、关键 stderr/stdout 摘录（可打码 sk） |
| 版本 | PATH kscc 版本；若比过 KCwork 捆绑版也写上 |
| 对主线建议 | 明确写：支持拍板 A / 仅当接受丢 resume 才 A / 建议维持 C / 需换 kscc 版本再验 |
| 本轮不做 | 未改业务代码、未 commit |

返回给总监时：先贴结论表三行，再给 FINDINGS 路径。
