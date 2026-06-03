import { randomUUID } from 'node:crypto'

import { HrcConflictError, HrcErrorCode, HrcRuntimeUnavailableError, validateFence } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  PrepareAttachedRunResponse,
  ResumeAttachedRunResponse,
  StartRuntimeResponse,
} from 'hrc-core'
import { enrichTurnPromptForBrain } from './brain-enricher.js'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  getBrokerRuntimeTmuxSocketPath,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  assertRuntimeNotBusy,
  isBrokerRuntimeQueueCapable,
  requireContinuity,
  requireKnownRuntime,
  requireSession,
} from './require-helpers.js'
import { findDispatchInteractiveRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import type { AttachBeforeInvocationStartOption } from './server-types.js'
import {
  parseDispatchTurnRequest,
  parseEnsureRuntimeRequest,
  parseJsonBody,
  parsePrepareAttachedRunRequest,
  parseResumeAttachedRunRequest,
  parseStartRuntimeRequest,
} from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { toEnsureRuntimeResponse, toStartRuntimeResponse } from './status-views.js'

export async function handleEnsureRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseEnsureRuntimeRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'runtime-ensure',
  })
  const runtime = await this.ensureRuntimeForSession(
    session,
    body.intent,
    body.restartStyle ?? 'reuse_pty'
  )
  return json(toEnsureRuntimeResponse(runtime))
}

export async function handleStartRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseStartRuntimeRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'runtime-start',
  })
  const runtime = await this.startRuntimeForSession(
    session,
    body.intent,
    body.restartStyle ?? 'reuse_pty'
  )
  return json(toStartRuntimeResponse(runtime) satisfies StartRuntimeResponse)
}

export async function handleDispatchTurn(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDispatchTurnRequest(await parseJsonBody(request))
  const requestedSession = requireSession(this.db, body.hostSessionId)
  const continuity = requireContinuity(this.db, requestedSession)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)
  const fence = validateFence(body.fences, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!fence.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
  }

  const resolved = requireSession(this.db, fence.resolvedHostSessionId)
  // Stale-generation guard runs after fence validation so that a caller
  // pinning a specific generation via `fences` gets a predictable
  // STALE_CONTEXT error instead of silent rotation.
  const { session } = await this.maybeAutoRotateStaleSession(resolved, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'dispatch-turn',
  })
  const runId = `run-${randomUUID()}`
  const parsedIntent = normalizeDispatchIntent(
    body.runtimeIntent ?? session.lastAppliedIntentJson,
    session,
    runId
  )
  const intent =
    body.attachments !== undefined
      ? { ...parsedIntent, attachments: body.attachments }
      : parsedIntent

  return await this.dispatchTurnForSession(session, intent, body.prompt, {
    runId,
    waitForCompletion: body.waitForCompletion,
  })
}

type AttachedRunResult = StartRuntimeResponse | DispatchTurnResponse

async function dispatchTurnResponseJson(response: Response) {
  return (await response.json()) as {
    runId: string
    hostSessionId: string
    generation: number
    runtimeId: string
    transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
    status: 'completed' | 'started'
    supportsInFlightInput: boolean
  }
}

function runtimeIdFromAttachedRunResult(result: AttachedRunResult): string {
  return result.runtimeId
}

async function attachDescriptorBody(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
) {
  return (await server.attachRuntime(runtime).json()) as PrepareAttachedRunResponse['attach']
}

