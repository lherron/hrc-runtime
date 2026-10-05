import { setTimeout as delay } from 'node:timers/promises'
import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import {
  assertActuatorSplitRuntimeReuse,
  prepareActuatorSplitIntent,
} from '../../actuator-split.js'
import {
  aspdInteractiveBrokerEndpoint,
  aspdInteractiveRouteFor,
  assertPreparedAspdAttemptRoute,
  findPreparedAspdAttemptForRetry,
  launchAspdPreparedAttempt,
  prepareAspdHeadlessAttempt,
  readAspdPreparation,
} from '../../aspd-headless-start.js'
import {
  decideBrokerDurableInteractiveRoute,
  decideInteractiveTmuxBrokerContinuation,
  toRuntimeContinuationRef,
} from '../../broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from '../../broker-decisions.js'
import type { DispatchTurnResponseBase } from '../../broker-interactive-shared.js'
import { appendHrcEvent } from '../../hrc-event-helper.js'
import { waitForLaunchCarriedSubmissionIdentity } from '../../launch-carried-submission.js'
import { resolveBrokerDurableIpcEnabled } from '../../option-resolvers.js'
import { assertParticipantAddressNotSubstituted } from '../../participant-delivery.js'
import {
  type RedirectOffBirthJoin,
  assertBirthJoinAdmitted,
  assertBirthJoinRoute,
  recordStartBirth,
  startBirthOfIntent,
} from '../../presentation-operator.js'
import { isRunActive } from '../../require-helpers.js'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context.js'
import { writeServerLog } from '../../server-log.js'
import {
  type AttachBeforeInvocationStartOption,
  type DispatchRunPersistenceOptions,
  type InvokeFirstTurnRendezvous,
  dispatchRunPersistence,
  submissionDoorCarriesColdLaunch,
} from '../../server-types.js'
import { aspdUnconfiguredError, json, timestamp } from '../../server-util.js'
import { automaticContinuationForSession } from '../../session-continuation-reuse.js'
import type { AdmittedPlan } from '../types.js'

function cleanupInvokeFirstTurnRendezvous(
  server: HrcServerInstanceForHandlers,
  hostSessionId: string,
  rendezvous: InvokeFirstTurnRendezvous
): void {
  if (
    rendezvous.settled &&
    rendezvous.crossingRunIds.size === 0 &&
    server.invokeFirstTurnRendezvous.get(hostSessionId) === rendezvous
  ) {
    server.invokeFirstTurnRendezvous.delete(hostSessionId)
  }
}

