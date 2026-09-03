import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcErrorCode, HrcRuntimeUnavailableError, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { buildHrcCorrelationEnv, mergeEnv } from './agent-spaces-adapter/cli-adapter.js'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { buildDirectAgentHarnessPlan } from './agent-spaces-adapter/direct-agent-harness.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import {
  compilerPrimingSubmissionId,
  isCompilerPrimingSubmissionTerminal,
} from './compiler-priming.js'
import { armFirstTurnWatch } from './first-turn-watch.js'
import { appendHrcEvent, createUserPromptPayload } from './hrc-event-helper.js'
import { buildManagedBrokerDispatchEnv } from './managed-broker-runtime-env.js'
import { formatDmAddress } from './messages.js'
import { runtimeActivityPatch } from './runtime-activity.js'

import {
  actuatorSplitRuntimeAuthority,
  assertActuatorSplitAdmission,
  prepareActuatorSplitIntent,
} from './actuator-split.js'
import {
  decideCodexAppServerPresentation,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  toRuntimeContinuationRef,
} from './broker-decisions.js'
import { connectObservedBrokerUnixClient } from './broker/client-observability.js'
import type { BrokerUnixClientFactory } from './broker/controller.js'
import { isClosedDbError } from './broker/controller/internal.js'
import { submissionOrigin, submitThroughBrokerDoor } from './broker/submission-doors.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import { createPrecompileLaunchTimingContext } from './precompile-launch-timing.js'
import {
  classifyBrokerInputFailure,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  isTransientBrokerInputStateFailure,
  isTransitionalBrokerInvocationState,
  requireSession,
} from './require-helpers.js'
import {
  HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
} from './server-constants.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import {
  type CoalescedQueuedMember,
  type DispatchRunPersistenceOptions,
  dispatchOriginRunFields,
  dispatchRunPersistence,
} from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { automaticContinuationForSession } from './session-continuation-reuse.js'
import { reattachDurableBrokerForDispatch } from './startup-reconcile.js'
import {
  assertRuntimeSupportsResponseFormat,
  toBrokerResponseFormat,
} from './turn-response-format.js'

type DispatchTurnResponseBase = Omit<
  DispatchTurnResponse,
  'startIdentity' | 'observation' | 'stage' | 'status' | 'outcome' | 'replayed' | 'error'
> & { status: 'started' | 'completed' }

export const buildHeadlessBrokerDispatchEnv = buildManagedBrokerDispatchEnv

/**
 * A promptless cold Codex boot still runs the compiler-owned agent priming
 * input. The caller prompt is a separate guarded invoke, so it must wait for
 * that priming submission's identified turn to become terminal. This consumes
 * only the broker ledger/subscriber projection: no local busy guess, polling,
 * timer, or reply row participates.
 */
export async function waitForCompilerPrimingTerminal(
  server: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  signal: AbortSignal
): Promise<void> {
  const submissionId = compilerPrimingSubmissionId(server.db, runtime)
  const invocationId = runtime.activeInvocationId
  if (submissionId === undefined || invocationId === undefined) return

  const evaluate = (): boolean =>
    isCompilerPrimingSubmissionTerminal(server.db, invocationId, submissionId)

  if (evaluate()) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      server.rawBrokerSubscribers.delete(subscriber)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        new HrcRuntimeUnavailableError('compiler priming wait aborted', {
          runtimeId: runtime.runtimeId,
          invocationId,
          submissionId,
        })
      )
    }
    const subscriber = (notification: { record: { invocationId: string } }) => {
      if (notification.record.invocationId === invocationId && evaluate()) finish()
    }
    server.rawBrokerSubscribers.add(subscriber)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else if (evaluate()) finish()
  })
}

type JsonRepairRunCorrelation = {
  kind: 'json_repair'
  sourceRunId: string
  failedValidationRunId: string
  repairRunId: string
}

type DurableHeadlessTurnInput = {
  kind: string
  prompt: string
  source: string
  sourceMessageId?: string | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
}

function parseDurableHeadlessTurnInput(value: string | null): DurableHeadlessTurnInput | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<DurableHeadlessTurnInput>
    if (typeof parsed.kind !== 'string' || typeof parsed.prompt !== 'string') return undefined
    const source = typeof parsed.source === 'string' ? parsed.source : parsed.kind
    return { ...parsed, kind: parsed.kind, prompt: parsed.prompt, source }
  } catch {
    return undefined
  }
}

type DurableHeadlessQueueEntry = {
  run: HrcRunRecord
  delivery: DurableHeadlessTurnInput
}

/**
 * The caller prompt of a cold-birth accepted run, made durable (T-07944).
 *
 * A promptless cold boot accepts the run and then waits for the compiler
 * priming turn before submitting the caller's prompt through the invoke door.
 * That wait used to live only in an in-memory `.then` chain, so a daemon
 * restart in the window dropped the prompt with no record: the run stayed
 * `accepted` with no `dispatched_input_id` until the zombie sweep buried it 30
 * minutes later. Persisting the prompt and its dispatch options at acceptance
 * (in the SAME `runs.correlation_json` column the queued path already uses)
 * lets startup recovery re-arm the wait -> submit, or fail the run positively
 * and immediately when the invocation it was owed to is gone.
 */
const DURABLE_COLD_BOOT_INPUT_KIND = 'durable_cold_boot_turn_input'

