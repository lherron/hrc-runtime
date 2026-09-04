import { createMailKicker } from 'hrc-mail-kicker'
import type { KickerDispatchResult, MailKicker } from 'hrc-mail-kicker'

import { projectSemanticTurnResponse } from './event-notification-handlers.js'
import { homeAuthorityDeps, resolveForeignHome } from './federation/home-authority.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { findTargetSession } from './target-view.js'
import { preemptAuthorized } from './turn-dispatch-handlers.js'
import { buildKickRuntimeIntent } from './wrkq/kick-intent.js'

/** Bind the package-owned kicker state machine to this daemon's runtime capabilities. */
export function createServerMailKicker(server: HrcServerInstanceForHandlers): MailKicker {
  return createMailKicker(
    {
      db: server.db,
      ledger: server.wrkqLedger,
      nodeId: server.federationNodeId,
      registry: server.federationRegistryClient,
      foreignHomeMemo: server.foreignHomeMemo,
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
      resolveRuntimeIntent: (scopeRef, materializationIntent) =>
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
      preemptAuthorized: (session, request) => preemptAuthorized(server, session, request),
      requestAutoReplyReconcile: () => server.requestAutoReplyReconcile(),
      // One body authority: the kicker diagnostics report the SAME projection
      // the auto-reply and dispatcher responses mint from (T-07969).
      projectTurnResponse: (runId) => projectSemanticTurnResponse(server.db, runId),
      afterClaim: server.options.hrcMailKickerAfterClaim,
      log: writeServerLog,
    },
    {
      enabled: server.hrcMailKickerEnabled,
      sweepIntervalMs: server.hrcMailKickerSweepIntervalMs,
    }
  )
}