export async function handleInteractiveTmuxBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  plan: AdmittedPlan,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  flagOptions: DispatchRunPersistenceOptions & {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    waitForCompletion?: boolean | undefined
    joinInFlightRuntimeStart?: boolean | undefined
    /** T-08555: a redirect-off crossing re-checks every in-flight start it joins. */
    redirectOffBirthJoin?: RedirectOffBirthJoin | undefined
    coldBirthPromptMode?: 'replace-priming' | 'append-to-priming' | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const session = plan.session
  const { initialPrompt: _initialPrompt, ...turnIntent } = intent
  let promptRodeLaunch = false
  // T-07202: persisted semantic DMs can enter this interactive cold-start
  // branch concurrently. T-06313 protected only the headless broker branch;
  // this branch published its boot but never joined an existing one, so each
  // crossing DM started and then overwrote the same map entry. Join the
  // already-published host-session boot and deliver this caller's own input
  // through the winner. Keep this route opt-in so reattach and non-DM dispatch
  // policy remain outside this cold-provision fix.
  const existingInvokeRendezvous =
    flagOptions.joinInFlightRuntimeStart && flagOptions.submissionDoor === 'invoke'
      ? this.invokeFirstTurnRendezvous.get(session.hostSessionId)
      : undefined
  const existingBootOperation = flagOptions.joinInFlightRuntimeStart
    ? (existingInvokeRendezvous?.operation ??
      this.runtimeStartOperations?.get(session.hostSessionId))
    : undefined
  if (existingBootOperation) {
    existingInvokeRendezvous?.crossingRunIds.add(runId)
    try {
      if (flagOptions.redirectOffBirthJoin !== undefined) {
        await assertBirthJoinRoute(
          turnIntent,
          existingBootOperation,
          flagOptions.redirectOffBirthJoin
        )
      }
      const runtime = await existingBootOperation
      assertActuatorSplitRuntimeReuse(turnIntent, runtime)
      if (flagOptions.redirectOffBirthJoin !== undefined) {
        assertBirthJoinAdmitted(turnIntent, runtime, flagOptions.redirectOffBirthJoin)
      }
      return await this.executeInteractiveBrokerInputTurn(plan, runtime, prompt, runId, {
        waitForCompletion: flagOptions.waitForCompletion,
        responseFormat: flagOptions.responseFormat,
        ...dispatchRunPersistence(flagOptions),
      })
    } finally {
      if (existingInvokeRendezvous !== undefined) {
        existingInvokeRendezvous.crossingRunIds.delete(runId)
        cleanupInvokeFirstTurnRendezvous(this, session.hostSessionId, existingInvokeRendezvous)
      }
    }
  }
  let resolveAccepted!: (runtime: HrcRuntimeSnapshot) => void
  let rejectAccepted!: (error: unknown) => void
  let acceptedSettled = false
  const accepted = new Promise<HrcRuntimeSnapshot>((resolve, reject) => {
    resolveAccepted = (runtime) => {
      acceptedSettled = true
      resolve(runtime)
    }
    rejectAccepted = (error) => {
      acceptedSettled = true
      reject(error)
    }
  })
  // A blocking caller awaits bootOperation directly, so the early-acceptance
  // promise has no consumer on that route. Observe its legitimate startup
  // rejection here; detached callers still await the original promise below.
  void accepted.catch(() => undefined)
  const bootOperation = this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
    flagEnvName: flagOptions.flagEnvName,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    ...(flagOptions.attachBeforeInvocationStart
      ? { attachBeforeInvocationStart: flagOptions.attachBeforeInvocationStart }
      : {}),
    responseFormat: flagOptions.responseFormat,
    ...(flagOptions.coldBirthPromptMode !== undefined
      ? {
          coldBirthPrompt: prompt,
          includePrimingForColdBirthPrompt: flagOptions.coldBirthPromptMode === 'append-to-priming',
          onColdBirthPromptRoute: (rodeLaunch: boolean) => {
            promptRodeLaunch = rodeLaunch
          },
        }
      : {}),
    ...dispatchRunPersistence(flagOptions),
    onAccepted: (runtime) => {
      if (this.db.hrcEvents.listByRun(runId, { eventKind: 'turn.accepted' }).length === 0) {
        const acceptedAt = timestamp()
        this.notifyEvent(
          appendHrcEvent(this.db, 'turn.accepted', {
            ts: acceptedAt,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: session.generation,
            runId,
            runtimeId: runtime.runtimeId,
            transport: 'tmux',
            payload: {
              promptLength: prompt.length,
              authority: 'durable-start-graph',
            },
          })
        )
      }
      resolveAccepted(runtime)
    },
  }).then((runtime) => {
    // Broker dispatch through non-attached surfaces (hrcchat, agent-loop)
    // starts a tmux TUI with no operator terminal watching it. Presentation
    // stays best-effort and outside the acceptance boundary.
    //
    // T-08456: this publish is DRIVER-BLIND on purpose. It was once fenced to
    // `claude-code-tmux` (T-08012) only because that was then the sole driver
    // reaching this dispatch door; T-08338 routed Codex here too and inherited
    // the fence, so a dispatched codex-tui seat published nothing at birth. Its
    // first presentation then came from whichever later door happened to touch
    // it — in practice the broker-reuse publish that precedes a SECOND turn.
    // That is the whole observed defect: seats that got a second input appeared
    // 0.8-247s late (however long that input took to arrive), and seats that
    // only ever got one turn never appeared at all, however long they lived.
    // Both behaviours are this one missing publish, not two causes.
    //
    // Nothing here needs to know the driver: publishPresentation derives
    // `operatorAttachable` from the runtime's hosting state, so a driver with
    // no attachable TUI publishes `false` and the viewer skips it. Gating by
    // driver name can only reintroduce the same bug for the next driver routed
    // through this door.
    void this.publishPresentation(runtime, {
      operatorAttachPending: flagOptions.attachBeforeInvocationStart !== undefined,
      signal: this.runtimeStartPresentationSignal,
    })
    if (!acceptedSettled) resolveAccepted(runtime)
    return runtime
  })
  // The ordinary birth singleflight is shared by every admission door and must
  // end at bare boot. In particular, enqueue/mail deliberately reaches the
  // newborn broker while the launch-carried turn is live so its existing
  // steer/merge semantics remain intact.
  const publishedBootOperation = bootOperation.finally(() => {
    if (this.runtimeStartOperations?.get(session.hostSessionId) === publishedBootOperation) {
      this.runtimeStartOperations.delete(session.hostSessionId)
    }
  })
  recordStartBirth(publishedBootOperation, startBirthOfIntent('tmux', turnIntent))
  this.runtimeStartOperations?.set(session.hostSessionId, publishedBootOperation)
  void publishedBootOperation.catch(() => undefined)

  // T-08012: request-response invokes need a stronger, door-local projection.
  // The runtime is born before its argv-carried first turn owns a terminal
  // bracket, so a crossing invoke must not submit until that bracket closes.
  // Keep this promise out of runtimeStartOperations: sharing it there also
  // fenced enqueue/mail, contrary to their intentional live-turn steering.
  if (flagOptions.submissionDoor === 'invoke') {
    const invokeOperation = bootOperation.then(async (runtime) => {
      if (promptRodeLaunch) {
        await waitForLaunchCarriedFirstTurnTerminal(this, runId)
      }
      return this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    })
    const rendezvous: InvokeFirstTurnRendezvous = {
      ownerRunId: runId,
      operation: invokeOperation,
      crossingRunIds: new Set(),
      settled: false,
    }
    // T-08555: the rendezvous stands in for this birth at crossing joins.
    recordStartBirth(invokeOperation, startBirthOfIntent('tmux', turnIntent))
    this.invokeFirstTurnRendezvous.set(session.hostSessionId, rendezvous)
    void invokeOperation
      .then((runtime) => {
        rendezvous.runtimeId = runtime.runtimeId
      })
      .catch(() => undefined)
      .finally(() => {
        rendezvous.settled = true
        cleanupInvokeFirstTurnRendezvous(this, session.hostSessionId, rendezvous)
      })
  }
  void bootOperation.catch((error) => {
    if (!acceptedSettled) rejectAccepted(error)
  })
  if (flagOptions.waitForCompletion === false) {
    void bootOperation
      .then(async (runtime) => {
        if (promptRodeLaunch) return
        await this.executeInteractiveBrokerInputTurn(plan, runtime, prompt, runId, {
          waitForCompletion: false,
          responseFormat: flagOptions.responseFormat,
          ...dispatchRunPersistence(flagOptions),
        })
      })
      .catch(() => undefined)
    const runtime = await accepted
    // A launch-carried broker input is part of the durable start graph written
    // before `onAccepted`. Preserve that admission identity in the early birth
    // receipt when the driver has one (codex-app-server initialInput). A driver
    // whose launch prompt rides argv learns its identity only when the broker
    // observes the launch turn; a submission door waits (bounded) for it rather
    // than answering without one, because the body is already written (T-09643).
    const acceptedSubmissionId = submissionDoorCarriesColdLaunch(flagOptions.submissionDoor)
      ? this.db.runs.getByRunId(runId)?.brokerSubmissionId
      : undefined
    const launchSubmissionId =
      acceptedSubmissionId === undefined &&
      promptRodeLaunch &&
      submissionDoorCarriesColdLaunch(flagOptions.submissionDoor)
        ? await waitForLaunchCarriedSubmissionIdentity(this, runId, runtime.runtimeId)
        : acceptedSubmissionId
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      ...(launchSubmissionId === undefined
        ? {}
        : { submissionId: launchSubmissionId, admission: 'admitted' as const }),
    } satisfies DispatchTurnResponseBase)
  }
  const runtime = await bootOperation
  if (promptRodeLaunch) {
    const submissionId = submissionDoorCarriesColdLaunch(flagOptions.submissionDoor)
      ? await waitForLaunchCarriedSubmissionIdentity(this, runId, runtime.runtimeId)
      : undefined
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      ...(submissionId === undefined ? {} : { submissionId, admission: 'admitted' as const }),
    } satisfies DispatchTurnResponseBase)
  }
  return await this.executeInteractiveBrokerInputTurn(plan, runtime, prompt, runId, {
    waitForCompletion: false,
    responseFormat: flagOptions.responseFormat,
    ...dispatchRunPersistence(flagOptions),
  })
}

