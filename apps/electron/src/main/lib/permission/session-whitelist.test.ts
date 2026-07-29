import { describe, expect, test, beforeEach } from 'bun:test'
import {
  addToSessionWhitelist,
  clearSessionWhitelist,
  extractBaseCommand,
  isSessionWhitelisted,
} from './session-whitelist'

describe('extractBaseCommand', () => {
  test('extracts single token', () => {
    expect(extractBaseCommand('ls -la')).toBe('ls')
  })

  test('extracts two-token package/git commands', () => {
    expect(extractBaseCommand('git status')).toBe('git status')
    expect(extractBaseCommand('npm install lodash')).toBe('npm install')
  })
})

describe('session whitelist (always allow)', () => {
  const sessionId = 'session-perm-test'

  beforeEach(() => {
    clearSessionWhitelist(sessionId)
  })

  test('always-allow Bash permits a different non-dangerous command later', () => {
    addToSessionWhitelist(sessionId, 'Bash', { command: 'ls -la' })

    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'find . -type f' })).toBe(true)
    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'cat package.json' })).toBe(true)
    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'dir /s' })).toBe(true)
  })

  test('always-allow Bash still blocks dangerous commands', () => {
    addToSessionWhitelist(sessionId, 'Bash', { command: 'ls' })

    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'rm -rf /' })).toBe(false)
    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'sudo apt update' })).toBe(false)
  })

  test('always-allow Bash still blocks write structures', () => {
    addToSessionWhitelist(sessionId, 'Bash', { command: 'ls' })

    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'echo x > out.txt' })).toBe(false)
    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'echo $(whoami)' })).toBe(false)
  })

  test('always-allow Write is tool-scoped not path-scoped', () => {
    addToSessionWhitelist(sessionId, 'Write', { file_path: '/a.txt' })

    expect(isSessionWhitelisted(sessionId, 'Write', { file_path: '/b.txt' })).toBe(true)
    expect(isSessionWhitelisted(sessionId, 'Edit', { file_path: '/a.txt' })).toBe(false)
  })

  test('dangerous bash is never added to whitelist', () => {
    addToSessionWhitelist(sessionId, 'Bash', { command: 'rm -rf tmp' })
    expect(isSessionWhitelisted(sessionId, 'Bash', { command: 'ls' })).toBe(false)
  })
})