type DurableColdBootTurnInput = DurableHeadlessTurnInput & {
  kind: typeof DURABLE_COLD_BOOT_INPUT_KIND
  source: 'cold_boot'
  /**
   * The shared dispatch-persistence options verbatim (all JSON scalars/objects),
   * so a re-armed submit rebuilds `executeHeadlessBrokerInputTurn`'s options
   * exactly instead of inventing a fresh, lossier set.
   */
  dispatch: DispatchRunPersistenceOptions
}

export function parseDurableColdBootTurnInput(
  value: string | null
): DurableColdBootTurnInput | undefined {
  const parsed = parseDurableHeadlessTurnInput(value)
  if (parsed === undefined || parsed.kind !== DURABLE_COLD_BOOT_INPUT_KIND) return undefined
  const dispatch = (parsed as { dispatch?: unknown }).dispatch
  return {
    ...parsed,
    kind: DURABLE_COLD_BOOT_INPUT_KIND,
    source: 'cold_boot',
    dispatch:
      dispatch !== null && typeof dispatch === 'object'
        ? (dispatch as DispatchRunPersistenceOptions)
        : { dispatchIdempotencyKey: undefined },
  }
}

export function serializeDurableColdBootTurnInput(
  prompt: string,
  options: DispatchRunPersistenceOptions & { responseFormat?: HrcTurnResponseFormat | undefined }
): string {
  return JSON.stringify({
    kind: DURABLE_COLD_BOOT_INPUT_KIND,
    prompt,
    source: 'cold_boot',
    ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
    dispatch: dispatchRunPersistence(options),
  } satisfies DurableColdBootTurnInput)
}

function isDefaultPlainResponseFormat(responseFormat: HrcTurnResponseFormat | undefined): boolean {
  return responseFormat === undefined || responseFormat.kind === 'text'
}

function isCoalescibleSemanticDm(entry: DurableHeadlessQueueEntry): boolean {
  return (
    entry.delivery.source === 'semantic_dm' &&
    entry.delivery.sourceMessageId !== undefined &&
    isDefaultPlainResponseFormat(entry.delivery.responseFormat)
  )
}

export function formatQueuedDeliveryRemainderTrailer(
  entries: ReadonlyArray<{ seq?: number | undefined; senderScope: string }>
): string {
  return [
    `[queued delivery snapshot remainder count=${entries.length}]`,
    ...entries.map(
      (entry) => `- seq=${entry.seq === undefined ? 'n/a' : entry.seq} sender=${entry.senderScope}`
    ),
  ].join('\n')
}

export function formatQueuedSemanticDmDelivery(
  prompt: string,
  acceptedAt: string,
  deliveredAt: string
): string {
  const acceptedAtMs = Date.parse(acceptedAt)
  const deliveredAtMs = Date.parse(deliveredAt)
  const queueAgeMs =
    Number.isFinite(acceptedAtMs) && Number.isFinite(deliveredAtMs)
      ? Math.max(0, deliveredAtMs - acceptedAtMs)
      : 0
  return [
    `[queued DM delivery acceptedAt=${acceptedAt} deliveredAt=${deliveredAt} queueAgeMs=${queueAgeMs}]`,
    prompt,
  ].join('\n')
}

export function enqueueDurableHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    source: 'boot' | 'semantic_dm'
    runtimeId?: string | undefined
    sourceMessageId?: string | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): void {
  this.db.sqlite.transaction(() => {
    if (this.db.runs.getByRunId(runId)) return
    const nextQueueSeq =
      (this.db.sqlite
        .query<{ max_seq: number | null }, []>('SELECT MAX(queued_input_seq) AS max_seq FROM runs')
        .get()?.max_seq ?? 0) + 1
    const now = timestamp()
    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'queued',
      acceptedAt: now,
      updatedAt: now,
      queuedInputSeq: nextQueueSeq,
      dispatchedInputId: `input-${randomUUID()}`,
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      ...dispatchOriginRunFields(options),
    })
    this.db.runs.setCorrelationJson(
      runId,
      JSON.stringify({
        kind: 'durable_headless_turn_input',
        prompt,
        source: options.source,
        ...(options.sourceMessageId !== undefined
          ? { sourceMessageId: options.sourceMessageId }
          : {}),
        ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
      } satisfies DurableHeadlessTurnInput)
    )
  })()
}

export async function dispatchQueuedHeadlessTurnInput(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    coalescedMembers?: readonly CoalescedQueuedMember[] | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn runtime has no broker invocation', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  const queued = this.db.runs.getByRunId(runId)
  const inputId = queued?.dispatchedInputId
  if (queued?.status !== 'queued' || inputId === undefined) {
    throw new HrcRuntimeUnavailableError('queued turn input is no longer dispatchable', {
      runtimeId: runtime.runtimeId,
      runId,
      status: queued?.status,
      route: 'broker-queued-input',
    })
  }

  const claimedAt = timestamp()
  const claimed = this.db.sqlite.transaction(() => {
    const ownerClaimed = this.db.runs.claimQueued(runId, {
      runtimeId: runtime.runtimeId,
      invocationId,
      operationId: runtime.activeOperationId,
      dispatchedInputId: inputId,
      updatedAt: claimedAt,
    })
    if (!ownerClaimed) return false

    for (const member of options.coalescedMembers ?? []) {
      const message = this.db.messages.getById(member.sourceMessageId)
      if (
        message === undefined ||
        message.execution.state !== 'accepted' ||
        message.execution.runId !== member.runId
      ) {
        throw new Error(`queued DM ${member.sourceMessageId} is not coalescible`)
      }
      if (
        !this.db.runs.markQueuedCoalesced(member.runId, {
          ownerRunId: runId,
          position: member.position,
          completedAt: claimedAt,
          updatedAt: claimedAt,
        })
      ) {
        throw new Error(`queued run ${member.runId} is not coalescible`)
      }
      this.db.messages.updateExecution(member.sourceMessageId, {
        state: 'coalesced',
        coalescedIntoRunId: runId,
        coalescedPosition: member.position,
      })
    }
    return true
  })()
  if (!claimed) {
    throw new HrcRuntimeUnavailableError('queued turn input was already claimed', {
      runtimeId: runtime.runtimeId,
      runId,
      route: 'broker-queued-input',
    })
  }

  return await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, options)
}

