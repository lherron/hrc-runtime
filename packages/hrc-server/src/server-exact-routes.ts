import { HRC_RESTART_SELF_PATH } from 'hrc-core'
import {
  assertNoRetainedProjection,
  awaitRetainedRecoveryOwner,
} from './broker/runtime-exclusive-owner'
import { handleResolveRuntimeIntent, handleRunPreview } from './declaration-handlers.js'
import { handleFirstTurnDiagnostics } from './first-turn-diagnostics-handlers.js'
import type { HrcServerInstance } from './index.js'
import { handleResolvePlacement } from './placements-resolve.js'
import { handleListPresentationRuntimes } from './presentation-read-model.js'
import { handleRestartSelf } from './self-restart.js'
import { exactRouteKey } from './server-routing.js'
import type { ExactRouteHandler } from './server-types.js'
import { legacyLaunchIngestRetired } from './session-title-helpers.js'
import {
  handleTranscriptIndexRebuild,
  handleTranscriptIndexStatus,
  handleTranscriptSearch,
} from './transcript-index-handlers.js'

export function buildExactRouteHandlers(
  server: HrcServerInstance
): Record<string, ExactRouteHandler> {
  return {
    [exactRouteKey('GET', '/v1/admin/registrations/gc')]: () =>
      server.handleListRegistrationGcCandidates(),
    [exactRouteKey('POST', '/v1/admin/registrations/gc')]: (request) =>
      server.handleRetireRegistrationScopes(request),
    [exactRouteKey('POST', '/v1/registrations')]: (request) =>
      server.handleCreateExternalRegistration(request),
    [exactRouteKey('POST', '/v1/participants/attach')]: (request) =>
      server.handleAttachParticipant(request),
    [exactRouteKey('POST', '/v1/participants/register')]: (request) =>
      server.handleRegisterParticipant(request),
    [exactRouteKey('POST', '/v1/sessions/resolve')]: (request) =>
      server.handleResolveSession(request),
    [exactRouteKey('GET', '/v1/sessions')]: (_request, url) => server.handleListSessions(url),
    [exactRouteKey('GET', '/v1/sessions/page')]: (_request, url) => server.handleSessionPage(url),
    [exactRouteKey('GET', '/v1/sessions/facets')]: (_request, url) =>
      server.handleSessionFacets(url),
    [exactRouteKey('POST', '/v1/sessions/apply')]: (request) =>
      server.handleApplyAppSessions(request),
    [exactRouteKey('GET', '/v1/sessions/app')]: (_request, url) =>
      server.handleListAppSessions(url),
    [exactRouteKey('GET', '/v1/events')]: (request, url) => server.handleEvents(url, request),
    [exactRouteKey('GET', '/v1/events/tail')]: (_request, url) => server.handleEventsTail(url),
    [exactRouteKey('GET', '/v1/events/bounded-stream')]: (request, url) =>
      server.handleBoundedEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-events')]: (request, url) =>
      server.handleBrokerEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-events/query')]: (_request, url) =>
      server.handleBrokerEventsQuery(_request, url),
    [exactRouteKey('GET', '/v1/broker-events/follow')]: (request, url) =>
      server.handleBrokerEventsFollow(request, url),
    [exactRouteKey('POST', '/v1/server/subscribers')]: (request) =>
      server.handleDeclareSubscriber(request),
    [exactRouteKey('GET', '/v1/events/head')]: () => server.handleEventsHead(),
    [exactRouteKey('GET', '/v1/broker-forensics')]: (_request, url) =>
      server.handleBrokerForensics(url),
    [exactRouteKey('POST', '/v1/transcript-search')]: (request) =>
      handleTranscriptSearch(server, request),
    [exactRouteKey('GET', '/v1/transcript-index/status')]: () =>
      handleTranscriptIndexStatus(server),
    [exactRouteKey('POST', '/v1/transcript-index/rebuild')]: () =>
      handleTranscriptIndexRebuild(server),
    [exactRouteKey('GET', '/v1/events/latest-by-session')]: (_request, url) =>
      server.handleEventsLatestBySession(url),
    [exactRouteKey('GET', '/v1/server/subscribers')]: () =>
      Response.json(server.subscriberAdmissions.snapshot()),
    [exactRouteKey('POST', '/v1/server/subscribers/ack')]: (request) =>
      server.handleSubscriberReceiptAck(request),
    [exactRouteKey('GET', '/v1/server/turn-admission')]: () =>
      Response.json(server.turnAdmissionGate.snapshot()),
    [exactRouteKey('POST', '/v1/server/lifecycle')]: (request) =>
      server.lifecycleController.handleLocalRequest(request),
    [exactRouteKey('POST', '/v1/server/turn-admission/close')]: (request) =>
      server.handleCloseTurnAdmission(request),
    [exactRouteKey('POST', '/v1/server/turn-admission/reopen')]: (request) =>
      server.handleReopenTurnAdmission(request),
    [exactRouteKey('POST', '/v1/runtimes/ensure')]: (request) =>
      server.handleEnsureRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/start')]: (request) => server.handleStartRuntime(request),
    [exactRouteKey('POST', HRC_RESTART_SELF_PATH)]: (request) => handleRestartSelf(server, request),
    [exactRouteKey('POST', '/v1/command-runs/launch')]: (request) =>
      server.handleLaunchCommandScopedRun(request),
    [exactRouteKey('POST', '/v1/broker-sessions/open')]: (request) =>
      server.handleOpenBrokerSession(request),
    [exactRouteKey('POST', '/v1/runtimes/attach')]: async (request) => {
      // T-08566: operator attach is a live path into the runtime. Wait out an
      // in-flight retained recovery, then refuse if its projection committed.
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as { runtimeId?: unknown } | undefined
      if (typeof body?.runtimeId === 'string') {
        await awaitRetainedRecoveryOwner(server.brokerReattachOperations, body.runtimeId)
        assertNoRetainedProjection(server.db, body.runtimeId, 'operator')
      }
      return server.handleAttachRuntime(request)
    },
    [exactRouteKey('POST', '/v1/runtimes/inspect')]: (request) =>
      server.handleInspectRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/broker/inspect')]: (request) =>
      server.handleBrokerInspect(request),
    [exactRouteKey('POST', '/v1/runtimes/capture/status')]: (request) =>
      server.handleBrokerCaptureStatus(request),
    [exactRouteKey('POST', '/v1/runtimes/capture/release')]: (request) =>
      server.handleBrokerCaptureRelease(request),
    [exactRouteKey('POST', '/v1/capture/recover')]: (request) =>
      server.handleCaptureRecover(request),
    [exactRouteKey('POST', '/v1/runtimes/sweep')]: (request) => server.handleSweepRuntimes(request),
    [exactRouteKey('POST', '/v1/runtimes/prune')]: (request) => server.handlePruneRuntimes(request),
    [exactRouteKey('POST', '/v1/server/tmux/kill-broker-leases')]: () =>
      server.handleKillBrokerTmuxLeases(),
    [exactRouteKey('POST', '/v1/runs/sweep-zombies')]: (request) =>
      server.handleSweepZombieRuns(request),
    [exactRouteKey('POST', '/v1/runs/reconcile-active')]: (request) =>
      server.handleReconcileActiveRuns(request),
    [exactRouteKey('POST', '/v1/runs/recover-unstarted')]: (request) =>
      server.handleRecoverUnstartedRun(request),
    [exactRouteKey('POST', '/v1/runs/prepare-attached')]: (request) =>
      server.handlePrepareAttachedRun(request),
    [exactRouteKey('POST', '/v1/runs/resume-attached')]: (request) =>
      server.handleResumeAttachedRun(request),
    [exactRouteKey('POST', '/v1/turns')]: (request) => server.handleDispatchTurn(request),
    [exactRouteKey('POST', '/v1/submissions/steer')]: (request) =>
      server.handleSubmission(request, 'steer'),
    [exactRouteKey('POST', '/v1/submissions/enqueue')]: (request) =>
      server.handleSubmission(request, 'enqueue'),
    [exactRouteKey('POST', '/v1/submissions/invoke')]: (request) =>
      server.handleSubmission(request, 'invoke'),
    [exactRouteKey('POST', '/v1/submissions/preempt')]: (request) =>
      server.handleSubmission(request, 'preempt'),
    [exactRouteKey('POST', '/v1/submissions/preempt/admission')]: (request) =>
      server.handlePreemptAdmission(request),
    [exactRouteKey('POST', '/v1/submissions/withdraw')]: (request) =>
      server.handleWithdrawSubmission(request),
    [exactRouteKey('POST', '/v1/active-run-contributions')]: (request) =>
      server.handleActiveRunContribution(request),
    [exactRouteKey('POST', '/v1/in-flight-input')]: (request) =>
      server.handleInFlightInput(request),
    [exactRouteKey('GET', '/v1/capture')]: (_request, url) => server.handleCapture(url),
    [exactRouteKey('GET', '/v1/attach')]: (_request, url) => server.handleAttach(url),
    [exactRouteKey('POST', '/v1/surfaces/bind')]: (request) => server.handleBindSurface(request),
    [exactRouteKey('POST', '/v1/surfaces/unbind')]: (request) =>
      server.handleUnbindSurface(request),
    [exactRouteKey('GET', '/v1/surfaces')]: (_request, url) => server.handleListSurfaces(url),
    [exactRouteKey('POST', '/v1/bridges/local-target')]: (request) =>
      server.handleRegisterBridgeTarget(request),
    [exactRouteKey('POST', '/v1/bridges/target')]: (request) =>
      server.handleRegisterBridgeTarget(request),
    [exactRouteKey('POST', '/v1/bridges/deliver')]: (request) =>
      server.handleDeliverBridge(request),
    [exactRouteKey('POST', '/v1/bridges/deliver-text')]: (request) =>
      server.handleDeliverBridgeText(request),
    [exactRouteKey('POST', '/v1/bridges/close')]: (request) => server.handleCloseBridge(request),
    [exactRouteKey('GET', '/v1/bridges')]: (_request, url) => server.handleListBridges(url),
    [exactRouteKey('POST', '/v1/interrupt')]: (request) => server.handleInterrupt(request),
    [exactRouteKey('POST', '/v1/terminate')]: (request) => server.handleTerminate(request),
    [exactRouteKey('POST', '/v1/clear-context')]: (request) => server.handleClearContext(request),
    [exactRouteKey('POST', '/v1/sessions/clear-context')]: (request) =>
      server.handleClearContext(request),
    [exactRouteKey('POST', '/v1/sessions/drop-continuation')]: (request) =>
      server.handleDropContinuation(request),
    [exactRouteKey('POST', '/v1/sessions/create-successor')]: (request) =>
      server.handleCreateSessionSuccessor(request),
    [exactRouteKey('POST', '/v1/sessions/resume-continuation')]: (request) =>
      server.handleResumeContinuation(request),
    [exactRouteKey('POST', '/v1/sessions/archive-abandoned')]: (request) =>
      server.handleArchiveAbandonedSessions(request),
    // T-08566 stage 1: the launch-wrapper hook ingest is retired (no producer).
    [exactRouteKey('POST', '/v1/internal/hooks/ingest')]: (request) =>
      legacyLaunchIngestRetired(new URL(request.url).pathname),
    [exactRouteKey('GET', '/v1/runtime-diagnostics')]: (_request, url) =>
      handleFirstTurnDiagnostics(server.db, url),
    [exactRouteKey('GET', '/v1/presentation/runtimes')]: () =>
      handleListPresentationRuntimes(server.db),
    [exactRouteKey('GET', '/v1/health')]: () => server.handleHealth(),
    [exactRouteKey('GET', '/v1/status')]: (_request, url) => server.handleStatus(url),
    [exactRouteKey('GET', '/v1/federation/locate')]: (_request, url) =>
      server.handleFederationLocate(url),
    [exactRouteKey('GET', '/v1/federation/peers')]: () => server.handleFederationPeerHealth(),
    [exactRouteKey('GET', '/v1/federation/runtimes')]: (_request, url) =>
      server.handleFederationRuntimeProjection(url),
    [exactRouteKey('POST', '/v1/federation/retire')]: (request) =>
      server.handleFederationRetirement(request),
    [exactRouteKey('GET', '/v1/federation/bindings')]: () => server.handleFederationBindings(),
    [exactRouteKey('GET', '/v1/federation/designations')]: (_request, url) =>
      server.handleListUnbornDesignations(_request, url),
    [exactRouteKey('GET', '/v1/placement/bindings')]: (_request, url) =>
      server.handleListPlacementBindings(_request, url),
    [exactRouteKey('GET', '/v1/runtimes/live-refs')]: () => server.handleListLiveSeatRefs(),
    [exactRouteKey('GET', '/v1/targets')]: (_request, url) => server.handleListTargets(url),
    [exactRouteKey('GET', '/v1/targets/by-session-ref')]: (_request, url) =>
      server.handleGetTarget(url),
    [exactRouteKey('POST', '/v1/messages/query')]: (request) => server.handleQueryMessages(request),
    [exactRouteKey('POST', '/v1/messages/trace')]: (request) => server.handleTraceMessage(request),
    [exactRouteKey('POST', '/v1/messages/dm')]: (request) => server.handleSemanticDm(request),
    [exactRouteKey('POST', '/v1/messages/turn-handoff')]: (request) =>
      server.handleSemanticTurnHandoff(request),
    [exactRouteKey('POST', '/v1/targets/ensure')]: (request) => server.handleEnsureTarget(request),
    [exactRouteKey('POST', '/v1/messages')]: (request) => server.handleCreateMessage(request),
    [exactRouteKey('POST', '/v1/capture/by-selector')]: (request) =>
      server.handleCaptureBySelector(request),
    [exactRouteKey('POST', '/v1/literal-input/by-selector')]: (request) =>
      server.handleLiteralInputBySelector(request),
    [exactRouteKey('POST', '/v1/turns/by-selector')]: (request) =>
      server.handleDispatchTurnBySelector(request),
    [exactRouteKey('POST', '/v1/messages/wait')]: (request) => server.handleWaitMessage(request),
    [exactRouteKey('POST', '/v1/messages/watch')]: (request) => server.handleWatchMessages(request),
    // T-07612 §8 stop gate (wave 3). The `mail` spelling is historical: the
    // predicate is a wrkq query and the hook scripts on four nodes call server
    // path by name, so renaming it is a separate coordinated change.
    [exactRouteKey('POST', '/v1/internal/mail/stop-decision')]: (request) =>
      server.handleMailStopDecision(request),
    [exactRouteKey('POST', '/v1/internal/mail/hint-decision')]: (request) =>
      server.handleMailHintDecision(request),
    [exactRouteKey('POST', '/v1/declarations/resolve')]: (request) =>
      handleResolveRuntimeIntent(request),
    [exactRouteKey('POST', '/v1/placements/resolve')]: (request) => handleResolvePlacement(request),
    [exactRouteKey('POST', '/v1/previews/run')]: (request) =>
      handleRunPreview.call(server, request),
    [exactRouteKey('POST', '/v1/app-sessions/ensure')]: (request) =>
      server.handleEnsureAppSession(request),
    [exactRouteKey('GET', '/v1/app-sessions')]: (_request, url) =>
      server.handleListManagedAppSessions(url),
    [exactRouteKey('GET', '/v1/app-sessions/by-key')]: (_request, url) =>
      server.handleGetManagedAppSessionByKey(url),
    [exactRouteKey('POST', '/v1/app-sessions/remove')]: (request) =>
      server.handleRemoveAppSession(request),
    [exactRouteKey('POST', '/v1/app-sessions/apply')]: (request) =>
      server.handleApplyManagedAppSessions(request),
    [exactRouteKey('POST', '/v1/app-sessions/turns')]: (request) =>
      server.handleAppSessionDispatchTurn(request),
    [exactRouteKey('POST', '/v1/app-sessions/in-flight-input')]: (request) =>
      server.handleAppSessionInFlightInput(request),
    [exactRouteKey('POST', '/v1/app-sessions/clear-context')]: (request) =>
      server.handleAppSessionClearContext(request),
    [exactRouteKey('POST', '/v1/app-sessions/literal-input')]: (request) =>
      server.handleAppSessionLiteralInput(request),
    [exactRouteKey('GET', '/v1/app-sessions/capture')]: (_request, url) =>
      server.handleAppSessionCapture(url),
    [exactRouteKey('GET', '/v1/app-sessions/attach')]: (_request, url) =>
      server.handleAppSessionAttach(url),
    [exactRouteKey('POST', '/v1/app-sessions/interrupt')]: (request) =>
      server.handleAppSessionInterrupt(request),
    [exactRouteKey('POST', '/v1/app-sessions/terminate')]: (request) =>
      server.handleAppSessionTerminate(request),
  }
}
