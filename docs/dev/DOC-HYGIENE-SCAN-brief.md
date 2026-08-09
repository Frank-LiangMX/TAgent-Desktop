# Brief · 全仓文档归类 / 过期扫描（便宜模型）

> `kscc -p --model glm-5.1 --dangerously-skip-permissions`  
> **只读扫文档 + 写报告**；可小改明显过期的 MASTER/状态行；**禁止改应用代码**；禁止大段重写历史 FINDINGS。

## 范围

优先：

- `docs/dev/**`（尤其 `moa-roundtable/`、`core-loop/`、`kscc-acp/`）
- `docs/plans/multi-runtime/` 里与 MoA/会诊相关的索引句（若明显与现状矛盾则记下）

不必逐字读完所有 REGRESS 长文；用目录 + 各线 `00-MASTER` / HANDOFF / FIX-NOTES 标题与状态段抽样。

## 查什么

1. **归类**：各线是否有 `00-MASTER`（或等价入口）？孤儿 brief/FINDINGS 是否挂到 MASTER？  
2. **过期**：MASTER / SPEC 状态是否与 FIX-NOTES 矛盾（例：仍写「MoA 无 UI」「外部渠 MoA 不做」「会诊在 ModelSelector」）？  
3. **重复 / 可归档**：明显被更新文档取代的旧 brief 是否应标「已完成/归档」？  
4. **缺口**：Agent 行为设置（04）、Pi MoA（03）、续聊注入（§10）是否在 MASTER 可见？

## 产出

写：`docs/dev/DOC-HYGIENE-SCAN-FINDINGS.md`

结构：

1. 总判（一句话）  
2. 按目录的现状表（线名 / 入口文件 / 健康度：齐|乱|过期）  
3. **建议更新清单**（可执行、按优先级 P0/P1/P2；写清改哪个文件哪一句）  
4. 本轮若已随手修正的 MASTER 状态行：列出来  
5. 不做：删文件（除非空且用户已授权——本轮**只建议不删**）

## 已知近期事实（对照用，勿无视）

- MoA：kscc + 外部 Pi 会诊已落地；发送 ▾ one-shot；设置「Agent 行为」CRUD **进行中或刚交卷**  
- 会诊→普通续聊注入已修（新会话首条会诊场景）  
- ACP 线搁置  
- `01-MOA-PRODUCT-SPEC` 仍可能写「外部渠道 MoA 不做」——应标过期或加勘误指针到 03  
