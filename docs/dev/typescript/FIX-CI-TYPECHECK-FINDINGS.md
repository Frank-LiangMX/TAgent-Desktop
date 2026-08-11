# FIX-CI-TYPECHECK 结果

## 修前

`@tagent/core typecheck` 3 条：`no-progress.ts` 用了 `NodeJS.ProcessEnv` / `process`，而 `packages/core` 的 `types: []` 无 Node。

## 修法

`resolveNoProgressGuardMode` 改为纯 `Record` 入参，不再读 Node 全局。主进程本就传 `process.env`。

## 修后

`bun run typecheck` 全包 exit 0。
