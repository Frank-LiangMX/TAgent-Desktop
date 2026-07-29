import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  deleteWorkspace,
  getOrCreateWorkspace,
  listWorkspaces,
  reorderWorkspaces,
} from './workspace-manager'

describe('workspace manager sidebar registry', () => {
  let configDir = ''

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'tagent-workspaces-'))
    process.env.TAGENT_CONFIG_DIR = configDir
  })

  afterEach(() => {
    delete process.env.TAGENT_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  })

  function createProject(name: string): ReturnType<typeof getOrCreateWorkspace> {
    const projectDirectory = join(configDir, 'code', name)
    mkdirSync(projectDirectory, { recursive: true })
    return getOrCreateWorkspace(projectDirectory)
  }

  it('persists a user-defined workspace order', () => {
    const alpha = createProject('alpha')
    const beta = createProject('beta')
    const gamma = createProject('gamma')

    const reordered = reorderWorkspaces([beta.id, alpha.id, gamma.id])

    expect(reordered.map((workspace) => workspace.id)).toEqual([beta.id, alpha.id, gamma.id])
    expect(listWorkspaces().map((workspace) => workspace.id)).toEqual([
      beta.id,
      alpha.id,
      gamma.id,
    ])
  })

  it('removes a workspace index without deleting the local project directory and restores it on reopen', () => {
    const alpha = createProject('alpha')
    const workspaceDataDir = join(configDir, 'projects', alpha.id)

    deleteWorkspace(alpha.id)

    expect(listWorkspaces()).toEqual([])
    expect(existsSync(workspaceDataDir)).toBe(true)

    getOrCreateWorkspace(alpha.projectDirectory!)
    expect(listWorkspaces().map((workspace) => workspace.id)).toEqual([alpha.id])
  })
})
