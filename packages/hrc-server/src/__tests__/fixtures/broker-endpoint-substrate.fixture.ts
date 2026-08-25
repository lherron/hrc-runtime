import type { HrcDatabase } from 'hrc-store-sqlite'
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
import type { DurableBrokerClientLike } from '../../broker/controller'
import type { TmuxPaneState } from '../../tmux'

export const SERVER_INSTANCE_ID = 'hrc-server-ph4-test'
export const ATTACH_TOKEN = 'attach-token-ph4'
export const RUNTIME_ROOT = '/tmp/hrc-ph4'
export const GENERATION = 1
export const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-01875'
export const LANE_REF = 'main'

// Headless durable runtime IDs
export const HEADLESS_HOST_SESSION_ID = 'hsid_headless_durable'
export const HEADLESS_RUNTIME_ID = 'runtime_headless_durable'
export const HEADLESS_OPERATION_ID = 'op_headless_durable'
export const HEADLESS_INVOCATION_ID = 'inv_headless_durable' as InvocationId
export const HEADLESS_RUN_ID = 'run_headless_durable'

// Interactive durable runtime IDs (normalized-shape test)
export const INTERACTIVE_HOST_SESSION_ID = 'hsid_interactive_normalized'
export const INTERACTIVE_RUNTIME_ID = 'runtime_interactive_normalized'
export const INTERACTIVE_OPERATION_ID = 'op_interactive_normalized'
export const INTERACTIVE_INVOCATION_ID = 'inv_interactive_normalized' as InvocationId
export const INTERACTIVE_RUN_ID = 'run_interactive_normalized'

// Legacy daemon-child headless runtime IDs
export const LEGACY_HOST_SESSION_ID = 'hsid_legacy_daemon_child'
export const LEGACY_RUNTIME_ID = 'runtime_legacy_daemon_child'

// v0.1 row IDs
export const V01_HOST_SESSION_ID = 'hsid_v01_row'
export const V01_RUNTIME_ID = 'runtime_v01_row'

// Broker socket paths (fake, not real files)
export const HEADLESS_BROKER_SOCKET = '/tmp/hrc-ph4/bipc/headless.sock'
export const HEADLESS_LEASE_SOCKET = '/tmp/hrc-ph4/btmux/headless-runtime.sock'
export const HEADLESS_SESSION_NAME = 'hrc-claude-code-tmux-headless-runtime'

export const INTERACTIVE_BROKER_SOCKET = '/tmp/hrc-ph4/bipc/interactive.sock'
export const INTERACTIVE_LEASE_SOCKET = '/tmp/hrc-ph4/btmux/interactive-runtime.sock'
export const INTERACTIVE_SESSION_NAME = 'hrc-claude-code-tmux-interactive-runtime'

export const BROKER_WINDOW: TmuxPaneState = {
  socketPath: HEADLESS_LEASE_SOCKET,
  sessionName: HEADLESS_SESSION_NAME,
  windowName: 'broker',
  sessionId: '$10',
  windowId: '@10',
  paneId: '%10',
}

export const TUI_WINDOW: TmuxPaneState = {
  socketPath: INTERACTIVE_LEASE_SOCKET,
  sessionName: INTERACTIVE_SESSION_NAME,
  windowName: 'tui',
  sessionId: '$20',
  windowId: '@21',
  paneId: '%21',
}

export const INTERACTIVE_BROKER_WINDOW: TmuxPaneState = {
  socketPath: INTERACTIVE_LEASE_SOCKET,
  sessionName: INTERACTIVE_SESSION_NAME,
  windowName: 'broker',
  sessionId: '$20',
  windowId: '@20',
  paneId: '%20',
}

export function nowTs(): string {
  return '2026-06-04T00:00:00.000Z'
}

// An old timestamp to simulate a run that would be zombied without activity refresh.
export function oldTs(): string {
  return '2026-06-01T00:00:00.000Z'
}

// ─────────────────────────────────────────────────────────────────────────────
// DB seeding helpers
// ─────────────────────────────────────────────────────────────────────────────

export function seedSession(
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
export function seedHeadlessDurableRuntime(
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
export function seedInteractiveNormalizedRuntime(db: HrcDatabase): void {
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
export function seedLegacyDaemonChildRuntime(db: HrcDatabase): void {
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
export function seedV01Row(db: HrcDatabase): void {
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

export class MockDurableBrokerClient implements DurableBrokerClientLike {
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
    return {
      invocationId: this.snapshotResponse.invocationId,
      state: 'ready',
    } as InvocationStatusResponse
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

export function emptySnapshot(
  invocationId: InvocationId,
  overrides: Partial<InvocationSnapshot> = {}
): InvocationSnapshot {
  return {
    invocationId,
    state: 'ready',
    capabilities: {
      input: {
        user: true,
        steer: true,
        appendContext: true,
        localImages: true,
        fileRefs: true,
        queue: false,
      },
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

export function attachResponseFor(
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

export function makeEnvelope(
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
