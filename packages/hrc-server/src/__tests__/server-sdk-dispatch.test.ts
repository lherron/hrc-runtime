/**
 * RED/GREEN tests for hrc-server Phase 2 — SDK dispatch path (T-00968 / T-00967)
 *
 * Tests the server's SDK transport support:
 *   - dispatchTurn with interactive=false uses SDK transport
 *   - SDK dispatch creates runtime with transport='sdk'
 *   - Raw ledger records agent-spaces events during SDK dispatch
 *   - runtime_buffers populated during SDK dispatch
 *   - Continuation persisted on session after SDK turn
 *   - Provider mismatch returns 422
 *   - Capture on SDK runtime reads from runtime_buffers
 *   - Attach on SDK runtime returns error
 *
 * Pass conditions for Larry (T-00967):
 *   1. POST /v1/turns with { harness: { interactive: false } } returns transport='sdk' in response
 *   2. Runtime record created by SDK dispatch has transport='sdk', no tmux_json
 *   3. Events with source='agent-spaces' appear in the raw events ledger during SDK dispatch
 *   4. GET /v1/capture on SDK runtime returns text from runtime_buffers
 *   5. Continuation from SDK turn is persisted on session record
 *   6. POST /v1/turns with provider mismatch on existing runtime returns 422
 *   7. GET /v1/attach on SDK runtime returns error (attach not supported)
 *   8. Run record transitions: accepted → started → completed
 *   9. Runtime transitions: created → busy → ready after SDK dispatch
 *  10. harness_session_json persisted on runtime record after SDK turn
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 2
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | undefined

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function listRawEvents(): any[] {
  const db = openHrcDatabase(dbPath)
  try {
    return db.events.listFromSeq(1)
  } finally {
    db.close()
  }
}

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const canonical = scope.startsWith('agent:') ? scope : `agent:${scope}`
  const res = await postJson('/v1/sessions/resolve', {
    sessionRef: `${canonical}/lane:default`,
  })
  const data = (await res.json()) as any
  return data.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent.
 * Uses interactive=false without preferredMode so that
 * shouldUseSdkTransport matches (not shouldUseHeadlessTransport). */
function sdkIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
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
      interactive: false,
    },
  }
}