export async function drainDurableHeadlessTurnInputs(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string
): Promise<void> {
  if (this.queuedTurnInputDrains.has(hostSessionId)) return
  this.queuedTurnInputDrains.add(hostSessionId)
  let queued: HrcRunRecord | undefined
  let delivery: DurableHeadlessTurnInput | undefined

  try {
    const snapshot = this.db.runs
      .snapshotQueuedByHostSessionId(hostSessionId, `queue-snapshot-${randomUUID()}`, timestamp())
      .map((run): DurableHeadlessQueueEntry | undefined => {
        const parsed = parseDurableHeadlessTurnInput(this.db.runs.getCorrelationJson(run.runId))
        return parsed === undefined ? undefined : { run, delivery: parsed }
      })
    if (snapshot.length === 0) return
    const first = snapshot[0]
    if (first === undefined) return

    const executing: DurableHeadlessQueueEntry[] = []
    if (isCoalescibleSemanticDm(first)) {
      for (const entry of snapshot) {
        if (entry === undefined || !isCoalescibleSemanticDm(entry)) break
        executing.push(entry)
      }
    } else {
      executing.push(first)
    }
    const owner = executing.at(-1)
    if (owner === undefined) return
    queued = owner.run
    delivery = owner.delivery
    const remainder = snapshot.slice(executing.length)

    const session = requireSession(this.db, hostSessionId)
    // T-07206: fresh starts commit this field only after controller.start succeeds,
    // so it is safe for an automatic drain to reuse as materialization authority.
    const intent = session.lastAppliedIntentJson
    if (!intent) {
      throw new HrcRuntimeUnavailableError('queued turn has no runtime intent', {
        hostSessionId,
        runId: queued.runId,
        route: 'broker-queued-input',
      })
    }

    const deliveredAt = timestamp()
    const content = executing
      .map((entry) =>
        entry.delivery.source === 'semantic_dm'
          ? formatQueuedSemanticDmDelivery(
              entry.delivery.prompt,
              entry.run.acceptedAt ?? entry.run.updatedAt,
              deliveredAt
            )
          : entry.delivery.prompt
      )
      .join('\n\n')
    const trailer = formatQueuedDeliveryRemainderTrailer(
      remainder.map((entry) => {
        if (entry === undefined) return { senderScope: 'unknown' }
        const message =
          entry.delivery.sourceMessageId === undefined
            ? undefined
            : this.db.messages.getById(entry.delivery.sourceMessageId)
        return {
          seq: entry.run.queuedInputSeq,
          senderScope:
            message === undefined ? entry.delivery.source : formatDmAddress(message.from),
        }
      })
    )
    const prompt = `${content}\n\n${trailer}`
    const coalescedMembers = executing.slice(0, -1).map((entry, position) => {
      const sourceMessageId = entry.delivery.sourceMessageId
      if (sourceMessageId === undefined) {
        throw new Error(`coalescible run ${entry.run.runId} has no source message`)
      }
      return { runId: entry.run.runId, sourceMessageId, position }
    })
    const response = await this.dispatchTurnForSession(session, intent, prompt, {
      runId: queued.runId,
      waitForCompletion: false,
      responseFormat: delivery.responseFormat,
      ...(coalescedMembers.length === 0 ? {} : { coalescedMembers }),
    })
    const result = (await response.json()) as DispatchTurnResponse
    if (delivery.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: result.status === 'completed' ? 'completed' : 'started',
        mode: 'headless',
        sessionRef: `${session.scopeRef}/lane:${session.laneRef}`,
        hostSessionId: result.hostSessionId,
        generation: result.generation,
        runtimeId: result.runtimeId,
        runId: result.runId,
        transport: 'headless',
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (queued) {
      const now = timestamp()
      this.db.runs.markCompleted(queued.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: message,
      })
    }
    if (delivery?.sourceMessageId !== undefined) {
      this.db.messages.updateExecution(delivery.sourceMessageId, {
        state: 'failed',
        errorCode: 'delivery_not_guaranteed',
        errorMessage: `input ${delivery.sourceMessageId} was not delivered: ${message}`,
      })
    }
    writeServerLog('WARN', 'turn_input_queue.drain_failed', {
      hostSessionId,
      runId: queued?.runId,
      error: message,
    })
  } finally {
    this.queuedTurnInputDrains.delete(hostSessionId)
  }
}

