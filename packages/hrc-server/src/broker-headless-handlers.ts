import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import { asBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { appendHrcEvent } from './hrc-event-helper.js'

import type { InvocationInput } from 'spaces-harness-broker-protocol'
import {
  filterBrokerDispatchEnvForLockedEnv,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import {
  isBrokerRuntimeQueueCapable,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
} from './require-helpers.js'
import { HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV } from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { json, timestamp } from './server-util.js'

export async function startHeadlessBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string
): Promise<HrcRuntimeSnapshot> {
  const turnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  const now = timestamp()
  this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now)

  const client = await startAspcFacadeBrokerClient()
  let handedOffToController = false
  const hrcDispatchEnv = mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch)
  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent: turnIntent,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        continuation: toRuntimeContinuationRef(session.continuation ?? undefined),
      },
      {
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
        ids: {
          requestId: () => `req-${randomUUID()}`,
          operationId: () => `op-${randomUUID()}`,
          runtimeId: () => `rt-${randomUUID()}`,
          invocationId: () => `inv-${randomUUID()}`,
          initialInputId: () => `input-${randomUUID()}`,
          runId: () => runId,
          traceId: () => `trace-${randomUUID()}`,
        },
      }
    )

    if (!compiled.admitted) {
      throw new HrcRuntimeUnavailableError('headless broker compile/admission rejected', {
        hostSessionId: session.hostSessionId,
        runId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'broker',
      })
    }

    const controller = this.getHarnessBrokerController()
    handedOffToController = true
    const result = await controller.start({
      plan: compiled.plan,
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      identity: compiled.identity,
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(hrcDispatchEnv, compiled.startRequest),
      brokerClient: asBrokerClient(client),
      routeDecision: {
        route: 'broker',
        flag: HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
        selectedBy: 'decideHeadlessExecutionRoute',
      },
      lifecyclePolicy: resolveLifecyclePolicyOverlay({
        routeId: `headless-broker:${compiled.profile.brokerDriver}`,
        brokerRoute: true,
      }),
    })

    if (!result.ok) {
      throw new HrcRuntimeUnavailableError('headless broker start failed', {
        hostSessionId: session.hostSessionId,
        runId,
        code: result.error.code,
        message: result.error.message,
        route: 'broker',
      })
    }

    return result.runtime
  } catch (error) {
    if (!handedOffToController) {
      await client.close().catch(() => undefined)
    }
    throw error
  }
}

export async function executeHeadlessBrokerStartTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  }
): Promise<Response> {
  const runtime = await this.startHeadlessBrokerRuntime(session, intent, prompt, runId)

  if (options.waitForCompletion === false) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: true,
  } satisfies DispatchTurnResponse)
}

export async function executeHeadlessBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('headless broker runtime has no active invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker',
    })
  }

  // Queued-mode detection: a runtime is "busy" iff it has an active run still
  // in a non-terminal state. In that case the active run keeps the runtime
  // and invocation pointers (HRC must NOT clobber them with this new runId);
  // the broker queues the new input (whenBusy:'queue') and the event-mapper
  // flips invocation.runId + runtime.activeRunId onto this run on the
  // drained input.accepted envelope.
  const activeRun =
    runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
  const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
  const queueCapable = isBrokerRuntimeQueueCapable(this.db, runtime)

  const inputId = `input-${randomUUID()}` as InvocationInput['inputId']
  const now = timestamp()
  this.db.runs.insert({
    runId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    invocationId,
    operationId: runtime.activeOperationId,
    // Persist HRC's inputId on the run row so the broker event-mapper can
    // correlate a drained input.accepted envelope back to this run and flip
    // invocation.runId before turn.* events project. Set on every dispatch
    // (immediate and queued) for uniform reasoning; a no-op flip is harmless.
    dispatchedInputId: inputId,
  })
  if (!queuedMode) {
    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: runId,
      status: 'busy',
      lastActivityAt: now,
      updatedAt: now,
    })
    this.db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
  }

  const input: InvocationInput = {
    inputId,
    kind: 'user',
    content: [{ type: 'text', text: prompt }],
    metadata: { runId },
  }

  const result = await this.getHarnessBrokerController().dispatchInput({
    runtimeId: runtime.runtimeId,
    input,
    // Always send whenBusy:'queue' when the active invocation supports
    // FIFO queueing: the broker applies it only when its invocation state
    // is turn_active; if the invocation became 'ready' in between, the
    // broker applies the input immediately and ignores policy (per
    // harness-broker invocation-manager). The event-mapper flip on
    // input.accepted is the unconditional safety net in either case.
    ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
  })
  if (!result.ok || !result.response.accepted) {
    const completedAt = timestamp()
    const errorMessage = result.ok
      ? (result.response.reason ?? 'broker rejected invocation input')
      : result.error.message
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const terminalInputFailure =
      isTerminalBrokerInvocationState(invocation?.invocationState) ||
      isTerminalBrokerInputFailure(errorMessage)
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    this.db.runtimes.update(runtime.runtimeId, {
      status: terminalInputFailure ? 'stale' : 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      ...(terminalInputFailure
        ? {
            runtimeStateJson: {
              ...(runtime.runtimeStateJson ?? {}),
              status: 'stale',
              updatedAt: completedAt,
              terminalInvocation: {
                invocationId,
                reason: errorMessage,
              },
            },
          }
        : {}),
    })
    throw new HrcRuntimeUnavailableError(`headless broker input failed: ${errorMessage}`, {
      runtimeId: runtime.runtimeId,
      runId,
      invocationId,
      route: 'broker',
      cause: errorMessage,
      error: errorMessage,
      recommendation: terminalInputFailure
        ? 'retry the turn; HRC marked the stale broker runtime unavailable'
        : 'inspect hrc server logs and retry after the broker is healthy',
    })
  }

  if (options.waitForCompletion === false) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: true,
  } satisfies DispatchTurnResponse)
}

