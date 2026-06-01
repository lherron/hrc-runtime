import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'

import { dirname, join } from 'node:path'

import { HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import { asBrokerClient } from './agent-spaces-adapter/aspc-facade-client.js'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  type BrokerTmuxAllocation,
  type BrokerTmuxAllocator,
  type BrokerWindowIdentity,
  HarnessBrokerController,
} from './broker/controller.js'
import { BrokerEventMapper } from './broker/event-mapper.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import { withDirectTmuxDegradedControlState } from './broker/runtime-state.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'

import type { InvocationInput } from 'spaces-harness-broker-protocol'
import {
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxExecutionRoute,
  filterBrokerDispatchEnvForLockedEnv,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldBlockForBrokerTurnCompletion,
  shouldUseHeadlessSdkExecutor,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import type { InteractiveTmuxBrokerDriver } from './broker-decisions.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import {
  assertRuntimeNotBusy,
  isBrokerRuntimeQueueCapable,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
} from './require-helpers.js'
import { getReusableHeadlessRuntimeForSession } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { json, timestamp } from './server-util.js'
import { brokerLeaseIdsMatch } from './startup-reconcile.js'
import {
  getBrokerIpcSocketPath,
  getBrokerTmuxSocketPath,
  preflightBrokerIpcSocketPath,
} from './tmux-socket.js'
import { createTmuxManager } from './tmux.js'
import type { HrcServerOptions } from './server-types.js'

export async function handleHeadlessDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  const runtime =
    getReusableHeadlessRuntimeForSession(
      this.db,
      session.hostSessionId,
      intent.harness.provider,
      intent.harness.id
    ) ?? this.createHeadlessRuntimeForSession(session, intent)
  assertRuntimeNotBusy(this.db, runtime)

  const continuation = runtime.continuation ?? session.continuation
  const now = timestamp()
  this.db.sessions.updateIntent(session.hostSessionId, intent, now)

  const run = this.db.runs.insert({
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
  })

  this.db.runtimes.update(runtime.runtimeId, {
    activeRunId: run.runId,
    status: 'busy',
    continuation,
    updatedAt: now,
    lastActivityAt: now,
  })

  const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    payload: {
      promptLength: prompt.length,
      transport: 'headless',
    },
  })
  this.notifyEvent(acceptedEvent)

  const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const startedAt = timestamp()
  this.db.runs.update(runId, {
    status: 'started',
    startedAt,
    updatedAt: startedAt,
  })
  this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

  const startedEvent = appendHrcEvent(this.db, 'turn.started', {
    ts: startedAt,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    payload: {
      transport: 'headless',
    },
  })
  this.notifyEvent(startedEvent)

  const execute = async (): Promise<Response> => {
    if (shouldUseHeadlessSdkExecutor(intent.harness)) {
      return await this.executeHeadlessSdkTurn(
        session,
        runtime,
        intent,
        prompt,
        runId,
        continuation
      )
    }

    throw new HrcRuntimeUnavailableError('headless CLI legacy execution is unavailable', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      provider: intent.harness.provider,
      harnessId: intent.harness.id,
    })
  }

  if (options.waitForCompletion === false) {
    void execute().catch((err: unknown) => {
      try {
        this.recordDetachedHeadlessTurnFailure(session, runtime.runtimeId, runId, err)
      } catch (failureErr) {
        writeServerLog('WARN', 'headless.detached_turn_failure_record_failed', {
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          runId,
          error: failureErr instanceof Error ? failureErr.message : String(failureErr),
        })
      }
    })

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponse)
  }

  return await execute()
}

