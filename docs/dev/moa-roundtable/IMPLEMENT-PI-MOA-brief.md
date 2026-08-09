# Brief · 实现 Pi / 外部渠道 MoA

> `kscc -p --model glm-5.2 --dangerously-skip-permissions`  
> 规格：`docs/dev/moa-roundtable/03-PI-EXTERNAL-MOA-SPEC.md`（必读）  
> 对齐：`02-SESSION-UX-SPEC.md`、现有 `run-moa-turn.ts` / `moa-dispatch.ts` / `moa-orchestrator.ts`

## 目标

让**非 kscc-internal**渠道也能会诊：同 UI（发送 ▾ / 圆桌卡 / 历史 / one-shot），席位走 Pi HTTP 直连，不调用 `spawnKsccBare`。

## 必做

1. **`resolveConsultPresetsForChannel`**（纯函数 + 单测）  
   - kscc：过滤 stored 预置  
   - 外部 ≥2 模：可用 stored 或合成 `channel-default`  
   - 外部 1 模：合成 `channel-same-model`（同模多角色）

2. **放宽门禁**  
   - `validateMoAPresetForChannel` 不再「仅 kscc」硬拒；改为席位必须属于**当前** channel 且 enabled。

3. **seat runner 分流**（`moa-orchestrator` 或旁路模块）  
   - kscc → 现有 bare  
   - 外部 → 复用 `createHttpDirectStreamFn` / streamSimple，收集纯文本；注入 channel 的 apiKey/baseUrl/provider（主进程解密，与 pi-adapter 同路）  
   - `runMoaTurn` 传入 runner 所需凭据；**勿**把密钥写进预置文件或圆桌卡。

4. **UI**  
   - Chat / SendSplitButton 用 `resolveConsultPresetsForChannel(当前渠道, listMoaPresets)`  
   - 外部菜单可加一行计费提示（短）

5. **回归**  
   - kscc 会诊单测 + 外部合成预置单测仍绿  
   - FIX-NOTES 追加 §9；更新 `00-MASTER.md` 本轮条目

## 验收（交卷写进 FIX-NOTES）

- [ ] 规格 §6 条目 1–5 对应证据（单测命令输出 / 关键代码路径）  
- [ ] 未做跨渠混席 / 设置页 CRUD  
- [ ] 不 setModel('moa:…') / 外部不 spawn kscc bare

## 本轮不做

跨渠混席、预置 CRUD UI、汇总只读工具、ACP、大范围清债。
