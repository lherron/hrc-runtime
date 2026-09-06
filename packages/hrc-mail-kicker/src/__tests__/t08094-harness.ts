import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcSessionRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { MailKickerContext } from '../context.js'
import type { KickerDispatchOptions, KickerDispatchResult } from '../contracts.js'
import { deliverToSeat } from '../drive/delivery.js'
import { readActionableEnvelopes } from '../drive/presentation.js'
import type { ObservedBrokerSeat } from '../drive/seat.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopePendingView,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
} from '../ledger/types.js'

const SCOPE = 'agent:clod:project:hrc-runtime:task:T-08094'
const TARGET = `${SCOPE}/lane:main`
const RUNTIME = 'rt-t08094'
const HOST_SESSION = 'hsid-t08094'

/**
 * The shared T-08094 fixture: one session, one runtime, a fake wrkq ledger and
 * a MailKickerContext whose every seam is recorded rather than real.
 *
 * It lives here rather than in either test file because both of them need all
 * of it, and a fixture duplicated is a fixture that drifts — the two copies
 * would disagree about what a seat is, and the tests would agree with their own
 * copy instead of with the code.
 */

type Recorded = { level: string; event: string; detail: Record<string, unknown> }

class FakeLedger {
  readonly envelopes = new Map<string, WrkqEnvelope>()
  readonly presentRequests: WrkqEnvelopePresentParams[] = []
  readonly failRequests: Array<{ envelope: string; reason: string }> = []
  private seq = 0

  say(overrides: Partial<WrkqEnvelope> = {}): WrkqEnvelope {
    this.seq += 1
    const id = `EN-${String(this.seq).padStart(5, '0')}`
    const now = new Date().toISOString()
    const envelope: WrkqEnvelope = {
      uuid: `uuid-${id}`,
      id,
      roomUuid: 'room-T-08094',
      roomKey: 'T-08094',
      roomKind: 'task',
      from: { principalRef: 'agent:chief', scopeRef: 'chief@hcs:T-07987' },
      to: { principalRef: 'agent:clod', scopeRef: SCOPE },
      obligation: 'reply_required',
      delivery: 'queue',
      body: 'the body',
      state: 'pending',
      terminal: false,
      presentedTo: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
    this.envelopes.set(id, envelope)
    return envelope
  }

  pendingView(): Promise<WrkqEnvelopePendingView> {
    const items = [...this.envelopes.values()].filter((envelope) => !envelope.terminal)
    return Promise.resolve({
      items,
      blocking: items.filter((item) => item.state === 'presented').map((item) => item.id),
      repended: 0,
    })
  }

  present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    this.presentRequests.push(params)
    // wrkq refuses a presentation onto a discharged row, and the exact wire
    // error is what HRC keys the disposed-before-landing branch on.
    if (params.preview !== true && envelope.terminal) {
      throw new Error('wrong_state: envelope is terminal')
    }
    if (params.preview === true) {
      return Promise.resolve({ envelope, recorded: false, historyHint: false, messageCount: 1 })
    }
    // Exactly-once per presentation id, which is what makes a replayed landing
    // idempotent on the wrkq side.
    const already = envelope.presentedTo.some(
      (receipt) => receipt.driveAttemptId === params.driveAttemptId
    )
    if (!already) {
      envelope.presentedTo.push({
        memberRef: SCOPE,
        ...(params.runtimeId === undefined ? {} : { runtimeId: params.runtimeId }),
        ...(params.inputId === undefined ? {} : { inputId: params.inputId }),
        ...(params.driveAttemptId === undefined ? {} : { driveAttemptId: params.driveAttemptId }),
        ...(params.deliveryOutcome === undefined
          ? {}
          : { deliveryOutcome: params.deliveryOutcome }),
        presentedAt: new Date().toISOString(),
      })
      envelope.state = 'presented'
    }
    return Promise.resolve({
      envelope,
      recorded: !already,
      historyHint: false,
      messageCount: 1,
    })
  }

  fail(params: { envelope: string; reason: string }): Promise<WrkqEnvelope> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    this.failRequests.push({ envelope: params.envelope, reason: params.reason })
    envelope.state = 'failed'
    envelope.terminal = true
    envelope.failureReason = params.reason as WrkqEnvelope['failureReason']
    return Promise.resolve(envelope)
  }

  envelopeShow(params: { envelope: string }): Promise<WrkqEnvelope> {
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    return Promise.resolve(envelope)
  }

  eventsView(): Promise<{ items: never[]; highWater: number }> {
    return Promise.resolve({ items: [], highWater: 0 })
  }
}

export type T08094Harness = {
  dir: string
  db: HrcDatabase
  ledger: FakeLedger
  logs: Recorded[]
  wakes: string[]
  dispatches: KickerDispatchOptions[]
  dispatchResult: () => KickerDispatchResult
  context: MailKickerContext
  session: HrcSessionRecord
}

