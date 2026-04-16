import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import type {
  DispatchTurnResponse,
  HrcTargetView,
  SemanticDmResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture | undefined
let server: HrcServer | undefined

function headlessIntent(
  provider: 'anthropic' | 'openai',
  options: {
    preferredMode?: 'headless' | 'nonInteractive'
    pathPrepend?: string[]
    initialPrompt?: string
  } = {}
): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: true,
    },
    execution: {
      preferredMode: options.preferredMode ?? 'headless',
    },
    ...(options.pathPrepend
      ? {
          launch: {
            pathPrepend: options.pathPrepend,
          },
        }
      : {}),
    ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
  }
}

function expectedAnthropicContinuationKey(hostSessionId: string): string {
  return `sdk-${createHash('sha1').update(hostSessionId).digest('hex').slice(0, 12)}`
}

async function createTestServer(): Promise<void> {
  fixture = await createHrcTestFixture('hrc-headless-anthropic-')
  server = await createHrcServer(fixture.serverOpts())
}

async function resolveSession(
  scopeRef: string
): Promise<{ hostSessionId: string; generation: number }> {
  if (!fixture) throw new Error('fixture not initialized')
  return await fixture.resolveSession(scopeRef)
}

async function getSession(hostSessionId: string): Promise<any> {
  if (!fixture) throw new Error('fixture not initialized')
  const res = await fixture.fetchSocket(`/v1/sessions/by-host/${hostSessionId}`)
  expect(res.status).toBe(200)
  return await res.json()
}

function getRuntime(runtimeId: string): any {
  if (!fixture) throw new Error('fixture not initialized')
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function seedHeadlessRuntime(
  hostSessionId: string,
  scopeRef: string,
  generation: number,
  options: {
    continuation?: { provider: 'anthropic'; key: string } | undefined
    lastAppliedIntentJson?: object | undefined
  } = {}
): string {
  if (!fixture) throw new Error('fixture not initialized')
  const runtimeId = `rt-headless-${randomUUID()}`
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()

  try {
    if (options.lastAppliedIntentJson) {
      db.sessions.updateIntent(hostSessionId, options.lastAppliedIntentJson as any, now)
    }
    if (options.continuation) {
      db.sessions.updateContinuation(hostSessionId, options.continuation as any, now)
    }

    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: scopeRef.startsWith('agent:') ? scopeRef : `agent:${scopeRef}`,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      ...(options.continuation ? { continuation: options.continuation } : {}),
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return runtimeId
}

async function installFakeClaude(
  dirName: string,
  options: { interactiveDelayMs?: number } = {}
): Promise<{ binDir: string; logPath: string }> {
  if (!fixture) throw new Error('fixture not initialized')
  const binDir = join(fixture.tmpDir, dirName)
  const logPath = join(binDir, 'claude.log')
  const scriptPath = join(binDir, 'claude')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
log_path=${JSON.stringify(logPath)}
printf 'claude:%s\\n' "$*" >> "$log_path"
printf 'CLAUDE_ATTACH_STARTED\\n'
/bin/sleep ${((options.interactiveDelayMs ?? 1_500) / 1000).toFixed(3)}
exit 0
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)

  return { binDir, logPath }
}

async function installFakeCodex(dirName: string): Promise<{ binDir: string; logPath: string }> {
  if (!fixture) throw new Error('fixture not initialized')
  const binDir = join(fixture.tmpDir, dirName)
  const logPath = join(binDir, 'codex.log')
  const scriptPath = join(binDir, 'codex')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
log_path=${JSON.stringify(logPath)}
cmd="\${1:-}"
if [ "$cmd" = "exec" ]; then
  printf 'exec:%s\\n' "$*" >> "$log_path"
  printf '{"type":"thread.started","thread_id":"thread-openai-headless"}\\n'
  exit 0
fi
printf 'interactive:%s\\n' "$*" >> "$log_path"
exit 0
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)

  return { binDir, logPath }
}

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  if (fixture) {
    await fixture.cleanup()
    fixture = undefined
  }
})

describe('A. Anthropic headless dispatch', () => {
  it('dispatches Anthropic preferredMode=headless via transport=headless and persists continuation', async () => {
    await createTestServer()

    const { hostSessionId } = await resolveSession('anthropic-headless-dispatch')
    const expectedKey = expectedAnthropicContinuationKey(hostSessionId)

    const res = await fixture!.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'Dispatch an anthropic headless turn',
      runtimeIntent: headlessIntent('anthropic'),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as DispatchTurnResponse
    expect(data.transport).toBe('headless')
    expect(data.status).toBe('completed')
    expect(data.runtimeId).toBeString()

    const session = await getSession(hostSessionId)
    expect(session.continuation).toEqual({
      provider: 'anthropic',
      key: expectedKey,
    })

    const runtime = getRuntime(data.runtimeId)
    expect(runtime).not.toBeNull()
    expect(runtime?.transport).toBe('headless')
    expect(runtime?.provider).toBe('anthropic')
    expect(runtime?.tmuxJson).toBeUndefined()
  })
})

