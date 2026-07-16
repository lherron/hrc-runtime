import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMessageRecord, SemanticDmRequest, SemanticDmResponse } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import { cmdDm } from '../commands/dm.js'
import { cmdTurn } from '../commands/turn.js'

const envNames = [
  'ASP_AGENTS_ROOT',
  'ASP_PROJECT',
  'ASP_PROJECT_ROOT_OVERRIDE',
  'HRC_SESSION_REF',
] as const

let tempRoot: string
let projectRoot: string
let localAgentRoot: string
let canonicalAgentsRoot: string
let savedEnv: Map<(typeof envNames)[number], string | undefined>

function profile(defaultScopeRole: string): string {
  return [
    'schemaVersion = 2',
    '',
    '[identity]',
    'display = "Scope Fixture"',
    'role = "tester"',
    'harness = "codex"',
    `default_scope_role = "${defaultScopeRole}"`,
    '',
  ].join('\n')
}

async function captureStdout(action: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write
  const originalExitCode = process.exitCode
  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write

  try {
    await action()
  } finally {
    process.stdout.write = originalWrite
    process.exitCode = originalExitCode
  }

  return chunks.join('')
}

function makeMessageRecord(request: SemanticDmRequest): HrcMessageRecord {
  return {
    messageSeq: 1,
    messageId: 'msg-profile-aware',
    createdAt: '2026-07-16T00:00:00.000Z',
    kind: 'dm',
    phase: 'request',
    from: request.from,
    to: request.to,
    rootMessageId: 'msg-profile-aware',
    body: request.body,
    bodyFormat: 'text/plain',
    execution: { state: 'accepted' },
  }
}

beforeEach(async () => {
  savedEnv = new Map(envNames.map((name) => [name, process.env[name]]))
  tempRoot = await mkdtemp(join(tmpdir(), 'hrcchat-profile-scope-'))
  projectRoot = join(tempRoot, 'project')
  localAgentRoot = join(projectRoot, 'agents', 'clod')
  canonicalAgentsRoot = join(tempRoot, 'canonical-agents')
  const canonicalAgentRoot = join(canonicalAgentsRoot, 'clod')

  await mkdir(localAgentRoot, { recursive: true })
  await mkdir(canonicalAgentRoot, { recursive: true })
  await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
  await writeFile(join(localAgentRoot, 'agent-profile.toml'), profile('tester'))
  await writeFile(join(canonicalAgentRoot, 'agent-profile.toml'), profile('coordinator'))

  process.env['ASP_AGENTS_ROOT'] = canonicalAgentsRoot
  process.env['ASP_PROJECT'] = 'proj'
  process.env['ASP_PROJECT_ROOT_OVERRIDE'] = projectRoot
  Reflect.deleteProperty(process.env, 'HRC_SESSION_REF')
})

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name)
    } else {
      process.env[name] = value
    }
  }
  await rm(tempRoot, { recursive: true, force: true })
})

describe('profile-aware hrcchat address resolution', () => {
  test('dm and turn use the project-local configured role for the same explicit task', async () => {
    const handle = 'clod@proj:T-12345'
    const expectedSessionRef = 'agent:clod:project:proj:task:T-12345:role:tester/lane:main'
    const requests: SemanticDmRequest[] = []
    const client = {
      async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
        requests.push(request)
        return { request: makeMessageRecord(request) }
      },
    } as HrcClient

    await captureStdout(() => cmdDm(client, { json: true }, [handle, 'hello']))
    const turnOutput = await captureStdout(() =>
      cmdTurn({} as HrcClient, { dryRun: true }, [handle, 'hello'])
    )
    const turnPlan = JSON.parse(turnOutput) as { sessionRef: string }

    expect(requests).toHaveLength(1)
    expect(requests[0]?.to).toEqual({ kind: 'session', sessionRef: expectedSessionRef })
    expect(turnPlan.sessionRef).toBe(expectedSessionRef)
    expect(turnPlan.sessionRef).not.toContain(':role:coordinator')
  })

  test('turn surfaces an invalid configured role instead of printing an un-roled plan', async () => {
    await writeFile(join(localAgentRoot, 'agent-profile.toml'), profile('not/a/role'))

    await expect(
      captureStdout(() =>
        cmdTurn({} as HrcClient, { dryRun: true }, ['clod@proj:T-12345', 'hello'])
      )
    ).rejects.toThrow()
  })
})