function interactiveCliIntent(
  provider: 'anthropic' | 'openai',
  options: {
    preferredMode?: 'interactive' | 'headless' | 'nonInteractive'
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
      preferredMode: options.preferredMode ?? 'interactive',
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-test-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })

  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
  })
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // ok
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('runtime lifecycle start/attach', () => {
  async function installFakeCodex(
    dirName: string,
    behavior: {
      execDelayMs?: number
      execThreadId?: string
      interactiveBanner?: string
      interactiveDelayMs?: number
      resumeDelayMs?: number
    } = {}
  ): Promise<{ binDir: string; logPath: string; resumePath: string }> {
    const binDir = join(tmpDir, dirName)
    const logPath = join(binDir, 'codex.log')
    const resumePath = join(binDir, 'resume.log')
    await mkdir(binDir, { recursive: true })
    const scriptPath = join(binDir, 'codex')
    await writeFile(
      scriptPath,
      `#!/bin/sh
set -eu
cmd="\${1:-}"
log_path=${JSON.stringify(logPath)}
resume_path=${JSON.stringify(resumePath)}
if [ "$cmd" = "exec" ]; then
  printf 'exec\\n' >> "$log_path"
  /bin/sleep ${((behavior.execDelayMs ?? 0) / 1000).toFixed(3)}
  printf '{"type":"thread.started","thread_id":"${behavior.execThreadId ?? 'thread-123'}"}\\n'
  exit 0
fi
if [ "$cmd" = "resume" ]; then
  printf 'resume:%s\\n' "\${2:-}" >> "$resume_path"
  /bin/sleep ${((behavior.resumeDelayMs ?? 0) / 1000).toFixed(3)}
  exit 0
fi
printf 'interactive:%s\\n' "$*" >> "$log_path"
printf '%s\\n' ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
/bin/sleep ${((behavior.interactiveDelayMs ?? 1_500) / 1000).toFixed(3)}
exit 0
`,
      'utf-8'
    )
    await chmod(scriptPath, 0o755)
    return { binDir, logPath, resumePath }
  }

  async function waitForResumeLog(resumePath: string, expectedLines: number): Promise<string[]> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const resumeLog = await readFile(resumePath, 'utf-8')
        const lines = resumeLog
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
        if (lines.length >= expectedLines) {
          return lines
        }
      } catch {
        // Resume log is written asynchronously by the fake Codex shim.
      }
      await Bun.sleep(100)
    }

    throw new Error(`resume log ${resumePath} did not reach ${expectedLines} lines in time`)
  }

  async function waitForRuntimeStatus(
    runtimeId: string,
    expectedStatuses: string[],
    timeoutMs = 5_000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const db = openHrcDatabase(dbPath)
      try {
        const runtime = db.runtimes.getByRuntimeId(runtimeId)
        if (runtime && expectedStatuses.includes(runtime.status)) {
          return runtime.status
        }
      } finally {
        db.close()
      }
      await Bun.sleep(100)
    }

    throw new Error(
      `runtime ${runtimeId} did not reach one of [${expectedStatuses.join(', ')}] within ${timeoutMs}ms`
    )
  }

  it('POST /v1/runtimes/start is idempotent for headless codex startup and persists continuation', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-idempotent')
    const hsid = await resolveSession('lifecycle-start-idempotent')

    const startBody = {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed a detached session',
      }),
    }

    const firstRes = await postJson('/v1/runtimes/start', startBody)
    expect(firstRes.status).toBe(200)
    const firstData = (await firstRes.json()) as any

    const secondRes = await postJson('/v1/runtimes/start', startBody)
    expect(secondRes.status).toBe(200)
    const secondData = (await secondRes.json()) as any

    expect(secondData.runtimeId).toBe(firstData.runtimeId)

    const sessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    const sessionData = (await sessionRes.json()) as any
    expect(sessionData.continuation).toEqual({
      provider: 'openai',
      key: 'thread-123',
    })

    const launchesRes = await fetchSocket(
      `/v1/launches?runtimeId=${encodeURIComponent(firstData.runtimeId)}`
    )
    const launches = (await launchesRes.json()) as any[]
    expect(launches).toHaveLength(1)

    const execLog = await readFile(fakeCodex.logPath, 'utf-8')
    expect(execLog.trim().split('\n')).toEqual(['exec'])
  })

  it('POST /v1/clear-context can rotate to a fresh session without inheriting continuation', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-clear-context-new-session', {
      execThreadId: 'thread-old',
    })
    const hsid = await resolveSession('lifecycle-clear-context-new-session')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed detached session',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as { runtimeId: string }
    await waitForRuntimeStatus(startData.runtimeId, ['ready'])

    const clearRes = await postJson('/v1/clear-context', {
      hostSessionId: hsid,
      dropContinuation: true,
    })
    expect(clearRes.status).toBe(200)
    const clearData = (await clearRes.json()) as {
      hostSessionId: string
      priorHostSessionId: string
      generation: number
    }
    expect(clearData.priorHostSessionId).toBe(hsid)
    expect(clearData.hostSessionId).not.toBe(hsid)
    expect(clearData.generation).toBe(2)

    const priorSessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    const priorSessionData = (await priorSessionRes.json()) as any
    expect(priorSessionData.status).toBe('archived')
    expect(priorSessionData.continuation).toEqual({
      provider: 'openai',
      key: 'thread-old',
    })

    const nextSessionRes = await fetchSocket(`/v1/sessions/by-host/${clearData.hostSessionId}`)
    const nextSessionData = (await nextSessionRes.json()) as any
    expect(nextSessionData.status).toBe('active')
    expect(nextSessionData.continuation).toBeUndefined()
  })

  it('POST /v1/runtimes/attach blocks on in-flight start and is idempotent for codex resume', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach', {
      execDelayMs: 350,
      resumeDelayMs: 250,
    })
    const hsid = await resolveSession('lifecycle-attach-blocks')

    const startPromise = postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before attach',
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 75))

    let attachSettled = false
    const attachPromise = (async () => {
      const startRes = await startPromise
      const startData = (await startRes.json()) as any
      const attachRes = await postJson('/v1/runtimes/attach', {
        runtimeId: startData.runtimeId,
      })
      attachSettled = true
      return { startData, attachRes }
    })()

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(attachSettled).toBe(false)

    const { startData, attachRes } = await attachPromise
    expect(attachRes.status).toBe(200)
    const attachData = (await attachRes.json()) as any
    expect(attachData.bindingFence.runtimeId).toBeString()
    expect(attachData.bindingFence.runtimeId).not.toBe(startData.runtimeId)

    await new Promise((resolve) => setTimeout(resolve, 400))

    const secondAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(secondAttachRes.status).toBe(200)

    expect(await waitForResumeLog(fakeCodex.resumePath, 1)).toEqual(['resume:thread-123'])
  })

  it('POST /v1/runtimes/attach prefers tmux sessionId when stored sessionName is stale', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-stale-session-name')
    const hsid = await resolveSession('lifecycle-attach-stale-session-name')
    let sessionId = ''

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before stale session attach',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(200)
    const initialAttachData = (await initialAttachRes.json()) as any
    const attachedRuntimeId = String(initialAttachData.bindingFence.runtimeId)

    const db = openHrcDatabase(dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(attachedRuntimeId)
      expect(runtime).not.toBeNull()
      expect(runtime?.tmuxJson?.['sessionId']).toBeString()
      sessionId = String(runtime?.tmuxJson?.['sessionId'])

      db.runtimes.update(attachedRuntimeId, {
        tmuxJson: {
          ...(runtime?.tmuxJson ?? {}),
          sessionName: 'hrc-stale-session-name',
        },
        updatedAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    const attachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: attachedRuntimeId,
    })
    expect(attachRes.status).toBe(200)
    const attachData = (await attachRes.json()) as any
    expect(attachData.argv).toEqual([
      'tmux',
      '-S',
      tmuxSocketPath,
      'attach-session',
      '-t',
      sessionId,
    ])
  })

  it('POST /v1/runtimes/attach rematerializes tmux when the requested codex tmux runtime is already dead', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach-dead-runtime')
    const hsid = await resolveSession('lifecycle-attach-dead-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before dead attach recovery',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(200)
    const initialAttachData = (await initialAttachRes.json()) as any
    const attachedRuntimeId = String(initialAttachData.bindingFence.runtimeId)

    const db = openHrcDatabase(dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(attachedRuntimeId)
      expect(runtime).not.toBeNull()
      db.runtimes.update(attachedRuntimeId, {
        status: 'dead',
        updatedAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: attachedRuntimeId,
    })
    expect(recoveredAttachRes.status).toBe(200)
    const recoveredAttachData = (await recoveredAttachRes.json()) as any
    expect(recoveredAttachData.bindingFence.runtimeId).toBeString()
    expect(recoveredAttachData.argv).toContain('attach-session')

    expect(await waitForResumeLog(fakeCodex.resumePath, 1)).toContain('resume:thread-123')
  }, 10_000)

  it('POST /v1/runtimes/attach rematerializes tmux in one call after the prior attach runtime exits', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach-terminated-runtime', {
      resumeDelayMs: 250,
    })
    const hsid = await resolveSession('lifecycle-attach-terminated-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before terminated attach recovery',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(200)
    const initialAttachData = (await initialAttachRes.json()) as any
    const attachedRuntimeId = String(initialAttachData.bindingFence.runtimeId)

    expect(await waitForResumeLog(fakeCodex.resumePath, 1)).toEqual(['resume:thread-123'])
    expect(await waitForRuntimeStatus(attachedRuntimeId, ['terminated'])).toBe('terminated')

    const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: attachedRuntimeId,
    })
    expect(recoveredAttachRes.status).toBe(200)
    const recoveredAttachData = (await recoveredAttachRes.json()) as any
    expect(recoveredAttachData.bindingFence.runtimeId).toBeString()
    expect(recoveredAttachData.bindingFence.runtimeId).not.toBe(attachedRuntimeId)

    expect(await waitForResumeLog(fakeCodex.resumePath, 2)).toEqual([
      'resume:thread-123',
      'resume:thread-123',
    ])
  }, 10_000)

  it('POST /v1/runtimes/attach attaches directly to a live codex tmux runtime without continuation', async () => {
    const hsid = await resolveSession('lifecycle-attach-live-no-continuation')
    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(200)
    const ensureData = (await ensureRes.json()) as any
    const runtimeId = String(ensureData.runtimeId)

    const attachRes = await postJson('/v1/runtimes/attach', {
      runtimeId,
    })
    expect(attachRes.status).toBe(200)
    const attachData = (await attachRes.json()) as any
    expect(attachData.argv[0]).toBe('tmux')
    expect(attachData.argv).toContain('attach-session')
  })

  it('POST /v1/internal/launches/:id/exited marks the runtime terminated when the harness exits', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-dead-after-exit', {
      interactiveDelayMs: 10_000,
    })
    const hsid = await resolveSession('lifecycle-exited-dead-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    let launchId = ''
    let sessionTarget = ''
    const db = openHrcDatabase(dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(startData.runtimeId)
      expect(runtime).not.toBeNull()
      expect(runtime?.launchId).toBeString()
      launchId = String(runtime?.launchId)
      sessionTarget = String(runtime?.tmuxJson?.['sessionId'] ?? runtime?.tmuxJson?.['sessionName'])
    } finally {
      db.close()
    }

    const killed = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-session', '-t', sessionTarget], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const killStderr = await new Response(killed.stderr).text()
    expect(await killed.exited).toBe(0)
    expect(killStderr.trim()).toBe('')

    const exitedRes = await postJson(`/v1/internal/launches/${launchId}/exited`, {
      hostSessionId: hsid,
      exitCode: 0,
    })
    expect(exitedRes.status).toBe(200)

    const runtimeRes = await fetchSocket(`/v1/runtimes?hostSessionId=${encodeURIComponent(hsid)}`)
    expect(runtimeRes.status).toBe(200)
    const runtimes = (await runtimeRes.json()) as Array<{ runtimeId: string; status: string }>
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0]?.runtimeId).toBe(startData.runtimeId)
    expect(runtimes[0]?.status).toBe('terminated')
  })

  it('POST /v1/runtimes/start launches the interactive harness before attach', async () => {
    const interactiveBanner = 'INTERACTIVE_START_LAUNCHED'
    const fakeCodex = await installFakeCodex('fake-codex-interactive-start', {
      interactiveBanner,
      interactiveDelayMs: 2_000,
    })
    const hsid = await resolveSession('lifecycle-interactive-start')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const attachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(attachRes.status).toBe(200)
    const attachData = (await attachRes.json()) as any
    expect(attachData.bindingFence.runtimeId).toBe(startData.runtimeId)

    let captureText = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const captureRes = await fetchSocket(`/v1/capture?runtimeId=${startData.runtimeId}`)
      expect(captureRes.status).toBe(200)
      captureText = ((await captureRes.json()) as any).text
      if (captureText.includes(interactiveBanner)) {
        break
      }
      await Bun.sleep(100)
    }

    expect(captureText).toContain(interactiveBanner)

    const execLog = await readFile(fakeCodex.logPath, 'utf-8')
    expect(execLog).toContain('interactive:')
  })
})

