import { createInProcessInjectionPort, createMailKicker } from 'hrc-mail-kicker'
import type { KickerDispatchResult, MailKicker } from 'hrc-mail-kicker'

import { homeAuthorityDeps, resolveForeignHome } from './federation/home-authority.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { findTargetSession } from './target-view.js'
import { preemptAdmission } from './turn-dispatch-handlers.js'
import { buildKickRuntimeIntent } from './wrkq/kick-intent.js'

/** Bind the package-owned kicker state machine to this daemon's runtime capabilities. */
export function createServerMailKicker(server: HrcServerInstanceForHandlers): MailKicker {
  return createMailKicker(
    {
      store: server.db,
      port: createInProcessInjectionPort({
        db: server.db,
        registry: server.federationRegistryClient,
        resolveForeignHome: (scopeRef) =>
          resolveForeignHome(
            homeAuthorityDeps(server, (failedScopeRef, error) => {
              writeServerLog('WARN', 'wrkq.kicker.home_consult_failed', {
                scopeRef: failedScopeRef,
                error: error instanceof Error ? error.message : String(error),
              })
            }),
            scopeRef
          ),
        resolveRuntimeIntent: async (scopeRef, materializationIntent) =>
          buildKickRuntimeIntent(scopeRef, materializationIntent),
        findTargetSession: (targetSessionRef) =>
          findTargetSession(server.db, targetSessionRef) ?? undefined,
        ensureTargetSession: (targetSessionRef, intent, options) =>
          server.ensureTargetSession(targetSessionRef, intent, undefined, 'local', options),
        dispatchTurn: async (session, intent, prompt, options) => {
          const response = await server.dispatchTurnForSession(session, intent, prompt, options)
          return (await response.json()) as KickerDispatchResult
        },
        broker: {
          seatProbe: (runtimeId) => server.getHarnessBrokerController().seatProbe(runtimeId),
          withdraw: (input) => server.getHarnessBrokerController().withdraw(input),
        },
        preemptAdmission: (session, request) => preemptAdmission(server, session, request),
      }),
      ledger: server.wrkqLedger,
      nodeId: server.federationNodeId,
      foreignHomeMemo: server.foreignHomeMemo,
      log: writeServerLog,
    },
    {
      enabled: server.hrcMailKickerEnabled,
      sweepIntervalMs: server.hrcMailKickerSweepIntervalMs,
    }
  )
}
