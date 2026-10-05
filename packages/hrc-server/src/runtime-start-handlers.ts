import { randomUUID } from 'node:crypto'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord, RestartStyle } from 'hrc-core'
import {
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
} from './actuator-split.js'
import { hasInitialUserTurn } from './agent-spaces-adapter/compile-adapter.js'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveTmuxBrokerStartRoute,
  isMatchingInteractiveTmuxBrokerRuntime,
  isProducerSelectedOrdinaryBirth,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeCodexInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldRedirectClaudeToInteractiveBroker,
  shouldRedirectCodexToInteractiveBroker,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  assertAttachedRunReusesHeadless,
  assertNoOperatorPresentationConflict,
  assertOperatorPresentationRoutable,
  createStartBirthDecision,
  decideCrossingBirthRoute,
  decideRedirectOffCodexRoute,
  findEstablishedBrokerRuntime,
  isOmittedChoiceCodexRequest,
  recordStartBirth,
  requestsOperatorPresentation,
  scopeHasLiveHeadlessBrokerRuntime,
  startBirthOf,
  startBirthOfIntent,
} from './presentation-operator.js'
import { isBrokerRuntimeTransitional, requireRuntime } from './require-helpers.js'
import {
  assertV2SelectionCompatibleForReuse,
  findLatestSessionRuntime,
  getReusableHeadlessRuntimeForSession,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import type { AttachBeforeInvocationStartOption } from './server-types.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'
import { automaticContinuationForSession } from './session-continuation-reuse.js'
import type { AdmittedPlan } from './turn-admission/types.js'
import { enrichDispatchTurnResponse } from './turn-dispatch-attached-run-handlers.js'

/** The existing START observer is selected at the physical route's receipt. */
export type InitialPromptDeliveryReceipt = {
  response?: Response | undefined
  completionKind?: 'interactive' | 'headless' | undefined
}

function captureInitialPromptReceipt(
  receipt: InitialPromptDeliveryReceipt | undefined,
  completionKind: 'interactive' | 'headless',
  response?: Response
): void {
  if (receipt !== undefined) Object.assign(receipt, { response, completionKind })
}

export async function startRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  restartStyle: RestartStyle,
  options: {
    /** D10 has already admitted its initial input; completion is observed after its lease. */
    initialPromptPlan?: AdmittedPlan | undefined
    initialPromptReceipt?: InitialPromptDeliveryReceipt | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
    operatorAttachPending?: boolean | undefined
    /** This start is the attached-run door's operation. */
    attachedRunDoor?: boolean | undefined
    /** §1.4 "Joining a registered start": the newborn a joined start produced. */
    attachedRunJoinedRuntimeId?: string | undefined
    /** The settled start this door already joined; it can no longer change rows. */
    attachedRunJoinedOperation?: Promise<HrcRuntimeSnapshot> | undefined
    /** §1.4 "Initial input": delivered by identity before the operation deregisters. */
    attachedRunPrompt?: AttachedRunPrompt | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  assertLocalPersonaAllowed(this, session.scopeRef)
  // An attached run is a generic door.  It cannot inspect the request to
  // predict a driver or a surface: ASP admits the execution first, and the
  // controller exposes the attach gate only when that execution allocated a
  // leased presentation surface.
  const attachedRunDoor = options.attachedRunDoor === true
  // Generic participant scopes are likewise permanent externally-owned
  // addresses. Establishment enters through the participant broker path, so an
  // ordinary cold-start here would create a competing HRC-owned writer.
  const participantRegistration = this.db.participantRegistrations.getRegistrationByScopeRef(
    session.scopeRef
  )
  if (participantRegistration !== null) {
    throw new HrcRuntimeUnavailableError('participant scope cannot be cold-born', {
      scopeRef: session.scopeRef,
      registrationId: participantRegistration.registrationId,
      reason: 'participant_address_reserved',
    })
  }
  const existingOperation = this.runtimeStartOperations.get(session.hostSessionId)
  if (
    existingOperation &&
    attachedRunDoor &&
    existingOperation !== options.attachedRunJoinedOperation
  ) {
    // T-08556 (§1.4): never return another start's result as this door's. A
    // foreign recorded birth refuses before its boot is awaited; otherwise the
    // start settles and the door re-enters to select inside its OWN registered
    // operation, carrying the newborn (a newborn is never admission-replaced).
    const birth = await startBirthOf(existingOperation)
    if (birth !== undefined) decideCrossingBirthRoute(intent, birth)
    const joined = await existingOperation.catch(() => undefined)
    return await this.startRuntimeForSession(session, intent, restartStyle, {
      ...options,
      attachedRunJoinedRuntimeId: joined?.runtimeId ?? options.attachedRunJoinedRuntimeId,
      attachedRunJoinedOperation: existingOperation,
    })
  }
  if (existingOperation && !attachedRunDoor) {
    const runtime = await existingOperation
    assertActuatorSplitRuntimeReuse(intent, runtime)
    // T-08553: joining a boot is reuse; a conflicting live presentation refuses.
    assertNoOperatorPresentationConflict(intent, [runtime])
    return runtime
  }

  // T-08555: a crossing redirect-off dispatch reads this start's chosen birth
  // (settled below once decided, or undefined on an early exit).
  const startBirth = createStartBirthDecision()
  const operation = (async () => {
    let existingRuntime = findLatestSessionRuntime(this.db, session.hostSessionId)
    if (existingRuntime) {
      existingRuntime = await this.reconcileTmuxRuntimeLiveness(existingRuntime)
      if (
        existingRuntime.controllerKind === 'harness-broker' &&
        !isRuntimeUnavailableStatus(existingRuntime.status)
      ) {
        // The producer's frozen selection is the only reuse identity. In
        // particular, a request that omits selection does not force a local
        // default back onto an established runtime.
        assertV2SelectionCompatibleForReuse(existingRuntime, intent)
      }
    }
    // T-08556 (§1.4): the attached-run door's selection. The selected runtime
    // is marked operator-attach-pending and receives the door's prompt by
    // identity before this registered operation settles.
    const attachedRunSelected = async (
      runtime: HrcRuntimeSnapshot
    ): Promise<HrcRuntimeSnapshot> => {
      await this.publishPresentation(runtime, { operatorAttachPending: true })
      if (options.attachedRunPrompt !== undefined) {
        await deliverAttachedRunPrompt(this, runtime, options.attachedRunPrompt)
      }
      return runtime
    }
    if (attachedRunDoor) {
      const joined =
        options.attachedRunJoinedRuntimeId !== undefined
          ? this.db.runtimes.getByRuntimeId(options.attachedRunJoinedRuntimeId)
          : null
      const liveJoined =
        joined !== null &&
        joined.controllerKind === 'harness-broker' &&
        joined.status !== 'failed' &&
        !isRuntimeUnavailableStatus(joined.status)
          ? joined
          : undefined
      // Rules 1–2: a live joined newborn is never replaced.
      if (liveJoined !== undefined) {
        // The attached door consumes an execution that has already been
        // admitted and allocated.  Legacy provider/harness birth classifiers
        // cannot participate in this decision.
        assertAttachedRunReusesHeadless(liveJoined, {
          transitional: isBrokerRuntimeTransitional(this.db, liveJoined),
        })
        startBirth.decide(undefined)
        return await attachedRunSelected(liveJoined)
      }
      // Rule 5: an established headless runtime of any harness or state is never
      // stale-marked, replaced or started beside, short of --force-restart.
      if (restartStyle !== 'fresh_pty') {
        const established = findEstablishedBrokerRuntime(
          this.db.runtimes.listByHostSessionId(session.hostSessionId)
        )
        if (established !== undefined && established.transport !== 'tmux') {
          assertAttachedRunReusesHeadless(established, {
            transitional: isBrokerRuntimeTransitional(this.db, established),
          })
          startBirth.decide(undefined)
          return await attachedRunSelected(established)
        }
      }
    }
    // An ordinary v2 start never selects a provider, harness, profile or
    // driver locally. ASP compiles the raw request and HRC hosts its frozen
    // execution. Only an explicit operator surface keeps the older interactive
    // attach choreography below.
    if (isProducerSelectedOrdinaryBirth(intent)) {
      startBirth.decide(undefined)
      const presentationOptions = {
        operatorAttachPending:
          options.attachBeforeInvocationStart !== undefined ||
          options.operatorAttachPending === true,
      }
      if (
        existingRuntime?.controllerKind === 'harness-broker' &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        restartStyle !== 'fresh_pty'
      ) {
        assertActuatorSplitRuntimeReuse(intent, existingRuntime)
        assertNoOperatorPresentationConflict(intent, [existingRuntime])
        if (attachedRunDoor) return await attachedRunSelected(existingRuntime)
        await this.publishPresentation(existingRuntime, presentationOptions)
        const initialPrompt = intent.initialPrompt ?? ''
        if (initialPrompt.length > 0) {
          const runId = options.initialPromptPlan?.options.runId ?? `run-${randomUUID()}`
          const receipt = await executeBrokerInputTurn(
            this,
            session,
            existingRuntime,
            initialPrompt,
            runId,
            {
              ...options.initialPromptPlan?.options,
              waitForCompletion: options.initialPromptPlan === undefined,
            }
          )
          captureInitialPromptReceipt(
            options.initialPromptReceipt,
            existingRuntime.transport === 'tmux' ? 'interactive' : 'headless',
            receipt
          )
        }
        return requireRuntime(this.db, existingRuntime.runtimeId)
      }

      const startRunId = options.initialPromptPlan?.options.runId ?? `run-${randomUUID()}`
      if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
        this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
          reason: 'producer-selected-ordinary-start-reprovision',
          route: 'producer-selected-execution',
        })
      }
      const initialPrompt = intent.initialPrompt ?? ''
      const runtime = await this.startHeadlessBrokerRuntime(
        session,
        intent,
        initialPrompt,
        startRunId,
        {
          ...options.initialPromptPlan?.options,
          ...(hasInitialUserTurn(intent) ? {} : { allowCompilerInitialInputWithoutIdentity: true }),
          ...(options.attachBeforeInvocationStart !== undefined
            ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
            : {}),
        }
      )
      await this.publishPresentation(runtime, presentationOptions)
      if (attachedRunDoor) return await attachedRunSelected(runtime)
      if (initialPrompt.length > 0)
        captureInitialPromptReceipt(options.initialPromptReceipt, 'headless')
      if (initialPrompt.length > 0 && options.initialPromptPlan === undefined) {
        await this.waitForHeadlessBrokerRunCompletion(startRunId, runtime.runtimeId)
      }
      return requireRuntime(this.db, runtime.runtimeId)
    }
    const highRiskActuatorSplit =
      normalizeActuatorSplitPolicy(intent.execution?.actuatorSplit)?.mode === 'high-risk'
    const claudeRedirect =
      this.claudeCodeTmuxBrokerEnabled &&
      !highRiskActuatorSplit &&
      shouldRedirectClaudeToInteractiveBroker(intent)
    // T-08553: an explicit per-request no-viewer choice keeps the start headless,
    // and an omitted one is delivered into the scope's live headless runtime.
    // T-08555: with the redirect off, the scope's established broker runtime
    // selects the admission (§1.3 rules 3–5); nothing established runs headless
    // with the node presentation default.
    const codexRedirect = this.codexCliTmuxBrokerEnabled
      ? !highRiskActuatorSplit &&
        !requestsOperatorPresentation(intent) &&
        shouldRedirectCodexToInteractiveBroker(intent) &&
        !scopeHasLiveHeadlessBrokerRuntime(this.db, session.hostSessionId)
      : !claudeRedirect &&
        isOmittedChoiceCodexRequest(intent) &&
        decideRedirectOffCodexRoute(
          intent,
          this.db.runtimes.listByHostSessionId(session.hostSessionId)
        ) === 'interactive'
    const startIntent = claudeRedirect
      ? normalizeClaudeInteractiveBrokerIntent(intent)
      : codexRedirect
        ? normalizeCodexInteractiveBrokerIntent(intent)
        : intent
    startBirth.decide(
      startBirthOfIntent(shouldUseHeadlessTransport(startIntent) ? 'headless' : 'tmux', startIntent)
    )
    // T-08553: refuse an unhonorable or conflicting no-viewer choice before any
    // reuse, stale-marking or reprovision below.
    if (requestsOperatorPresentation(startIntent)) {
      assertOperatorPresentationRoutable(startIntent, {
        claudeRedirect,
        headlessTransport: shouldUseHeadlessTransport(startIntent),
        headlessRoute: shouldUseHeadlessTransport(startIntent)
          ? decideHeadlessExecutionRoute(startIntent, {
              brokerFlagEnabled: this.headlessCodexBrokerEnabled,
              museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
            })
          : undefined,
      })
      assertNoOperatorPresentationConflict(
        startIntent,
        this.db.runtimes.listByHostSessionId(session.hostSessionId)
      )
    }
    const normalizedIntent = normalizeRuntimeProvisionIntent(startIntent)
    const presentationOptions = {
      operatorAttachPending:
        options.attachBeforeInvocationStart !== undefined || options.operatorAttachPending === true,
    }
    if (shouldUseHeadlessTransport(startIntent)) {
      // T-01757 (Wave C, A2): codex headless START provisions THROUGH the
      // HarnessBrokerController (parent acceptance: "Codex headless sessions
      // start through HarnessBrokerController") — never exec.ts. SDK start
      // still hard-fails; legacy-exec still fails closed.
      const headlessRoute = decideHeadlessExecutionRoute(startIntent, {
        brokerFlagEnabled: this.headlessCodexBrokerEnabled,
        museBrokerFlagEnabled: this.headlessMuseBrokerEnabled,
      })
      assertActuatorSplitRouteAdmission(startIntent, headlessRoute)
      if (headlessRoute === 'broker') {
        const reusableBrokerRuntime = getReusableHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId
        )
        // Idempotent reuse ONLY for a real broker headless runtime that has a
        // continuation. A legacy (non-broker) or continuation-less runtime is
        // staled + reprovisioned through the broker, never returned as-is.
        if (
          reusableBrokerRuntime &&
          reusableBrokerRuntime.controllerKind === 'harness-broker' &&
          !isRuntimeUnavailableStatus(reusableBrokerRuntime.status) &&
          automaticContinuationForSession(this.db, session)?.key
        ) {
          assertActuatorSplitRuntimeReuse(startIntent, reusableBrokerRuntime)
          await this.publishPresentation(reusableBrokerRuntime, presentationOptions)
          const initialPrompt = startIntent.initialPrompt ?? ''
          let resolvedRuntime = reusableBrokerRuntime
          if (initialPrompt.length > 0) {
            const receipt = await this.executeHeadlessBrokerInputTurn(
              session,
              reusableBrokerRuntime,
              initialPrompt,
              options.initialPromptPlan?.options.runId ?? `run-${randomUUID()}`,
              {
                ...options.initialPromptPlan?.options,
                waitForCompletion: options.initialPromptPlan === undefined,
              }
            )
            captureInitialPromptReceipt(options.initialPromptReceipt, 'headless', receipt)
            resolvedRuntime = requireRuntime(this.db, reusableBrokerRuntime.runtimeId)
          }
          this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, timestamp())
          return resolvedRuntime
        }
        const startRunId = options.initialPromptPlan?.options.runId ?? `run-${randomUUID()}`
        if (reusableBrokerRuntime && !isRuntimeUnavailableStatus(reusableBrokerRuntime.status)) {
          this.markRuntimeStaleForBrokerReprovision(session, reusableBrokerRuntime, {
            reason: 'headless-broker-start-reprovision',
            route: 'headless-broker',
          })
        }

        // The broker controller owns runtime allocation — do NOT pre-create a
        // runtime record here. Pass the RAW intent (not normalizedIntent): the
        // broker headless plan needs interactive:false; normalizeRuntimeProvisionIntent
        // flips headless intents to interactive:true for tmux provisioning,
        // which would compile the broker plan in interactive mode.
        const initialPrompt = startIntent.initialPrompt ?? ''
        const brokerRuntime = await this.startHeadlessBrokerRuntime(
          session,
          startIntent,
          initialPrompt,
          startRunId,
          // A promptless headless start still permits ASPC's bundle/profile
          // priming input, just as broker session-open does. No HRC run/input
          // identity exists in this shape, so attachment-bearing starts remain
          // strict and do not opt in here.
          {
            ...options.initialPromptPlan?.options,
            ...(hasInitialUserTurn(startIntent)
              ? {}
              : { allowCompilerInitialInputWithoutIdentity: true }),
          }
        )
        await this.publishPresentation(brokerRuntime, presentationOptions)
        // Explicit start WITH an initial prompt: wait for the startup turn to
        // complete (continuation established) via broker events, as the old
        // exec.ts start did. With NO initial user turn there is no run to wait
        // on — return once the controller yields the runtime.
        if (initialPrompt.length > 0)
          captureInitialPromptReceipt(options.initialPromptReceipt, 'headless')
        if (initialPrompt.length > 0 && options.initialPromptPlan === undefined) {
          await this.waitForHeadlessBrokerRunCompletion(startRunId, brokerRuntime.runtimeId)
        }
        return requireRuntime(this.db, brokerRuntime.runtimeId)
      }

      // SDK (anthropic) start hard-fails; legacy-exec start fails closed.
      const reusableRuntime = getReusableHeadlessRuntimeForSession(this.db, session.hostSessionId)
      if (reusableRuntime && automaticContinuationForSession(this.db, session)?.key) {
        assertActuatorSplitRuntimeReuse(startIntent, reusableRuntime)
        this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, timestamp())
        return reusableRuntime
      }

      // Retired SDK and legacy CLI starts fail before allocating a runtime row.
      // Continuation-backed reuse above remains valid and does not allocate
      // anything.
      if (headlessRoute === 'sdk') {
        this.failSdkHarnessPath(
          'startRuntimeForSession',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }

      if (headlessRoute === 'legacy-exec') {
        this.failCliStartPath(
          'startRuntimeForSession',
          session,
          normalizedIntent,
          `run-${randomUUID()}`
        )
      }
    }

    if (highRiskActuatorSplit) {
      assertActuatorSplitRouteAdmission(startIntent, 'interactive-broker')
    }
    const interactiveBrokerOptions = this.selectInteractiveTmuxBrokerOptions(normalizedIntent)
    if (interactiveBrokerOptions) {
      if (
        existingRuntime &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        restartStyle === 'reuse_pty' &&
        isMatchingInteractiveTmuxBrokerRuntime(
          existingRuntime,
          normalizedIntent,
          interactiveBrokerOptions.allowedBrokerDriver
        )
      ) {
        assertActuatorSplitRuntimeReuse(normalizedIntent, existingRuntime)
        if (attachedRunDoor) return await attachedRunSelected(existingRuntime)
        await this.publishPresentation(existingRuntime, presentationOptions)
        return existingRuntime
      }
      const startRunId = options.initialPromptPlan?.options.runId ?? `run-${randomUUID()}`
      if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
        this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
          reason: 'interactive-broker-start-reprovision',
          allowedBrokerDriver: interactiveBrokerOptions.allowedBrokerDriver,
        })
      }

      // T-01757 (Wave C): the route is hardcoded 'broker', so the legacyTmux
      // closure was dead. Dropped — only the broker executor is reachable.
      const runtime = await runInteractiveTmuxRoute('broker', {
        broker: async () =>
          this.startInteractiveTmuxBrokerRuntime(session, normalizedIntent, startRunId, {
            ...interactiveBrokerOptions,
            ...options.initialPromptPlan?.options,
            ...(options.attachBeforeInvocationStart
              ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
              : {}),
          }),
      })
      if (attachedRunDoor) return await attachedRunSelected(runtime)
      await this.publishPresentation(runtime, presentationOptions)
      if ((normalizedIntent.initialPrompt ?? '').length > 0)
        captureInitialPromptReceipt(options.initialPromptReceipt, 'interactive')
      if (
        (normalizedIntent.initialPrompt ?? '').length > 0 &&
        options.initialPromptPlan === undefined
      ) {
        await this.waitForInteractiveBrokerRunCompletion(startRunId, runtime.runtimeId)
      }
      return runtime
    }

    // T-01757 (Wave C) reachability note: the headless branch above always
    // returns; the interactive-broker block above always returns-or-throws.
    // By here the intent is therefore NOT headless, so this guard ALWAYS
    // throws RuntimeUnavailable for any non-headless, non-broker-admissible
    // interactive intent. The legacy interactive/headless START fall-through
    // that used to follow (ensureRuntimeForSession plus start-launch dispatch)
    // was provably unreachable and is removed.
    throw new HrcRuntimeUnavailableError('interactive runtime is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: normalizedIntent.harness.provider,
      harnessId: normalizedIntent.harness.id,
      route: 'interactive-broker',
    })
  })().finally(() => {
    startBirth.decide(undefined)
    this.runtimeStartOperations.delete(session.hostSessionId)
  })

  recordStartBirth(operation, startBirth.decided)
  this.runtimeStartOperations.set(session.hostSessionId, operation)
  return await operation
}