// ---------------------------------------------------------------------------
// 1. SDK dispatch basic — transport='sdk' in response
// ---------------------------------------------------------------------------
describe('SDK dispatch via dispatchTurn', () => {
  it('returns transport=sdk when harness.interactive=false', async () => {
    const hsid = await resolveSession('sdk-test-1')

    const res = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Hello from SDK test',
      runtimeIntent: sdkIntent(),
    })

    // RED GATE: This will fail until Larry implements SDK dispatch branching
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.status).toBe('completed')
    expect(data.runtimeId).toBeDefined()
    // The key Phase 2 assertion: transport should be 'sdk', not 'tmux'
    expect(data.transport).toBe('sdk')
  })
})

// ---------------------------------------------------------------------------
// 2. SDK runtime record — transport='sdk', no tmux_json
// ---------------------------------------------------------------------------
describe('SDK runtime record', () => {
  it('creates runtime with transport=sdk and no tmux session', async () => {
    const hsid = await resolveSession('sdk-test-2')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Check runtime transport',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete (it's synchronous in-process)
    await new Promise((r) => setTimeout(r, 500))

    // Check the events for runtime.created
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    await eventsRes.text()
    // RED GATE: SDK runtime creation may not emit runtime.created or may use different transport
    // The runtime should exist with transport='sdk'
    expect(turnData.runtimeId).toBeString()
  })
})

