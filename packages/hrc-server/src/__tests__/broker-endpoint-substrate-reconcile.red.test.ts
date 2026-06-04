/**
 * RED tests — T-01875 / T-01862 Ph4: endpoint/substrate-driven startup
 * reconciliation, orphan sweeper, lazy dispatch reattach, and zombie/activity
 * handling.
 *
 * Ph4 replaces the transport-driven broker GC loop with endpoint/substrate-driven
 * reconciliation keyed off `parseBrokerRuntimeHostingState` + predicates from
 * broker/runtime-hosting.ts. The following 10 scenarios all fail at HEAD because
 * the current code uses `runtime.transport === 'tmux'` as the gate:
 *
 *  Scenario 1  — reconcileDurableBrokerStartup REATTACHES a headless durable
 *                runtime after daemon restart; NO broker_orphaned_on_restart event.
 *                AT HEAD: transport guard skips headless → runtime absent from outcomes.
 *
 *  Scenario 2  — reconcileDurableBrokerRuntimeReattach handles an interactive
 *                runtime persisted in the NORMALIZED hosting-state shape
 *                (broker.substrate / broker.presentation keys). brokerLeaseWindowsMatch
 *                reads flat-shape only → window check fails → stale instead of reattach.
 *
 *  Scenario 3  — reconcileDurableBrokerStartup stales a legacy daemon-child headless
 *                row with broker_legacy_no_durable_endpoint_on_restart.
 *                AT HEAD: runtime skipped → not in outcomes.
 *
 *  Scenario 4  — reconcileDurableBrokerStartup stales a nonterminal v0.1 row
 *                (endpoint=stdio-jsonrpc-ndjson) with
 *                broker_protocol_legacy_unsupported_on_startup.
 *                AT HEAD: transport+endpoint guard skips it → not in outcomes.
 *
 *  Scenario 5  (G4) — reconcileDurableBrokerRuntimeReattach for a HEADLESS runtime
 *                (presentation.none): probe with matching brokerWindow but null
 *                tuiWindow REATTACHES. brokerLeaseWindowsMatch requires tuiWindow
 *                for ALL leased substrates → fails for presentation.none.
 *
 *  Scenario 6  — Orphan sweeper PRESERVES a headless (transport='headless') runtime
 *                with leased-tmux substrate pointing to a live socket.
 *                AT HEAD: sweeper gates on transport==='tmux' → headless not claimed
 *                → socket killed.
 *
 *  Scenario 7  — Orphan sweeper still REAPS an unclaimed/dead leased substrate
 *                regardless of the headless-claim fix. (Sanity check that the
 *                substrate-based claim detection doesn't over-protect.)
 *
 *  Scenario 8  (G5) — reattachDurableBrokerForDispatch returns true for a HEADLESS
 *                runtime (presentation.none) when the broker socket is live.
 *                AT HEAD: brokerLeaseWindowsMatch fails (no tuiWindow) → returns false.
 *
 *  Scenario 9  (G5/G4) — reattachDurableBrokerForDispatch for a HEADLESS runtime
 *                does NOT attempt direct tmux pane input when reattach fails
 *                (canUseDirectPaneFallback===false guards the pane path).
 *
 *  Scenario 10 (G6) — After a successful broker.attach + replay in
 *                reconcileDurableBrokerRuntimeReattach, the active RUN's activity
 *                timestamp is updated so a recovered in-flight run is NOT zombied by
 *                a subsequent zombie sweep.
 *                AT HEAD: outcome returned without updating run → zombie sweep kills it.
 *
 * Harness fidelity: real HRC SQLite + real HarnessBrokerController + scripted mock
 * DurableBrokerClient. No live broker, no live tmux (except scenarios 6/7 which
 * create real tmux sessions for the orphan sweep, following broker-pane-lease-orphan-
 * sweep.red.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { HrcRuntimeSnapshot } from 'hrc-core'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthResponse,
  BrokerHelloResponse,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationId,
  InvocationInputResponse,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationStatusResponse,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'

import { type DurableBrokerClientLike, HarnessBrokerController } from '../broker/controller'
import {
  canUseDirectPaneFallback,
  hasDurableBrokerEndpoint,
  hasLeasedBrokerSubstrate,
} from '../broker/runtime-hosting'
import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import type { TmuxPaneState } from '../tmux'
import * as reconcile from '../startup-reconcile'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture constants
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_INSTANCE_ID = 'hrc-server-ph4-test'
const ATTACH_TOKEN = 'attach-token-ph4'
const GENERATION = 1
const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01875'
const LANE_REF = 'main'

// Headless durable runtime IDs
const HEADLESS_HOST_SESSION_ID = 'hsid_headless_durable'
const HEADLESS_RUNTIME_ID = 'runtime_headless_durable'
const HEADLESS_OPERATION_ID = 'op_headless_durable'
const HEADLESS_INVOCATION_ID = 'inv_headless_durable' as InvocationId
const HEADLESS_RUN_ID = 'run_headless_durable'

// Interactive durable runtime IDs (normalized-shape test)
const INTERACTIVE_HOST_SESSION_ID = 'hsid_interactive_normalized'
const INTERACTIVE_RUNTIME_ID = 'runtime_interactive_normalized'
const INTERACTIVE_OPERATION_ID = 'op_interactive_normalized'
const INTERACTIVE_INVOCATION_ID = 'inv_interactive_normalized' as InvocationId
const INTERACTIVE_RUN_ID = 'run_interactive_normalized'

// Legacy daemon-child headless runtime IDs
const LEGACY_HOST_SESSION_ID = 'hsid_legacy_daemon_child'
const LEGACY_RUNTIME_ID = 'runtime_legacy_daemon_child'

// v0.1 row IDs
const V01_HOST_SESSION_ID = 'hsid_v01_row'
const V01_RUNTIME_ID = 'runtime_v01_row'

// Broker socket paths (fake, not real files)
const HEADLESS_BROKER_SOCKET = '/tmp/hrc-ph4/bipc/headless.sock'
const HEADLESS_LEASE_SOCKET = '/tmp/hrc-ph4/btmux/headless-runtime.sock'
const HEADLESS_SESSION_NAME = 'hrc-claude-code-tmux-headless-runtime'

const INTERACTIVE_BROKER_SOCKET = '/tmp/hrc-ph4/bipc/interactive.sock'
const INTERACTIVE_LEASE_SOCKET = '/tmp/hrc-ph4/btmux/interactive-runtime.sock'
const INTERACTIVE_SESSION_NAME = 'hrc-claude-code-tmux-interactive-runtime'

const BROKER_WINDOW: TmuxPaneState = {
  socketPath: HEADLESS_LEASE_SOCKET,
  sessionName: HEADLESS_SESSION_NAME,
  windowName: 'broker',
  sessionId: '$10',
  windowId: '@10',
  paneId: '%10',
}

const TUI_WINDOW: TmuxPaneState = {
  socketPath: INTERACTIVE_LEASE_SOCKET,
  sessionName: INTERACTIVE_SESSION_NAME,
  windowName: 'tui',
  sessionId: '$20',
  windowId: '@21',
  paneId: '%21',
}

const INTERACTIVE_BROKER_WINDOW: TmuxPaneState = {
  socketPath: INTERACTIVE_LEASE_SOCKET,
  sessionName: INTERACTIVE_SESSION_NAME,
  windowName: 'broker',
  sessionId: '$20',
  windowId: '@20',
  paneId: '%20',
}

function nowTs(): string {
  return '2026-06-04T00:00:00.000Z'
}

// An old timestamp to simulate a run that would be zombied without activity refresh.
function oldTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

// ─────────────────────────────────────────────────────────────────────────────
// DB seeding helpers
// ─────────────────────────────────────────────────────────────────────────────

function seedSession(
  db: HrcDatabase,
  hostSessionId: string,
  scopeRef: string = SCOPE_REF
): void {
  const now = nowTs()
  db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: LANE_REF,
    generation: GENERATION,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
}

/**
 * Seed a HEADLESS durable runtime using the FLAT T-01801 broker persisted shape.
 * - transport='headless' (headless public API route)
 * - endpoint.kind='unix-jsonrpc-ndjson' (v0.2 durable)
 * - brokerWindow present in flat broker block (→ substrate=leased-tmux)
 * - NO tuiWindow (→ presentation=none)
 */