async function waitForLaunchCarriedFirstTurnTerminal(
  server: HrcServerInstanceForHandlers,
  runId: string
): Promise<void> {
  while (true) {
    const run = server.db.runs.getByRunId(runId)
    // The real launch path persists the run before resolving boot. Keep this
    // tolerant for a controller/start failure that removed or never committed
    // the graph: there is then no owned first turn for the fence to protect.
    if (run === null || !isRunActive(run)) return
    await delay(25)
  }
}

export async function startInteractiveTmuxBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  turnIntent: HrcRuntimeIntent,
  diagnosticRunId: string,
  flagOptions: DispatchRunPersistenceOptions & {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
    coldBirthPrompt?: string | undefined
    includePrimingForColdBirthPrompt?: boolean | undefined
    onColdBirthPromptRoute?: ((rodeLaunch: boolean) => void) | undefined
  }
): Promise<HrcRuntimeSnapshot> {
  // R-4.3.2: never born a substitute runtime at a reserved participant
  // address. Delivery routes into the participant's own runtime before this
  // point; this is the backstop at the place a runtime is actually born.
  assertParticipantAddressNotSubstituted(this, session)
  const preparedActuatorSplit = await prepareActuatorSplitIntent(turnIntent)
  const effectiveTurnIntent = preparedActuatorSplit.intent
  // T-08556 (§1.4), T-08560 (§1.5.1), T-08562 (§1.6.2): every door's interactive
  // broker birth prepares through aspd on a configured node and launches from the
  // frozen execution release; only the deprecated codex-cli-tmux keeps the facade.
  // A cold-birth prompt is a preparation input (D1), not a route selector. No
  // facade client is opened on this route and there is no fallback.
  const aspdEndpoint = aspdInteractiveBrokerEndpoint({
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
  })
  if (aspdEndpoint !== undefined) {
    return await startAspdInteractiveBrokerRuntime(this, session, effectiveTurnIntent, {
      ...flagOptions,
      diagnosticRunId,
      endpoint: aspdEndpoint,
      preparedAuthority: preparedActuatorSplit.authority,
    })
  }
  // T-08596 (T-08569A closure): the bundled ASP execution closure is removed.
  // The facade/toolchain fallback below is deleted — including the deprecated
  // codex-cli-tmux keeper. An unconfigured node refuses loudly with a typed
  // refusal, never an ENOENT from a missing bin.
  throw aspdUnconfiguredError('interactive-broker-birth', {
    hostSessionId: session.hostSessionId,
    runId: diagnosticRunId,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
  })
}