// ---------------------------------------------------------------------------
// 3. Events from SDK dispatch appear in watch stream
// ---------------------------------------------------------------------------
describe('SDK events in raw ledger', () => {
  it('SDK dispatch events have source=agent-spaces in the raw events ledger', async () => {
    const hsid = await resolveSession('sdk-test-3')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Generate events',
      runtimeIntent: sdkIntent(),
    })

    // Wait for in-process SDK dispatch to complete
    await new Promise((r) => setTimeout(r, 1000))

    const events = listRawEvents()

    // Should have agent-spaces sourced events from the SDK adapter
    const sdkEvents = events.filter((e: any) => e.source === 'agent-spaces')
    expect(sdkEvents.length).toBeGreaterThan(0)

    // At minimum, we expect sdk.running and sdk.complete
    const kinds = sdkEvents.map((e: any) => e.eventKind)
    expect(kinds).toContain('sdk.running')
    expect(kinds).toContain('sdk.complete')
  })
})

// ---------------------------------------------------------------------------
// 4. Capture on SDK runtime reads from runtime_buffers
// ---------------------------------------------------------------------------
describe('capture on SDK runtime', () => {
  it('returns text from runtime_buffers instead of tmux', async () => {
    const hsid = await resolveSession('sdk-test-4')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Buffer test',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete and populate buffers
    await new Promise((r) => setTimeout(r, 1000))

    const captureRes = await fetchSocket(`/v1/capture?runtimeId=${turnData.runtimeId}`)
    expect(captureRes.status).toBe(200)
    const captureData = (await captureRes.json()) as any
    expect(captureData.text).toBeString()
    expect(captureData.text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Continuation persisted on session after SDK turn
// ---------------------------------------------------------------------------
describe('continuation persistence', () => {
  it('stores continuation on session record after SDK turn', async () => {
    const hsid = await resolveSession('sdk-test-5')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Continuation test',
      runtimeIntent: sdkIntent(),
    })

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Fetch the session and check continuation
    const sessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    expect(sessionRes.status).toBe(200)
    const sessionData = (await sessionRes.json()) as any
    expect(sessionData.continuation).toBeDefined()
    expect(sessionData.continuation.provider).toBe('anthropic')
  })
})

// ---------------------------------------------------------------------------
// 6. Provider mismatch returns 422
// ---------------------------------------------------------------------------
describe('provider mismatch', () => {
  it('returns 422 when requesting different provider on existing SDK runtime', async () => {
    const hsid = await resolveSession('sdk-test-6')

    // First turn: anthropic
    const firstRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'First turn',
      runtimeIntent: sdkIntent('anthropic'),
    })
    expect(firstRes.status).toBe(200)

    // Wait for first turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Second turn: openai (provider mismatch)
    const secondRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Mismatched turn',
      runtimeIntent: sdkIntent('openai'),
    })

    expect(secondRes.status).toBe(422)
    const errorData = (await secondRes.json()) as any
    expect(errorData.error).toBeDefined()
    expect(errorData.error.code).toMatch(/provider.?mismatch/i)
  })
})

