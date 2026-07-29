# ADR-0001：双核模式（kscc 可插拔 + Pi 主核）

> 状态：已定调（2026-07-25）
> 关联实测文档（TAgent_General，详细证据链）：
> - `docs/plans/2026-07-25-2.0-architecture-decision-dual-core.md`
> - `docs/plans/2026-07-25-bare-cache-prefix-experiment.md`
> - `docs/plans/2026-07-25-http-direct-cache-control-experiment.md`
> - `docs/plans/2026-07-25-stream-json-cache-control-experiment.md`
> - `docs/plans/2026-07-25-kscc-bare-vs-resume-long-session-benchmark.md`

## 决策

2.0 是双核：kscc 核（Claude Agent SDK + kscc 内网渠道）+ Pi 核（外部渠道，pi-ai 直连）。

- **kscc 可插拔**：内网增强包，对外版不装（无拖累）。
- **Pi 主核**：对外版唯一主运行时，自带循环，无长驻问题。
- **核随渠道**：会话绑渠道=绑核，终身不切。kscc↔外部互斥，核内换模型自由。

## 为什么不是全切 Pi（原方向否决）

- 公司网关只放行 kscc OAuth（裸 HTTP 403），Pi 绕不开 kscc。
- kscc 不透传 cache_control，bare 咬不住长会话新历史段。
- antml ↔ 原生 tool_use 不互通，混用=格式地狱。

## 能力差（选渠道=选能力包）

| 维度 | kscc 核 | Pi 核 |
| --- | --- | --- |
| 长会话 cache | resume 咬住 | 靠 Pi 侧压缩 |
| Xfast/MoA | 削弱（单模型） | 全活（可并行） |
| 换模型 | 核内（Anthropic 系） | 全互通 |

## 上下文压缩（补充，2026-07-29）

- **Pi 核**：使用 `@earendil-works/pi-agent-core` 原生 compaction API；**触发/接线/UI/重试为 TAgent 自研**。禁止照搬 Proma 业务代码。设计见 `docs/plans/2026-07-29-pi-context-compaction.md`。
- **kscc 核**：继续依赖 Claude Agent SDK 长驻 + resume；SDK compact 另案，不与 Pi 混用同一套 API。

## TAgent-Desktop 落地

- `adapters/claude/` = kscc 核（对外版编译排除）
- `adapters/pi/` = Pi 核（内网版可排除）
- `adapters/index.ts` 按渠道选核
