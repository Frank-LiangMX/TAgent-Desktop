# Markdown 结构位去 emoji（对齐 Codex/Cursor）

## 目标
对用户可见回复少用装饰性 emoji；渲染侧兜底剥掉标题/列表行首 emoji。

## 改动
1. `buildOutputStylePrompt`：加一条「章节/列表不用 emoji，靠标题层级与加粗」
2. `stripStructuralEmojiFromMarkdown`：保护围栏代码块；剥 `#` / `-` / `1.` / `>` 行首的 Extended_Pictographic 串
3. `MessageResponse` 渲染前调用

## 不做
- 不换 Twemoji；不剥句中 emoji；不改角色人设里的 emoji（仅沟通红线 + 渲染）

## 验收
- 单测：标题/列表剥掉，代码块内保留，句中保留
- prompt 含禁 emoji 文案
