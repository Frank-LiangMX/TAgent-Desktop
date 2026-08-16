# .githooks — 提交尾迹清洗钩子

自动剥掉 AI 工具的 `Co-Authored-By` / `Co-authored-by` 尾迹
（Claude / kscc / Cursor / Copilot 提交时都会带）。

## 为什么
这些工具默认在 commit message 末尾加 `Co-Authored-By: <工具名>`，
导致 GitHub 贡献者列表出现 "Claude Opus 4.8" / "Cursor" 等非本人账户。
本钩子在任何提交落盘前自动删掉这些行，只保留你写的正文。

## 每台设备只需配置一次

本钩子脚本已提交到仓库（git 会同步到所有设备），但每台新设备
**第一次 clone/pull 之后**需要跑一次以下命令，让 git 从 `.githooks` 读钩子：

```bash
git config core.hooksPath .githooks
```

之后本仓库的所有 agent（Claude/kscc/Cursor/Copilot）提交
都会自动被清洗。

## 验证是否生效

```bash
# 应输出: .githooks
git config core.hooksPath
```

## 如何手动触发（可选）

```bash
.git/githooks/prepare-commit-msg <提交信息文件路径>
```
一般无需手动执行——git 在 `git commit` 时自动调用。