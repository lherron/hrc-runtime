/**
 * RED test (T-01789 / T-01783 Workstream D) — HRC RECONCILIATION ORDERING:
 * lifecycle terminal events WIN over stale/orphan classification.
 *
 * Depends on (GREEN on main):
 *   - WS-B: runtimes/broker_invocations carry `lifecycle_terminal_reason`.
 *   - WS-C (00dc392, broker/event-mapper.ts): terminal broker events project
 *     `lifecycle_terminal_reason` onto the invocation —
 *       harness.exited      → lifecycleTerminalReason := payload.reason
 *       invocation.exited   → lifecycleTerminalReason := payload.reason
 *                             (e.g. the future `idle-ttl` retire reason)
 *
 * ── Acceptance under test (T-01783 WS-D) ───────────────────────────────────
 * When a broker-tmux runtime's active invocation already carries a persisted
 * lifecycle terminal reason (drained into projection by WS-C), a later
 * `reconcileTmuxRuntimeLiveness` pass MUST classify the runtime by that
 * lifecycle reason and MUST NOT synthesize a generic stale/dead/orphan
 * classification from raw pane/session liveness inspection.
 *
 * Concretely, the runtime was intentionally retired by the broker (harness
 * exited; its leased tmux session was torn down). The terminal reason
 * (`idle-retire` / `idle-ttl`) is the source of truth. When reconciliation
 * next inspects the (now gone) lease and observes "session missing", it must
 * DEFER to the persisted lifecycle reason rather than overwrite it with the
 * generic `broker_tmux_session_missing` (or `broker_tmux_harness_not_live`)
 * synthesized reason.
 *
 * ── Why this is RED at HEAD ─────────────────────────────────────────────────
 * `reconcileTmuxRuntimeLiveness` (index.ts ~line 5823) has NO precedence check.
 * For a broker-tmux runtime whose lease session is gone it unconditionally
 * calls `markRuntimeStale(... reason: 'broker_tmux_session_missing')`, which
 * (a) never propagates the lifecycle terminal reason onto the runtime record,
 * and (b) records the generic synthesized reason as the classification. Both
 * assertions below therefore fail until the ordering/precedence logic exists.
 *
 * The test exercises the REAL projection (BrokerEventMapper.apply) to persist
 * the terminal reason, the REAL startup reconcile (createHrcServer re-associates
 * the still-live lease so the runtime is `ready` going in), and then the REAL
 * `reconcileTmuxRuntimeLiveness` against the runtime after its lease is torn
 * down. Run with TMPDIR=/tmp.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../broker/event-mapper'
import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * Reasons `reconcileTmuxRuntimeLiveness` synthesizes from raw pane/session
 * liveness inspection. None of these may win over a persisted lifecycle
 * terminal reason.
 */
const GENERIC_SYNTHESIZED_REASONS = [
  'broker_tmux_session_missing',
  'broker_tmux_harness_not_live',
  'broker_tmux_socket_missing',
]

/** A server instance still carries the private reconcile method at runtime. */
type Reconcilable = HrcServer & {
  reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
}

let fixture: HrcServerTestFixture
const servers: HrcServer[] = []
const leaseSockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-reconcile-ordering-')
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
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
      // fine when no server exists
    }
  }
  await fixture.cleanup()
})

