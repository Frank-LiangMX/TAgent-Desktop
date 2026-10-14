import { describe, expect, it } from 'vitest'
import { isKsccProvider, isTokenHubProvider, parseCodexModelProviders, resolveCodexConfigProtocol } from './codex-config'

describe('codex.toml internal channel discovery', () => {
  it('reads provider URL, bearer token, env key, and wire protocol', () => {
    const providers = parseCodexModelProviders(`
[model_providers.tokenhub]
base_url = "https://tokenhub.internal/airoute"
wire_api = "responses"
experimental_bearer_token = "sk-tokenhub"

[model_providers.kscc]
base_url = 'http://kscc.internal'
wire_api = 'messages'
env_key = 'KSCC_API_KEY'
`)
    expect(providers).toHaveLength(2)
    expect(providers[0]).toMatchObject({ name: 'tokenhub', baseUrl: 'https://tokenhub.internal/airoute', apiKey: 'sk-tokenhub' })
    expect(providers[1]).toMatchObject({ name: 'kscc', baseUrl: 'http://kscc.internal', envKey: 'KSCC_API_KEY' })
    expect(resolveCodexConfigProtocol(providers[1]!)).toBe('anthropic-messages')
    expect(isTokenHubProvider(providers[0]!)).toBe(true)
    expect(isKsccProvider(providers[1]!)).toBe(true)
  })
})
