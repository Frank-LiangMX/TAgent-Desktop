# Brief：修复 CI `bun run typecheck` 全仓报错

## 目标

清零 GitHub Actions `typecheck` job（`bun run --filter='*' typecheck`）的 TypeScript 报错。只做类型/窄补丁，不改产品行为；完成后可 commit（用户要修 CI）但本 brief 执行时可先改代码，由总监决定 push。

## 怎么跑

仓库根 `F:/TAgent-Desktop`：

```bash
bun run typecheck
```

若本机 bun filter 异常，可逐包：

```bash
bun run --cwd packages/shared typecheck
bun run --cwd packages/core typecheck
bun run --cwd packages/ui typecheck
bun run --cwd packages/pi-core typecheck
bun run --cwd apps/electron typecheck
```

也可对照最近失败 run 的 typecheck 日志。

## 范围

- 修所有 workspace 包 `tsc --noEmit` 报错
- 禁止无关重构 / 改 UI / 动 `.procs.txt`
- 写 `docs/dev/typescript/FIX-CI-TYPECHECK-FINDINGS.md`（修前/修后 + 文件列表）

## 验收

- [ ] `bun run typecheck` exit 0（或各包 typecheck 全过）
- [ ] 返回改动文件 + 错误摘要