/**
 * Project an interactive controller start failure onto the accepted run graph
 * (when the start graph exists) and throw the caller-facing error. Shared by the
 * facade-compiled and the aspd-prepared (T-08556) interactive routes.
 */
function settleFailedInteractiveBrokerStart(
  server: HrcServerInstanceForHandlers,
  input: {
    session: HrcSessionRecord
    runId: string
    runtimeId: string
    invocationId: string
    operationId: string
    error: { code: string; message: string; detail: Record<string, unknown> }
    responseFormat?: HrcTurnResponseFormat | undefined
    flagEnvName: string
  }
): never {
  const { session, runId: diagnosticRunId, runtimeId } = input
  const result = { error: input.error }
  const flagOptions = { responseFormat: input.responseFormat, flagEnvName: input.flagEnvName }
  const acceptedRun = server.db.runs.getByRunId(diagnosticRunId)
  if (acceptedRun !== null && isRunActive(acceptedRun)) {
    const failedAt = timestamp()
    server.db.runs.markCompleted(diagnosticRunId, {
      status: 'failed',
      completedAt: failedAt,
      updatedAt: failedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: result.error.message,
    })
    server.db.brokerInvocations.update(input.invocationId, {
      invocationState: 'failed',
      updatedAt: failedAt,
    })
    server.db.runtimeOperations.update(input.operationId, {
      status: 'failed',
      completedAt: failedAt,
      updatedAt: failedAt,
      errorCode: result.error.code,
      errorMessage: result.error.message,
    })
    server.db.runtimes.update(runtimeId, {
      status: 'failed',
      statusChangedAt: failedAt,
      activeRunId: diagnosticRunId,
      updatedAt: failedAt,
      runtimeStateJson: {
        ...(server.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson ?? {}),
        status: 'failed',
        updatedAt: failedAt,
        startFailure: {
          code: result.error.code,
          message: result.error.message,
        },
      },
    })
    server.notifyEvent(
      appendHrcEvent(server.db, 'turn.failed', {
        ts: failedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId: diagnosticRunId,
        runtimeId,
        transport: 'tmux',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        payload: {
          code: result.error.code,
          message: result.error.message,
          phase: 'broker-invocation-start',
        },
      })
    )
  }
  if (
    result.error.code === 'unsupported_capability' &&
    flagOptions.responseFormat?.kind === 'json_schema'
  ) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.UNSUPPORTED_CAPABILITY,
      result.error.message,
      result.error.detail
    )
  }
  const externalToolchainFailure = typeof result.error.detail['toolchainSource'] === 'string'
  throw new HrcRuntimeUnavailableError(
    externalToolchainFailure ? result.error.message : 'interactive broker start failed',
    {
      hostSessionId: session.hostSessionId,
      runId: diagnosticRunId,
      code: result.error.code,
      message: result.error.message,
      route: 'interactive-broker',
      flag: flagOptions.flagEnvName,
      ...result.error.detail,
    }
  )
}