export async function waitForInteractiveBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('interactive broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('interactive broker turn timed out', {
    runtimeId,
    runId,
    route: 'interactive-broker',
  })
}

export async function waitForHeadlessBrokerRunCompletion(
  this: HrcServerInstanceForHandlers,
  runId: string,
  runtimeId: string
): Promise<HrcRunRecord> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    const run = this.db.runs.getByRunId(runId)
    if (run && !isRunActive(run)) {
      // Guarded cleanup: only clear runtime.activeRunId / set status='ready'
      // when the runtime's active run is STILL this one. With broker FIFO
      // queueing, the event-mapper may have already flipped activeRunId to
      // a drained queued run on input.accepted; unconditionally clearing
      // would clobber that pointer and re-introduce the T-01711 hang class.
      const currentRuntime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (currentRuntime?.activeRunId === runId) {
        const now = timestamp()
        this.db.runtimes.updateRunId(runtimeId, undefined, now)
        this.db.runtimes.update(runtimeId, {
          status: 'ready',
          lastActivityAt: now,
          updatedAt: now,
        })
      }
      if (run.status !== 'completed') {
        throw new HrcRuntimeUnavailableError('headless broker turn failed', {
          runtimeId,
          runId,
          status: run.status,
          errorCode: run.errorCode,
          errorMessage: run.errorMessage,
        })
      }
      return run
    }
    await delay(100)
  }

  throw new HrcRuntimeUnavailableError('headless broker turn timed out', {
    runtimeId,
    runId,
    route: 'broker',
  })
}

export function recordDetachedHeadlessTurnFailure(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtimeId: string,
  runId: string,
  err: unknown
): void {
  const errorMessage = err instanceof Error ? err.message : String(err)
  writeServerLog('WARN', 'headless.detached_turn_failed', {
    hostSessionId: session.hostSessionId,
    runtimeId,
    runId,
    error: errorMessage,
  })

  const run = this.db.runs.getByRunId(runId)
  if (!run || !isRunActive(run)) {
    return
  }

  const now = timestamp()
  this.db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    errorMessage,
  })

  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime?.activeRunId === runId) {
    this.db.runtimes.updateRunId(runtimeId, undefined, now)
    this.db.runtimes.update(runtimeId, {
      status: 'ready',
      updatedAt: now,
      lastActivityAt: now,
    })
  }

  const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    payload: {
      success: false,
      transport: 'headless',
    },
  })
  this.notifyEvent(completedEvent)
}

export const brokerHeadlessHandlersMethods = {
  startHeadlessBrokerRuntime,
  executeHeadlessBrokerStartTurn,
  executeHeadlessBrokerInputTurn,
  waitForInteractiveBrokerRunCompletion,
  waitForHeadlessBrokerRunCompletion,
  recordDetachedHeadlessTurnFailure,
}

export type BrokerHeadlessHandlersMethods = typeof brokerHeadlessHandlersMethods