export async function handleHeadlessBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: {
    waitForCompletion?: boolean | undefined
  } = {}
): Promise<Response> {
  const reusableRuntime = getReusableHeadlessRuntimeForSession(
    this.db,
    session.hostSessionId,
    intent.harness.provider,
    intent.harness.id
  )
  if (reusableRuntime) {
    if (
      reusableRuntime.controllerKind === 'harness-broker' &&
      reusableRuntime.activeInvocationId !== undefined
    ) {
      // Broker FIFO queue support: when the active broker invocation's composed
      // capabilities.input.queue is true, a busy runtime can accept a second
      // concurrent turn — the broker queues it (whenBusy:'queue') and drains
      // FIFO after the active turn completes. Skip assertRuntimeNotBusy in
      // that case; the queued path inside executeHeadlessBrokerInputTurn keeps
      // the active run's pointers intact and relies on the event-mapper to
      // flip invocation.runId on input.accepted for the drained input.
      if (!isBrokerRuntimeQueueCapable(this.db, reusableRuntime)) {
        assertRuntimeNotBusy(this.db, reusableRuntime)
      }
      return await this.executeHeadlessBrokerInputTurn(
        session,
        reusableRuntime,
        prompt,
        runId,
        options
      )
    }

    this.markRuntimeStaleForBrokerReprovision(session, reusableRuntime, {
      reason: 'headless-broker-nonbroker-reuse-rejected',
      route: 'headless-broker',
    })
  }

  return await this.executeHeadlessBrokerStartTurn(session, intent, prompt, runId, options)
}

export async function handleInteractiveTmuxBrokerDispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  flagOptions: {
    flagEnvName: string
    allowedBrokerDriver: InteractiveTmuxBrokerDriver
    waitForCompletion?: boolean | undefined
  }
): Promise<Response> {
  const turnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  const runtime = await this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
    flagEnvName: flagOptions.flagEnvName,
    allowedBrokerDriver: flagOptions.allowedBrokerDriver,
  })

  // T-01770 Phase C: block the synchronous caller on the first broker turn
  // (the start delivers the initial prompt under diagnosticRunId). Async
  // reply-bridge callers pass waitForCompletion:false to get status:'started'.
  if (!shouldBlockForBrokerTurnCompletion(flagOptions.waitForCompletion)) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    status: 'completed',
    supportsInFlightInput: true,
  } satisfies DispatchTurnResponse)
}

export async function executeInteractiveBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: { waitForCompletion?: boolean | undefined } = {}
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('interactive broker runtime has no active invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'interactive-broker',
    })
  }

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
    transport: 'tmux',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
    invocationId,
    operationId: runtime.activeOperationId,
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
    ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
  })

  if (!result.ok || !result.response.accepted) {
    const completedAt = timestamp()
    const errorMessage = result.ok
      ? (result.response.reason ?? 'broker rejected invocation input')
      : result.error.message
    if (
      !result.ok &&
      result.error.code === 'broker_runtime_not_active' &&
      runtime.transport === 'tmux' &&
      (await this.deliverReassociatedBrokerTmuxInput(session, runtime, prompt, runId))
    ) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }
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
    if (!queuedMode) {
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    }
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
    throw new HrcRuntimeUnavailableError(`interactive broker input failed: ${errorMessage}`, {
      runtimeId: runtime.runtimeId,
      runId,
      invocationId,
      route: 'interactive-broker',
      cause: errorMessage,
      error: errorMessage,
      recommendation: terminalInputFailure
        ? 'retry the turn; HRC marked the stale broker runtime unavailable'
        : 'inspect hrc server logs and retry after the broker is healthy',
    })
  }

  // T-01770 Phase C: a synchronous caller (ACP/Discord round-trip via
  // dispatchTurnForSession) blocks until the Claude turn completes; the async
  // reply-bridge callers pass waitForCompletion:false and get status:'started'.
  if (!shouldBlockForBrokerTurnCompletion(options.waitForCompletion)) {
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    status: 'completed',
    supportsInFlightInput: true,
  } satisfies DispatchTurnResponse)
}

export async function deliverReassociatedBrokerTmuxInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string
): Promise<boolean> {
  const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  if (!socketPath || !sessionName) {
    return false
  }

  const brokerTmux = createTmuxManager({ socketPath })
  const pane = await brokerTmux.inspectSession(sessionName)
  if (!pane || !brokerLeaseIdsMatch(runtime, pane)) {
    return false
  }

  const liveness = await brokerTmux.inspectPaneLiveness(pane.paneId)
  if (!liveness?.alive) {
    return false
  }

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
        source: 'reassociated-broker-tmux-fallback',
      },
    })
  )
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.user_prompt', {
      ts: acceptedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: createUserPromptPayload(prompt),
    })
  )

  await brokerTmux.sendKeys(pane.paneId, prompt)

  const startedAt = timestamp()
  const latestRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
  this.db.runs.update(runId, {
    status: 'started',
    startedAt,
    updatedAt: startedAt,
  })
  this.db.runtimes.update(runtime.runtimeId, {
    status: 'busy',
    activeRunId: runId,
    lastActivityAt: startedAt,
    updatedAt: startedAt,
    runtimeStateJson: withDirectTmuxDegradedControlState(latestRuntime.runtimeStateJson),
  })
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.started', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        source: 'reassociated-broker-tmux-fallback',
      },
    })
  )
  this.notifyEvent(
    appendHrcEvent(this.db, 'turn.degraded_input_delivered', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        source: 'reassociated-broker-tmux-fallback',
        controlMode: 'direct-tmux-degraded',
        brokerAttached: false,
        paneId: pane.paneId,
      },
    })
  )

  writeServerLog('INFO', 'interactive_broker.reassociated_tmux_input_fallback', {
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    runId,
    paneId: pane.paneId,
  })
  return true
}