/** T-08556 (§1.4): the attached-run door's prompt and the sink for its turn response. */
export type AttachedRunPrompt = {
  plan: AdmittedPlan
  prompt: string
  runId: string
  onDelivered: (response: Response) => void
}

/**
 * §1.4 "Initial input exactly once": the prompt goes to the selected runtime by
 * identity, through the turn admission gate and that transport's input-turn
 * executor. No session-level selection, admission or reprovision runs here.
 */
async function deliverAttachedRunPrompt(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  input: AttachedRunPrompt
): Promise<void> {
  // The attached door owns the lease and admission; consume its plan by identity.
  const response = await executeBrokerInputTurn(
    server,
    input.plan.session,
    requireRuntime(server.db, runtime.runtimeId),
    input.prompt,
    input.runId,
    { ...input.plan.options, waitForCompletion: false }
  )
  input.onDelivered(
    input.plan.observation === undefined
      ? response
      : await enrichDispatchTurnResponse(server, response, input.plan.observation)
  )
}

/** One input turn into a selected broker runtime, through its transport's executor. */
async function executeBrokerInputTurn(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: Parameters<HrcServerInstanceForHandlers['executeHeadlessBrokerInputTurn']>[4]
): Promise<Response> {
  return runtime.transport === 'tmux'
    ? await server.executeInteractiveBrokerInputTurn(session, runtime, prompt, runId, options)
    : await server.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, options)
}

