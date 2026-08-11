/**
 * 设置 · Agent 行为 → MOA
 *
 * 会诊与圆桌是对等两种协作方式，共用同一套班底预置。
 * 页结构：Intro → 双子模块（会诊 | 圆桌）→ 共用班底。
 * tab id 仍 agent-roundtable；旧深链 agent / agent-discuss 归一到此。
 */
import { SettingsCard, SettingsPageIntro, SettingsSection } from '@tagent/ui'
import { AgentBehaviorSettings } from './AgentBehaviorSettings'
import { AgentDiscussSettings } from './AgentDiscussSettings'

export function MoaSettings(): JSX.Element {
  return (
    <div className="settings-page agent-behavior-page">
      <SettingsPageIntro
        title="MOA"
        description="会诊与圆桌是两种对等的多模型协作方式，共用下方同一套班底；席位与模型只配一次。"
      />

      <div className="moa-mode-grid" role="group" aria-label="MOA 协作方式">
        <SettingsSection
          title="会诊"
          description="各席独立作答，再由汇总席交卷。发送旁入口「会诊」。"
        >
          <SettingsCard divided={false} className="moa-mode-card">
            <div className="moa-mode-panel">
              <p className="moa-mode-panel__lead">并行交卷 · 单轮</p>
              <p className="moa-mode-panel__body">
                使用共用班底里的参考席与汇总模型。会诊固定单轮，班底中的「研讨轮数」不生效；超时按班底配置。
              </p>
              <p className="moa-mode-panel__note">当前无额外全局偏好。</p>
            </div>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="圆桌"
          description="多角色互相讨论出共识，支持插话与喊停。发送旁入口「圆桌」。"
        >
          <AgentDiscussSettings variant="module" />
        </SettingsSection>
      </div>

      <AgentBehaviorSettings hideIntro />
    </div>
  )
}
