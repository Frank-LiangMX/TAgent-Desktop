const TAGENT_REPO_URL = 'https://github.com/ErlichLiu/TAgent'

let _tagentVersion = '0.0.0'

export function setTAgentVersion(version: string): void {
  _tagentVersion = version
}

export function getTAgentVersion(): string {
  return _tagentVersion
}

export function getTAgentUserAgent(version?: string): string {
  const v = version ?? _tagentVersion
  return `TAgent/${v} (+${TAGENT_REPO_URL})`
}
