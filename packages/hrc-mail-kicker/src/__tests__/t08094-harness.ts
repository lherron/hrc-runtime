import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BrokerEventsQueryOp, HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
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
  return { state, runtimeId: RUNTIME, steerCapable }
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
    store: db,
    ledger: ledger as unknown as MailKickerContext['ledger'],
    nodeId: 'max3',
    foreignHomeMemo: new Map(),
    port: {
      runtimes: db.runtimes,
      brokerInvocations: db.brokerInvocations,
      brokerEvents: db.brokerInvocationEvents,
      events: db.hrcEvents,
      placement: createPlacementLedgerRepository(db.sqlite),
      broker: {
        seatProbe: async () => ({ ok: false, error: { message: 'not used' } }),
        withdraw: async () => ({ ok: false, error: { message: 'not used' } }),
      },
      registry: undefined,
      resolveForeignHome: async () => undefined,
      resolveRuntimeIntent: () => ({}) as never,
      findTargetSession: () => session,
      ensureTargetSession: async () => session,
      steer: async (
        _session: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        _prompt: string,
        options: KickerDispatchOptions
      ) => {
        dispatches.push({ ...options, submissionDoor: 'steer' })
        return dispatchResult()
      },
      enqueue: async (
        _session: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        _prompt: string,
        options: KickerDispatchOptions
      ) => {
        dispatches.push({ ...options, submissionDoor: 'enqueue' })
        return dispatchResult()
      },
      invoke: async (
        _session: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        _prompt: string,
        options: KickerDispatchOptions
      ) => {
        dispatches.push({ ...options, submissionDoor: 'invoke' })
        return dispatchResult()
      },
      preempt: async (
        _session: HrcSessionRecord,
        _intent: HrcRuntimeIntent,
        _prompt: string,
        options: KickerDispatchOptions
      ) => {
        dispatches.push({ ...options, submissionDoor: 'preempt' })
        return dispatchResult()
      },
      preemptAdmission: async () => 'authority-denied',
    } as unknown as MailKickerContext['port'],
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
    mailKickerSteerFallback: new Set(),
    mailKickerDeliveryBackoff: new Map(),
    log: (level, event, detail) => logs.push({ level, event, detail }),
    wake: (target) => wakes.push(target),
    drainTarget: async () => undefined,
    runSweepOnce: async () => undefined,
    runTailOnce: async () => undefined,
    observeLifecycleEvent: () => undefined,
    observeBrokerEvent: () => undefined,
  }

  Object.assign(context.port, {
    runtime: async (runtimeId: string) => db.runtimes.getByRuntimeId(runtimeId) ?? undefined,
    runtimesByHostSession: async (hostSessionId: string) =>
      db.runtimes.listByHostSessionId(hostSessionId),
    allRuntimes: async () => db.runtimes.listAll(),
    liveSessionRefs: async () => db.runtimes.listLiveSessionRefs(),
    targetBySessionRef: async () => session,
    seat: async (runtimeId: string) => {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      const invocationId = runtime?.activeInvocationId ?? null
      const invocation =
        invocationId === null ? undefined : db.brokerInvocations.getByInvocationId(invocationId)
      const capabilities = JSON.parse(invocation?.capabilitiesJson ?? '{}') as {
        admission?: { classes?: Array<'steer' | 'enqueue' | 'invoke' | 'preempt'> }
      }
      return {
        runtimeId,
        invocationId,
        generation: runtime?.generation ?? 0,
        admissionClasses: capabilities.admission?.classes ?? null,
        currentBrokerSeq:
          invocationId === null ? null : db.brokerInvocationEvents.maxBrokerSeq(invocationId),
        probe: null,
        probeError: { code: 'test_probe_failed', message: 'not configured' },
      }
    },
    eventsHead: async () => ({ hrcSeq: db.hrcEvents.maxHrcSeq(), brokerCommit: 0 }),
    lifecycleEvents: async ({
      eventKind,
      runtimeId,
      limit,
    }: {
      eventKind: string
      runtimeId: string
      limit: number
    }) => db.hrcEvents.listByKind(eventKind, { runtimeId, limit }),
    brokerEventsQuery: async (op: BrokerEventsQueryOp) => {
      const events = db.brokerInvocationEvents
      switch (op.op) {
        case 'admission-rejection': {
          const result = events.findAdmissionRejection(op.runtimeId, op.submissionId)
          return { result: result === undefined ? null : { op: op.op, ...result } }
        }
        case 'input-accepted':
          return {
            result: { op: op.op, accepted: events.hasInputAccepted(op.runtimeId, op.inputId) },
          }
        case 'unique-submission-after': {
          const submissionId = events.findUniqueSubmissionForEnvelopeAfter(op)
          return { result: submissionId === undefined ? null : { op: op.op, submissionId } }
        }
        case 'disposition': {
          const result = events.findSubmissionDisposition(op.runtimeId, op.submissionId)
          return { result: result === undefined ? null : { op: op.op, ...result } }
        }
        case 'input-rejection-evidence': {
          const deliveryEvidence = events.findInputRejectionDeliveryEvidence(
            op.runtimeId,
            op.submissionId
          )
          return { result: deliveryEvidence === undefined ? null : { op: op.op, deliveryEvidence } }
        }
      }
    },
    localPlacementBindings: async () => ({
      localNodeId: 'max3',
      bindings: createPlacementLedgerRepository(db.sqlite)
        .list()
        .filter((binding) => binding.state === 'active'),
    }),
    locate: async () => undefined,
    unbornDesignations: async () => ({ localNodeId: 'max3', designations: [] }),
    subscribeLifecycle: async () => () => undefined,
    subscribeBroker: async () => () => undefined,
    withdraw: async () => ({ ok: false, error: { message: 'not used' } }),
  })

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
