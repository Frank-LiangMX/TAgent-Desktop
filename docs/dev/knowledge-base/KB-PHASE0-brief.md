# Phase 0 brief · KB 只读检索验证

> **状态**：已完成的历史派工 brief；当前实施进度以 KB-PHASE0-FINDINGS.md 和 KB-PRODUCT-SPEC-v2.md 为准
> **原始角色**：实现（可派 kscc agent cli）
> **原始契约**：KB-PRODUCT-SPEC-v1.md §5 Phase 0
> **原始本轮**：只做「目录 → 检索工具 → 来源标注」，**不建 kb.db / 不写 Rail UI / 不写入**
> **原始禁止项**：改 L0–L5、BotMemory、FusionRoom；禁止 commit（除非用户另嘱）

---

## 目标

验证用户是否「只需要规范能搜到」：在会话里绑定一个或多个文档目录，Agent 用工具检索 MD/TXT，回答带来源。

**成功闸门（用户手测）：**
1. `knowledge/`（或用户指定目录）放入 2–3 份 MD，绑定后问项目相关问题能命中并带来源路径  
2. 未绑定 → 空结果 / 明确提示，不扫全盘  
3. 不写入 memory / BotMemory

若 Phase 0 已够用 → 可暂停；若需要库面板 / 多格式 / 确认入库 → 再开 Phase 1。

---

## 范围

### 做

1. **配置（最小）**  
   - 会话或 workspace 级：`kbRoots: string[]`（绝对路径列表，0..N）  
   - 可先落 JSON（仿现有 settings 小文件），或会话 meta 字段；**不**强制绑 workspace 路径  

2. **索引（进程内、无独立 db）**  
   - 扫描 `kbRoots` 下 `*.md` / `*.txt`（可限制深度，如 4；忽略 `node_modules`）  
   - 内存或临时 FTS/简单关键词检索即可（文件少时暴力扫 + 标题/正文匹配可接受）  
   - 变更：下次 search 再扫，或 mtime 缓存；**不做**向量  

3. **AgentTool dual-mount**（照 `kanban-agent-tools.ts`）  
   - `kb_list_libraries` / `kb_list_roots`：列出已配置根目录  
   - `kb_search({ query, rootId?, limit? })`：只在已绑定 roots 内搜  
   - `kb_get({ path })`：读单文件（须在已绑定 root 下，防路径穿越）  
   - Pi：`extraTools`；kscc：`createSdkMcpServer`  

4. **来源**  
   - 工具返回含 `path` + 短摘录；prompt/UI 可显示 `[KB: relative-path]`（UI 徽章可极简或先只在 tool result 里）  

5. **样例目录（可选）**  
   - 仓库 `knowledge/README.md` 说明用途；可放 1～2 个指向 `docs/` 现有规范的说明（或软链/复制短样例），勿塞大文件  

### 不做

- `kb.db` / blobs / Rail 知识库页  
- candidate 写入、Office、截图 OCR、PixelRAG、向量  
- 自动注入 Frozen / 每轮强制 RAG（以工具按需为主）  
- Agent 整理/合并  

---

## 关键文件（预期）

| 动作 | 路径 |
|------|------|
| 新建 | `apps/electron/src/main/lib/kb/kb-fs-index.ts`（扫描+检索） |
| 新建 | `apps/electron/src/main/lib/kb/kb-agent-tools.ts`（dual-mount） |
| 接线 | `pi-agent-adapter.ts` / `session-service.ts`（仿 kanban 注入） |
| 配置 | 小 store 或 session meta；preload/IPC **仅当**需要 UI 绑定时才加；P0 可先用配置文件/硬编码测通工具 |
| 单测 | `kb-fs-index.test.ts`、`kb-agent-tools` 路径穿越拒绝 |

---

## 验收命令

```bash
# 单测（实现方补全路径）
cd apps/electron && bun test src/main/lib/kb/

# 手测
# 1. 配置 kbRoots 指向含 MD 的目录
# 2. 新会话：让 Agent kb_search「IPC」或项目关键词
# 3. 确认命中路径正确；清空 kbRoots 后 search 为空
```

---

## 产出

- 代码 + 单测  
- 短笔记：`docs/dev/knowledge-base/KB-PHASE0-FINDINGS.md`（怎么配、手测结果、是否建议进 Phase 1）

---

## 工期

约 2–4 人日；优先跑通工具链路，UI 绑定可后补。