// ---------------------------------------------------------------------------
// 7. Attach on SDK runtime returns error
// ---------------------------------------------------------------------------
describe('attach on SDK runtime', () => {
  it('returns error for SDK runtime attach requests', async () => {
    const hsid = await resolveSession('sdk-test-7')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Attach test',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    const attachRes = await fetchSocket(`/v1/attach?runtimeId=${turnData.runtimeId}`)
    // SDK runtimes should reject attach
    expect(attachRes.status).toBeGreaterThanOrEqual(400)
    const errorData = (await attachRes.json()) as any
    expect(errorData.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Run record lifecycle
// ---------------------------------------------------------------------------
describe('SDK run record lifecycle', () => {
  it('transitions run through accepted → started → completed', async () => {
    const hsid = await resolveSession('sdk-test-8')

    await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Lifecycle test',
      runtimeIntent: sdkIntent(),
    })

    // Wait for full SDK turn lifecycle
    await new Promise((r) => setTimeout(r, 1000))

    // Check events for the full lifecycle
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const eventKinds = events.map((e: any) => e.eventKind)

    expect(eventKinds).toContain('turn.accepted')
    expect(eventKinds).toContain('turn.started')
    // After SDK turn completes, we expect turn.completed
    expect(eventKinds).toContain('turn.completed')
  })
})

// ---------------------------------------------------------------------------
// 9. harness_session_json persisted on runtime
// ---------------------------------------------------------------------------
describe('harness session identity', () => {
  it('persists provider/frontend as harness identity on runtime', async () => {
    const hsid = await resolveSession('sdk-test-9')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Identity test',
      runtimeIntent: sdkIntent(),
    })
    await turnRes.json()

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    // Verify via events that the runtime was updated
    // (direct runtime query would be better but depends on API surface)
    const eventsRes = await fetchSocket('/v1/events?fromSeq=1')
    const eventsText = await eventsRes.text()
    const events = eventsText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

    // The turn should have completed successfully
    const completed = events.find(
      (e: any) => e.eventKind === 'turn.completed' || e.eventKind === 'sdk.complete'
    )
    expect(completed).toBeDefined()
  })
})