export async function startInteractiveTmuxBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  turnIntent: HrcRuntimeIntent,
  diagnosticRunId: string,
  flagOptions: { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
): Promise<HrcRuntimeSnapshot> {
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
        // T-01770 Phase D: arriving here means there is no live TUI to reuse
        // (the reuse predicates return an already-live runtime first). A fresh
        // first launch must NOT attempt continuation — passing session.continuation
        // for codex would emit `codex resume <rollout>` (or `claude --continue`),
        // replaying a transcript and, when the recorded cwd differs, blocking the
        // TUI on a "choose working directory to resume" picker (commit 120eb7a).
        // We REVERSE that disable ONLY for the safe recreate case: claude-code-tmux
        // + a captured Claude session id ⇒ pass the continuation so the adapter
        // emits `--resume <uuid>` (no cwd picker). All other cases stay undefined.
        continuation: toRuntimeContinuationRef(
          decideInteractiveTmuxBrokerContinuation({
            allowedBrokerDriver: flagOptions.allowedBrokerDriver,
            sessionContinuation: session.continuation,
          })
        ),
      },
      {
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
        ids: {
          requestId: () => `req-${randomUUID()}`,
          operationId: () => `op-${randomUUID()}`,
          runtimeId: () => `rt-${randomUUID()}`,
          invocationId: () => `inv-${randomUUID()}`,
          initialInputId: () => `input-${randomUUID()}`,
          runId: () => diagnosticRunId,
          traceId: () => `trace-${randomUUID()}`,
        },
      }
    )

    if (!compiled.admitted) {
      throw new HrcRuntimeUnavailableError('interactive broker compile/admission rejected', {
        hostSessionId: session.hostSessionId,
        runId: diagnosticRunId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'interactive-broker',
        flag: flagOptions.flagEnvName,
      })
    }

    const route = decideInteractiveTmuxExecutionRoute(turnIntent, compiled.profile, {
      brokerFlagEnabled: true,
      allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    })
    if (route !== 'broker') {
      throw new HrcRuntimeUnavailableError(
        `interactive broker profile did not resolve to ${flagOptions.allowedBrokerDriver}`,
        {
          hostSessionId: session.hostSessionId,
          runId: diagnosticRunId,
          brokerDriver: compiled.profile.brokerDriver,
          brokerTerminal: compiled.profile.brokerTerminal,
          route: 'interactive-broker',
          flag: flagOptions.flagEnvName,
        }
      )
    }

    handedOffToController = true
    const result = await this.getHarnessBrokerController().start({
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
        flag: flagOptions.flagEnvName,
        selectedBy: 'decideInteractiveTmuxExecutionRoute',
      },
      lifecyclePolicy: resolveLifecyclePolicyOverlay({
        routeId: `interactive-broker:${compiled.profile.brokerDriver}`,
        brokerRoute: true,
      }),
    })

    if (!result.ok) {
      throw new HrcRuntimeUnavailableError('interactive broker start failed', {
        hostSessionId: session.hostSessionId,
        runId: diagnosticRunId,
        code: result.error.code,
        message: result.error.message,
        route: 'interactive-broker',
        flag: flagOptions.flagEnvName,
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

/**
 * A named-window tmux manager sufficient for the durable broker allocator: it
 * hosts a 'broker' window (launched exec-form with the harness-broker Unix
 * command) and an idempotent 'tui' lease window under ONE per-runtime socket.
 */
export type DurableTmuxManagerLike = {
  initialize(): Promise<void>
  createWindowWithCommand(input: {
    sessionName: string
    windowName: string
    command: string
  }): Promise<BrokerWindowIdentity>
  createOrInspectWindow(input: {
    sessionName: string
    windowName: string
  }): Promise<BrokerWindowIdentity>
  inspectPaneProcess?(
    paneId: string
  ): Promise<{ command: string; pid: number; dead: boolean } | null>
}

export type BrokerDurableTmuxAllocatorDeps = {
  tmuxManagerFactory: (opts: { socketPath: string }) => DurableTmuxManagerLike
  generateAttachToken: () => string
  now?: () => string
}

/**
 * T-01812 Phase 3 — durable interactive broker allocator. Carves a per-runtime
 * btmux lease hosting TWO named windows under ONE socket/session:
 *   - a 'broker' window launched EXEC-FORM with `harness-broker … --transport
 *     unix <ipcSocket>` (the broker is the pane root process, NOT pasted keys),
 *   - a 'tui' window whose pane lease is handed to runtime.terminalSurface.
 * Allocates an owner-only (0700) broker IPC dir + attach token (referenced
 * redacted, never persisted raw) and runs the sockaddr_un HARD preflight BEFORE
 * any tmux spawn. The controller dials `brokerIpcSocketPath` via connectUnix.
 */
export function createBrokerDurableTmuxAllocator(
  options: Pick<HrcServerOptions, 'runtimeRoot'>,
  deps: BrokerDurableTmuxAllocatorDeps
): BrokerTmuxAllocator {
  const now = deps.now ?? timestamp
  return {
    allocate: async ({ runtimeId, brokerDriver, generation }): Promise<BrokerTmuxAllocation> => {
      const brokerIpcSocketPath = getBrokerIpcSocketPath(options, brokerDriver, runtimeId)
      // HARD preflight BEFORE any tmux spawn / IPC dir creation: an over-long
      // sockaddr_un path fails EARLY with a readable error, never a later
      // bind/connect errno.
      preflightBrokerIpcSocketPath(brokerIpcSocketPath)

      const btmuxSocketPath = getBrokerTmuxSocketPath(
        options as HrcServerOptions,
        brokerDriver,
        runtimeId
      )
      const ipcDir = dirname(brokerIpcSocketPath)
      await mkdir(dirname(btmuxSocketPath), { recursive: true })
      // Owner-only broker IPC dir (0700). mkdir mode is umask-masked, so chmod
      // the leaf explicitly to guarantee rwx------.
      await mkdir(ipcDir, { recursive: true, mode: 0o700 })
      await chmod(ipcDir, 0o700)

      // Allocate the attach token and persist it by REFERENCE (owner-only file).
      // The raw secret never enters runtime_state_json — only the redacted ref.
      const attachToken = deps.generateAttachToken()
      const attachTokenPath = join(ipcDir, 'attach.token')
      await writeFile(attachTokenPath, attachToken, { mode: 0o600 })

      const tmux = deps.tmuxManagerFactory({ socketPath: btmuxSocketPath })
      await tmux.initialize()

      const sessionName = `hrc-${brokerDriver}-${runtimeId}`
      const brokerCommand = `exec harness-broker run --transport unix --socket ${brokerIpcSocketPath}`
      const brokerWindow = await tmux.createWindowWithCommand({
        sessionName,
        windowName: 'broker',
        command: brokerCommand,
      })
      const tuiWindow = await tmux.createOrInspectWindow({ sessionName, windowName: 'tui' })

      // Capture the broker pane's running pid for persisted identity (best
      // effort — pane ids alone are known weak; the pid/command corroborate).
      let brokerPid: number | undefined
      if (typeof tmux.inspectPaneProcess === 'function') {
        const proc = await tmux.inspectPaneProcess(brokerWindow.paneId)
        if (proc && !proc.dead && proc.pid > 0) {
          brokerPid = proc.pid
        }
      }

      // The lease handed to runtime.terminalSurface is the TUI pane (operators
      // attach here) — NEVER the broker pane.
      const lease = {
        kind: 'tmux-pane' as const,
        ownership: 'hrc' as const,
        socketPath: tuiWindow.socketPath,
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
        sessionName: tuiWindow.sessionName,
        windowName: tuiWindow.windowName,
        allowedOps: {
          inspect: true as const,
          sendInput: true as const,
          sendInterrupt: true as const,
          capture: true,
          resize: false,
        },
      }

      return {
        socketPath: btmuxSocketPath,
        allocatedAt: now(),
        generation,
        lease,
        brokerIpcSocketPath,
        attachToken,
        attachTokenRef: { kind: 'file', path: attachTokenPath, redacted: true },
        brokerCommand,
        ...(brokerPid !== undefined ? { brokerPid } : {}),
        brokerWindow,
        tuiWindow,
        // Legacy single-pane fields mirror the TUI pane for restart reconcile /
        // teardown that still reads the flat shape.
        sessionId: tuiWindow.sessionId,
        windowId: tuiWindow.windowId,
        paneId: tuiWindow.paneId,
        sessionName: tuiWindow.sessionName,
        windowName: tuiWindow.windowName,
      }
    },
  }
}

export function getHarnessBrokerController(
  this: HrcServerInstanceForHandlers
): HarnessBrokerController {
  if (this.harnessBrokerController) {
    return this.harnessBrokerController
  }

  const mapper = new BrokerEventMapper({ db: this.db })
  const tmuxAllocator: BrokerTmuxAllocator = {
    allocate: async ({ runtimeId, brokerDriver, generation }) => {
      const socketPath = getBrokerTmuxSocketPath(this.options, brokerDriver, runtimeId)
      await mkdir(dirname(socketPath), { recursive: true })
      const tmux = createTmuxManager({ socketPath })
      await tmux.initialize()
      // Allocate the runtime-owned tmux pane on its dedicated lease socket and
      // hand the broker a narrow pane lease (it attaches to the pane, never
      // owns the server). Session name is deterministic from runtimeId so
      // restart reconcile can re-scan it (C-02889).
      const sessionName = `hrc-${brokerDriver}-${runtimeId}`
      const pane = await tmux.createLeaseSession(sessionName)
      const lease = {
        kind: 'tmux-pane' as const,
        ownership: 'hrc' as const,
        socketPath,
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        paneId: pane.paneId,
        sessionName: pane.sessionName,
        windowName: pane.windowName,
        allowedOps: {
          inspect: true as const,
          sendInput: true as const,
          sendInterrupt: true as const,
          capture: true,
          resize: false,
        },
      }
      return {
        socketPath,
        allocatedAt: timestamp(),
        lease,
        generation,
        sessionId: pane.sessionId,
        windowId: pane.windowId,
        paneId: pane.paneId,
        sessionName: pane.sessionName,
        windowName: pane.windowName,
      }
    },
  }
  this.harnessBrokerController = new HarnessBrokerController({
    db: this.db,
    mapper: {
      apply: (envelope) => {
        const result = mapper.apply(envelope)
        // Notify the canonical lifecycle events (hrc_events): these carry hrcSeq
        // so follow-stream subscribers deliver them and notifyEvent finalizes the
        // semantic turn on turn.completed. The raw `events` mirror lacks hrcSeq and
        // is provenance-only, so it is intentionally not notified.
        for (const event of result.lifecycleEvents) {
          this.notifyEvent(event)
        }
        return result
      },
    },
    tmuxAllocator,
    env: process.env,
    serverInstanceId: `hrc-server:${process.pid}`,
    logger: {
      info: (message, fields) => writeServerLog('INFO', message, fields),
      warn: (message, fields) => writeServerLog('WARN', message, fields),
      error: (message, fields) => writeServerLog('ERROR', message, fields),
    },
  })
  return this.harnessBrokerController
}

export const brokerInteractiveHandlersMethods = {
  handleHeadlessDispatchTurn,
  handleHeadlessBrokerDispatchTurn,
  handleInteractiveTmuxBrokerDispatchTurn,
  executeInteractiveBrokerInputTurn,
  deliverReassociatedBrokerTmuxInput,
  startInteractiveTmuxBrokerRuntime,
  getHarnessBrokerController,
}

export type BrokerInteractiveHandlersMethods = typeof brokerInteractiveHandlersMethods