export type { Recorded }
export { FakeLedger }
export const SCOPE_REF = SCOPE
export const TARGET_REF = TARGET
export const RUNTIME_ID = RUNTIME
export const HOST_SESSION_ID = HOST_SESSION

export function seatIn(
  state: 'turn-active' | 'idle' | 'turn-observed',
  steerCapable = true
): ObservedBrokerSeat {
  if (state === 'turn-active') {
    return { state, runtimeId: RUNTIME, turnId: 'turn-1', steerCapable }
  }
  if (state === 'turn-observed') return { state, runtimeId: RUNTIME, turnId: 'turn-1' }
  return { state, runtimeId: RUNTIME }
}

export function brokerRecord(type: string, payload: Record<string, unknown>) {
  return {
    invocationId: 'inv-t08094',
    seq: 1,
    time: new Date().toISOString(),
    type,
    runtimeId: RUNTIME,
    brokerEventJson: JSON.stringify(payload),
    projectionStatus: 'projected',
    createdAt: new Date().toISOString(),
  }
}

export async function createT08094Harness(): Promise<T08094Harness> {
  const dir = await mkdtemp(join(tmpdir(), 't08094-kicker-'))
  const db = openHrcDatabase(join(dir, 'state.sqlite'))
  const ledger = new FakeLedger()
  const logs: Recorded[] = []
  const wakes: string[] = []
  const dispatches: KickerDispatchOptions[] = []
  const dispatchResult: () => KickerDispatchResult = () =>
    ({
      submissionId: 'sub-1',
      admission: 'admitted',
      runId: 'run-ignored',
      hostSessionId: HOST_SESSION,
      generation: 1,
      runtimeId: RUNTIME,
      transport: 'headless',
      stage: 'accepted',
      status: 'started',
      replayed: false,
      supportsInFlightInput: false,
      observation: {
        lifecycle: { selector: { runId: 'run-ignored', generation: 1 }, fromSeq: 0 },
      },
    }) as KickerDispatchResult

  const now = new Date().toISOString()
  db.sessions.insert({
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME,
    hostSessionId: HOST_SESSION,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  const stored = db.sessions.getByHostSessionId(HOST_SESSION)
  if (stored === null) throw new Error('fixture session missing')
  const session = stored

  const context: MailKickerContext = {
    db,
    ledger: ledger as unknown as MailKickerContext['ledger'],
    nodeId: 'max3',
    registry: undefined,
    foreignHomeMemo: new Map(),
    broker: {
      seatProbe: async () => ({ ok: false, error: { message: 'not used' } }),
      withdraw: async () => ({ ok: false, error: { message: 'not used' } }),
    },
    enabled: true,
    sweepIntervalMs: 60_000,
    stopping: false,
    mailKickerSweepTimer: undefined,
    mailKickerSweepInFlight: undefined,
    wrkqLedgerTailInFlight: undefined,
    mailKickerColdStartCatchupPending: false,
    mailKickerPendingTargets: new Map(),
    mailKickerTargetOperations: new Map(),
    mailKickerForeignHomeAnnounced: new Map(),
    mailKickerBirthDeferredAnnounced: new Map(),
    mailKickerBirthSweepBackoff: new Map(),
    mailKickerLapsedRuntimes: new Set(),
    mailKickerDisposalsPending: new Set(),
    mailKickerBootReconcilePending: false,
    mailKickerStalledDeliveryAnnounced: new Set(),
    mailKickerSteerRefused: new Set(),
    mailKickerDeliveryBackoff: new Map(),
    resolveForeignHome: async () => undefined,
    resolveRuntimeIntent: () => ({}) as never,
    findTargetSession: () => session,
    ensureTargetSession: async () => session,
    dispatchTurn: async (_session, _intent, _prompt, options) => {
      dispatches.push(options)
      return dispatchResult()
    },
    preemptAuthorized: async () => false,
    log: (level, event, detail) => logs.push({ level, event, detail }),
    wake: (target) => wakes.push(target),
    drainTarget: async () => undefined,
    runSweepOnce: async () => undefined,
    runTailOnce: async () => undefined,
    observeLifecycleEvent: () => undefined,
    observeBrokerEvent: () => undefined,
  }

  return { dir, db, ledger, logs, wakes, dispatches, dispatchResult, context, session }
}

export async function destroyT08094Harness(h: T08094Harness): Promise<void> {
  h.db.close()
  await rm(h.dir, { recursive: true, force: true })
}

/** Deliver ONE envelope to a seat, failing loudly if it was not actionable. */
export async function deliverOneTo(
  h: T08094Harness,
  seat: ObservedBrokerSeat,
  envelope: WrkqEnvelope
) {
  const actionable = await readActionableEnvelopes(h.context, TARGET)
  const item = actionable.find((candidate) => candidate.envelope.id === envelope.id)
  if (item === undefined) throw new Error(`${envelope.id} was not actionable`)
  return deliverToSeat(h.context, TARGET, h.session, seat, item, 'insert')
}
