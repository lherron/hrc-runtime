/**
 * T-08553 — per-request operator presentation on the aspd headless Codex route
 * (docs/aspd-headless-codex-integration.md §1.1). Shares the T-08542 doubles.
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

import { decideCodexAppServerPresentation } from '../broker-decisions'
import { createBrokerDurableHeadlessAllocator } from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import {
  assertNoOperatorPresentationConflict,
  liveRuntimePresentation,
} from '../presentation-operator'
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

const SCOPE = 'agent:t08553:project:hrc-runtime:task:T-08553'

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
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08553-')
  scratch = await mkdtemp(join(tmpdir(), 't8553-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  releaseB = makeRelease(join(scratch, 'releases'), 'b')
  aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  // A no-viewer response is terminal-free and does not carry an attachable
  // operator surface. The explicit mismatch test below overrides this with
  // the actual hrcdev bad shape.
  aspd.producerResult = producerResult({
    selection: {
      presentation: false,
      provenance: {
        harness: 'catalog-default',
        modelProvider: 'catalog-default',
        model: 'catalog-default',
        presentation: 'compile-request',
      },
    },
    execution: { presentationFulfillment: 'birth-variant' },
  })
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

function operationsFor(hostSessionId: string) {
  return internal()
    .db.sqlite.query<{ operation_id: string; status: string; error_code: string | null }, [string]>(
      `SELECT operation_id, status, error_code FROM runtime_operations
        WHERE host_session_id = ? ORDER BY created_at ASC`
    )
    .all(hostSessionId)
}

// ── T-08553 per-request operator presentation ────────────────────────────────

describe('T-08553 per-request operator presentation', () => {
  type RecordedInteractive = { intent: HrcRuntimeIntent }

  /** Max3 shape: Codex interactive redirect on. */
  async function bootMax3Node(): Promise<RecordedInteractive[]> {
    await server.stop()
    await bootServer({ codexCliTmuxBrokerEnabled: true })
    const recorded: RecordedInteractive[] = []
    // The interactive tmux route is observed, not run: it records the intent it
    // was handed and refuses, so no real tmux is touched.
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

  function noViewerIntent(): HrcRuntimeIntent {
    return {
      ...headlessIntent(),
      selection: { presentation: false },
      presentation: { operator: 'none' },
    }
  }

  function operatorOnlyNoViewerIntent(): HrcRuntimeIntent {
    return {
      ...headlessIntent(),
      presentation: { operator: 'none' },
    }
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

  function routeDecisions(hostSessionId: string) {
    return internal()
      .db.sqlite.query<
        { route_decision_json: string | null; preparation_json: string | null },
        [string]
      >(
        `SELECT route_decision_json, preparation_json FROM runtime_operations
          WHERE host_session_id = ? ORDER BY created_at ASC`
      )
      .all(hostSessionId)
  }

  it('the presentation decision: explicit none overrides the node viewer policy; omitted keeps it', () => {
    const base = { operatorPresentation: 'tmux-tui', brokerDriver: 'codex-app-server' }
    expect(decideCodexAppServerPresentation(base)).toBe('tmux-tui')
    expect(decideCodexAppServerPresentation({ ...base, requestedOperator: 'none' })).toBe('none')
    expect(decideCodexAppServerPresentation({ ...base, operatorPresentation: undefined })).toBe(
      'none'
    )
  })

  it('omitted choice reaches ASP unchanged instead of reselecting a local interactive route', async () => {
    const recorded = await bootMax3Node()
    const s = await session()
    const response = await turn(s.hostSessionId, headlessIntent())
    expect(response.status).toBeLessThan(300)
    expect(recorded).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
    expect(operationsFor(s.hostSessionId)).toMatchObject([{ status: 'completed' }])
  })

  it('explicit none stays headless on a redirecting node and prepares through aspd with source request', async () => {
    const recorded = await bootMax3Node()
    const s = await session()
    const response = await turn(s.hostSessionId, noViewerIntent())
    await Bun.sleep(50)
    expect(recorded).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
    const [op] = routeDecisions(s.hostSessionId)
    const preparation = JSON.parse(op?.preparation_json ?? '{}')
    expect(preparation.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      hostingPresentation: 'none',
      selectedBy: 'producer-selected-execution',
    })
    expect(preparation.hosting.presentation).toBe('none')
    expect(preparation.intent.presentation).toEqual({ operator: 'none' })
    expect(response.status).toBeLessThan(500)
  })

  it('admits the published nonterminal Codex plan whose static fulfillment is attachable', async () => {
    const s = await session()
    // Real hrcdev ASPD readback for the Codex withoutPresentation recipe:
    // presentation is explicitly false, hosting is nonterminal, and no
    // presentation surface exists. The fulfillment label names recipe
    // capability; it is not a selected operator surface.
    aspd.producerResult = producerResult({
      selection: {
        presentation: false,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'compile-request',
        },
      },
      execution: { presentationFulfillment: 'attachable' },
    })

    const response = await turn(s.hostSessionId, operatorOnlyNoViewerIntent())
    await Bun.sleep(50)

    expect(aspd.compileRequested).toEqual([{ presentation: false }])
    expect(response.status).toBeLessThan(500)
    const [op] = routeDecisions(s.hostSessionId)
    const preparation = JSON.parse(op?.preparation_json ?? '{}')
    expect(preparation.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      hostingPresentation: 'none',
      selectedBy: 'producer-selected-execution',
    })
    expect(preparation.hosting.presentation).toBe('none')
    expect(ledger.attachCalls).toBe(0)
  })

  it('sends operator none as the existing presentation constraint and fences a terminal producer answer before preparation', async () => {
    const s = await session()
    // This mirrors the hrcdev readback: agent-profile presentation true,
    // terminal hosting, and an attachable operator surface. Until HRC carries
    // operator:none into `requested.presentation`, the compile double returns
    // this shape and the start wrongly reaches allocation.
    aspd.producerResult = producerResult({
      selection: {
        presentation: true,
        provenance: {
          harness: 'catalog-default',
          modelProvider: 'catalog-default',
          model: 'catalog-default',
          presentation: 'agent-profile',
        },
      },
      execution: {
        hosting: {
          executionTransport: 'pty',
          terminalRequired: true,
          terminalHost: 'tmux',
          processExecution: 'broker-process',
        },
        presentationFulfillment: 'attachable',
        presentationSurface: { transport: 'websocket-unix', terminalHost: 'tmux' },
      },
    })

    const response = await turn(s.hostSessionId, operatorOnlyNoViewerIntent())

    expect(aspd.compileRequested).toEqual([{ presentation: false }])
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'runtime_unavailable',
        detail: {
          code: 'admission-rejected',
          admissionCode: 'execution_presentation_constraint_mismatch',
        },
      },
    })
    expect(operationsFor(s.hostSessionId)).toEqual([])
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toEqual([])
    expect(ledger.commands).toEqual([])
    expect(ledger.startCalls).toEqual([])
  })

  it('refuses unknown values and a viewer placement for none before any effect', async () => {
    const s = await session()
    for (const presentation of [
      // T-08554 made 'tmux-tui' a valid choice; any other value stays malformed.
      { operator: 'tui' },
      { operator: 'none', viewerWindow: 'console' },
    ]) {
      const response = await turn(s.hostSessionId, { ...headlessIntent(), presentation })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { detail: { field: string } } }
      expect(body.error.detail.field).toBe('presentation.operator')
    }
    expect(aspd.compileCalls).toBe(0)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toEqual([])
  })

  it('forwards legacy interactive and Claude harness metadata through the ordinary v2 door', async () => {
    await server.stop()
    await bootServer({ codexCliTmuxBrokerEnabled: true })
    const s = await session()
    const claudeSession = await session('agent:t08553claude:project:hrc-runtime:task:T-08553')
    const interactive = {
      ...noViewerIntent(),
      harness: { provider: 'openai', id: 'codex-cli', interactive: true },
      execution: { preferredMode: 'interactive' },
    }
    const claude = {
      ...noViewerIntent(),
      harness: { provider: 'anthropic', id: 'claude-code', interactive: false },
    }
    const internalServer = server as unknown as { claudeCodeTmuxBrokerEnabled: boolean }
    Object.defineProperty(internalServer, 'claudeCodeTmuxBrokerEnabled', { value: true })
    const interactiveResponse = await turn(s.hostSessionId, interactive)
    const claudeResponse = await turn(claudeSession.hostSessionId, claude)
    expect(interactiveResponse.status).toBeLessThan(300)
    expect(claudeResponse.status).toBeLessThan(300)
    expect(aspd.compileCalls).toBe(2)
    expect(operationsFor(s.hostSessionId)).toMatchObject([{ status: 'completed' }])
    expect(operationsFor(claudeSession.hostSessionId)).toMatchObject([{ status: 'completed' }])
  })

  it('refuses explicit none against a live viewer or interactive surface and leaves it untouched', async () => {
    const s = await session()
    const live = [liveRuntime(s, 'rt-t08553-tui', 'headless', 'tmux-tui')]
    for (const runtime of live) {
      internal().db.runtimes.insert(runtime as never)
      const before = internal().db.runtimes.getByRuntimeId(runtime.runtimeId)
      const response = await turn(s.hostSessionId, noViewerIntent())
      expect(response.status).toBe(409)
      const body = (await response.json()) as {
        error: { code: string; detail: { runtimeId: string } }
      }
      expect(body.error.code).toBe('presentation_conflict')
      expect(body.error.detail.runtimeId).toBe(runtime.runtimeId)
      expect(internal().db.runtimes.getByRuntimeId(runtime.runtimeId)).toEqual(before)
      internal().db.runtimes.update(runtime.runtimeId, { status: 'terminated' } as never)
    }
    const legacyTmux = {
      ...liveRuntime(s, 'rt-t08553-tmux', 'tmux', 'none'),
      // A non-broker legacy tmux runtime has no durable broker hosting fact;
      // its transport remains the interactive fallback.
      controllerKind: 'process',
    } as HrcRuntimeSnapshot
    expect(() => assertNoOperatorPresentationConflict(noViewerIntent(), [legacyTmux])).toThrow(
      'interactive'
    )
    expect(aspd.compileCalls).toBe(0)
    expect(operationsFor(s.hostSessionId)).toEqual([])
  })

  it('omitted choice is delivered into a live headless runtime, never redirected past it', async () => {
    const recorded = await bootMax3Node()
    const s = await session()
    const runtime = {
      ...liveRuntime(s, 'rt-t08553-live', 'headless', 'none'),
      activeInvocationId: 'inv-t08553-live',
    }
    internal().db.runtimes.insert(runtime as never)
    const now = new Date().toISOString()
    internal().db.brokerInvocations.insert({
      invocationId: 'inv-t08553-live',
      operationId: 'op-t08553-live',
      runtimeId: runtime.runtimeId,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({ inputQueue: { mode: 'fifo' } }),
      specHash: 'sha256:t08553-spec',
      startRequestHash: 'sha256:t08553-request',
      selectedProfileHash: 'sha256:t08553-profile',
      createdAt: now,
      updatedAt: now,
    } as never)
    await turn(s.hostSessionId, headlessIntent())
    await Bun.sleep(50)
    expect(recorded).toHaveLength(0)
    expect(aspd.compileCalls).toBe(0)
  })

  it('the conflict predicate: omitted and matching choices never conflict; dead runtimes never count', async () => {
    const s = await session()
    const tui = liveRuntime(s, 'rt-a', 'headless', 'tmux-tui') as unknown as HrcRuntimeSnapshot
    const plain = liveRuntime(s, 'rt-b', 'headless', 'none') as unknown as HrcRuntimeSnapshot
    const dead = { ...tui, status: 'terminated' } as HrcRuntimeSnapshot
    // A start that failed (e.g. a refused interactive writer) left a tmux row behind.
    const failed = { ...tui, transport: 'tmux', status: 'failed' } as HrcRuntimeSnapshot
    const unreadable = { ...plain, runtimeStateJson: { broker: {} } } as HrcRuntimeSnapshot
    expect(() => assertNoOperatorPresentationConflict(headlessIntent(), [tui])).not.toThrow()
    expect(() =>
      assertNoOperatorPresentationConflict(noViewerIntent(), [plain, dead, failed])
    ).not.toThrow()
    expect(() => assertNoOperatorPresentationConflict(noViewerIntent(), [tui])).toThrow('tmux-tui')
    expect(() => assertNoOperatorPresentationConflict(noViewerIntent(), [unreadable])).toThrow(
      'unknown'
    )
  })

  it('reads durable broker presentation before the broad tmux transport fallback', async () => {
    const s = await session()
    const brokerTui = liveRuntime(s, 'rt-t08553-broker-tui', 'tmux', 'tmux-tui')
    const legacyTmux = {
      ...brokerTui,
      runtimeId: 'rt-t08553-legacy-tmux',
      controllerKind: 'process',
    } as HrcRuntimeSnapshot

    expect(liveRuntimePresentation(brokerTui)).toBe('tmux-tui')
    expect(liveRuntimePresentation(legacyTmux)).toBe('interactive')
  })

  it('a same-key retry reaches its frozen no-viewer preparation without re-evaluating node defaults', async () => {
    const recorded = await bootMax3Node()
    const s = await session()
    renameSync(releaseA.releaseRoot, `${releaseA.releaseRoot}.withheld`)
    const refused = await turn(s.hostSessionId, noViewerIntent(), {
      idempotencyKey: 'k-t08553',
      waitFor: 'terminal',
    })
    expect(refused.status).toBe(503)
    renameSync(`${releaseA.releaseRoot}.withheld`, releaseA.releaseRoot)
    // Retry WITHOUT the choice on a node whose defaults would redirect it.
    await turn(s.hostSessionId, headlessIntent(), { idempotencyKey: 'k-t08553' })
    await Bun.sleep(50)
    expect(recorded).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
    expect(operationsFor(s.hostSessionId)).toMatchObject([{ status: 'completed' }])
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
          socketPath: '/tmp/t08553.sock',
          attachTokenRef: { kind: 'file', path: '/tmp/t08553.token' },
        },
        // An interactive surface on an external substrate is not probed for
        // tmux liveness here, so it stays live for the refusal under test.
        substrate:
          transport === 'tmux'
            ? { kind: 'external' }
            : {
                kind: 'leased-tmux',
                tmuxSocketPath: '/tmp/t08553-tmux.sock',
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
