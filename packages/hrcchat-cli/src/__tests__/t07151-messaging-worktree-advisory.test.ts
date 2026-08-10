import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageRecord, SemanticDmRequest, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { createGitFixture, runGit } from '../../../../test-support/git-fixture.js'
import { cmdDm } from '../commands/dm.js'

const ENV_NAMES = [
  'ASP_AGENTS_ROOT',
  'ASP_DEFAULT_TASK',
  'ASP_PROJECT',
  'ASP_PROJECT_ROOT_OVERRIDE',
  'HOME',
  'HRC_SESSION_REF',
] as const

describe('T-07151 messaging worktree association preflight', () => {
  let root: string
  let savedEnv: Map<(typeof ENV_NAMES)[number], string | undefined>

  beforeEach(() => {
    savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]))
    root = mkdtempSync(join(tmpdir(), 'hrcchat-t07151-'))
    process.env['HOME'] = root
    Reflect.deleteProperty(process.env, 'ASP_AGENTS_ROOT')
    Reflect.deleteProperty(process.env, 'ASP_DEFAULT_TASK')
    Reflect.deleteProperty(process.env, 'ASP_PROJECT')
    Reflect.deleteProperty(process.env, 'ASP_PROJECT_ROOT_OVERRIDE')
    Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
  })

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  test('dm delivery survives detached, wrong-branch, and absent task worktrees', async () => {
    const projectId = 't07151-fixture'
    const taskId = 'T-07151'
    const projectRoot = join(root, 'praesidium', projectId)
    const agentRoot = join(projectRoot, 'agents', 'cody')
    const repo = createGitFixture(projectRoot, { initialBranch: 'main' })
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
    writeFileSync(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n')
    runGit(repo, ['add', 'asp-targets.toml', 'agents/cody/agent-profile.toml'])
    runGit(repo, ['commit', '-m', 'fixture'])

    const handle = `cody@${projectId}:${taskId}`
    const detachedPath = join(root, `cody-${taskId}-detached`)
    runGit(repo, ['worktree', 'add', '--detach', detachedPath])

    const detached = await deliver(handle)
    expect(detached.requests).toHaveLength(1)
    expect(detached.stderr.trim().split('\n')).toHaveLength(1)
    expect(detached.stderr).toContain('detached HEAD (no branch)')
    expect(detached.stderr).not.toContain('branch detached')

    runGit(repo, ['worktree', 'remove', detachedPath])
    const wrongPath = join(root, `cody-${taskId}-wrong`)
    runGit(repo, ['worktree', 'add', '-b', 'wrong-branch', wrongPath])

    const wrongBranch = await deliver(handle)
    expect(wrongBranch.requests).toHaveLength(1)
    expect(wrongBranch.stderr.trim().split('\n')).toHaveLength(1)
    expect(wrongBranch.stderr).toContain('branch wrong-branch does not carry T-07151')

    runGit(repo, ['worktree', 'remove', wrongPath])

    const absent = await deliver(handle)
    expect(absent.requests).toHaveLength(1)
    expect(absent.stderr).toBe('')
  })
})

async function deliver(handle: string): Promise<{
  requests: SemanticDmRequest[]
  stderr: string
}> {
  const requests: SemanticDmRequest[] = []
  const client = {
    async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
      requests.push(request)
      return { request: messageRecord(request) }
    },
  } as HrcClient
  const writes: string[] = []
  const originalStderrWrite = process.stderr.write
  const originalStdoutWrite = process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write

  try {
    await cmdDm(client, { as: 'human', json: true }, [handle, 'association advisory'])
  } finally {
    process.stderr.write = originalStderrWrite
    process.stdout.write = originalStdoutWrite
  }

  return { requests, stderr: writes.join('') }
}

function messageRecord(request: SemanticDmRequest): HrcMessageRecord {
  return {
    messageSeq: 1,
    messageId: 'msg-t07151',
    createdAt: '2026-08-10T00:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: request.from,
    to: request.to,
    rootMessageId: 'msg-t07151',
    body: request.body,
    bodyFormat: 'text/plain',
    execution: { state: 'accepted' },
  }
}
