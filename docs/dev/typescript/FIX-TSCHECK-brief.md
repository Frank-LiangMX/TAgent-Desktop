# Brief：修复 apps/electron TypeScript 检查报错

## 目标

在仓库 `F:/TAgent-Desktop` 跑通（或尽量清零）Electron 相关 `tsc` / typecheck 报错；**只修类型与必要的窄补丁**，不改产品行为、不做无关重构。

## 怎么跑

在仓库根或 `apps/electron`：

```bash
# 优先用仓库既有脚本；没有则：
cd apps/electron && npx tsc --noEmit -p tsconfig.json
# 或 monorepo：pnpm exec tsc -b / pnpm typecheck（以 package.json scripts 为准）
```

先查 `package.json` / turbo 里的 `typecheck` / `tsc` 脚本，用项目惯用命令。

## 范围

- 修 `tsc` 报出的错误（含基线：`no-progress-guard.ts`、`no-progress-replay.test.ts`、`pi-agent-adapter.event-ir.test.ts`、`session-service.ts` 等）
- 可改类型标注、窄断言、缺导出、错误 import、测试类型夹具
- **禁止**：大范围改 runtime 逻辑、删功能、改 UI 文案、无关格式化
- **禁止**：改 `.procs.txt`；不擅自 `git commit` / `push`（本任务只修代码）

## 验收

- [ ] 记录最初 `tsc` 错误条数与文件列表
- [ ] 修完后再跑同一命令：错误数下降，理想 0
- [ ] 若某错需产品决策才能消，写清原因并留下最小 TODO，不要瞎改语义
- [ ] 返回：改动文件列表 + 修前/修后错误摘要