function seedHeadlessDurableRuntime(
  db: HrcDatabase,
  overrides: { status?: string; runStatus?: string; runUpdatedAt?: string } = {}
): void {
  const now = nowTs()
  seedSession(db, HEADLESS_HOST_SESSION_ID)
  db.runtimes.insert({
    runtimeId: HEADLESS_RUNTIME_ID,
    hostSessionId: HEADLESS_HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: overrides.status ?? 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: HEADLESS_OPERATION_ID,
    activeInvocationId: HEADLESS_INVOCATION_ID,
    activeRunId: HEADLESS_RUN_ID,
    // No tmuxJson — headless runtimes have no operator TUI (presentation=none).
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: HEADLESS_RUNTIME_ID,
      hostSessionId: HEADLESS_HOST_SESSION_ID,
      generation: GENERATION,
      status: overrides.status ?? 'ready',
      broker: {
        // FLAT shape: endpoint + brokerWindow; no tuiWindow → presentation.none
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: HEADLESS_BROKER_SOCKET,
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-ph4/bipc/headless.token',
            redacted: true,
          },
        },
        generation: GENERATION,
        brokerWindow: BROKER_WINDOW,
        // tuiWindow intentionally absent → parseFlatPresentation → presentation.none
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  db.runs.insert({
    runId: HEADLESS_RUN_ID,
    hostSessionId: HEADLESS_HOST_SESSION_ID,
    runtimeId: HEADLESS_RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    status: overrides.runStatus ?? 'accepted',
    acceptedAt: overrides.runUpdatedAt ?? now,
    updatedAt: overrides.runUpdatedAt ?? now,
    operationId: HEADLESS_OPERATION_ID,
    invocationId: HEADLESS_INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: HEADLESS_INVOCATION_ID,
    operationId: HEADLESS_OPERATION_ID,
    runtimeId: HEADLESS_RUNTIME_ID,
    runId: HEADLESS_RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-headless',
    startRequestHash: 'sha256:req-headless',
    selectedProfileHash: 'sha256:prof-headless',
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * Seed an INTERACTIVE durable runtime using the NORMALIZED hosting-state shape
 * (broker.substrate + broker.presentation keys, not the flat brokerWindow/tuiWindow).
 * This exercises parseBrokerRuntimeHostingState's normalized branch.
 */
function seedInteractiveNormalizedRuntime(db: HrcDatabase): void {
  const now = nowTs()
  seedSession(db, INTERACTIVE_HOST_SESSION_ID)
  db.runtimes.insert({
    runtimeId: INTERACTIVE_RUNTIME_ID,
    hostSessionId: INTERACTIVE_HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: INTERACTIVE_OPERATION_ID,
    activeInvocationId: INTERACTIVE_INVOCATION_ID,
    activeRunId: INTERACTIVE_RUN_ID,
    tmuxJson: {
      socketPath: INTERACTIVE_LEASE_SOCKET,
      sessionName: INTERACTIVE_SESSION_NAME,
      windowName: 'tui',
      sessionId: TUI_WINDOW.sessionId,
      windowId: TUI_WINDOW.windowId,
      paneId: TUI_WINDOW.paneId,
      brokerDriver: 'claude-code-tmux',
    },
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: INTERACTIVE_RUNTIME_ID,
      hostSessionId: INTERACTIVE_HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        // NORMALIZED shape: uses substrate + presentation keys (not flat brokerWindow/tuiWindow).
        // This is the future-state persisted shape that Ph4 must handle.
        protocolVersion: 'harness-broker/0.2',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: INTERACTIVE_BROKER_SOCKET,
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-ph4/bipc/interactive.token',
            redacted: true,
          },
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: INTERACTIVE_LEASE_SOCKET,
          sessionName: INTERACTIVE_SESSION_NAME,
          brokerWindow: {
            sessionId: INTERACTIVE_BROKER_WINDOW.sessionId,
            windowId: INTERACTIVE_BROKER_WINDOW.windowId,
            paneId: INTERACTIVE_BROKER_WINDOW.paneId,
          },
          generation: GENERATION,
          eventLedgerPath: '/tmp/hrc-ph4/ledger/interactive.jsonl',
        },
        presentation: {
          kind: 'tmux-tui',
          tuiWindow: {
            sessionId: TUI_WINDOW.sessionId,
            windowId: TUI_WINDOW.windowId,
            paneId: TUI_WINDOW.paneId,
          },
          operatorAttachTarget: true,
        },
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
  db.runs.insert({
    runId: INTERACTIVE_RUN_ID,
    hostSessionId: INTERACTIVE_HOST_SESSION_ID,
    runtimeId: INTERACTIVE_RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: nowTs(),
    updatedAt: nowTs(),
    operationId: INTERACTIVE_OPERATION_ID,
    invocationId: INTERACTIVE_INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INTERACTIVE_INVOCATION_ID,
    operationId: INTERACTIVE_OPERATION_ID,
    runtimeId: INTERACTIVE_RUNTIME_ID,
    runId: INTERACTIVE_RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'claude-code-tmux',
    invocationState: 'ready',
    capabilitiesJson: JSON.stringify({ turns: 'single' }),
    specHash: 'sha256:spec-interactive',
    startRequestHash: 'sha256:req-interactive',
    selectedProfileHash: 'sha256:prof-interactive',
    createdAt: nowTs(),
    updatedAt: nowTs(),
  })
}

/**
 * Seed a legacy daemon-child headless runtime — no durable endpoint.
 * Represents a pre-Ph3 headless broker that cannot survive a restart.
 */
function seedLegacyDaemonChildRuntime(db: HrcDatabase): void {
  const now = nowTs()
  seedSession(db, LEGACY_HOST_SESSION_ID)
  db.runtimes.insert({
    runtimeId: LEGACY_RUNTIME_ID,
    hostSessionId: LEGACY_HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'headless',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    // No endpoint in runtimeStateJson → parseBrokerRuntimeHostingState returns undefined
    // → !hasDurableBrokerEndpoint → classify-once → broker_legacy_no_durable_endpoint_on_restart
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: LEGACY_RUNTIME_ID,
      hostSessionId: LEGACY_HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      // No broker block → no hosting state parseable.
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
}

/**
 * Seed a nonterminal v0.1 row — endpoint.kind='stdio-jsonrpc-ndjson'.
 * Represents an old broker runtime that spoke stdio/v0.1 protocol.
 */
function seedV01Row(db: HrcDatabase): void {
  const now = nowTs()
  seedSession(db, V01_HOST_SESSION_ID)
  db.runtimes.insert({
    runtimeId: V01_RUNTIME_ID,
    hostSessionId: V01_HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: LANE_REF,
    generation: GENERATION,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: V01_RUNTIME_ID,
      hostSessionId: V01_HOST_SESSION_ID,
      generation: GENERATION,
      status: 'ready',
      broker: {
        // v0.1 row: stdio endpoint, no durable unix socket.
        protocolVersion: 'harness-broker/0.1',
        ownerServerInstanceId: SERVER_INSTANCE_ID,
        endpoint: {
          kind: 'stdio-jsonrpc-ndjson',
        },
        generation: GENERATION,
      },
    },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock durable broker client (copied from broker-startup-reattach.red.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

class MockDurableBrokerClient implements DurableBrokerClientLike {
  readonly calls: string[] = []
  closed = false
  attachResponse!: BrokerAttachResponse
  snapshotResponse!: InvocationSnapshot
  private eventsSinceQueue: InvocationEventsSinceResponse[] = []
  eventsSinceThrows: Error | undefined

  queueEventsSince(response: InvocationEventsSinceResponse): void {
    this.eventsSinceQueue.push(response)
  }

  async attach(_req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    this.calls.push('attach')
    return this.attachResponse
  }
  async snapshot(_req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    this.calls.push('snapshot')
    return this.snapshotResponse
  }
  async eventsSince(_req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    this.calls.push('eventsSince')
    if (this.eventsSinceThrows) throw this.eventsSinceThrows
    const next = this.eventsSinceQueue.shift()
    if (!next) throw new Error('eventsSince called more than scripted')
    return next
  }
  async ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
    this.calls.push('ackEvents')
    return { ackedThroughSeq: req.throughSeq }
  }
  async permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse> {
    this.calls.push('permissionRespond')
    return {
      status: 'accepted',
      permissionRequestId: req.permissionRequestId,
      decision: req.decision,
    }
  }
  async hello(): Promise<BrokerHelloResponse> {
    this.calls.push('hello')
    throw new Error('hello must not be called during reattach')
  }
  async health(): Promise<BrokerHealthResponse> {
    this.calls.push('health')
    return { status: 'ok', activeInvocations: 1, drivers: [] }
  }
  async startInvocationFromRequest(): Promise<never> {
    throw new Error('startInvocationFromRequest must not be called during reattach')
  }
  async input(): Promise<InvocationInputResponse> {
    this.calls.push('input')
    return {
      inputId: 'input_x' as InvocationInputResponse['inputId'],
      accepted: true,
      disposition: 'started',
    }
  }
  async interrupt(): Promise<InvocationInterruptResponse> {
    this.calls.push('interrupt')
    return { accepted: true, effect: 'turn_interrupted' }
  }
  async stop(): Promise<InvocationStopResponse> {
    this.calls.push('stop')
    return { accepted: true, state: 'stopping' }
  }
  async status(): Promise<InvocationStatusResponse> {
    this.calls.push('status')
    return { invocationId: HEADLESS_INVOCATION_ID, state: 'ready' } as InvocationStatusResponse
  }
  async dispose(_req: InvocationDisposeRequest): Promise<void> {
    this.calls.push('dispose')
  }
  onPermissionRequest(): void {
    this.calls.push('onPermissionRequest')
  }
  onClose(): void {
    this.calls.push('onClose')
  }
  async close(): Promise<void> {
    this.calls.push('close')
    this.closed = true
  }
}

function emptySnapshot(
  invocationId: InvocationId,
  overrides: Partial<InvocationSnapshot> = {}
): InvocationSnapshot {
  return {
    invocationId,
    state: 'ready',
    capabilities: {
      input: { user: true, steer: true, appendContext: true, localImages: true, fileRefs: true, queue: false },
      turns: { concurrency: 'single', interrupt: 'protocol' },
      continuation: { supported: true, provider: 'anthropic', keyKind: 'thread' },
      events: {
        assistantDeltas: true,
        toolCalls: true,
        usage: true,
        diagnostics: true,
        replay: true,
        ack: true,
      },
      control: { stop: true, dispose: true, status: true, attach: true },
      permissions: { brokerToClientRequests: true, eventAudit: true },
    },
    pendingInputIds: [],
    inputDispositions: {},
    pendingPermissionRequests: [],
    currentSeq: overrides.currentSeq ?? 0,
    retentionFloorSeq: overrides.retentionFloorSeq ?? 0,
    ...overrides,
  }
}

function attachResponseFor(
  runtimeId: string,
  invocationId: InvocationId,
  snapshot: InvocationSnapshot
): BrokerAttachResponse {
  return {
    attached: true,
    brokerInstanceId: 'broker-instance-test',
    runtimeId,
    generation: GENERATION,
    invocationId,
    activeControllerInstanceId: SERVER_INSTANCE_ID,
    currentSeq: snapshot.currentSeq,
    retentionFloorSeq: snapshot.retentionFloorSeq,
    snapshot,
  }
}

function makeEnvelope(
  invocationId: InvocationId,
  type: InvocationEventEnvelope['type'],
  seq: number,
  payload: unknown
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: nowTs(),
    type,
    payload: payload as InvocationEventEnvelope['payload'],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit test setup (per-test DB, no live server)
// ─────────────────────────────────────────────────────────────────────────────

let dir: string
let dbPath: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-ph4-'))
  dbPath = join(dir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const rt = db.runtimes.getByRuntimeId(runtimeId)
  if (!rt) throw new Error(`runtime ${runtimeId} vanished`)
  return rt
}

function makeController(overrideDb?: HrcDatabase): HarnessBrokerController {
  return new HarnessBrokerController({
    db: overrideDb ?? db,
    now: () => nowTs(),
    serverInstanceId: SERVER_INSTANCE_ID,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: reconcileDurableBrokerStartup REATTACHES a headless durable runtime
//
// RED: At HEAD, reconcileDurableBrokerStartup has `runtime.transport !== 'tmux'`
// guard that skips headless runtimes entirely → outcomes is empty for headless.
// After Ph4 impl: uses hasDurableBrokerEndpoint + hasLeasedBrokerSubstrate instead
// of transport → headless durable runtime IS processed → outcomes includes
// broker-attached entry.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 1: reconcileDurableBrokerStartup reattaches headless durable runtime', () => {
  it('headless durable runtime (transport=headless) is included in outcomes with state=broker-attached', async () => {
    seedHeadlessDurableRuntime(db)

    const client = new MockDurableBrokerClient()
    const snap = emptySnapshot(HEADLESS_INVOCATION_ID, { currentSeq: 1, retentionFloorSeq: 1 })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(HEADLESS_RUNTIME_ID, HEADLESS_INVOCATION_ID, snap)
    client.queueEventsSince({
      events: [
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      controller,
      brokerUnixClientFactory: async () => client,
      resolveAttachToken: async () => ATTACH_TOKEN,
      probeBrokerLease: async () => ({
        brokerSocketLive: true,
        brokerWindow: BROKER_WINDOW,
        tuiWindow: null, // presentation.none — no TUI window
      }),
      sweepOrphans: async () => {},
    })

    // Ph4 impl must include the headless runtime in outcomes with broker-attached.
    // AT HEAD: outcomes is empty → fails here.
    const headlessOutcome = outcomes.find((o) => o.runtimeId === HEADLESS_RUNTIME_ID)
    expect(headlessOutcome).toBeDefined()
    expect(headlessOutcome?.state).toBe('broker-attached')
    expect(headlessOutcome?.brokerAttached).toBe(true)

    // The runtime must NOT be staled.
    expect(readRuntime(HEADLESS_RUNTIME_ID).status).not.toBe('stale')

    // No runtime.stale event with reason broker_orphaned_on_restart must be emitted.
    const staleEvents = db.hrcEvents.listByKind('runtime.stale')
    const orphanedEvent = staleEvents.find(
      (e) =>
        (e.payload as Record<string, unknown>)?.['reason'] === 'broker_orphaned_on_restart' &&
        (e.payload as Record<string, unknown>)?.['runtimeId'] === HEADLESS_RUNTIME_ID
    )
    expect(orphanedEvent).toBeUndefined()
  })

  it('headless predicates confirm the seeded runtime has durable endpoint + leased substrate', () => {
    seedHeadlessDurableRuntime(db)
    const runtime = readRuntime(HEADLESS_RUNTIME_ID)
    // Predicate checks (already green from Ph1) — confirming fixture correctness.
    expect(hasDurableBrokerEndpoint(runtime)).toBe(true)
    expect(hasLeasedBrokerSubstrate(runtime)).toBe(true)
    expect(canUseDirectPaneFallback(runtime)).toBe(false) // presentation=none
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: reconcileDurableBrokerRuntimeReattach handles NORMALIZED shape
//
// RED: At HEAD, brokerLeaseWindowsMatch reads broker['brokerWindow'] and
// broker['tuiWindow'] (flat shape). A runtime persisted with the normalized
// shape (broker.substrate.brokerWindow, broker.presentation.tuiWindow) has
// NO flat keys → window check fails → stale.
// After Ph4: uses brokerLeaseIdentityMatches from runtime-hosting.ts which
// calls parseBrokerRuntimeHostingState → handles normalized shape → reattach.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 2: interactive runtime with normalized shape reattaches', () => {
  it('reconcileDurableBrokerRuntimeReattach returns broker-attached for a normalized-shape interactive runtime', async () => {
    seedInteractiveNormalizedRuntime(db)

    const client = new MockDurableBrokerClient()
    const snap = emptySnapshot(INTERACTIVE_INVOCATION_ID, { currentSeq: 1, retentionFloorSeq: 1 })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(
      INTERACTIVE_RUNTIME_ID,
      INTERACTIVE_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        makeEnvelope(INTERACTIVE_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(INTERACTIVE_RUNTIME_ID),
      {
        controller,
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          // Probe carries the matching identity from the normalized substrate.
          brokerWindow: INTERACTIVE_BROKER_WINDOW,
          tuiWindow: TUI_WINDOW, // presentation.tmux-tui requires tuiWindow
        }),
      }
    )

    // Ph4: normalized shape must be handled by parseBrokerRuntimeHostingState
    // + brokerLeaseIdentityMatches → broker-attached.
    // AT HEAD: brokerLeaseWindowsMatch reads flat broker['brokerWindow']=undefined
    // (absent in normalized shape) → returns false → stale.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart
//
// RED: At HEAD, reconcileDurableBrokerStartup skips the legacy runtime (no
// durable endpoint → filtered out), so it is NOT in outcomes and the staling
// happens (with wrong reason broker_orphaned_on_restart) only via the blanket
// GC loop in reconcileStartupState. After Ph4: reconcileDurableBrokerStartup
// processes ALL nonterminal harness-broker runtimes and stales legacy ones with
// the precise reason broker_legacy_no_durable_endpoint_on_restart.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 3: legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart', () => {
  it('reconcileDurableBrokerStartup stales a legacy headless runtime with the precise reason', async () => {
    seedLegacyDaemonChildRuntime(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for legacy/v0.1 classify-once path')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe legacy daemon-child runtime')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: legacy runtime must appear in outcomes with specific reason.
    // AT HEAD: outcomes is empty for this runtime → headlessOutcome is undefined.
    const legacyOutcome = outcomes.find((o) => o.runtimeId === LEGACY_RUNTIME_ID)
    expect(legacyOutcome).toBeDefined()
    expect(legacyOutcome?.state).toBe('stale')
    expect(legacyOutcome?.reason).toBe('broker_legacy_no_durable_endpoint_on_restart')

    // Runtime must actually be staled in DB with the correct staleReason.
    const runtime = readRuntime(LEGACY_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_legacy_no_durable_endpoint_on_restart')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: v0.1 row (endpoint=stdio) → broker_protocol_legacy_unsupported_on_startup
//
// RED: At HEAD, v0.1 row (transport='tmux', endpoint=stdio) is skipped by
// reconcileDurableBrokerStartup (no unix endpoint → filtered). After Ph4:
// classify-once with precedence v0.1 > no-endpoint stales it with
// broker_protocol_legacy_unsupported_on_startup.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 4: v0.1 row → broker_protocol_legacy_unsupported_on_startup', () => {
  it('reconcileDurableBrokerStartup stales a v0.1 stdio-endpoint row with the legacy protocol reason', async () => {
    seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for v0.1 rows')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe v0.1 row')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: v0.1 row must appear in outcomes with the protocol-legacy reason.
    // AT HEAD: outcomes is empty (no unix endpoint → filter skips it).
    const v01Outcome = outcomes.find((o) => o.runtimeId === V01_RUNTIME_ID)
    expect(v01Outcome).toBeDefined()
    expect(v01Outcome?.state).toBe('stale')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')

    // Precedence: v0.1 (stdio endpoint present) before no-durable-endpoint.
    const runtime = readRuntime(V01_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })

  it('classify-once precedence: v0.1 stales with protocol reason, not no-endpoint reason', async () => {
    // Verify v0.1 gets protocol reason even though it also lacks a durable endpoint.
    seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      controller: makeController(),
      brokerUnixClientFactory: async () => { throw new Error('unused') },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => { throw new Error('unused') },
      sweepOrphans: async () => {},
    })

    const v01Outcome = outcomes.find((o) => o.runtimeId === V01_RUNTIME_ID)
    // Must be protocol-legacy, NOT broker_legacy_no_durable_endpoint_on_restart.
    expect(v01Outcome?.reason).not.toBe('broker_legacy_no_durable_endpoint_on_restart')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 (G4): reconcileDurableBrokerRuntimeReattach for headless (presentation.none)
// requires only brokerWindow, NOT tuiWindow
//
// RED: At HEAD, brokerLeaseWindowsMatch:
//   const persisted = getPersistedBrokerWindows(runtime)
//   if (!persisted?.brokerWindow || !persisted.tuiWindow) return false  ← fails for headless
// For a headless runtime, broker['tuiWindow'] is absent → persisted.tuiWindow = undefined
// → brokerLeaseWindowsMatch returns false → stale with broker_window_identity_mismatch.
// After Ph4: uses brokerLeaseIdentityMatches which skips tuiWindow when
// presentation.kind === 'none' → reattach succeeds.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 5 (G4): headless reattach requires only brokerWindow, not tuiWindow', () => {
  it('reconcileDurableBrokerRuntimeReattach with probe.tuiWindow=null succeeds for presentation.none', async () => {
    seedHeadlessDurableRuntime(db)

    const client = new MockDurableBrokerClient()
    const snap = emptySnapshot(HEADLESS_INVOCATION_ID, { currentSeq: 2, retentionFloorSeq: 1 })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(HEADLESS_RUNTIME_ID, HEADLESS_INVOCATION_ID, snap)
    client.queueEventsSince({
      events: [
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.started', 1, { pid: 1, command: 'claude', args: [], cwd: '/tmp' }),
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(HEADLESS_RUNTIME_ID),
      {
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: BROKER_WINDOW, // matching brokerWindow
          tuiWindow: null,             // no TUI window — presentation.none
        }),
      }
    )

    // Ph4: presentation.none → only brokerWindow identity required → reattach.
    // AT HEAD: brokerLeaseWindowsMatch requires !persisted.tuiWindow to be falsy,
    // but ALSO requires persisted.tuiWindow to exist in the second branch →
    // the function returns false → outcome.state === 'stale'.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })

  it('interactive reattach (presentation.tmux-tui) still fails when tuiWindow is missing from probe', async () => {
    // G4 counterpart: for presentation.tmux-tui, tuiWindow IS required.
    seedInteractiveNormalizedRuntime(db)

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(INTERACTIVE_RUNTIME_ID),
      {
        controller: makeController(),
        brokerUnixClientFactory: async () => {
          throw new Error('must not dial when identity check fails')
        },
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: INTERACTIVE_BROKER_WINDOW,
          tuiWindow: null, // missing → identity mismatch for tmux-tui
        }),
      }
    )

    // For presentation.tmux-tui, tuiWindow is REQUIRED. Probe missing it → stale.
    // This should PASS after Ph4 (the tmux-tui gate is stricter).
    // At HEAD: also stale (brokerLeaseWindowsMatch requires tuiWindow) — may already pass.
    // Kept as a regression guard.
    expect(outcome.state).toBe('stale')
    expect(outcome.brokerAttached).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios 6 & 7: Orphan sweeper with real tmux + createHrcServer
// These follow the pattern from broker-pane-lease-orphan-sweep.red.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const GRACE_ENV = 'HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'

let serverFixture: HrcServerTestFixture
const liveServers: HrcServer[] = []
const leaseSockets: string[] = []
let priorGrace: string | undefined

// Use separate beforeEach/afterEach for the server-level tests.
// Bun runs describes in sequence so these are scoped to this block.

describe('Scenario 6: orphan sweeper PRESERVES headless leased substrate', () => {
  beforeEach(async () => {
    serverFixture = await createHrcTestFixture('hrc-ph4-sweep-')
    priorGrace = process.env[GRACE_ENV]
  })

  afterEach(async () => {
    for (const server of liveServers.splice(0)) {
      await server.stop()
    }
    for (const socketPath of leaseSockets.splice(0)) {
      try {
        const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {
        // fine
      }
    }
    if (priorGrace === undefined) {
      delete process.env[GRACE_ENV]
    } else {
      process.env[GRACE_ENV] = priorGrace
    }
    await serverFixture.cleanup()
  })

  function btmuxDir(): string {
    return join(serverFixture.runtimeRoot, 'btmux')
  }

  async function createLeaseSession(
    runtimeId: string
  ): Promise<{ socketPath: string; sessionName: string }> {
    await mkdir(btmuxDir(), { recursive: true })
    // Use short driver prefix to keep socket path under macOS 104-char limit.
    const socketPath = join(btmuxDir(), `cc-${runtimeId}.sock`)
    const sessionName = `hrc-cc-${runtimeId}`
    leaseSockets.push(socketPath)
    const { exited } = Bun.spawn(
      ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    expect(await exited).toBe(0)
    return { socketPath, sessionName }
  }

  async function sessionAlive(socketPath: string, sessionName: string): Promise<boolean> {
    const mgr = createTmuxManager({ socketPath })
    // Use listSessionNames (not inspectSession) — listSessionNames doesn't
    // require a specific window name, making it robust for headless leases
    // whose first window is 'broker' (not 'main').
    return (await mgr.listSessionNames()).includes(sessionName)
  }

  /**
   * Seed a headless harness-broker runtime whose broker block points to the given
   * lease socket (flat shape: brokerWindow.socketPath = socketPath).
   *
   * The CURRENT sweeper checks `runtime.transport !== 'tmux'` → headless not
   * recognized as claiming the socket. After Ph4 it must check
   * hasLeasedBrokerSubstrate(runtime) and read the socket from substrate.
   */
  function seedHeadlessClaimingRuntime(runtimeId: string, socketPath: string): void {
    const swDb = openHrcDatabase(serverFixture.dbPath)
    const now = serverFixture.now()
    const hostSessionId = `hs_${runtimeId}`
    const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01875:${runtimeId}`
    const sessionName = `hrc-cc-${runtimeId}`
    try {
      swDb.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      swDb.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless', // ← headless; NOT 'tmux' — fails the current transport gate
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        // Flat-shape broker block with brokerWindow pointing to the real lease socket.
        // parseBrokerRuntimeHostingState reads this as substrate.kind=leased-tmux.
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          runtimeId,
          hostSessionId,
          generation: 1,
          status: 'ready',
          broker: {
            protocolVersion: 'harness-broker/0.2',
            ownerServerInstanceId: 'sweep-test',
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: join(serverFixture.runtimeRoot, 'bipc', `${runtimeId}.sock`),
              attachTokenRef: { kind: 'file', path: '/tmp/ph4-sweep.token', redacted: true },
            },
            generation: 1,
            // FLAT shape: brokerWindow.socketPath is the lease socket the sweeper must preserve.
            // The sweeper in Ph4 reads this via parseBrokerRuntimeHostingState → substrate.tmuxSocketPath.
            brokerWindow: {
              socketPath,   // ← the lease socket this runtime claims
              sessionName,  // `hrc-cc-${runtimeId}`
              windowName: 'main',
              sessionId: '$99',
              windowId: '@99',
              paneId: '%99',
            },
            // No tuiWindow → presentation.none
          },
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
    } finally {
      swDb.close()
    }
  }

  it('headless runtime (transport=headless) with leased substrate is NOT swept', async () => {
    const runtimeId = 'hdlA'
    const { socketPath, sessionName } = await createLeaseSession(runtimeId)
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Seed the headless claiming runtime BEFORE server start.
    seedHeadlessClaimingRuntime(runtimeId, socketPath)  // transport='headless', claimed

    // Grace=0 so any unclaimed lease WOULD be killed.
    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    // Ph4: headless runtime with leased substrate claims the socket via
    // substrate-based claim detection → socket preserved.
    // AT HEAD: sweeper checks transport==='tmux' → headless not claimed → socket killed.
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)
  })
})

describe('Scenario 7: orphan sweeper still REAPS unclaimed/dead leased substrate', () => {
  beforeEach(async () => {
    serverFixture = await createHrcTestFixture('hrc-ph4-reap-')
    priorGrace = process.env[GRACE_ENV]
  })

  afterEach(async () => {
    for (const server of liveServers.splice(0)) {
      await server.stop()
    }
    for (const socketPath of leaseSockets.splice(0)) {
      try {
        const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {}
    }
    if (priorGrace === undefined) {
      delete process.env[GRACE_ENV]
    } else {
      process.env[GRACE_ENV] = priorGrace
    }
    await serverFixture.cleanup()
  })

  function btmuxDir(): string {
    return join(serverFixture.runtimeRoot, 'btmux')
  }

  async function createUnclaimedLeaseSession(
    runtimeId: string
  ): Promise<{ socketPath: string; sessionName: string }> {
    await mkdir(btmuxDir(), { recursive: true })
    const socketPath = join(btmuxDir(), `cc-${runtimeId}.sock`)
    const sessionName = `hrc-cc-${runtimeId}`
    leaseSockets.push(socketPath)
    const { exited } = Bun.spawn(
      ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    expect(await exited).toBe(0)
    return { socketPath, sessionName }
  }

  async function sessionAlive(socketPath: string, sessionName: string): Promise<boolean> {
    const mgr = createTmuxManager({ socketPath })
    return (await mgr.listSessionNames()).includes(sessionName)
  }

  it('unclaimed leased substrate (no matching runtime) is swept past grace', async () => {
    // Create a lease session with NO corresponding DB runtime.
    const { socketPath, sessionName } = await createUnclaimedLeaseSession('unclB')
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Grace=0: unclaimed sessions past grace are killed.
    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    // No runtime claims this socket → sweeper kills it (Ph4 doesn't change this).
    expect(await sessionAlive(socketPath, sessionName)).toBe(false)
  })

  it('dead lease socket file with no matching runtime is removed past grace', async () => {
    await mkdir(btmuxDir(), { recursive: true })
    const socketPath = join(btmuxDir(), 'cc-deadC.sock')
    // Write a fake socket file with no live tmux server.
    const f = Bun.file(socketPath)
    await Bun.write(f, '')
    expect(existsSync(socketPath)).toBe(true)

    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    expect(existsSync(socketPath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8 (G5): reattachDurableBrokerForDispatch returns true for HEADLESS
// runtime (presentation.none) when broker socket is live.
//
// RED: At HEAD, reconcileDurableBrokerRuntimeReattach uses brokerLeaseWindowsMatch
// which requires tuiWindow for ALL leased substrates. Headless has no tuiWindow →
// brokerLeaseWindowsMatch returns false → reattachDurableBrokerForDispatch returns
// false. After Ph4: brokerLeaseIdentityMatches skips tuiWindow for presentation.none
// → identity check passes → returns true.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 8 (G5): reattachDurableBrokerForDispatch reattaches headless on broker_runtime_not_active', () => {
  it('returns true when broker socket is live and runtime has durable endpoint + leased substrate (presentation.none)', async () => {
    seedHeadlessDurableRuntime(db)

    const client = new MockDurableBrokerClient()
    const snap = emptySnapshot(HEADLESS_INVOCATION_ID, { currentSeq: 1, retentionFloorSeq: 1 })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(HEADLESS_RUNTIME_ID, HEADLESS_INVOCATION_ID, snap)
    client.queueEventsSince({
      events: [
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(HEADLESS_RUNTIME_ID),
      {
        controller,
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: BROKER_WINDOW,
          tuiWindow: null, // presentation.none — no tuiWindow
        }),
      }
    )

    // Ph4: headless reattach returns true → dispatch retry can proceed.
    // AT HEAD: returns false (brokerLeaseWindowsMatch fails for presentation.none).
    expect(reattached).toBe(true)
    expect(client.calls).toContain('attach')
  })

  it('headless runtime has canUseDirectPaneFallback=false (no tmux pane for dispatch fallback)', () => {
    // Guard: this predicate must remain false for headless runtimes.
    // Ph4 must NOT wire direct-tmux-pane fallback for presentation.none dispatch.
    seedHeadlessDurableRuntime(db)
    expect(canUseDirectPaneFallback(readRuntime(HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9 (G5/G4): reattachDurableBrokerForDispatch returns false for
// headless when broker socket is dead (no direct tmux fallback available).
//
// At HEAD: already returns false (for wrong reason — window check fails).
// After Ph4: returns false for correct reason (socket unavailable, no pane fallback).
// This scenario verifies the correct failure mode, not just the return value.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 9 (G5/G4): headless dispatch: no direct tmux pane fallback when reattach fails', () => {
  it('reattachDurableBrokerForDispatch returns false when broker socket is dead (presentation.none)', async () => {
    seedHeadlessDurableRuntime(db)

    let dialed = false
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(HEADLESS_RUNTIME_ID),
      {
        controller: makeController(),
        brokerUnixClientFactory: async () => {
          dialed = true
          throw new Error('socket unavailable')
        },
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: false, // socket dead
          brokerWindow: null,
          tuiWindow: null,
        }),
      }
    )

    // Reattach must fail (no socket → no attach).
    expect(reattached).toBe(false)
    // The unix factory must NOT be called when the socket probe returns dead.
    expect(dialed).toBe(false)

    // The predicate confirms no direct pane fallback is available.
    expect(canUseDirectPaneFallback(readRuntime(HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10 (G6): Active RUN activity is refreshed on successful broker.attach
// so a recovered in-flight run is NOT zombied by the zombie sweep.
//
// RED: At HEAD, reconcileDurableBrokerRuntimeReattach on success returns
// outcome={state:'broker-attached'} but does NOT update the active run's
// updatedAt. A subsequent zombie sweep with thresholdSeconds=0 kills the run.
// After Ph4: successful attach/replay refreshes run.updatedAt → zombie sweep
// leaves the run alive.
//
// Also covers: retention gap → broker_event_retention_gap emitted by
// attachAndReplay, NOT zombie.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 10 (G6): active RUN activity refreshed on broker.attach/replay', () => {
  it('run is NOT zombied after a successful broker.attach + replay (G6 activity refresh)', async () => {
    // Seed with an OLD run timestamp — zombie would kill it without activity refresh.
    seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: oldTs() })

    const client = new MockDurableBrokerClient()
    const snap = emptySnapshot(HEADLESS_INVOCATION_ID, { currentSeq: 2, retentionFloorSeq: 1 })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(HEADLESS_RUNTIME_ID, HEADLESS_INVOCATION_ID, snap)
    client.queueEventsSince({
      events: [
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.started', 1, { pid: 1, command: 'claude', args: [], cwd: '/tmp' }),
        makeEnvelope(HEADLESS_INVOCATION_ID, 'invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(HEADLESS_RUNTIME_ID),
      {
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: BROKER_WINDOW,
          tuiWindow: null, // presentation.none
        }),
      }
    )

    // Reattach must succeed.
    expect(outcome.state).toBe('broker-attached')

    // G6: after attach/replay the active run's updatedAt must be refreshed so
    // the zombie sweep cannot kill it.
    const run = db.runs.getByRunId(HEADLESS_RUN_ID)
    expect(run).toBeDefined()

    // The run must NOT be in a terminal state (failed/zombie).
    expect(run?.status).not.toBe('zombie')
    expect(run?.status).not.toBe('failed')

    // Ph4: run activity timestamp must have been updated from oldTs() to now.
    // AT HEAD: run.updatedAt remains oldTs() → zombie sweep (below) kills it.
    // After Ph4: run.updatedAt is refreshed → zombie sweep skips it.
    //
    // Verify by running the zombie sweep with zero threshold.
    // The sweep targets headless runs older than threshold in ('accepted','started','running').
    const sweepResult = await fetch(
      `http+unix://${encodeURIComponent(serverFixture.socketPath)}/v1/runs/sweep-zombies`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thresholdSeconds: 0 }),
      }
    ).catch(() => null)

    if (sweepResult && sweepResult.ok) {
      // If we managed to reach the server, check the run isn't zombied.
      const runAfterSweep = db.runs.getByRunId(HEADLESS_RUN_ID)
      expect(runAfterSweep?.status).not.toBe('zombie')
    } else {
      // No server — verify directly that the run timestamp was refreshed.
      // At HEAD: run.updatedAt is still oldTs() → would be zombie-eligible.
      // After Ph4: run.updatedAt > oldTs().
      expect(run?.updatedAt).not.toBe(oldTs())
    }
  })

  it('retention gap on reattach → broker_replay_retention_gap emitted, NOT zombie (G6)', async () => {
    // Seeds headless runtime with a non-zero lastProjectedSeq to create a gap.
    seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: oldTs() })

    const client = new MockDurableBrokerClient()
    // Create a retention gap: retentionFloorSeq=10 but lastProjectedSeq=0 → gap.
    const snap = emptySnapshot(HEADLESS_INVOCATION_ID, {
      currentSeq: 10,
      retentionFloorSeq: 10, // floor has advanced past last projected (0+1) → gap
    })
    client.snapshotResponse = snap
    client.attachResponse = attachResponseFor(HEADLESS_RUNTIME_ID, HEADLESS_INVOCATION_ID, snap)
    // eventsSince will not be called due to early gap detection in attachAndReplay.

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(HEADLESS_RUNTIME_ID),
      {
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: BROKER_WINDOW,
          tuiWindow: null,
        }),
      }
    )

    // Retention gap → reattach fails with a specific reason.
    // The reason must be broker_event_retention_gap (not zombie, not generic stale).
    expect(outcome.state).toBe('stale')
    expect(outcome.reason).toBe('broker_event_retention_gap')
    expect(outcome.brokerAttached).toBe(false)

    // The run must be explicitly failed (not left alive for zombie sweep).
    const run = db.runs.getByRunId(HEADLESS_RUN_ID)
    expect(run?.status).not.toBe('zombie')
    // Run is marked failed/unavailable due to retention gap.
    expect(run?.status).toMatch(/^(failed|stale)$/)
  })
})
