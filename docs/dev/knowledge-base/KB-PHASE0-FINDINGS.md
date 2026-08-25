# 知识库实现记录

日期：2026-08-25

## 当前可用形态

知识库是应用级资源，与项目、工作区和会话解耦：

- 在左侧 Rail 打开“知识库”管理页。
- 新建知识库时填写名称、描述，并可一次选择多个本地目录作为来源。
- 一个知识库可以继续添加或移除多个来源目录。
- 在任意项目的会话底部点击“知识库”，勾选本次会话要使用的知识库。
- 会话只保存知识库 ID，不复制来源文件，也不会修改本地文件。
- 删除知识库只删除应用配置，不删除来源目录。

旧会话中的 `kbRoots` 仍兼容；当会话没有 `knowledgeBaseIds` 时，会继续使用旧的目录绑定方式。

## 实现边界

- 当前来源类型为本地目录，支持 `.md`、`.markdown`、`.txt`。
- 扫描限制：最大深度 4、单 root 最多 2000 个文件、单文件索引上限 1 MiB。
- 跳过 `.git`、`node_modules`、构建目录和符号链接。
- Agent 工具：`kb_list_roots`、`kb_search`、`kb_get`。
- Pi 使用 `extraTools`，kscc 使用 MCP，Chat 和 Work 均挂载。
- `kb_get` 使用 root containment + realpath 校验，拒绝路径穿越和符号链接逃逸。
- 知识库不进入 L0-L5 Frozen memory，也不写 BotMemory。

## 存储

全局知识库配置保存在应用配置目录的 `knowledge-bases.json`，包含知识库名称、描述和来源目录元数据。会话元数据只保存 `knowledgeBaseIds`。

## 明确未做

- SQLite/FTS5、blobs
- Office/PDF/OCR/网页抓取
- 向量检索和自动注入
- candidate/active 入库和版本化知识条目

## 验证

- 单测：`bun test apps/electron/src/main/lib/kb`
- 类型检查：`bun run typecheck`
- 构建：`bun run build`