export function selectInteractiveTmuxBrokerOptions(
  this: HrcServerInstanceForHandlers,
  intent: HrcRuntimeIntent
): { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver } | undefined {
  if (!isExplicitInteractiveTmuxBrokerStartIntent(intent)) {
    return undefined
  }

  const route = decideInteractiveTmuxBrokerStartRoute(intent, {
    claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
    piTuiTmuxBrokerEnabled: this.piTuiTmuxBrokerEnabled,
    museCliTmuxBrokerEnabled: this.museCliTmuxBrokerEnabled,
  })

  if (route.route !== 'broker') {
    return undefined
  }

  return {
    flagEnvName: route.flagEnvName,
    allowedBrokerDriver: route.allowedBrokerDriver,
  }
}

function isExplicitInteractiveTmuxBrokerStartIntent(intent: HrcRuntimeIntent): boolean {
  return (
    (intent.harness.provider === 'anthropic' && intent.harness.id === 'claude-code') ||
    (intent.harness.provider === 'openai' &&
      (intent.harness.id === 'codex-cli' ||
        intent.harness.id === 'pi' ||
        intent.harness.id === 'pi-cli')) ||
    (intent.harness.provider === 'meta' && intent.harness.id === 'muse-cli')
  )
}

export const runtimeStartHandlersMethods = {
  startRuntimeForSession,
  selectInteractiveTmuxBrokerOptions,
}

export type RuntimeStartHandlersMethods = typeof runtimeStartHandlersMethods
