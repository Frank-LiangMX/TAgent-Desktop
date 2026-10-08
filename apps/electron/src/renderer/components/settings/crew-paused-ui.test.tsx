// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { afterEach, expect, test, vi } from 'vitest'
import { AGENT_CREW_PREFS_DEFAULT, type AgentCrewPrefs, type MoAPreset } from '@tagent/shared'
import { TooltipProvider } from '@tagent/ui'
import { channelsAtom } from '../../atoms/channel-atoms'
import { AgentCrewSettings } from './AgentCrewSettings'
import { SendSplitButton } from '../chat/ConsultMenu'

// Keep the real page state and IPC boundary; make only the select primitive native
// so these tests do not depend on Radix's pointer capture/layout in jsdom.
vi.mock('@tagent/ui', async (original) => ({
  ...await original<object>(),
  SettingsSelect: ({ label, value, onValueChange, options, disabled }: {
    label: string; value: string; onValueChange: (value: string) => void;
    options: Array<{ value: string; label: string }>; disabled?: boolean;
  }) => <label>{label}<select aria-label={label} value={value} disabled={disabled}
    onChange={(event) => onValueChange(event.target.value)}>
    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function mount(node: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<TooltipProvider>{node}</TooltipProvider>))
}

const preset: MoAPreset = {
  id: 'review', name: '评审班底', enabled: true,
  references: [{ name: 'A', modelId: 'a' }, { name: 'B', modelId: 'b' }],
  aggregatorModelId: 'a',
}

test('old callers cannot expose crew dispatch; normal send and consultation remain usable', async () => {
  const onSend = vi.fn()
  const onConsultPreset = vi.fn()
  const onKanbanDispatch = vi.fn()
  await mount(<SendSplitButton presets={[preset]} hasDraft onSend={onSend}
    onConsultPreset={onConsultPreset} onKanbanDispatch={onKanbanDispatch} />)
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.click())
  expect(onSend).toHaveBeenCalledOnce()
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="更多发送方式"]')?.click())
  expect(document.body.textContent).toContain('普通发送')
  expect(document.body.textContent).not.toContain('用看板派工')
  const consult = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('评审班底'))
  expect(consult).toBeDefined()
  act(() => consult?.click())
  expect(onConsultPreset).toHaveBeenCalledWith('review')
  expect(onKanbanDispatch).not.toHaveBeenCalled()
}, 60_000)

test('crew-only legacy callback does not create an empty send menu', () => {
  const html = renderToStaticMarkup(<TooltipProvider><SendSplitButton presets={[]} hasDraft onSend={() => {}}
    onConsultPreset={() => {}} onKanbanDispatch={() => {}} /></TooltipProvider>)
  expect(html).toContain('aria-label="发送"')
  expect(html).not.toContain('aria-label="更多发送方式"')
}, 60_000)

test('subagent concurrency and model saves preserve hidden crew preferences', async () => {
  const prefs: AgentCrewPrefs = {
    ...AGENT_CREW_PREFS_DEFAULT,
    maxParallelWorkers: 2,
    autoOpenPanelOnDispatch: false,
    showFlowAsGraph: true,
    modelProfiles: [{ channelId: 'removed', modelId: 'old', enabled: false,
      strength: 'unknown', speed: 'unknown', cost: 'unknown', goodFor: [] }],
  }
  const setAgentCrewPrefs = vi.fn(async (next: AgentCrewPrefs) => next)
  vi.stubGlobal('electronAPI', { getAgentCrewPrefs: vi.fn(async () => prefs), setAgentCrewPrefs })
  const store = createStore()
  store.set(channelsAtom, [{ id: 'api', name: 'API', provider: 'openai', enabled: true,
    baseUrl: '', apiKey: '', createdAt: 0, updatedAt: 0,
    models: [{ id: 'm', name: 'Model', enabled: true }] }])
  await mount(<Provider store={store}><AgentCrewSettings /></Provider>)
  expect(document.body.textContent).toContain('子代理调度')
  expect(document.body.textContent?.match(/班组功能已暂停/g)).toHaveLength(1)
  expect(document.body.textContent).not.toContain('自动展开班组')
  const select = document.querySelector<HTMLSelectElement>('[aria-label="同时运行的子代理上限"]')!
  expect(select).not.toBeNull()
  await act(async () => { select.value = '3'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(setAgentCrewPrefs).toHaveBeenLastCalledWith(expect.objectContaining({
    maxParallelWorkers: 3, autoOpenPanelOnDispatch: false, showFlowAsGraph: true,
  }))
  const save = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '保存画像')
  expect(save).toBeDefined()
  await act(async () => save?.click())
  expect(setAgentCrewPrefs).toHaveBeenLastCalledWith(expect.objectContaining({
    maxParallelWorkers: 3, autoOpenPanelOnDispatch: false, showFlowAsGraph: true,
    modelProfiles: expect.arrayContaining([
      expect.objectContaining({ channelId: 'removed', modelId: 'old', enabled: false }),
      expect.objectContaining({ channelId: 'api', modelId: 'm', enabled: true }),
    ]),
  }))
}, 60_000)