/**
 * T-08556 (§1.4), T-08560 (§1.5), T-08562 (§1.6) — an aspd-prepared interactive
 * broker birth (Codex TUI, Claude Code or Pi TUI) by any door. Prepare and freeze
 * at boundary P (or resume a same-key frozen attempt, D2), then launch only from
 * the persisted operation, with the
 * attached-run door's live attach handshake when it has one. The durable
 * interactive route is required: the stdio route would spawn a
 * resolver-selected broker.
 */
async function startAspdInteractiveBrokerRuntime(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  options: DispatchRunPersistenceOptions & {
    diagnosticRunId: string
    endpoint: string
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
    coldBirthPrompt?: string | undefined
    includePrimingForColdBirthPrompt?: boolean | undefined
    onColdBirthPromptRoute?: ((rodeLaunch: boolean) => void) | undefined
    preparedAuthority: Awaited<ReturnType<typeof prepareActuatorSplitIntent>>['authority']
  }
): Promise<HrcRuntimeSnapshot> {
  const durableInteractiveRoute = decideBrokerDurableInteractiveRoute({
    durableIpcEnabled: resolveBrokerDurableIpcEnabled(server.options),
    endpointKind: 'unix-jsonrpc-ndjson',
    interactionMode: 'interactive',
  })
  if (durableInteractiveRoute !== 'durable-ipc') {
    throw new HrcRuntimeUnavailableError(
      'the aspd-prepared interactive route requires durable broker IPC',
      {
        code: 'aspd_route_requires_durable_ipc',
        route: 'aspd',
        hostSessionId: session.hostSessionId,
        runId: options.diagnosticRunId,
      }
    )
  }
  // T-08560 D2: a same-host-session, same-key retry whose frozen run identity
  // this dispatch reused launches that never-submitted preparation, and only a
  // preparation frozen on this route.
  const resumable =
    options.dispatchIdempotencyKey !== undefined
      ? findPreparedAspdAttemptForRetry(
          server,
          session.hostSessionId,
          options.dispatchIdempotencyKey
        )
      : undefined
  let operationId: string
  if (resumable !== undefined && resumable.runId === options.diagnosticRunId) {
    assertPreparedAspdAttemptRoute(
      resumable,
      {
        route: aspdInteractiveRouteFor(options.allowedBrokerDriver),
        driverKind: options.allowedBrokerDriver,
      },
      session.hostSessionId
    )
    operationId = resumable.operationId
    writeServerLog('INFO', 'aspd.preparation.resume', {
      operationId,
      runId: options.diagnosticRunId,
      hostSessionId: session.hostSessionId,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
    })
  } else {
    operationId = await prepareAspdHeadlessAttempt(server, {
      session,
      intent,
      interactive: {
        flagEnvName: options.flagEnvName,
        brokerDriver: options.allowedBrokerDriver,
        continuation: toRuntimeContinuationRef(
          decideInteractiveTmuxBrokerContinuation({
            allowedBrokerDriver: options.allowedBrokerDriver,
            sessionContinuation: automaticContinuationForSession(server.db, session),
          })
        ),
        door:
          options.attachBeforeInvocationStart !== undefined ? 'attached-run' : 'interactive-birth',
        ...(options.coldBirthPrompt !== undefined
          ? {
              launchCarriedPrompt: {
                prompt: options.coldBirthPrompt,
                mode: options.includePrimingForColdBirthPrompt
                  ? ('append-to-priming' as const)
                  : ('replace-priming' as const),
              },
            }
          : {}),
      },
      preparedAuthority: options.preparedAuthority,
      runId: options.diagnosticRunId,
      // Rev11 seals all existing interactive births to the legacy admission
      // format until a separately advanced caller contract selects format 2.
      executionFormat: 'format1',
      endpoint: options.endpoint,
      responseFormat: options.responseFormat,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      observation: options.attachBeforeInvocationStart?.observation,
    })
  }
  // T-08560 D1: the launch-carried report comes only from the committed frozen
  // record (after boundary P, or from the resumed attempt), never from the
  // caller's mode. A refusal before P reaches no report, so the dispatch door
  // delivers nothing.
  if (options.onColdBirthPromptRoute !== undefined) {
    const { record } = readAspdPreparation(server, operationId)
    options.onColdBirthPromptRoute(
      record.dispatch.routeDecision['launchCarriedPrompt'] !== undefined &&
        record.admission.execution.hosting.terminalRequired
    )
  }
  const { runtime, intent: launchedIntent } = await launchAspdPreparedAttempt(server, operationId, {
    ...dispatchRunPersistence(options),
    ...(options.attachBeforeInvocationStart !== undefined
      ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
      : {}),
    ...(options.onAccepted ? { onAccepted: options.onAccepted } : {}),
    settleFailure: (error) => {
      const { record } = readAspdPreparation(server, operationId)
      if (record.runId === undefined) {
        throw new Error('interactive format-1 preparation is missing its admission run identity')
      }
      return settleFailedInteractiveBrokerStart(server, {
        session,
        runId: record.runId,
        runtimeId: record.runtimeId,
        invocationId: String(record.admission.identity.invocationId),
        operationId,
        error,
        responseFormat: options.responseFormat,
        flagEnvName: options.flagEnvName,
      })
    },
  })
  // Same authority rule as the facade route: commit the applied intent only
  // after the controller launched exactly this frozen intent.
  server.db.sessions.updateIntent(session.hostSessionId, launchedIntent, timestamp())
  return runtime
}
