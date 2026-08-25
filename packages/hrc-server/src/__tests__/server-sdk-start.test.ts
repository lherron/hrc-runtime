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
 *   - Attach on SDK runtime returns error
 *
 * Pass conditions for Larry (T-00967):
 *   1. POST /v1/turns with { harness: { interactive: false } } returns transport='sdk' in response
 *   2. Runtime record created by SDK dispatch has transport='sdk', no tmux_json
 *   3. Events with source='agent-spaces' appear in the raw events ledger during SDK dispatch
 *   4. GET /v1/capture on SDK runtime is refused; operators should use events
 *   5. Continuation from SDK turn is persisted on session record
 *   6. POST /v1/turns with provider mismatch on existing runtime returns 422
 *   7. GET /v1/attach on SDK runtime returns error (attach not supported)
 *   8. Run record transitions: accepted → started → completed
 *   9. Runtime transitions: created → busy → ready after SDK dispatch
 *  10. harness_session_json persisted on runtime record after SDK turn
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 2
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { installFakeCodex } from './fixtures/fake-harness-driver'
import {
  readRuntime,
  seedSessionContinuation,
  seedTerminatedTmuxRuntime,
  waitForQueuedPrompt,
} from './fixtures/sdk-dispatch-database.fixture'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | undefined
let projectRoot: string
let originalPath: string | undefined
let originalAspClaudePath: string | undefined
let originalAspCodexPath: string | undefined
let originalAspCodexSkipCommonPaths: string | undefined
let originalAspHeadlessDurableBroker: string | undefined

const INTEGRATION_TIMEOUT_MS = 60_000

// This file boots real server instances and compiles real harness plans. Keep a
// bounded integration timeout, but leave enough headroom for loaded-box runs:
// eight concurrent copies have pushed the real compile RPC to roughly 30s.
setDefaultTimeout(INTEGRATION_TIMEOUT_MS)

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((signalResolve) => {
    resolve = signalResolve
  })
  return { promise, resolve }
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
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

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const canonical = scope.startsWith('agent:') ? scope : `agent:${scope}`
  const res = await postJson('/v1/sessions/resolve', {
    sessionRef: `${canonical}/lane:default`,
    create: true,
  })
  const data = (await res.json()) as any
  return data.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent.
 * Uses an explicit SDK harness id so Anthropic's default Ghostty routing does
 * not capture SDK-specific assertions. */
function sdkIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: false,
      id: provider === 'anthropic' ? 'agent-sdk' : 'pi-sdk',
    },
  }
}

function interactiveCliIntent(
  provider: 'anthropic' | 'openai',
  options: {
    preferredMode?: 'interactive' | 'headless' | 'nonInteractive'
    pathPrepend?: string[]
    initialPrompt?: string
    interactive?: boolean
  } = {}
): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: options.interactive ?? true,
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

void sdkIntent

beforeEach(async () => {
  originalPath = process.env['PATH']
  originalAspClaudePath = process.env['ASP_CLAUDE_PATH']
  originalAspCodexPath = process.env['ASP_CODEX_PATH']
  originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  originalAspHeadlessDurableBroker = process.env['ASP_HEADLESS_DURABLE_BROKER']

  // T-01866 — HRC now admits ONLY harness-broker/0.2 broker profiles. The
  // currently-installed ASP emits the v0.2 headless codex profile only when this
  // operator flag is set (Ph4b); clod's co-transactional agent-spaces half makes
  // v0.2 UNCONDITIONAL, after which this flag is a harmless no-op. Set it so the
  // real compile in these integration tests yields the v0.2 profile HRC requires.
  process.env['ASP_HEADLESS_DURABLE_BROKER'] = '1'

  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-test-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')
  projectRoot = join(tmpDir, 'project')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
  await mkdir(projectRoot, { recursive: true })

  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    headlessCodexBrokerEnabled: false,
    claudeCodeTmuxBrokerEnabled: false,
    codexCliTmuxBrokerEnabled: false,
  })
})

