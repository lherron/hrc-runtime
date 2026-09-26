/**
 * T-08554 — explicit app-server viewer on the aspd headless Codex route
 * (docs/aspd-headless-codex-integration.md §1.2). Shares the T-08542 doubles.
 *
 * Original T-08542 harness notes: HRC-hosted headless codex-app-server preparation through aspd with a
 * frozen execution release (hrc-runtime.aspd-prepared-execution-release).
 *
 * Real pieces: a Unix-socket aspd double speaking the published ASPC NDJSON wire
 * through the real `AspcUnixClient`, the real HRC server handlers, the real
 * `HarnessBrokerController`, and the real durable headless substrate allocator.
 * Doubles: the tmux manager (records the exact broker command it would exec) and
 * the worker's broker client, whose hello reports the release of the executable
 * the allocator actually launched — so a worker's identity follows its launch,
 * not a value the test hands the assertion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { renameSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { assertNoOperatorPresentationConflict } from '../presentation-operator'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  makeRelease,
  producerResult,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t08554:project:hrc-runtime:task:T-08554'

// ── Harness ───────────────────────────────────────────────────────────────────

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspdSocket: string
let aspd: AspdDouble
let releaseA: Release
let releaseB: Release
let ledger: HostingLedger
const savedEnv: Record<string, string | undefined> = {}

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  startHeadlessBrokerRuntime(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options?: Record<string, unknown>
  ): Promise<HrcRuntimeSnapshot>
  startRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    restartStyle: 'reuse_pty' | 'fresh_pty',
    options: Record<string, unknown>
  ): Promise<HrcRuntimeSnapshot>
}

function internal(): Internal {
  return server as unknown as Internal
}

function headlessIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (record === null) throw new Error('session missing')
  return record
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** (Re)create the server under test with the doubled worker controller. */
async function bootServer(overrides: { codexCliTmuxBrokerEnabled?: boolean } = {}): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: overrides.codexCliTmuxBrokerEnabled ?? false,
      otelListenerEnabled: false,
    })
  )
  const releases = [releaseA, releaseB]
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, releases, ledger.commands.at(-1)) as never,
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08542',
    }),
    tmuxAllocator: createBrokerDurableTmuxAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08554-terminal',
    }),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08554',
    }),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08554-')
  scratch = await mkdtemp(join(tmpdir(), 't8554-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  releaseB = makeRelease(join(scratch, 'releases'), 'b')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  // A resolver-governed selection that would be wrong if this route consulted it.
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')

  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
  await bootServer()
})

afterEach(async () => {
  aspd.stop()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  await server.stop()
  await fixture.cleanup()
  await rm(scratch, { recursive: true, force: true })
})

// ── T-08554 explicit app-server viewer ────────────────────────────────────────