async function createSession(socketPath: string, sessionName: string): Promise<void> {
  const { exited } = Bun.spawn(
    ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  expect(await exited).toBe(0)
}

async function killServer(socketPath: string): Promise<void> {
  const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await exited
}

type Seeded = {
  runtimeId: string
  invocationId: string
  sessionName: string
  leaseSocket: string
}

/**
 * Allocate a REAL, id-matched, alive broker-tmux lease and persist a
 * broker-tmux runtime + ready invocation pointing at it. The live lease lets
 * the daemon's startup reconcile re-associate (not GC) the runtime, so it is
 * `ready` when `reconcileTmuxRuntimeLiveness` later runs.
 */
async function seedAliveBrokerLease(tag: string): Promise<Seeded> {
  const driver = 'claude-code-tmux'
  const runtimeId = `runtime_${tag}`
  const hostSessionId = `hsid_${tag}`
  const operationId = `op_${tag}`
  const invocationId = `invocation_${tag}`
  const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01789:${tag}`
  const sessionName = `hrc-${driver}-${runtimeId}`
  const leaseSocket = join(fixture.runtimeRoot, `lease-${tag}.sock`)
  leaseSockets.push(leaseSocket)

  await createSession(leaseSocket, sessionName)
  const leaseMgr = createTmuxManager({ socketPath: leaseSocket })
  const pane = await leaseMgr.inspectSession(sessionName)
  if (!pane) throw new Error('failed to allocate leased tmux pane fixture')

  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: invocationId,
      tmuxJson: {
        socketPath: leaseSocket,
        sessionName,
        windowName: 'main',
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        paneId: pane.paneId,
        brokerDriver: driver,
      },
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId,
      brokerProtocol: 'harness-broker/0.1',
      brokerDriver: driver,
      invocationState: 'ready',
      capabilitiesJson: JSON.stringify({}),
      specHash: `sha256:spec-${tag}`,
      startRequestHash: `sha256:req-${tag}`,
      selectedProfileHash: `sha256:prof-${tag}`,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return { runtimeId, invocationId, sessionName, leaseSocket }
}

/**
 * Drain a terminal broker event THROUGH the real WS-C projection so the
 * lifecycle terminal reason is persisted on the invocation exactly as it would
 * be in production.
 */
function drainTerminalEvent(
  invocationId: string,
  type: InvocationEventType,
  payload: Record<string, unknown>
): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const mapper = new BrokerEventMapper({ db, now: () => fixture.now() })
    const envelope: InvocationEventEnvelope = {
      invocationId,
      seq: 1,
      time: fixture.now(),
      type,
      payload: payload as InvocationEventEnvelope['payload'],
    }
    mapper.apply(envelope)
  } finally {
    db.close()
  }
}

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) throw new Error(`runtime ${runtimeId} not found`)
    return runtime
  } finally {
    db.close()
  }
}

function readInvocationTerminalReason(invocationId: string): string | undefined {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.brokerInvocations.getByInvocationId(invocationId)?.lifecycleTerminalReason
  } finally {
    db.close()
  }
}

function readStaleReasons(runtimeId: string): Array<string | undefined> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listByKind('runtime.stale', { runtimeId })
      .map((event) => (event.payload as Record<string, unknown> | undefined)?.['reason'])
      .map((reason) => (typeof reason === 'string' ? reason : undefined))
  } finally {
    db.close()
  }
}

/**
 * Shared body: seed an alive lease, drain a terminal lifecycle event, boot the
 * daemon (re-associates the live lease), tear down the lease, then run
 * `reconcileTmuxRuntimeLiveness` and assert the lifecycle reason wins.
 */
async function runOrderingScenario(options: {
  tag: string
  type: InvocationEventType
  reason: string
}): Promise<void> {
  const { runtimeId, invocationId, leaseSocket } = await seedAliveBrokerLease(options.tag)

  // WS-C drains the terminal event into projection -> reason persisted.
  drainTerminalEvent(invocationId, options.type, {
    reason: options.reason,
    exitCode: 0,
    signal: null,
  })
  expect(readInvocationTerminalReason(invocationId)).toBe(options.reason)

  // Daemon "restart": startup reconcile re-associates the still-live, id-matched
  // lease, leaving the runtime usable (ready) — NOT GC'd.
  const server = (await createHrcServer(fixture.serverOpts())) as Reconcilable
  servers.push(server)
  expect(['ready', 'starting']).toContain(readRuntime(runtimeId).status)

  // The broker retired the harness and tore down its leased tmux session.
  await killServer(leaseSocket)

  // Reconciliation runs against the retired runtime. The lifecycle terminal
  // reason is already persisted, so it must WIN: classify by the lifecycle
  // reason, NOT synthesize a generic stale/orphan from "session missing".
  const result = await server.reconcileTmuxRuntimeLiveness(readRuntime(runtimeId))

  // (1) The runtime carries the lifecycle terminal reason (precedence applied).
  expect(result.lifecycleTerminalReason).toBe(options.reason)
  expect(readRuntime(runtimeId).lifecycleTerminalReason).toBe(options.reason)

  // (2) Reconciliation did NOT overwrite it with a generic synthesized reason.
  for (const staleReason of readStaleReasons(runtimeId)) {
    expect(GENERIC_SYNTHESIZED_REASONS).not.toContain(staleReason)
  }
}

describe('RED (T-01789 WS-D): reconciliation defers to persisted lifecycle terminal reason', () => {
  it('classifies by harness.exited reason=idle-retire (not broker_tmux_session_missing)', async () => {
    await runOrderingScenario({
      tag: 'idle_retire',
      type: 'harness.exited',
      reason: 'idle-retire',
    })
  })

  it('classifies by invocation.exited reason=idle-ttl (not broker_tmux_session_missing)', async () => {
    await runOrderingScenario({
      tag: 'idle_ttl',
      type: 'invocation.exited',
      reason: 'idle-ttl',
    })
  })
})