afterEach(async () => {
  if (originalPath === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (=undefined leaks string "undefined")
    delete process.env['PATH']
  } else {
    process.env['PATH'] = originalPath
  }
  if (originalAspCodexPath === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_PATH']
  } else {
    process.env['ASP_CODEX_PATH'] = originalAspCodexPath
  }
  if (originalAspClaudePath === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CLAUDE_PATH']
  } else {
    process.env['ASP_CLAUDE_PATH'] = originalAspClaudePath
  }
  if (originalAspCodexSkipCommonPaths === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  } else {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalAspCodexSkipCommonPaths
  }
  if (originalAspHeadlessDurableBroker === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_HEADLESS_DURABLE_BROKER']
  } else {
    process.env['ASP_HEADLESS_DURABLE_BROKER'] = originalAspHeadlessDurableBroker
  }

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
  // T-01757 (Wave C, A2): codex headless START provisions THROUGH the
  // HarnessBrokerController, which requires the headless codex broker flag ON.
  // The default beforeEach server runs with the flag OFF (to exercise the
  // fail-closed legacy routes), so broker-start tests recreate the server with
  // the flag ON over the same paths.
  async function restartServerWithHeadlessCodexBroker(): Promise<void> {
    await installFakeCodex(tmpDir, 'fake-codex-headless-broker')
    await server.stop()
    server = await createHrcServer({
      runtimeRoot,
      stateRoot,
      socketPath,
      lockPath,
      spoolDir,
      dbPath,
      tmuxSocketPath,
      headlessCodexBrokerEnabled: true,
      claudeCodeTmuxBrokerEnabled: false,
      codexCliTmuxBrokerEnabled: false,
    })
  }

  // A broker-routed codex headless START intent: interactive:false marks it a
  // broker candidate for decideHeadlessExecutionRoute (interactive codex stays
  // on the legacy/tmux route).
  function headlessCodexIntent(options: {
    pathPrepend?: string[]
    initialPrompt?: string
  }): object {
    return interactiveCliIntent('openai', {
      preferredMode: 'headless',
      interactive: false,
      ...options,
    })
  }

  // T-01757 (Wave C, A2): the out-of-process asp-broker child cannot spawn in
  // bun unit tests, so broker-START tests stub getHarnessBrokerController().start()
  // (the established .dispatchInput stub pattern). The route decision + the real
  // plan compile still run BEFORE the stub, so coverage stays on what we care
  // about (headless routing, compiled interactionMode, persistence,
  // artifact-absence, idempotent reuse); only the spawn is replaced. The stub
  // persists a harness-broker/headless runtime (+invocation, +session
  // continuation) and returns { ok, runtime }. `calls` captures each start input
  // so tests can regression-lock the compiled mode and assert the reuse seam.
  // `gate`, when provided, holds the start "in flight" until it resolves.
  function installHeadlessBrokerStartStub(
    hostSessionId: string,
    options: { continuationKey?: string; gate?: Promise<unknown> } = {}
  ): {
    calls: any[]
    inputCalls: any[]
    runtimeIds: string[]
    startCalled: Promise<void>
    runtimePersisted: Promise<void>
    inputDispatched: Promise<void>
  } {
    const calls: any[] = []
    const inputCalls: any[] = []
    const runtimeIds: string[] = []
    const startCalled = createSignal()
    const runtimePersisted = createSignal()
    const inputDispatched = createSignal()
    ;(server as any).getHarnessBrokerController = () => ({
      start: async (input: any) => {
        calls.push(input)
        startCalled.resolve()
        if (options.gate) {
          await options.gate
        }
        await input?.brokerClient?.close?.().catch?.(() => undefined)
        const db = openHrcDatabase(dbPath)
        try {
          const session = db.sessions.getByHostSessionId(hostSessionId)
          if (!session) {
            throw new Error(`broker-start stub: no session for ${hostSessionId}`)
          }
          const now = new Date().toISOString()
          const runtimeId = `rt-broker-${randomUUID()}`
          const operationId = `op-broker-${randomUUID()}`
          const invocationId = `inv-broker-${randomUUID()}`
          const continuation = {
            provider: 'openai' as const,
            key: options.continuationKey ?? 'thread-123',
          }
          db.runtimes.insert({
            runtimeId,
            hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: session.generation,
            transport: 'headless',
            harness: 'codex-cli',
            provider: 'openai',
            status: 'ready',
            supportsInflightInput: true,
            adopted: false,
            controllerKind: 'harness-broker',
            activeOperationId: operationId,
            activeInvocationId: invocationId,
            continuation,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
          })
          db.brokerInvocations.insert({
            invocationId,
            operationId,
            runtimeId,
            brokerProtocol: 'harness-broker/0.2',
            brokerDriver: 'codex-cli-tmux',
            invocationState: 'ready',
            capabilitiesJson: JSON.stringify({}),
            specHash: 'sha256:spec-broker-start-stub',
            startRequestHash: 'sha256:req-broker-start-stub',
            selectedProfileHash: 'sha256:prof-broker-start-stub',
            createdAt: now,
            updatedAt: now,
          })
          db.sessions.updateContinuation(hostSessionId, continuation, now)
          runtimeIds.push(runtimeId)
          runtimePersisted.resolve()
          return { ok: true, runtime: db.runtimes.getByRuntimeId(runtimeId) }
        } finally {
          db.close()
        }
      },
      dispatchInput: async (input: any) => {
        inputCalls.push(input)
        const db = openHrcDatabase(dbPath)
        try {
          const runId = input.input.metadata?.runId
          if (typeof runId !== 'string') {
            throw new Error('broker-input stub: input metadata has no runId')
          }
          const completedAt = new Date().toISOString()
          db.runs.markCompleted(runId, {
            status: 'completed',
            completedAt,
            updatedAt: completedAt,
          })
          inputDispatched.resolve()
          return { ok: true, response: { accepted: true } }
        } finally {
          db.close()
        }
      },
    })
    return {
      calls,
      inputCalls,
      runtimeIds,
      startCalled: startCalled.promise,
      runtimePersisted: runtimePersisted.promise,
      inputDispatched: inputDispatched.promise,
    }
  }

  it('interactive ensure fails closed when no broker-admissible route exists', async () => {
    const hsid = await resolveSession('interactive-dispatch-no-stale-session-continuation')
    seedTerminatedTmuxRuntime(dbPath, {
      hostSessionId: hsid,
      scopeRef: 'agent:interactive-dispatch-no-stale-session-continuation',
      runtimeId: 'rt-prior-terminated-no-continuation',
    })
    seedSessionContinuation(dbPath, hsid, 'stale-session-continuation')

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(503)
    const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('ensureRuntime supports only broker-admissible runtimes')
  })

  it('interactive ensure does not mint legacy tmux runtimes with runtime continuation present', async () => {
    const hsid = await resolveSession('interactive-dispatch-runtime-continuation')
    seedSessionContinuation(dbPath, hsid, 'stale-session-continuation')

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(503)
    const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('ensureRuntime supports only broker-admissible runtimes')
  })

  it('headless codex dispatch fails closed instead of using legacy exec', async () => {
    const fakeCodex = await installFakeCodex(tmpDir, 'fake-codex-headless-session-continuation')
    const hsid = await resolveSession('headless-dispatch-session-continuation-fallback')
    const db = openHrcDatabase(dbPath)
    try {
      db.sessions.updateContinuation(
        hsid,
        { provider: 'openai', key: 'session-headless-continuation' },
        new Date().toISOString()
      )
    } finally {
      db.close()
    }

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Dispatch headless with session fallback',
      runtimeIntent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(turnRes.status).toBe(503)
    const body = (await turnRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('headless legacy execution is unavailable')

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  })

  it('POST /v1/runtimes/start provisions headless codex THROUGH the broker and is idempotent', async () => {
    // T-01757 (Wave C, A2): codex headless START goes through the
    // HarnessBrokerController (parent acceptance), NOT exec.ts. Asserts the
    // broker contract: 200 + controllerKind 'harness-broker' + NO launch
    // artifact + the compiled plan is mode=headless (regression-locks the
    // normalize bug that flipped headless->interactive) + idempotent reuse
    // does NOT re-call controller.start().
    await restartServerWithHeadlessCodexBroker()
    const hsid = await resolveSession('lifecycle-start-idempotent')
    const stub = installHeadlessBrokerStartStub(hsid)

    const startBody = {
      hostSessionId: hsid,
      intent: headlessCodexIntent({}),
    }

    const firstRes = await postJson('/v1/runtimes/start', startBody)
    expect(firstRes.status).toBe(200)
    const firstData = (await firstRes.json()) as any

    const firstRuntime = readRuntime(dbPath, firstData.runtimeId)
    expect(firstRuntime?.controllerKind).toBe('harness-broker')
    expect(firstRuntime?.transport).toBe('headless')

    // Regression-lock: the broker plan compiled in HEADLESS mode (not interactive).
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].profile.interactionMode).toBe('headless')

    const secondRes = await postJson('/v1/runtimes/start', startBody)
    expect(secondRes.status).toBe(200)
    const secondData = (await secondRes.json()) as any

    // Idempotent: a live broker headless runtime with continuation is REUSED —
    // controller.start() is NOT called again (no re-provision).
    expect(secondData.runtimeId).toBe(firstData.runtimeId)
    expect(stub.calls).toHaveLength(1)

    const sessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    const sessionData = (await sessionRes.json()) as any
    expect(sessionData.continuation).toEqual({
      provider: 'openai',
      key: 'thread-123',
    })

    // Broker route writes NO legacy launch artifact (exec.ts retired).
    const launchesRes = await fetchSocket(
      `/v1/launches?runtimeId=${encodeURIComponent(firstData.runtimeId)}`
    )
    const launches = (await launchesRes.json()) as any[]
    expect(launches).toHaveLength(0)
  })

  it('POST /v1/runtimes/start delivers initialPrompt when reusing a headless broker runtime', async () => {
    await restartServerWithHeadlessCodexBroker()
    const hsid = await resolveSession('lifecycle-start-existing-prompt')
    const stub = installHeadlessBrokerStartStub(hsid)

    const firstRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: headlessCodexIntent({}),
    })
    expect(firstRes.status).toBe(200)
    const firstData = (await firstRes.json()) as { runtimeId: string }

    const secondRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: headlessCodexIntent({ initialPrompt: 'wake the existing session' }),
    })
    expect(secondRes.status).toBe(200)
    const secondData = (await secondRes.json()) as { runtimeId: string }

    expect(secondData.runtimeId).toBe(firstData.runtimeId)
    expect(stub.calls).toHaveLength(1)
    expect(stub.inputCalls).toHaveLength(1)
    expect(stub.inputCalls[0].input.content).toEqual([
      { type: 'text', text: 'wake the existing session' },
    ])
  })

  it('keeps a fresh-session prompt in the broker start after the waiting client exits', async () => {
    await restartServerWithHeadlessCodexBroker()
    const hsid = await resolveSession('lifecycle-start-fresh-prompt-client-exit')
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const stub = installHeadlessBrokerStartStub(hsid, { gate })
    const controller = new AbortController()

    const request = fetchSocket('/v1/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostSessionId: hsid,
        prompt: 'fresh prompt must survive caller timeout',
        runtimeIntent: headlessCodexIntent({}),
        waitForCompletion: true,
      }),
      signal: controller.signal,
    })

    try {
      await stub.startCalled
      controller.abort()
      await request.catch(() => undefined)

      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0].startRequest.initialInput?.content).toEqual([
        { type: 'text', text: 'fresh prompt must survive caller timeout' },
      ])
    } finally {
      releaseGate()
    }

    await stub.runtimePersisted
    expect(stub.runtimeIds).toHaveLength(1)
  })

  it(
    'queues an existing-session prompt behind boot and delivers it after the client exits',
    async () => {
      await restartServerWithHeadlessCodexBroker()
      const hsid = await resolveSession('lifecycle-start-existing-boot-prompt-client-exit')
      let releaseGate: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const stub = installHeadlessBrokerStartStub(hsid, { gate })

      const bootRequest = postJson('/v1/runtimes/start', {
        hostSessionId: hsid,
        intent: headlessCodexIntent({}),
      })
      await stub.startCalled

      const controller = new AbortController()
      const promptRequest = fetchSocket('/v1/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostSessionId: hsid,
          prompt: 'queued prompt must survive boot timeout',
          runtimeIntent: headlessCodexIntent({}),
          waitForCompletion: true,
        }),
        signal: controller.signal,
      })

      try {
        // Abort only after the accepting handler has durably queued the prompt.
        await waitForQueuedPrompt(
          dbPath,
          hsid,
          'queued prompt must survive boot timeout',
          INTEGRATION_TIMEOUT_MS
        )
        controller.abort()
        await promptRequest.catch(() => undefined)
      } finally {
        releaseGate()
      }

      const bootResponse = await bootRequest
      expect(bootResponse.status).toBe(200)
      await stub.runtimePersisted
      expect(stub.runtimeIds).toHaveLength(1)

      // A boot-racing prompt belongs to the one booting runtime. Starting a
      // second broker invocation is not queueing and can split the session.
      expect(stub.calls).toHaveLength(1)
      await stub.inputDispatched
      expect(stub.inputCalls).toHaveLength(1)
      expect(stub.inputCalls[0].input.content).toEqual([
        { type: 'text', text: 'queued prompt must survive boot timeout' },
      ])
    },
    INTEGRATION_TIMEOUT_MS
  )
})