export async function handlePrepareAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parsePrepareAttachedRunRequest(await parseJsonBody(request))
  const requested = requireSession(this.db, body.hostSessionId)
  const { session } = await this.maybeAutoRotateStaleSession(requested, {
    allowStaleGeneration: body.allowStaleGeneration,
    trigger: 'prepare-attached-run',
  })
  const pendingStartId = `attached-${randomUUID()}`
  const controller = this.getHarnessBrokerController()

  const operation = (async (): Promise<AttachedRunResult> => {
    if (body.prompt && body.prompt.length > 0) {
      const response = await this.dispatchTurnForSession(session, body.intent, body.prompt, {
        runId: `run-${randomUUID()}`,
        waitForCompletion: false,
        attachBeforeInvocationStart: { pendingStartId },
      })
      return await dispatchTurnResponseJson(response)
    }

    const runtime = await this.startRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty',
      { attachBeforeInvocationStart: { pendingStartId } }
    )
    return toStartRuntimeResponse(runtime)
  })()

  this.attachedRunOperations.set(pendingStartId, operation)
  void operation
    .finally(() => {
      this.attachedRunOperations.delete(pendingStartId)
    })
    .catch(() => undefined)

  try {
    const winner = await Promise.race([
      controller
        .waitForAttachedStartReady(pendingStartId)
        .then((ready: { pendingStartId: string; runtime: HrcRuntimeSnapshot }) => ({
          kind: 'prepared' as const,
          ready,
        })),
      operation.then((result) => ({ kind: 'started' as const, result })),
    ])

    if (winner.kind === 'prepared') {
      return json({
        status: 'prepared',
        pendingStartId,
        hostSessionId: winner.ready.runtime.hostSessionId,
        runtimeId: winner.ready.runtime.runtimeId,
        attach: await attachDescriptorBody(this, winner.ready.runtime),
      } satisfies PrepareAttachedRunResponse)
    }

    controller.cancelAttachedStart(pendingStartId, 'attached run completed without a pending start')
    const runtime = requireKnownRuntime(this.db, runtimeIdFromAttachedRunResult(winner.result))
    return json({
      status: 'started',
      result: winner.result,
      attach: await attachDescriptorBody(this, runtime),
    } satisfies PrepareAttachedRunResponse)
  } catch (error) {
    controller.cancelAttachedStart(
      pendingStartId,
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}

export async function handleResumeAttachedRun(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseResumeAttachedRunRequest(await parseJsonBody(request))
  const operation = this.attachedRunOperations.get(body.pendingStartId) as
    | Promise<AttachedRunResult>
    | undefined
  if (!operation) {
    throw new HrcRuntimeUnavailableError('attached run is not pending', {
      pendingStartId: body.pendingStartId,
      route: 'attached-run',
    })
  }

  const resumed = this.getHarnessBrokerController().resumeAttachedStart(body.pendingStartId)
  if (!resumed.ok) {
    throw new HrcRuntimeUnavailableError(resumed.error.message, {
      pendingStartId: body.pendingStartId,
      code: resumed.error.code,
      route: 'attached-run',
    })
  }

  const result = await operation
  return json({
    status: 'started',
    result,
  } satisfies ResumeAttachedRunResponse)
}

export async function dispatchTurnForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  inputIntent: HrcRuntimeIntent,
  prompt: string,
  options: {
    runId?: string | undefined
    ensureInteractiveRuntime?: boolean | undefined
    waitForCompletion?: boolean | undefined
    skipBrainEnrichment?: boolean | undefined
    attachBeforeInvocationStart?: AttachBeforeInvocationStartOption | undefined
  } = {}
): Promise<Response> {
  const runId = options.runId ?? `run-${randomUUID()}`
  // T-01770 Phase B: admit ariadne-class (explicit id:claude-code dispatched
  // headless) and SDK-shaped Claude intents into the claude-code-tmux broker
  // path BEFORE the headless/SDK branches. Without this they fall onto legacy
  // exec.ts (fresh conversation each turn) or the hard-failing SDK executor.
  // Normalizing to an interactive claude-code intent makes the predicates
  // below route them to the broker branch (and NOT runSdkTurn / the retired
  // headless CLI exec path). Flag-gated so a disabled broker is unchanged.
  const intent =
    this.claudeCodeTmuxBrokerEnabled && shouldRedirectClaudeToInteractiveBroker(inputIntent)
      ? normalizeClaudeInteractiveBrokerIntent(inputIntent)
      : inputIntent
  // Capture whether this is a headless/non-interactive claude coerced into the
  // interactive broker BEFORE normalization rewrites preferredMode to
  // 'interactive'. Such a runtime has no operator terminal of its own, so on a
  // fresh broker-start we pop a best-effort ghostmux viewer attached to its TUI.
  const isHeadlessClaudeRedirect =
    this.claudeCodeTmuxBrokerEnabled &&
    shouldRedirectClaudeToInteractiveBroker(inputIntent) &&
    (inputIntent.execution?.preferredMode === 'headless' ||
      inputIntent.execution?.preferredMode === 'nonInteractive')
  let dispatchPrompt = prompt
  if (options.skipBrainEnrichment !== true) {
    const originalPromptLength = prompt.length
    const enriched = await enrichTurnPromptForBrain({ session, intent, prompt, runId })
    dispatchPrompt = enriched.prompt
    writeServerLog('INFO', `brain.enricher.${enriched.reason}`, {
      hostSessionId: session.hostSessionId,
      runId,
      applied: enriched.applied,
      sourceCount: enriched.sources?.length ?? 0,
      promptLengthDelta: dispatchPrompt.length - originalPromptLength,
    })
  }

  let latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
  if (
    latestRuntime?.controllerKind === 'harness-broker' &&
    latestRuntime.transport === 'tmux' &&
    getBrokerRuntimeTmuxSocketPath(latestRuntime) !== undefined
  ) {
    latestRuntime = await this.reconcileTmuxRuntimeLiveness(latestRuntime)
  }

  const dispatchIntent = normalizeRuntimeProvisionIntent(intent)

  // A live, idle interactive (tmux/ghostty) broker runtime is the agent's real
  // session — the TUI a human may be watching. A DM/turn for that scope must be
  // delivered INTO it via the broker-reuse path, never spawned as a competing
  // headless run: a headless codex-app-server start resumes the SAME continuation
  // thread the live TUI already owns, finds no rollout in its (re-derived) codex
  // home, and wedges at `starting` — the turn silently dies. The SDK branch below
  // already defers to a live idle interactive runtime; the headless-codex branch
  // must do the same so codex DMs land in the open TUI (broker-reuse) instead of
  // a parallel headless run. When no such runtime exists (cron/autonomous
  // dispatch), the Wave C headless route is still taken.
  const liveInteractiveBrokerReusable = shouldDeferHeadlessToInteractiveBrokerReuse(
    intent,
    toLiveInteractiveRuntimeReuseView(latestRuntime)
  )

  if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
    const route = decideHeadlessExecutionRoute(intent, {
      brokerFlagEnabled: this.headlessCodexBrokerEnabled,
    })
    if (route === 'broker') {
      return await this.handleHeadlessBrokerDispatchTurn(session, intent, dispatchPrompt, runId, {
        waitForCompletion: options.waitForCompletion,
      })
    }
    if (route === 'sdk') {
      return await this.handleHeadlessDispatchTurn(session, dispatchIntent, dispatchPrompt, runId, {
        waitForCompletion: options.waitForCompletion,
      })
    }

    throw new HrcRuntimeUnavailableError('headless legacy execution is unavailable', {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route,
    })
  }

  if (shouldUseSdkTransport(intent)) {
    // Prefer a live idle interactive runtime over SDK when one is available (spec §11.3.3:
    // headless for CLI/headless-capable targets, SDK only as fallback)
    const liveInteractiveRuntime = latestRuntime
    const interactiveAvailableAndIdle =
      liveInteractiveRuntime &&
      (liveInteractiveRuntime.transport === 'tmux' ||
        liveInteractiveRuntime.transport === 'ghostty') &&
      (liveInteractiveRuntime.tmuxJson !== undefined ||
        liveInteractiveRuntime.surfaceJson !== undefined) &&
      !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
      liveInteractiveRuntime.activeRunId === undefined
    if (!interactiveAvailableAndIdle) {
      return await this.handleSdkDispatchTurn(session, intent, dispatchPrompt, runId, {
        waitForCompletion: options.waitForCompletion,
      })
    }
    // Fall through to tmux/headless path with the idle runtime
  }

  const admission = decideInteractiveBrokerAdmission(
    intent,
    toLatestRuntimeAdmissionView(latestRuntime),
    {
      claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
      codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
    }
  )

  if (admission.decision === 'runtime-unavailable') {
    throw new HrcRuntimeUnavailableError(admission.reason, {
      hostSessionId: session.hostSessionId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
      route: 'interactive-broker',
    })
  }

  if (admission.decision === 'broker-start' && isProviderOnlyOpenAiInteractiveIntent(inputIntent)) {
    throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
      hostSessionId: session.hostSessionId,
      provider: inputIntent.harness.provider,
      route: 'interactive-broker',
    })
  }

  if (admission.decision === 'broker-reuse') {
    if (!latestRuntime) {
      throw new HrcRuntimeUnavailableError('interactive broker runtime is unavailable', {
        hostSessionId: session.hostSessionId,
        route: 'interactive-broker',
      })
    }
    if (!isBrokerRuntimeQueueCapable(this.db, latestRuntime)) {
      assertRuntimeNotBusy(this.db, latestRuntime)
    }
    return await this.executeInteractiveBrokerInputTurn(
      session,
      latestRuntime,
      dispatchPrompt,
      runId,
      {
        waitForCompletion:
          admission.allowedBrokerDriver === 'codex-cli-tmux' ? false : options.waitForCompletion,
      }
    )
  }

  if (admission.decision === 'stale-and-reprovision' && latestRuntime) {
    this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
      reason: 'interactive-broker-admission-reprovision',
      allowedBrokerDriver: admission.allowedBrokerDriver,
    })
    if (isProviderOnlyInteractiveIntent(inputIntent)) {
      throw new HrcRuntimeUnavailableError('runtime intent is not broker-admissible', {
        hostSessionId: session.hostSessionId,
        provider: inputIntent.harness.provider,
        route: 'interactive-broker',
      })
    }
  }

  return await runInteractiveTmuxRoute('broker', {
    broker: async () =>
      this.handleInteractiveTmuxBrokerDispatchTurn(session, intent, dispatchPrompt, runId, {
        flagEnvName: admission.flagEnvName,
        allowedBrokerDriver: admission.allowedBrokerDriver,
        ...(options.attachBeforeInvocationStart
          ? { attachBeforeInvocationStart: options.attachBeforeInvocationStart }
          : {}),
        spawnHeadlessViewer: isHeadlessClaudeRedirect,
        waitForCompletion:
          admission.allowedBrokerDriver === 'codex-cli-tmux' ? false : options.waitForCompletion,
      }),
  })
}

function isProviderOnlyInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return intent.harness.interactive === true && intent.harness.id === undefined
}

function isProviderOnlyOpenAiInteractiveIntent(intent: HrcRuntimeIntent): boolean {
  return isProviderOnlyInteractiveIntent(intent) && intent.harness.provider === 'openai'
}

export function markRuntimeStaleForBrokerReprovision(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  payload: Record<string, unknown>
): void {
  if (isRuntimeUnavailableStatus(runtime.status)) {
    return
  }

  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    this.db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: 'runtime staled for harness-broker reprovision',
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  }

  this.db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'stale',
      updatedAt: now,
      staleReason: payload['reason'],
      stalePayload: payload,
    },
  })
  const event = appendHrcEvent(this.db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    ...(runtime.transport === 'sdk' ||
    runtime.transport === 'tmux' ||
    runtime.transport === 'headless' ||
    runtime.transport === 'ghostty'
      ? { transport: runtime.transport }
      : {}),
    payload,
  })
  this.notifyEvent(event)
}

export const turnDispatchHandlersMethods = {
  handleEnsureRuntime,
  handleStartRuntime,
  handleDispatchTurn,
  handlePrepareAttachedRun,
  handleResumeAttachedRun,
  dispatchTurnForSession,
  markRuntimeStaleForBrokerReprovision,
}

export type TurnDispatchHandlersMethods = typeof turnDispatchHandlersMethods
