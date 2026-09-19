import type { HrcDatabase } from 'hrc-store-sqlite'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'

import type {
  HrcRuntimeIntent,
  HrcSessionRecord,
  PreemptAdmission,
  PreemptSubmissionRequest,
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
    resolveForeignHome: dependencies.resolveForeignHome,
    resolveRuntimeIntent: dependencies.resolveRuntimeIntent,
    findTargetSession: dependencies.findTargetSession,
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
  }
}