function assertBrokerPermissionPolicyAdmitted(input: {
  mode: unknown
  hostSessionId: string
  runId: string
  route: string
}): void {
  if (input.mode === 'ask-client') {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.ASK_CLIENT_UNSUPPORTED,
      'ask-client permission mode is unsupported for HRC-owned broker dispatch',
      {
        hostSessionId: input.hostSessionId,
        runId: input.runId,
        route: input.route,
        permissionMode: 'ask-client',
      }
    )
  }
}

export async function startHeadlessBrokerRuntime(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    allowCompilerInitialInputWithoutIdentity?: boolean | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
    onAccepted?: ((runtime: HrcRuntimeSnapshot) => Promise<void> | void) | undefined
  } = {}
): Promise<HrcRuntimeSnapshot> {
  const requestedTurnIntent: HrcRuntimeIntent =
    prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
  // Resolve every approval/artifact/base/path fact before opening the compiler
  // facade or allocating a broker substrate. Actuator prompts are replaced here
  // with the deterministic apply request, so free-form caller text never enters
  // hash-covered invocation material as actuator authority.
  const preparedActuatorSplit = await prepareActuatorSplitIntent(requestedTurnIntent)
  const turnIntent = preparedActuatorSplit.intent
  const now = timestamp()
  const runtimeId = `rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('headless', runtimeId, this.options.stateRoot)

  let handedOffToController = false
  const hrcDispatchEnv = buildHeadlessBrokerDispatchEnv({
    baseEnv: mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch),
    db: this.db,
    runtimeRoot: this.options.runtimeRoot,
    hostSessionId: session.hostSessionId,
    runtimeId,
    mailStopSocket: this.options.socketPath,
  })
  const directPlan =
    turnIntent.harness.id === 'agent-harness' || turnIntent.harness.id === 'pi-sdk'
      ? await buildDirectAgentHarnessPlan({
          intent: turnIntent,
          session,
          runtimeId,
          runId,
          responseFormat: options.responseFormat,
          dispatchEnv: hrcDispatchEnv,
          now,
        })
      : undefined
  if (directPlan !== undefined && hrcDispatchEnv['HARNESS_PI_AUTH_STORE'] === undefined) {
    hrcDispatchEnv['HARNESS_PI_AUTH_STORE'] = join(homedir(), '.pi', 'agent', 'auth.json')
  }
  const client = directPlan === undefined ? await startAspcFacadeBrokerClient(timing) : undefined
  try {
    const compiled =
      directPlan === undefined
        ? await compileBrokerRuntimePlan(
            {
              intent: turnIntent,
              hostSessionId: session.hostSessionId,
              generation: session.generation,
              dispatchEnv: hrcDispatchEnv,
              continuation: toRuntimeContinuationRef(
                automaticContinuationForSession(this.db, session)
              ),
              allowCompilerInitialInputWithoutIdentity:
                options.allowCompilerInitialInputWithoutIdentity,
              responseFormat: options.responseFormat,
            },
            {
              compileHarnessInvocation: (request) => {
                if (client === undefined) {
                  throw new Error('ASPC facade client is unavailable for compiler-backed launch')
                }
                return client.compileHarnessInvocation(request)
              },
              timing,
              ids: {
                requestId: () => `req-${randomUUID()}`,
                operationId: () => `op-${randomUUID()}`,
                runtimeId: () => runtimeId,
                invocationId: () => `inv-${randomUUID()}`,
                initialInputId: () => `input-${randomUUID()}`,
                runId: () => runId,
                traceId: () => `trace-${randomUUID()}`,
              },
            }
          )
        : {
            admitted: true as const,
            ...directPlan,
            dispatchEnv: hrcDispatchEnv,
            diagnostics: [],
          }

    if (!compiled.admitted) {
      throw new HrcRuntimeUnavailableError('headless broker compile/admission rejected', {
        hostSessionId: session.hostSessionId,
        runId,
        code: compiled.code,
        diagnostics: compiled.diagnostics,
        route: 'broker',
      })
    }

    assertBrokerPermissionPolicyAdmitted({
      mode: compiled.profile.policy.permissionPolicy.mode,
      hostSessionId: session.hostSessionId,
      runId,
      route: 'broker',
    })
    const actuatorSplitAuthority = await assertActuatorSplitAdmission({
      intent: turnIntent,
      route: 'broker',
      startRequest: compiled.startRequest,
      preparedAuthority: preparedActuatorSplit.authority,
    })

    // T-01866 — headless durable cutover is UNCONDITIONAL. Every headless broker
    // runtime goes through the controller's leased-tmux + Unix-IPC allocation, so
    // HRC must NOT hand the controller a pre-created stdio broker client (that
    // bypasses substrate allocation and reintroduces the daemon-child lifecycle —
    // spec §10.4). The ASPC facade is used ONLY for compile; it is closed and
    // dropped here before handing off. There is no legacy-stdio route and no
    // HRC_HEADLESS_BROKER_LEGACY_STDIO escape hatch: the controller always
    // allocates a leased substrate + Unix v0.2 endpoint.
    await client?.close().catch(() => undefined)

    const controller = this.getHarnessBrokerController()
    handedOffToController = true
    // T-04921 (T-04905 Phase A) — HRC-owned operator-presentation policy for the
    // codex-app-server dual-tmux viewer route. The DEFAULT policy is sourced from
    // an env var (unset → ordinary headless, behaviour-preserving); the decision
    // gates on driver applicability (codex-app-server only). The trigger is the
    // POLICY, never the driver name alone.
    const operatorPresentation = decideCodexAppServerPresentation({
      operatorPresentation: process.env[HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION_ENV],
      brokerDriver: compiled.profile.brokerDriver,
    })
    const mergedDispatchEnv = { ...(compiled.dispatchEnv ?? {}), ...hrcDispatchEnv }
    const result = await controller.start({
      plan: compiled.plan,
      profile: compiled.profile,
      startRequest: compiled.startRequest,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      identity: compiled.identity,
      runtimeAuthority: actuatorSplitRuntimeAuthority(actuatorSplitAuthority),
      requestedResponseFormat: toBrokerResponseFormat(options.responseFormat),
      ...dispatchRunPersistence(options),
      dispatchEnv: filterBrokerDispatchEnvForLockedEnv(mergedDispatchEnv, compiled.startRequest),
      brokerEnv: extractPiSdkBrokerCredentialEnv(mergedDispatchEnv, compiled.startRequest),
      routeDecision: {
        route: 'broker',
        flag: HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
        selectedBy: 'decideHeadlessExecutionRoute',
        headlessRoute: 'durable-leased',
        brokerTransport: 'unix-jsonrpc-ndjson',
        // The presenter policy the controller routes on: 'tmux-tui' selects the
        // tmux-tui allocator + observer socket; 'none' is ordinary headless.
        operatorPresentation,
      },
      lifecyclePolicy: resolveLifecyclePolicyOverlay({
        routeId: `headless-broker:${compiled.profile.brokerDriver}`,
        brokerRoute: true,
      }),
      ...(options.onAccepted
        ? {
            onAccepted: async (graph) => {
              await options.onAccepted?.(graph.runtime)
            },
          }
        : {}),
    })

    if (!result.ok) {
      const acceptedRun = this.db.runs.getByRunId(runId)
      if (acceptedRun !== null) {
        const failedAt = timestamp()
        this.db.runs.markCompleted(runId, {
          status: 'failed',
          completedAt: failedAt,
          updatedAt: failedAt,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage: result.error.message,
        })
        this.db.brokerInvocations.update(String(compiled.identity.invocationId), {
          invocationState: 'failed',
          updatedAt: failedAt,
        })
        this.db.runtimeOperations.update(String(compiled.identity.operationId), {
          status: 'failed',
          completedAt: failedAt,
          updatedAt: failedAt,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        })
        this.db.runtimes.update(runtimeId, {
          status: 'failed',
          statusChangedAt: failedAt,
          activeRunId: runId,
          updatedAt: failedAt,
          runtimeStateJson: {
            ...(this.db.runtimes.getByRuntimeId(runtimeId)?.runtimeStateJson ?? {}),
            status: 'failed',
            updatedAt: failedAt,
            startFailure: {
              code: result.error.code,
              message: result.error.message,
            },
          },
        })
        const failedEvent = appendHrcEvent(this.db, 'turn.failed', {
          ts: failedAt,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runId,
          runtimeId,
          transport: 'headless',
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          payload: {
            code: result.error.code,
            message: result.error.message,
            phase: 'broker-invocation-start',
          },
        })
        this.notifyEvent(failedEvent)
      }
      if (
        result.error.code === 'unsupported_capability' &&
        options.responseFormat?.kind === 'json_schema'
      ) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.UNSUPPORTED_CAPABILITY,
          result.error.message,
          result.error.detail
        )
      }
      const externalToolchainFailure = typeof result.error.detail['toolchainSource'] === 'string'
      throw new HrcRuntimeUnavailableError(
        externalToolchainFailure ? result.error.message : 'headless broker start failed',
        {
          hostSessionId: session.hostSessionId,
          runId,
          code: result.error.code,
          message: result.error.message,
          route: 'broker',
          ...result.error.detail,
        }
      )
    }

    // `lastAppliedIntentJson` is materialization authority for automatic queued
    // drains and mail delivery. Commit only after the controller has admitted
    // and launched this exact intent; every earlier error therefore leaves the
    // prior authority untouched.
    this.db.sessions.updateIntent(session.hostSessionId, turnIntent, timestamp(), timing)
    return result.runtime
  } catch (error) {
    if (!handedOffToController) {
      await client?.close().catch(() => undefined)
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
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  },
  runtimeStartOwnership?:
    | {
        operation: Promise<HrcRuntimeSnapshot>
        resolve(runtime: HrcRuntimeSnapshot): void
        reject(error: unknown): void
      }
    | undefined
): Promise<Response> {
  // Publish the runtime-producing promise before yielding so crossing dispatches
  // join this boot through handleHeadlessBrokerDispatchTurn's deferral branch.
  // A cold-durable recovery may already own the map across its awaited
  // reattach/cleanup work. In that case keep its promise as the stable join
  // point and settle it from the fresh boot instead of replacing it here.
  const { initialPrompt: _initialPrompt, ...promptlessIntent } = intent
  let resolveAccepted!: (runtime: HrcRuntimeSnapshot) => void
  let rejectAccepted!: (error: unknown) => void
  let acceptedSettled = false
  const accepted = new Promise<HrcRuntimeSnapshot>((resolve, reject) => {
    resolveAccepted = (runtime) => {
      acceptedSettled = true
      resolve(runtime)
    }
    rejectAccepted = reject
  })
  const bootOperation = this.startHeadlessBrokerRuntime(session, promptlessIntent, '', runId, {
    // A promptless Codex seat still receives the compiler-owned agent priming
    // turn. It has no HRC run/input identity because the caller's prompt is
    // submitted separately through the invoke door after boot.
    allowCompilerInitialInputWithoutIdentity: true,
    responseFormat: options.responseFormat,
    ...dispatchRunPersistence(options),
    onAccepted: (runtime) => {
      const acceptedAt = timestamp()
      const acceptedRun = this.db.runs.getByRunId(runId)
      if (acceptedRun === null) {
        this.db.runs.insert({
          runId,
          hostSessionId: session.hostSessionId,
          runtimeId: runtime.runtimeId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          transport: 'headless',
          status: 'accepted',
          acceptedAt,
          updatedAt: acceptedAt,
          invocationId: runtime.activeInvocationId,
          operationId: runtime.activeOperationId,
          dispatchIdempotencyKey: options.dispatchIdempotencyKey,
          ...dispatchOriginRunFields(options),
        })
      } else if (acceptedRun.status === 'accepted') {
        this.db.runs.update(runId, {
          runtimeId: runtime.runtimeId,
          invocationId: runtime.activeInvocationId,
          operationId: runtime.activeOperationId,
          updatedAt: acceptedAt,
        })
      }
      // T-07944: the caller prompt is owed but not yet submitted — the priming
      // turn has to finish first. Make it durable NOW, at acceptance, so a
      // daemon restart in that window can re-arm the submit from the ledger
      // instead of losing the prompt with the process. Written only for the
      // exact shape recovery acts on (accepted, nothing dispatched), so it can
      // never overwrite another route's correlation on the same run row.
      const persistedRun = this.db.runs.getByRunId(runId)
      if (persistedRun?.status === 'accepted' && persistedRun.dispatchedInputId === undefined) {
        this.db.runs.setCorrelationJson(
          runId,
          serializeDurableColdBootTurnInput(prompt, {
            ...dispatchRunPersistence(options),
            responseFormat: options.responseFormat,
          })
        )
      }
      if (this.db.hrcEvents.listByRun(runId, { eventKind: 'turn.accepted' }).length === 0) {
        const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
          ts: acceptedAt,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runId,
          runtimeId: runtime.runtimeId,
          transport: 'headless',
          payload: {
            promptLength: prompt.length,
            authority: 'durable-start-graph',
          },
        })
        this.notifyEvent(acceptedEvent)
      }
      resolveAccepted(runtime)
    },
  })
    .then((runtime) => {
      // Detached acceptance must not wait for presentation, but completion of
      // the background boot still owns the best-effort presentation publish.
      // The attachability gate that used to stand here is redundant:
      // publishPresentation computes `operatorAttachable` itself and records it
      // either way, and the in-daemon spawn it fronts re-checks the predicate.
      void this.publishPresentation(runtime, { signal: this.runtimeStartPresentationSignal })
      if (!acceptedSettled) resolveAccepted(runtime)
      return runtime
    })
    .finally(() => {
      const publishedOperation = runtimeStartOwnership?.operation ?? bootOperation
      if (this.runtimeStartOperations.get(session.hostSessionId) === publishedOperation) {
        this.runtimeStartOperations.delete(session.hostSessionId)
      }
    })
  if (runtimeStartOwnership) {
    void bootOperation.then(runtimeStartOwnership.resolve, runtimeStartOwnership.reject)
  } else {
    this.runtimeStartOperations.set(session.hostSessionId, bootOperation)
  }
  void bootOperation.catch((error) => {
    if (!acceptedSettled) rejectAccepted(error)
  })
  if (options.waitForCompletion === false) {
    // T-07944: this detached chain owns the caller prompt until the priming turn
    // ends. It used to `.catch(() => undefined)`, which left an accepted run with
    // no continuation and no record of why — the sweep then buried it as a zombie
    // 30 minutes later and the sender was told a lie. Every failure now lands as
    // a positively reason-coded `turn.failed` on the run itself.
    void bootOperation
      .then(async (runtime) => {
        await waitForCompilerPrimingTerminal(this, runtime, this.runtimeStartPresentationSignal)
        await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, options)
      })
      .catch((error: unknown) => {
        failColdBootInputContinuation(this, runId, {
          errorCode: HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED,
          phase: 'cold-boot-input-continuation',
          error,
        })
      })
    const runtime = await accepted
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponseBase)
  }
  const runtime = await bootOperation
  await waitForCompilerPrimingTerminal(this, runtime, this.runtimeStartPresentationSignal)
  return await this.executeHeadlessBrokerInputTurn(session, runtime, prompt, runId, {
    ...options,
    waitForCompletion: false,
  })
}

/**
 * Terminalize a cold-birth accepted run whose owed prompt can no longer be
 * submitted (T-07944).
 *
 * The reason code is POSITIVE — it names what was lost — so the mail drive that
 * is waiting on this run fails truthfully and at once, instead of the sender
 * being told 30 minutes later that the turn "had no events" while the agent had
 * in fact already run.
 *
 * Idempotent by construction: a run that already reached a terminal status, or
 * that got its prompt dispatched after all, is left exactly as it is.
 */
export function failColdBootInputContinuation(
  server: HrcServerInstanceForHandlers,
  runId: string,
  input: {
    errorCode:
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_LOST
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED
    phase: string
    error?: unknown
    detail?: Record<string, unknown> | undefined
  }
): boolean {
  try {
    return writeColdBootInputContinuationFailure(server, runId, input)
  } catch (writeError) {
    // The detached continuation can outlive the store: a daemon stop aborts the
    // priming wait, and `stop()` closes the DB without draining this chain. A
    // closed store is not a failure to record — the run stays `accepted`, and
    // the NEXT startup's recovery pass is what disposes it.
    if (isClosedDbError(writeError)) return false
    throw writeError
  }
}

function writeColdBootInputContinuationFailure(
  server: HrcServerInstanceForHandlers,
  runId: string,
  input: {
    errorCode:
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_LOST
      | typeof HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED
    phase: string
    error?: unknown
    detail?: Record<string, unknown> | undefined
  }
): boolean {
  const run = server.db.runs.getByRunId(runId)
  if (run === null || run.status !== 'accepted' || run.dispatchedInputId !== undefined) {
    return false
  }
  const message =
    input.error === undefined
      ? 'cold-birth accepted run lost the continuation that owed its prompt'
      : input.error instanceof Error
        ? input.error.message
        : String(input.error)
  const failedAt = timestamp()
  server.db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: failedAt,
    updatedAt: failedAt,
    errorCode: input.errorCode,
    errorMessage: message,
  })
  writeServerLog('ERROR', 'broker.cold_boot_input.continuation_failed', {
    runId,
    runtimeId: run.runtimeId,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    errorCode: input.errorCode,
    phase: input.phase,
    error: message,
    ...(input.detail ?? {}),
  })
  const failedEvent = appendHrcEvent(server.db, 'turn.failed', {
    ts: failedAt,
    hostSessionId: run.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: run.generation,
    runId,
    ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
    transport: 'headless',
    errorCode: input.errorCode,
    payload: {
      code: input.errorCode,
      message,
      phase: input.phase,
      ...(input.detail ?? {}),
    },
  })
  server.notifyEvent(failedEvent)
  return true
}

export async function executeHeadlessBrokerInputTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  prompt: string,
  runId: string,
  options: DispatchRunPersistenceOptions & {
    waitForCompletion?: boolean | undefined
    repairCorrelation?: JsonRepairRunCorrelation | undefined
    responseFormat?: HrcTurnResponseFormat | undefined
  }
): Promise<Response> {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.BROKER_DESCRIPTOR_ABSENT,
      'headless broker runtime has no active invocation descriptor',
      {
        runtimeId: runtime.runtimeId,
        runId,
        route: 'broker',
      }
    )
  }
  assertRuntimeSupportsResponseFormat({
    db: this.db,
    runtime,
    responseFormat: options.responseFormat,
    route: 'broker',
  })

  const preacceptedRun = this.db.runs.getByRunId(runId)
  const now = timestamp()
  if (preacceptedRun) {
    if (preacceptedRun.status !== 'accepted') {
      throw new HrcRuntimeUnavailableError('preaccepted broker input is not dispatchable', {
        runtimeId: runtime.runtimeId,
        runId,
        status: preacceptedRun.status,
        route: 'broker',
      })
    }
    this.db.runs.update(runId, {
      runtimeId: runtime.runtimeId,
      invocationId,
      operationId: runtime.activeOperationId,
      updatedAt: now,
    })
  } else {
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
      dispatchIdempotencyKey: options.dispatchIdempotencyKey,
      ...dispatchOriginRunFields(options),
    })
  }
  if (options.repairCorrelation !== undefined) {
    this.db.runs.setCorrelationJson(runId, JSON.stringify(options.repairCorrelation))
  }
  if (options.submissionDoor !== 'enqueue') {
    armFirstTurnWatch(this.db, {
      runtimeId: runtime.runtimeId,
      generation: session.generation,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      runId,
      invocationId,
      transport: 'headless',
      timeoutMsOverride: options.firstTurnTimeoutMs,
      primingDispatchedAt: now,
    })
  }
  const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runId,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    payload: createUserPromptPayload(prompt),
  })
  this.notifyEvent(userPromptEvent)

  const dispatchToBroker = () =>
    submitThroughBrokerDoor(
      this.getHarnessBrokerController(),
      options.submissionDoor ?? 'enqueue',
      {
        runtimeId: runtime.runtimeId,
        body: prompt,
        origin: submissionOrigin(session.scopeRef, options),
        ...(toBrokerResponseFormat(options.responseFormat) !== undefined
          ? { responseFormat: toBrokerResponseFormat(options.responseFormat) }
          : {}),
        ...(options.freshContext !== undefined ? { freshContext: options.freshContext } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.turnPolicy !== undefined ? { turnPolicy: options.turnPolicy } : {}),
      }
    )

  // T-01996: wait for the post-restart serving-controller warmup so the first
  // dispatch sees the broker already bound instead of racing a cold controller.
  // The promise is `.catch`-wrapped to always resolve; if warmup failed/absent we
  // fall through to the lazy reattach path below. Never wedges.
  await this.brokerWarmupComplete

  let result = await dispatchToBroker()

  // T-01884: a durable HEADLESS broker that survived a daemon restart has live
  // broker state, but this daemon's request-serving controller is COLD —
  // startup reconcile attaches on a throwaway controller (ownership gap), so the
  // first input fails `broker_runtime_not_active` even when the runtime row is
  // 'ready'. Lazily reattach the persisted durable endpoint onto the
  // request-serving controller and retry on the SAME broker (continuity, no
  // re-alloc). Reports unavailable for non-durable runtimes. Mirrors the interactive
  // path's reattach-on-dispatch (broker-interactive-handlers), minus the
  // transport==='tmux' gate so durable HEADLESS benefits.
  if (
    !result.ok &&
    result.error.code === 'broker_runtime_not_active' &&
    (
      await reattachDurableBrokerForDispatch(this.db, runtime, {
        runtimeRoot: this.options.runtimeRoot,
        controller: this.getHarnessBrokerController(),
        inFlightOperations: this.brokerReattachOperations,
        brokerUnixClientFactory:
          this.brokerUnixClientFactory ??
          ((options) =>
            connectObservedBrokerUnixClient(options) as ReturnType<BrokerUnixClientFactory>),
      })
    ).state === 'reattached'
  ) {
    writeServerLog('INFO', 'headless.durable_reattach.dispatch_recovered', {
      runtimeId: runtime.runtimeId,
      runId,
    })
    result = await dispatchToBroker()
  }

  if (result.ok) {
    this.db.runs.update(runId, {
      brokerSubmissionId: result.response.submissionId,
      dispatchedInputId: result.response.submissionId,
      updatedAt: timestamp(),
    })
  }

  if (result.ok && result.response.admission === 'rejected') {
    const completedAt = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorMessage: result.response.reason ?? 'broker rejected submission',
    })
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'started',
      supportsInFlightInput: false,
      submissionId: result.response.submissionId,
      admission: result.response.admission,
      ...(result.response.reason !== undefined ? { reason: result.response.reason } : {}),
    } satisfies DispatchTurnResponseBase)
  }

  if (!result.ok) {
    const completedAt = timestamp()
    const errorMessage = result.error.message
    const brokerErrorCode = result.error.code
    const brokerInputTimeout = brokerErrorCode.endsWith('_timeout')
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    const brokerBindingMissing = result.error.code === 'broker_runtime_not_active'
    // T-04297: the lazy reattach above may have just STALED this runtime (lease
    // substrate gone after a host reboot, attach/replay failure, lease identity
    // mismatch). Re-read the row and treat an unavailable status as terminal —
    // writing 'ready' back here would resurrect the zombie the reattach just
    // reaped, and the "usually transient — just retry" recommendation would
    // loop the identical failure forever.
    const currentRuntime = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
    const runtimeReapedByReattach =
      currentRuntime != null && isRuntimeUnavailableStatus(currentRuntime.status)
    // T-05358: a rejection in a transient non-dispatchable state (starting/
    // stopping) is reprovision-worthy too — keeping the runtime `ready` here
    // re-arms it for the next reuse and loops the identical failure.
    const reprovisionRequired =
      runtimeReapedByReattach ||
      isTerminalBrokerInvocationState(invocation?.invocationState) ||
      isTransitionalBrokerInvocationState(invocation?.invocationState) ||
      brokerInputTimeout ||
      isTerminalBrokerInputFailure(errorMessage) ||
      isTransientBrokerInputStateFailure(errorMessage)
    if (brokerInputTimeout) {
      this.db.runs.fenceBrokerInput(runId, {
        fencedAt: completedAt,
        reason: brokerErrorCode,
      })
    }
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt,
      updatedAt: completedAt,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    this.db.runtimes.update(runtime.runtimeId, {
      status: reprovisionRequired ? 'stale' : 'ready',
      statusChangedAt: completedAt,
      ...runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'turn',
        occurredAt: completedAt,
        updatedAt: completedAt,
      }),
      ...(reprovisionRequired
        ? {
            runtimeStateJson: {
              // Spread the FRESH row state — the reattach may have just written
              // control/lastAttachError there; the stale in-memory snapshot
              // would clobber it.
              ...(currentRuntime?.runtimeStateJson ?? runtime.runtimeStateJson ?? {}),
              status: 'stale',
              updatedAt: completedAt,
              terminalInvocation: {
                invocationId,
                reason: errorMessage,
                ...(brokerInputTimeout ? { code: brokerErrorCode } : {}),
              },
            },
          }
        : {}),
    })
    const { headline, recommendation } = classifyBrokerInputFailure({
      label: 'headless',
      errorMessage,
      brokerBindingMissing,
      reprovisionRequired,
    })
    throw new HrcRuntimeUnavailableError(headline, {
      runtimeId: runtime.runtimeId,
      runId,
      invocationId,
      route: 'broker',
      cause: errorMessage,
      error: errorMessage,
      recommendation,
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
      supportsInFlightInput: false,
      submissionId: result.response.submissionId,
      admission: result.response.admission,
    } satisfies DispatchTurnResponseBase)
  }

  await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
  return json({
    runId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'headless',
    status: 'completed',
    supportsInFlightInput: false,
    submissionId: result.response.submissionId,
    admission: result.response.admission,
  } satisfies DispatchTurnResponseBase)
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
          statusChangedAt: run.completedAt ?? now,
          ...runtimeActivityPatch(this.db, runtimeId, {
            source: 'housekeeping',
            updatedAt: now,
          }),
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
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
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
  enqueueDurableHeadlessTurnInput,
  dispatchQueuedHeadlessTurnInput,
  drainDurableHeadlessTurnInputs,
  waitForInteractiveBrokerRunCompletion,
  waitForHeadlessBrokerRunCompletion,
  recordDetachedHeadlessTurnFailure,
}

export type BrokerHeadlessHandlersMethods = typeof brokerHeadlessHandlersMethods
