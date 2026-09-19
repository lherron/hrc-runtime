import type { HrcDatabase } from 'hrc-store-sqlite'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type {
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptAdmission,
  PreemptSubmissionRequest,
  RuntimeSeatResponse,
} from 'hrc-core'
import type {
  ForeignHome,
  HrcInjectionPort,
  KickerBrokerPort,
  KickerDispatchOptions,
  KickerDispatchResult,
  KickerRegistryClient,
} from './contracts.js'

/**
 * Transitional adapter for the daemon-embedded kicker.  Keeping direct store
 * and closure access here makes the rest of hrc-mail-kicker independent of
 * daemon internals and gives SocketInjectionPort one precise replacement seam.
 */
export type InProcessInjectionPortDependencies = {
  db: HrcDatabase
  registry?: KickerRegistryClient | undefined
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  resolveRuntimeIntent(
    scopeRef: string,
    materializationIntent: string | undefined
  ): Promise<HrcRuntimeIntent | undefined>
  findTargetSession(targetSessionRef: string): HrcSessionRecord | undefined
  ensureTargetSession(
    targetSessionRef: string,
    intent: HrcRuntimeIntent,
    options: { persistIntent: false }
  ): Promise<HrcSessionRecord>
  dispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: KickerDispatchOptions
  ): Promise<KickerDispatchResult>
  broker: KickerBrokerPort
  preemptAdmission(
    session: HrcSessionRecord,
    request: PreemptSubmissionRequest
  ): Promise<PreemptAdmission>
}

export function createInProcessInjectionPort(
  dependencies: InProcessInjectionPortDependencies
): HrcInjectionPort {
  return {
    runtimes: dependencies.db.runtimes,
    brokerInvocations: dependencies.db.brokerInvocations,
    brokerEvents: dependencies.db.brokerInvocationEvents,
    events: dependencies.db.hrcEvents,
    placement: createPlacementLedgerRepository(dependencies.db.sqlite),
    broker: dependencies.broker,
    registry: dependencies.registry,
    runtime: async (runtimeId) => dependencies.db.runtimes.getByRuntimeId(runtimeId) ?? undefined,
    runtimesByHostSession: async (hostSessionId) =>
      dependencies.db.runtimes.listByHostSessionId(hostSessionId),
    allRuntimes: async () => dependencies.db.runtimes.listAll(),
    liveSessionRefs: async () => dependencies.db.runtimes.listLiveSessionRefs(),
    seat: async (runtimeId) => {
      const runtime = dependencies.db.runtimes.getByRuntimeId(runtimeId)
      const invocationId = runtime?.activeInvocationId ?? null
      const probe = await dependencies.broker.seatProbe(runtimeId)
      const invocation =
        invocationId === null
          ? undefined
          : dependencies.db.brokerInvocations.getByInvocationId(invocationId)
      let admissionClasses: RuntimeSeatResponse['admissionClasses'] = null
      try {
        const parsed = JSON.parse(invocation?.capabilitiesJson ?? '{}') as {
          admission?: { classes?: RuntimeSeatResponse['admissionClasses'] }
        }
        admissionClasses = parsed.admission?.classes ?? null
      } catch {
        // Malformed legacy capability rows are intentionally an absent projection.
      }
      return {
        runtimeId,
        invocationId,
        generation: runtime?.generation ?? 0,
        admissionClasses,
        currentBrokerSeq:
          invocationId === null ? null : dependencies.db.brokerInvocationEvents.maxBrokerSeq(invocationId),
        probe: probe.ok ? probe.response : null,
        probeError: probe.ok ? null : { code: 'seat_probe_failed', message: probe.error.message },
      }
    },
    withdraw: (input) => dependencies.broker.withdraw(input),
    resolveForeignHome: dependencies.resolveForeignHome,
    resolveRuntimeIntent: dependencies.resolveRuntimeIntent,
    findTargetSession: dependencies.findTargetSession,
    targetBySessionRef: async (targetSessionRef) => dependencies.findTargetSession(targetSessionRef),
    ensureTargetSession: dependencies.ensureTargetSession,
    steer: (session, intent, prompt, options) =>
      dependencies.dispatchTurn(session, intent, prompt, { ...options, submissionDoor: 'steer' }),
    enqueue: (session, intent, prompt, options) =>
      dependencies.dispatchTurn(session, intent, prompt, { ...options, submissionDoor: 'enqueue' }),
    invoke: (session, intent, prompt, options) =>
      dependencies.dispatchTurn(session, intent, prompt, { ...options, submissionDoor: 'invoke' }),
    preempt: (session, intent, prompt, options) =>
      dependencies.dispatchTurn(session, intent, prompt, { ...options, submissionDoor: 'preempt' }),
    preemptAdmission: dependencies.preemptAdmission,
    eventsHead: async () => ({
      hrcSeq: dependencies.db.hrcEvents.maxHrcSeq(),
      brokerCommit: 0,
    }),
    lifecycleEvents: async ({ eventKind, runtimeId, limit }) =>
      dependencies.db.hrcEvents.listByKind(eventKind, { runtimeId, limit }),
    brokerEventsQuery: async (op) => {
      const events = dependencies.db.brokerInvocationEvents
      switch (op.op) {
        case 'admission-rejection': {
          const result = events.findAdmissionRejection(op.runtimeId, op.submissionId)
          return { result: result === undefined ? null : { op: op.op, ...result } }
        }
        case 'input-accepted':
          return { result: { op: op.op, accepted: events.hasInputAccepted(op.runtimeId, op.inputId) } }
        case 'unique-submission-after': {
          const submissionId = events.findUniqueSubmissionForEnvelopeAfter(op)
          return { result: submissionId === undefined ? null : { op: op.op, submissionId } }
        }
        case 'disposition': {
          const result = events.findSubmissionDisposition(op.runtimeId, op.submissionId)
          return { result: result === undefined ? null : { op: op.op, ...result } }
        }
        case 'input-rejection-evidence': {
          const deliveryEvidence = events.findInputRejectionDeliveryEvidence(op.runtimeId, op.submissionId)
          return {
            result:
              deliveryEvidence === undefined ? null : { op: op.op, deliveryEvidence },
          }
        }
      }
    },
    localPlacementBindings: async () => ({
      localNodeId: '',
      bindings: createPlacementLedgerRepository(dependencies.db.sqlite)
        .list()
        .filter((binding) => binding.state === 'active'),
    }),
    locate: dependencies.resolveForeignHome,
    unbornDesignations: async () => ({ localNodeId: '', designations: [] }),
    subscribeLifecycle: async () => () => undefined,
    subscribeBroker: async () => () => undefined,
  }
}