describe('B. Anthropic headless start', () => {
  it('starts Anthropic preferredMode=headless with transport=headless and reuses the runtime idempotently', async () => {
    await createTestServer()

    const { hostSessionId } = await resolveSession('anthropic-headless-start')
    const expectedKey = expectedAnthropicContinuationKey(hostSessionId)
    const startBody = {
      hostSessionId,
      intent: headlessIntent('anthropic', {
        initialPrompt: 'Seed an Anthropic headless runtime',
      }),
    }

    const firstRes = await fixture!.postJson('/v1/runtimes/start', startBody)
    expect(firstRes.status).toBe(200)
    const first = (await firstRes.json()) as StartRuntimeResponse
    expect(first.transport).toBe('headless')

    const secondRes = await fixture!.postJson('/v1/runtimes/start', startBody)
    expect(secondRes.status).toBe(200)
    const second = (await secondRes.json()) as StartRuntimeResponse
    expect(second.transport).toBe('headless')
    expect(second.runtimeId).toBe(first.runtimeId)

    const session = await getSession(hostSessionId)
    expect(session.continuation).toEqual({
      provider: 'anthropic',
      key: expectedKey,
    })
  })
})

describe('C. Attach from headless Anthropic runtime', () => {
  it('rematerializes tmux from a headless Anthropic runtime with continuation', async () => {
    await createTestServer()

    const fakeClaude = await installFakeClaude('fake-claude-attach')
    const { hostSessionId } = await resolveSession('anthropic-headless-attach')
    const startRes = await fixture!.postJson('/v1/runtimes/start', {
      hostSessionId,
      intent: headlessIntent('anthropic', {
        pathPrepend: [fakeClaude.binDir],
        initialPrompt: 'Seed before attach',
      }),
    })
    expect(startRes.status).toBe(200)
    const started = (await startRes.json()) as StartRuntimeResponse
    expect(started.transport).toBe('headless')

    const attachRes = await fixture!.postJson('/v1/runtimes/attach', {
      runtimeId: started.runtimeId,
    })
    expect(attachRes.status).toBe(200)
    const attachData = (await attachRes.json()) as any
    expect(attachData.transport).toBe('tmux')
    expect(attachData.argv[0]).toBe('tmux')
    expect(attachData.argv).toContain('attach-session')
    expect(attachData.bindingFence.runtimeId).toBeString()
    expect(attachData.bindingFence.runtimeId).not.toBe(started.runtimeId)

    const attachedRuntime = getRuntime(String(attachData.bindingFence.runtimeId))
    expect(attachedRuntime).not.toBeNull()
    expect(attachedRuntime?.transport).toBe('tmux')
    expect(attachedRuntime?.provider).toBe('anthropic')
  })

  it('returns an error when a headless Anthropic runtime has no continuation', async () => {
    await createTestServer()

    const scopeRef = 'agent:anthropic-headless-no-continuation'
    const { hostSessionId, generation } = await resolveSession(scopeRef)
    const runtimeId = seedHeadlessRuntime(hostSessionId, scopeRef, generation, {
      lastAppliedIntentJson: headlessIntent('anthropic'),
    })

    const attachRes = await fixture!.postJson('/v1/runtimes/attach', {
      runtimeId,
    })

    expect(attachRes.status).toBeGreaterThanOrEqual(400)
    const data = (await attachRes.json()) as any
    expect(data.error).toBeDefined()
    expect(String(data.error.message ?? '')).toContain('continuation')
  })
})

describe('D. DM fallback', () => {
  it('uses headless transport for Anthropic headless DM fallback when no tmux runtime exists', async () => {
    await createTestServer()

    const dmRes = await fixture!.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'fallback to anthropic headless transport',
      runtimeIntent: headlessIntent('anthropic'),
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.execution?.transport).toBe('headless')
    expect(dm.execution?.mode).toBe('headless')
    expect(dm.execution?.runtimeId).toBeString()
    expect(dm.execution?.continuationUpdated).toBe(true)

    const runtime = getRuntime(String(dm.execution?.runtimeId))
    expect(runtime).not.toBeNull()
    expect(runtime?.transport).toBe('headless')
    expect(runtime?.provider).toBe('anthropic')
    expect(runtime?.tmuxJson).toBeUndefined()
  })
})

describe('E. Regression', () => {
  it('keeps Codex headless dispatch on transport=headless', async () => {
    await createTestServer()

    const fakeCodex = await installFakeCodex('fake-codex-openai-headless')
    const { hostSessionId } = await resolveSession('openai-headless-regression')

    const res = await fixture!.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'OpenAI headless regression turn',
      runtimeIntent: headlessIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })

    expect(res.status).toBe(200)
    const data = (await res.json()) as DispatchTurnResponse
    expect(data.transport).toBe('headless')
    expect(data.status).toBe('completed')

    const session = await getSession(hostSessionId)
    expect(session.continuation).toEqual({
      provider: 'openai',
      key: 'thread-openai-headless',
    })
  })
})

describe('F. Target state', () => {
  it('reports an idle Anthropic headless runtime as summoned and headless-capable', async () => {
    await createTestServer()

    const sessionRef = 'agent:anthropic-target-state/lane:main'
    const { hostSessionId } = await resolveSession('anthropic-target-state')

    const startRes = await fixture!.postJson('/v1/runtimes/start', {
      hostSessionId,
      intent: headlessIntent('anthropic', {
        initialPrompt: 'Seed for target state',
      }),
    })
    expect(startRes.status).toBe(200)

    const targetRes = await fixture!.fetchSocket(
      `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
    )
    expect(targetRes.status).toBe(200)
    const target = (await targetRes.json()) as HrcTargetView

    expect(target.state).toBe('summoned')
    expect(target.runtime?.transport).toBe('headless')
    expect(target.capabilities.modesSupported).toContain('headless')
    expect(target.capabilities.sendReady).toBe(false)
    expect(target.capabilities.peekReady).toBe(false)
    expect(target.capabilities.dmReady).toBe(true)
  })
})