describe('T-08554 explicit app-server viewer', () => {
  type RecordedInteractive = { intent: HrcRuntimeIntent }

  /** Max3 shape: Codex interactive redirect on. */
  async function bootMax3Node(): Promise<RecordedInteractive[]> {
    await server.stop()
    await bootServer({ codexCliTmuxBrokerEnabled: true })
    const recorded: RecordedInteractive[] = []
    ;(server as unknown as Record<string, unknown>)['handleInteractiveTmuxBrokerDispatchTurn'] =
      async (_session: HrcSessionRecord, intent: HrcRuntimeIntent) => {
        recorded.push({ intent })
        const { HrcRuntimeUnavailableError } = await import('hrc-core')
        throw new HrcRuntimeUnavailableError('interactive route observed', {
          route: 'observed-interactive',
        })
      }
    return recorded
  }

  function viewerIntent(): HrcRuntimeIntent {
    return { ...headlessIntent(), presentation: { operator: 'tmux-tui' } }
  }

  function neutralViewerIntent(): HrcRuntimeIntent {
    return {
      ...headlessIntent(),
      harness: { interactive: false },
      presentation: { operator: 'tmux-tui' },
    } as HrcRuntimeIntent
  }

  async function turn(hostSessionId: string, runtimeIntent: unknown, extra = {}) {
    return await fixture.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'x',
      runtimeIntent,
      waitFor: 'accepted',
      ...extra,
    })
  }

  function preparations(hostSessionId: string) {
    return internal()
      .db.sqlite.query<
        {
          operation_id: string
          status: string
          error_code: string | null
          preparation_json: string | null
        },
        [string]
      >(
        `SELECT operation_id, status, error_code, preparation_json FROM runtime_operations
          WHERE host_session_id = ? ORDER BY created_at ASC`
      )
      .all(hostSessionId)
  }

  it('realizes the published Codex websocket viewer from the frozen producer answer', async () => {
    await server.stop()
    await bootServer({ codexCliTmuxBrokerEnabled: true })
    aspd.producerResult = producerResult({
      selection: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: true,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'compile-request',
        },
      },
      execution: {
        recipeId: 'codex-app-server',
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationSurface: { transport: 'websocket-unix', terminalHost: 'tmux' },
      },
    })
    const s = await session()
    const response = await turn(s.hostSessionId, neutralViewerIntent())
    if (response.status >= 300) throw new Error(`${response.status}: ${await response.text()}`)
    expect(response.status).toBeLessThan(300)
    expect(aspd.compileRequested).toEqual([{ presentation: true }])
    const [op] = preparations(s.hostSessionId)
    const record = JSON.parse(op?.preparation_json ?? '{}')
    const observerSocketPath = record.hosting.paths.observerSocketPath as string
    expect(observerSocketPath).toContain('/bipc/')
    expect(record.hosting.argv).toContain('--experimental-observer-socket')
    expect(record.hosting.argv).toContain(observerSocketPath)
    expect(
      record.hosting.argv.filter((arg: string) => arg === '--experimental-observer-socket')
    ).toHaveLength(1)
    expect(ledger.commands.at(-1)).toContain('--experimental-observer-socket')
    expect(ledger.startCalls[0]?.dispatch).toMatchObject({
      dispatchEnv: { HARNESS_BROKER_OBSERVER_SOCKET: observerSocketPath },
      runtime: { terminalSurfaceRequired: true },
    })
    const [runtime] = internal().db.runtimes.listByHostSessionId(s.hostSessionId)
    expect(runtime && parseBrokerRuntimeHostingState(runtime)?.presentation.kind).toBe('tmux-tui')
    expect(runtime?.runtimeStateJson).toMatchObject({
      broker: { endpoint: { observerSocketPath } },
    })
  })

  it('public start returns a producer-selected viewer with an attachable pane', async () => {
    await server.stop()
    await bootServer({ codexCliTmuxBrokerEnabled: true })
    aspd.producerResult = producerResult({
      selection: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: true,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'compile-request',
        },
      },
      execution: {
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationSurface: { transport: 'websocket-unix', terminalHost: 'tmux' },
      },
    })
    const s = await session()
    const response = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId: s.hostSessionId,
      intent: neutralViewerIntent(),
    })
    expect(response.status).toBe(200)
    expect(aspd.compileRequested).toEqual([{ presentation: true }])
    const [runtime] = internal().db.runtimes.listByHostSessionId(s.hostSessionId)
    expect(runtime && parseBrokerRuntimeHostingState(runtime)?.presentation.kind).toBe('tmux-tui')
    ;(server as unknown as Record<string, unknown>)['reconcileTmuxRuntimeLiveness'] = async (
      current: HrcRuntimeSnapshot
    ) => current
    const attach = await fixture.postJson('/v1/runtimes/attach', { runtimeId: runtime?.runtimeId })
    expect(attach.status).toBe(200)
    const body = (await attach.json()) as { argv: string[]; bindingFence: { runtimeId: string } }
    expect(body.bindingFence.runtimeId).toBe(runtime?.runtimeId)
    expect(body.argv.join(' ')).toContain(':tui')
  })

  it('refuses a neutral viewer start against a live no-viewer broker before reuse', async () => {
    const s = await session()
    const noViewer = liveRuntime(s, 'rt-t09274-none', 'headless', 'none')
    internal().db.runtimes.insert(noViewer as never)
    ;(server as unknown as Record<string, unknown>)['reconcileTmuxRuntimeLiveness'] = async (
      runtime: HrcRuntimeSnapshot
    ) => runtime
    const before = internal().db.runtimes.getByRuntimeId(noViewer.runtimeId)
    await expect(
      internal().startRuntimeForSession(s, neutralViewerIntent(), 'reuse_pty', {})
    ).rejects.toThrow('presentation')
    expect(internal().db.runtimes.getByRuntimeId(noViewer.runtimeId)).toEqual(before)
    expect(aspd.compileCalls).toBe(0)
    expect(ledger.commands).toEqual([])
  })

  it('refuses contradictory neutral viewer answers before preparation or allocation', async () => {
    const valid = producerResult({
      selection: {
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: true,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'compile-request',
        },
      },
      execution: {
        hosting: {
          executionTransport: 'jsonrpc-stdio',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationSurface: { transport: 'websocket-unix', terminalHost: 'tmux' },
      },
    })
    const cases = [
      { selection: { ...valid.selection, presentation: false }, execution: valid.execution },
      {
        selection: {
          ...valid.selection,
          provenance: { ...valid.selection.provenance, presentation: 'catalog-default' },
        },
        execution: valid.execution,
      },
      {
        selection: valid.selection,
        execution: {
          ...valid.execution,
          hosting: {
            executionTransport: 'jsonrpc-stdio' as const,
            terminalRequired: false as const,
            processExecution: 'broker-process' as const,
          },
        },
      },
      {
        selection: valid.selection,
        execution: { ...valid.execution, presentationSurface: undefined },
      },
      {
        selection: valid.selection,
        execution: {
          ...valid.execution,
          presentationSurface: { transport: 'unknown', terminalHost: 'tmux' },
        },
      },
      {
        selection: valid.selection,
        execution: {
          ...valid.execution,
          presentationSurface: { transport: 'websocket-unix', terminalHost: 'other' },
        },
      },
    ]
    for (const [index, result] of cases.entries()) {
      aspd.producerResult = result as never
      const s = await session(`agent:t08554case${index}:project:hrc-runtime:task:T-08554`)
      const response = await turn(s.hostSessionId, neutralViewerIntent())
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        error: { detail: { admissionCode: 'execution_presentation_constraint_mismatch' } },
      })
      expect(preparations(s.hostSessionId)).toEqual([])
      expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toEqual([])
    }
    expect(ledger.commands).toEqual([])
    expect(ledger.startCalls).toEqual([])
  })

  it('explicit tmux-tui stays headless on a redirecting node and freezes the viewer in an aspd preparation', async () => {
    const recorded = await bootMax3Node()
    const s = await session()
    const response = await turn(s.hostSessionId, viewerIntent())
    await Bun.sleep(80)
    expect(response.status).toBeLessThan(500)
    expect(recorded).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
    const [op] = preparations(s.hostSessionId)
    const record = JSON.parse(op?.preparation_json ?? '{}')
    expect(record.hosting.presentation).toBe('none')
    expect(record.hosting.paths.observerSocketPath).toBeUndefined()
    expect(record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      selectedBy: 'producer-selected-execution',
    })
    expect(record.intent.presentation).toEqual({ operator: 'tmux-tui' })
    // Launched on the viewer substrate from the frozen release worker.
    const command = ledger.commands.at(-1) ?? ''
    expect(command).toContain(join(releaseA.releaseRoot, 'harness-broker'))
    expect(command).not.toContain('--experimental-observer-socket')
    const [runtime] = internal().db.runtimes.listByHostSessionId(s.hostSessionId)
    expect(runtime && parseBrokerRuntimeHostingState(runtime)?.presentation.kind).toBe('none')
    const state = runtime?.runtimeStateJson as { executionRelease?: { releaseId?: string } }
    expect(state.executionRelease?.releaseId).toBe(releaseA.releaseId)
    expect(runtime?.transport).toBe('headless')
  })

  // T-08555: with HRC_ASPD_SOCKET configured a node-default viewer prepares
  // through aspd (t08555-default-app-server-viewer.test.ts). An unset socket
  // refuses with aspd_unconfigured.
  it('no request choice refuses with aspd_unconfigured when HRC_ASPD_SOCKET is unset (T-08596)', async () => {
    setEnv('HRC_ASPD_SOCKET', undefined)
    await server.stop()
    await bootServer()
    const s = await session()
    const response = await turn(s.hostSessionId, headlessIntent())
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { detail: { code: string } } }
    expect(body.error.detail.code).toBe('aspd_unconfigured')
    await Bun.sleep(50)
    expect(aspd.compileCalls).toBe(0)
  })

  it('refuses a viewer request for a driver that has no viewer before any effect', async () => {
    const s = await session()
    const response = await turn(s.hostSessionId, {
      ...viewerIntent(),
      harness: { provider: 'openai', id: 'pi-sdk', interactive: false },
    })
    expect(response.status).toBeLessThan(300)
    expect(aspd.compileCalls).toBe(1)
  })

  it('the conflict predicate compares the requested presentation with the live one', async () => {
    const s = await session()
    const tui = liveRuntime(s, 'rt-a', 'headless', 'tmux-tui') as unknown as HrcRuntimeSnapshot
    const plain = liveRuntime(s, 'rt-b', 'headless', 'none') as unknown as HrcRuntimeSnapshot
    const tmux = {
      ...liveRuntime(s, 'rt-c', 'tmux', 'none'),
      controllerKind: 'process',
    } as unknown as HrcRuntimeSnapshot
    expect(() => assertNoOperatorPresentationConflict(viewerIntent(), [tui])).not.toThrow()
    expect(() => assertNoOperatorPresentationConflict(viewerIntent(), [plain])).toThrow("'none'")
    expect(() => assertNoOperatorPresentationConflict(viewerIntent(), [tmux])).toThrow(
      "'interactive'"
    )
    expect(() =>
      assertNoOperatorPresentationConflict(headlessIntent(), [plain, tmux])
    ).not.toThrow()
  })

  it('launch refuses a frozen viewer preparation whose route decision no longer matches its hosting', async () => {
    const s = await session()
    renameSync(releaseA.releaseRoot, `${releaseA.releaseRoot}.withheld`)
    const refused = await turn(s.hostSessionId, viewerIntent(), {
      idempotencyKey: 'k-t08554',
      waitFor: 'terminal',
    })
    expect(refused.status).toBe(503)
    renameSync(`${releaseA.releaseRoot}.withheld`, releaseA.releaseRoot)
    const [op] = preparations(s.hostSessionId)
    const record = JSON.parse(op?.preparation_json ?? '{}')
    record.hosting.presentation = 'tmux-tui'
    internal()
      .db.sqlite.query('UPDATE runtime_operations SET preparation_json = ? WHERE operation_id = ?')
      .run(JSON.stringify(record), op?.operation_id ?? '')
    const commandsBefore = ledger.commands.length
    await turn(s.hostSessionId, viewerIntent(), { idempotencyKey: 'k-t08554' })
    await Bun.sleep(50)
    expect(preparations(s.hostSessionId)).toMatchObject([
      { status: 'prepared', error_code: 'launch_description_mismatch' },
    ])
    expect(ledger.commands.length).toBe(commandsBefore)
    expect(aspd.compileCalls).toBe(1)
  })

  it('operator attach returns a live headless viewer runtime as it is, never reprovisioning it', async () => {
    await bootMax3Node()
    const s = await session()
    const runtime = liveRuntime(s, 'rt-t08554-viewer', 'headless', 'tmux-tui')
    internal().db.runtimes.insert(runtime as never)
    ;(server as unknown as Record<string, unknown>)['reconcileTmuxRuntimeLiveness'] = async (
      r: HrcRuntimeSnapshot
    ) => r
    const before = internal().db.runtimes.getByRuntimeId(runtime.runtimeId)
    const response = await fixture.postJson('/v1/runtimes/attach', { runtimeId: runtime.runtimeId })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { argv: string[]; bindingFence: { runtimeId: string } }
    expect(body.bindingFence.runtimeId).toBe(runtime.runtimeId)
    expect(body.argv.join(' ')).toContain(':tui')
    expect(internal().db.runtimes.getByRuntimeId(runtime.runtimeId)).toEqual(before)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(1)
  })
})

