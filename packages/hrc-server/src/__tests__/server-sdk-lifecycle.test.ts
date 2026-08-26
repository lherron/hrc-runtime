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
 * Reference: wrkq T-00946 (agent-spaces/hrc/implementation-plan, archived).
 * The plan document itself no longer exists; docs/hrc-server-architecture.md
 * describes the shipped architecture.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

import { installFakeCodex } from './fixtures/fake-harness-driver'
import { waitForRuntimeStatus } from './fixtures/sdk-dispatch-database.fixture'

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

  describe('runtime lifecycle compatibility', () => {
    it('POST /v1/clear-context can rotate to a fresh session without inheriting continuation', async () => {
      // A2: seed a broker headless runtime + continuation via the broker start,
      // then clear-context rotates to a fresh session that does not inherit it.
      await restartServerWithHeadlessCodexBroker()
      const hsid = await resolveSession('lifecycle-clear-context-new-session')
      installHeadlessBrokerStartStub(hsid, { continuationKey: 'thread-old' })

      const startRes = await postJson('/v1/runtimes/start', {
        hostSessionId: hsid,
        intent: headlessCodexIntent({}),
      })
      expect(startRes.status).toBe(200)
      const startData = (await startRes.json()) as { runtimeId: string }
      await waitForRuntimeStatus(dbPath, startData.runtimeId, ['ready'])

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

    it(
      'POST /v1/runtimes/attach waits for in-flight start then fails closed without legacy resume',
      async () => {
        // A2: a broker headless START serializes the start operation; attach awaits
        // the in-flight start (does NOT race ahead) and then fails closed on the
        // headless runtime. The gate holds the broker start "in flight" so we can
        // observe attach blocking, then release it and assert the fail-closed result.
        await restartServerWithHeadlessCodexBroker()
        const hsid = await resolveSession('lifecycle-attach-blocks')
        let releaseGate: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve
        })
        const stub = installHeadlessBrokerStartStub(hsid, { gate })

        const startPromise = postJson('/v1/runtimes/start', {
          hostSessionId: hsid,
          intent: headlessCodexIntent({}),
        })

        await stub.startCalled

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

        // Start is still gated in-flight, so neither start nor the dependent attach
        // has settled.
        expect(attachSettled).toBe(false)

        releaseGate()

        const { startData, attachRes } = await attachPromise
        expect(attachRes.status).toBe(503)
        const attachBody = (await attachRes.json()) as {
          error?: { code?: string; message?: string }
        }
        expect(attachBody.error?.code).toBe('runtime_unavailable')
        expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')

        const secondAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(secondAttachRes.status).toBe(503)
      },
      INTEGRATION_TIMEOUT_MS
    )

    it(
      'POST /v1/runtimes/attach does not rematerialize legacy tmux from headless codex',
      async () => {
        // A2: start provisions a broker headless runtime; attach on a headless
        // runtime fails closed (not broker-admissible) and never rematerializes a
        // legacy tmux / writes an attach launch artifact.
        await restartServerWithHeadlessCodexBroker()
        const hsid = await resolveSession('lifecycle-attach-no-reprime')
        installHeadlessBrokerStartStub(hsid)

        const startRes = await postJson('/v1/runtimes/start', {
          hostSessionId: hsid,
          intent: headlessCodexIntent({}),
        })
        expect(startRes.status).toBe(200)
        const startData = (await startRes.json()) as any

        const attachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(attachRes.status).toBe(503)
        const attachBody = (await attachRes.json()) as {
          error?: { code?: string; message?: string }
        }
        expect(attachBody.error?.code).toBe('runtime_unavailable')
        expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')

        const launchesRes = await fetchSocket(
          `/v1/launches?runtimeId=${encodeURIComponent(startData.runtimeId)}`
        )
        const launches = (await launchesRes.json()) as Array<{ lifecycleAction?: string }>
        expect(launches.some((launch) => launch.lifecycleAction === 'attach')).toBe(false)
      },
      INTEGRATION_TIMEOUT_MS
    )

    it(
      'POST /v1/runtimes/attach rejects legacy attach descriptor recovery',
      async () => {
        // A2: attach on a broker headless runtime fails closed — no legacy attach
        // descriptor recovery.
        await restartServerWithHeadlessCodexBroker()
        const hsid = await resolveSession('lifecycle-attach-stale-session-name')
        installHeadlessBrokerStartStub(hsid)

        const startRes = await postJson('/v1/runtimes/start', {
          hostSessionId: hsid,
          intent: headlessCodexIntent({}),
        })
        expect(startRes.status).toBe(200)
        const startData = (await startRes.json()) as any

        const initialAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(initialAttachRes.status).toBe(503)
        const attachBody = (await initialAttachRes.json()) as {
          error?: { code?: string; message?: string }
        }
        expect(attachBody.error?.code).toBe('runtime_unavailable')
        expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')
      },
      INTEGRATION_TIMEOUT_MS
    )

    it(
      'POST /v1/runtimes/attach does not rematerialize tmux when the requested runtime is dead',
      async () => {
        // A2: a broker headless runtime fails closed on attach, and once marked dead
        // attach still fails closed (no legacy tmux rematerialize / resume).
        await restartServerWithHeadlessCodexBroker()
        const hsid = await resolveSession('lifecycle-attach-dead-runtime')
        installHeadlessBrokerStartStub(hsid)

        const startRes = await postJson('/v1/runtimes/start', {
          hostSessionId: hsid,
          intent: headlessCodexIntent({}),
        })
        expect(startRes.status).toBe(200)
        const startData = (await startRes.json()) as any

        const initialAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(initialAttachRes.status).toBe(503)

        const db = openHrcDatabase(dbPath)
        try {
          db.runtimes.update(startData.runtimeId, {
            status: 'dead',
            updatedAt: new Date().toISOString(),
          })
        } finally {
          db.close()
        }

        const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(recoveredAttachRes.status).toBe(503)
      },
      INTEGRATION_TIMEOUT_MS
    )

    it(
      'POST /v1/runtimes/attach does not rematerialize tmux after prior runtime exits',
      async () => {
        // A2: attach on the broker headless runtime fails closed; it stays a
        // ready broker runtime (never rematerializes a legacy tmux on re-attach).
        await restartServerWithHeadlessCodexBroker()
        const hsid = await resolveSession('lifecycle-attach-terminated-runtime')
        installHeadlessBrokerStartStub(hsid)

        const startRes = await postJson('/v1/runtimes/start', {
          hostSessionId: hsid,
          intent: headlessCodexIntent({}),
        })
        expect(startRes.status).toBe(200)
        const startData = (await startRes.json()) as any

        const initialAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(initialAttachRes.status).toBe(503)
        expect(
          await waitForRuntimeStatus(dbPath, startData.runtimeId, ['ready', 'terminated'])
        ).toBe('ready')

        const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
          runtimeId: startData.runtimeId,
        })
        expect(recoveredAttachRes.status).toBe(503)
      },
      INTEGRATION_TIMEOUT_MS
    )

    it('POST /v1/runtimes/attach does not attach directly to legacy codex tmux', async () => {
      const hsid = await resolveSession('lifecycle-attach-live-no-continuation')
      const ensureRes = await postJson('/v1/runtimes/ensure', {
        hostSessionId: hsid,
        intent: interactiveCliIntent('openai'),
      })
      expect(ensureRes.status).toBe(503)
      const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('runtime_unavailable')
      expect(body.error?.message).toContain(
        'ensureRuntime supports only broker-admissible runtimes'
      )
    })

    it('POST /v1/runtimes/start does not launch legacy interactive harness before attach', async () => {
      const interactiveBanner = 'INTERACTIVE_START_LAUNCHED'
      const fakeCodex = await installFakeCodex(tmpDir, 'fake-codex-interactive-start', {
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
      expect(startRes.status).toBe(503)
      const body = (await startRes.json()) as { error?: { code?: string; message?: string } }
      expect(body.error?.code).toBe('runtime_unavailable')
      expect(body.error?.message).toContain('interactive runtime is not broker-admissible')

      const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
      expect(execLog).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // 7. Attach on SDK runtime returns error
  // ---------------------------------------------------------------------------
})

void createSignal
void sdkIntent
