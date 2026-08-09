# MoA / 圆桌主线 · 状态

> **状态**：ACP/context-usage 线已搁置（见 `docs/dev/kscc-acp/`）。本线回到 multi-runtime MoA + 圆桌产品化。  
> **本仓库宪章**：`docs/plans/multi-runtime/`（尤其 03 / 05 / 06 / 07）  
> **代码现状**：MoA 会诊 UI 已落地（圆桌卡 + 会诊分组 + ConsultMenu + 外部渠 Pi 直连 + 续聊注入 + 设置页 Agent 行为/会诊班底 CRUD），见 `IMPLEMENT-FIX-NOTES.md` §1/§8/§9/§10/§11；待手测  
> **对照外部**：`C:\Users\loumi\Desktop\AI\hermes-studio`（本轮取经，不抄代码进仓库除非另开实现 brief）

---

## 本轮

1. ✅ hermes-studio 取经 → [`HERMES-STUDIO-TAKEAWAYS.md`](./HERMES-STUDIO-TAKEAWAYS.md)  
2. ✅ 拍板：做 **T-02 MoA 预置挂 picker**（完整产品化）  
3. 规格 → [`01-MOA-PRODUCT-SPEC.md`](./01-MOA-PRODUCT-SPEC.md)  
4. ✅ MoA 产品化闭环 · [`IMPLEMENT-FIX-NOTES.md`](./IMPLEMENT-FIX-NOTES.md)  
5. ✅ Session UX（历史 + 会诊本条 + 粘性文案）· SPEC [`02-SESSION-UX-SPEC.md`](./02-SESSION-UX-SPEC.md) · FIX-NOTES §8  
6. ✅ 发送分裂键（↑ / ▾）· 会诊=发送方式非模式  
7. ✅ **Pi / 外部渠 MoA** · SPEC [`03-PI-EXTERNAL-MOA-SPEC.md`](./03-PI-EXTERNAL-MOA-SPEC.md) · brief [`IMPLEMENT-PI-MOA-brief.md`](./IMPLEMENT-PI-MOA-brief.md) · FIX-NOTES §9  
8. **待手测**：kscc ▾ 会诊；外部渠（如 DeepSeek）▾ 会诊；新会话会诊→普通续聊上文  
9. ✅ **设置 · Agent 行为**（班组/会诊/圆桌壳 + 会诊 CRUD）· SPEC [`04-AGENT-BEHAVIOR-SETTINGS-SPEC.md`](./04-AGENT-BEHAVIOR-SETTINGS-SPEC.md) · FIX-NOTES §11  
10. ✅ **会诊班底双档**（kscc | `external` 合并池；设置两 pill；去左侧竖线）· SPEC [`05`](./05-CONSULT-PRESETS-DUAL-CORE-UX-SPEC.md) · brief [`IMPLEMENT-CONSULT-V3-EXTERNAL-MERGE-brief.md`](./IMPLEMENT-CONSULT-V3-EXTERNAL-MERGE-brief.md) · FIX-NOTES §12–§13 · 待手测  

ACP/圆环线继续搁置。同场不混核（kscc 席 + Pi 席）不做。