function liveRuntime(
  s: HrcSessionRecord,
  runtimeId: string,
  transport: 'headless' | 'tmux',
  presentation: 'none' | 'tmux-tui'
) {
  const now = new Date().toISOString()
  return {
    runtimeId,
    hostSessionId: s.hostSessionId,
    scopeRef: s.scopeRef,
    laneRef: s.laneRef,
    generation: s.generation,
    transport,
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    controllerKind: 'harness-broker',
    supportsInflightInput: true,
    adopted: false,
    runtimeStateJson: {
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/t08554.sock',
          attachTokenRef: { kind: 'file', path: '/tmp/t08554.token' },
        },
        // An interactive surface on an external substrate is not probed for
        // tmux liveness here, so it stays live for the refusal under test.
        substrate:
          transport === 'tmux'
            ? { kind: 'external' }
            : {
                kind: 'leased-tmux',
                tmuxSocketPath: '/tmp/t08554-tmux.sock',
                sessionName: 's',
                brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
                generation: 1,
              },
        presentation:
          presentation === 'tmux-tui'
            ? {
                kind: 'tmux-tui',
                tuiWindow: { sessionId: '$1', windowId: '@2', paneId: '%2' },
                operatorAttachTarget: true,
              }
            : { kind: 'none' },
      },
    },
    createdAt: now,
    updatedAt: now,
  }
}
