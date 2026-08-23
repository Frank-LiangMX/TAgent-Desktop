# P2-UX-BRIDGE · 单会话↔协作室桥接契约层（类型 / 预算 / 纯函数）

> **角色**：实现 agent（kscc）  
> **模型**：`kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> **仓库根**：`main` @ `76ea2d0`  
> **产品规格**：[14-SESSION-COLLAB-BRIDGE-SPEC.md](./14-SESSION-COLLAB-BRIDGE-SPEC.md)  
> **本切片范围**：**仅契约层**（shared 类型 + 预算常量 + 裁剪/校验纯函数 + 单测 + 文档旁注）。**不做** UI、**不做** LLM summarize、**不改** upgrade/exit 主路径行为。

---

## 目标

把「明示进房 / 明示回退 + 双向精炼预算」落成可测契约，供后续服务层接线：

1. 定义 `SessionToRoomBrief` / `RoomToSessionHandoff` / 预算常量 / 裁剪结果类型。  
2. 纯函数：按预算裁剪文本、估算字符↔token、校验 brief 结构、组装协调者可读的前情提要块。  
3. 可选：定义「按需读原史」请求/响应形状（工具契约，不实现工具本体）。  
4. 单测覆盖裁剪硬顶、默认档、空输入、超预算截断策略。  
5. `12-IMPLEMENTATION-LOG` §85 + `13-HANDOFF` / `14` 旁注一行。

---

## 建议落点

```text
packages/shared/src/types/session-collab-bridge.ts          # 类型 + 常量 + 纯函数
packages/shared/src/types/session-collab-bridge.test.ts     # 单测
packages/shared/src/types/index.ts（或现有 barrel）         # 导出
```

若仓库类型 barrel 习惯不同，跟现有 `collaboration-summary.ts` / `fusion-routing.ts` 同级放置并保证 `@tagent/shared` 可 import。

---

## 常量（必须与 14 规格一致）

```ts
/** 1 token ≈ 1.2 汉字（审计近似，非精确 tokenizer） */
export const BRIDGE_CHARS_PER_TOKEN = 1.2

export const SESSION_TO_ROOM_BRIEF_DEFAULT_TOKENS = 3000
export const SESSION_TO_ROOM_BRIEF_HARD_MAX_TOKENS = 8000

export const ROOM_TO_SESSION_HANDOFF_DEFAULT_TOKENS = 2000
export const ROOM_TO_SESSION_HANDOFF_HARD_MAX_TOKENS = 6000

export const SOURCE_EXCERPT_PER_CALL_DEFAULT_TOKENS = 1500
export const SOURCE_EXCERPT_PER_CALL_HARD_MAX_TOKENS = 2000
export const SOURCE_EXCERPT_PER_TURN_HARD_MAX_TOKENS = 4000
```

提供 `tokensToCharBudget(tokens)` / `estimateTokenCount(text)` 纯函数。

---

## 类型（最小可用）

```ts
export interface SessionToRoomBrief {
  goal: string
  decisions: string[]
  openQuestions: string[]
  todos: string[]
  artifacts: string[]
  sourceSessionId: string
  /** 可选散文兜底；有结构化字段时投影优先用列表 */
  narrative?: string
  tokenEstimate: number
  charCount: number
}

export interface RoomToSessionHandoff {
  outcomes: string[]
  changes: string[]
  risks: string[]
  roomId: string
  sourceSessionId: string
  narrative?: string
  tokenEstimate: number
  charCount: number
}

export interface SourceSessionExcerptRequest {
  sourceSessionId: string
  roomId: string
  /** 关键词或问题；实现层后续用 */
  query?: string
  /** 最近 N 条；实现层后续用 */
  recentMessageLimit?: number
  /** 调用方声明的 token 预算，须 ≤ PER_CALL hard max */
  maxTokens?: number
}

export interface SourceSessionExcerptResult {
  sourceSessionId: string
  excerpt: string
  tokenEstimate: number
  charCount: number
  truncated: boolean
}
```

---

## 纯函数（必须实现 + 测）

1. `clampBridgeText(text, maxTokens): { text, tokenEstimate, charCount, truncated }`  
   - 按 `BRIDGE_CHARS_PER_TOKEN` 换算字符硬顶；超则截断并尽量在段落边界截。  
2. `buildSessionToRoomBrief(input): SessionToRoomBrief`  
   - 输入：各字段原始字符串/数组 + `sourceSessionId` + 可选 `budgetTokens`（默认 DEFAULT，不得超过 HARD_MAX）。  
   - 对各字段与拼装后的 `formatSessionToRoomBriefForPrompt` 总量做预算：优先保 `goal` + `sourceSessionId` + decisions，再 todos / openQuestions / artifacts / narrative。  
3. `formatSessionToRoomBriefForPrompt(brief): string`  
   - 稳定模板（中文标题），供投影进 system / 房间背景；输出须再过一次 clamp（hard max）。  
4. `buildRoomToSessionHandoff(input): RoomToSessionHandoff` + `formatRoomToSessionHandoffForPrompt`  
   - 对称；默认预算更紧。  
5. `validateSourceExcerptBudget(requestedTokens, alreadyUsedThisTurnTokens): { ok, allowedTokens } | { ok:false, reason }`  
   - 单次 ≤ PER_CALL hard；单轮累计 ≤ PER_TURN hard。

**禁止**：调用 LLM、读磁盘、改 Electron IPC、改 `upgradeFusionSession` / `removeMember` 行为。

---

## 文档

1. `12-IMPLEMENTATION-LOG-2026-08-22.md` 追加 **§85**（契约层交付、预算表、未做项）。  
2. `13-HANDOFF-2026-08-23.md` §7 P2 旁注一行：桥接规格见 `14`，契约层 §85。  
3. 可 commit，message：`feat(fusion): P2-UX bridge enter/exit contract (brief budgets + pure fn)`；**不 push**。  
4. **不**动无关未提交文件：`BotSidecarPanel*` / `image-lightbox` / `message/index` / `tokens.css`。

---

## 验收

```powershell
bunx vitest run packages/shared/src/types/session-collab-bridge.test.ts
# 若改了 barrel，相关 typecheck：
bun run --filter='./packages/shared' typecheck
# 或全仓 electron typecheck 若 shared 被 electron 引用
bun run --filter='./apps/electron' typecheck
git diff --check
```

返回：改动文件、测试结果、诚实未做项（UI / LLM / 主路径接线）。
