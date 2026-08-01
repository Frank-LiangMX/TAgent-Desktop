# 持久化安全：原子 JSON 写入

> 状态：设计中（2026-07-31）
> 范围：主进程配置文件写入（整体覆盖式）；append 式（会话 JSONL）不动
> 参考：Frakio Work `atomic-json-store.mjs` 的产品意图（**实现自研**）

## 1. 背景

TAgent 主进程有多处**整体覆盖式** JSON 写入（读出来改完整个文件写回去）：

- `channels.json`（channel-store，L61 `writeFileSync`）
- 工作区注册表 `projects.json`（workspace-manager L51）
- 每工作区 meta 文件（workspace-manager L81）
- 记忆系统若干 JSON/JSONL（后续逐个套用）

直接覆盖写的风险：**写文件中途崩溃/断电 → 文件损坏（半截 JSON）→ 数据全丢且不可恢复**。

append 式（会话 JSONL，每轮追加一行）天然安全（最多丢尾行），不在本轮范围。

## 2. 机制（自研实现）

写流程（三步）：

```text
1. 写临时文件  <path>.tmp-<pid>-<ts>   （内容完整写入 + fsync）
2. 备份旧文件  rename <path> → <path>.bak  （先留底）
3. 原子替换    rename <tmp> → <path>       （系统级原子，要么成功要么失败）
```

读流程：

```text
readJsonSafe(path, fallback)
  正常 → 返回解析结果
  解析失败 → 尝试 <path>.bak：可用则恢复并返回备份内容，否则返回 fallback
  （损坏文件保留为 <path>.corrupt 供排查，不静默删除）
```

串行化：per-path Promise 链（`createSerialJsonWriter`），防止并发写同一文件互相覆盖
（渠道管理、工作区操作、记忆写入可能同时触发）。

失败清理：写失败时清理临时文件；rename 失败尝试回滚备份。

## 3. 实现文件

**`apps/electron/src/main/lib/atomic-json.ts`**（自研）：

- `writeJsonAtomic(filePath, data)` — 三步写
- `readJsonSafe(filePath, fallback?)` — 损坏自愈读取
- `createSerialJsonWriter(filePath)` — 串行化写入器（Promise 链）

**改造点**：

- `channel-store.ts`：`writeFileSync` → `writeJsonAtomic`
- `workspace-manager.ts`：注册表 + meta 写入 → `writeJsonAtomic`

## 4. 验收

- 单测：正常写读、模拟损坏（写半截）后 `readJsonSafe` 从 `.bak` 恢复、串行化不丢写
- typecheck 全绿
- 现有渠道/工作区功能无回归（读路径兼容，损坏时走恢复而非抛错）

## 5. 后续扩展（不在本轮）

- 记忆系统文件（L0-L5/ledger）逐个套用
- settings.json（如有）
