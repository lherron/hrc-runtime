import { randomUUID } from 'node:crypto'
import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  DispatchTurnResponse,
  DispatchTurnTerminalOutcome,
  EnqueueSubmissionRequest,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcSubmissionDoorReport,
  HrcSubmissionResponse,
  InvokeSubmissionRequest,
  PreemptSubmissionRequest,
} from 'hrc-core'
import { appendHrcEvent } from './hrc-event-helper.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody, parseSubmissionRequest } from './server-parsers.js'
import { assertDispatchRunId, json, timestamp } from './server-util.js'
import { submissionResponse, submitThroughAdmission } from './turn-admission/submit.js'
import type { DispatchTurnForSessionOptions } from './turn-dispatch-session-dispatch.js'
import {
  type InFlightIdempotentDispatch,
  type PublicDispatchWaitStage,
  type SubmissionDoor,
  type SubmissionDoorRequest,
  format2RequestHash,
  idempotentDispatches,
  joinedOutcome,
  publicDoorReport,
  resolveSubmissionTarget,
  runOriginFromSubmission,
  submissionDoorReport,
  terminalOutcome,
  waitForSubmissionTerminal,
} from './turn-dispatch-submission-support.js'

export async function handleSubmission(
  this: HrcServerInstanceForHandlers,
  request: Request,
  door: SubmissionDoor
): Promise<Response> {
  const raw = await parseJsonBody(request)
  const body: SubmissionDoorRequest =
    door === 'steer'
      ? parseSubmissionRequest(raw, 'steer')
      : door === 'enqueue'
        ? parseSubmissionRequest(raw, 'enqueue')
        : door === 'invoke'
          ? parseSubmissionRequest(raw, 'invoke')
          : parseSubmissionRequest(raw, 'preempt')
  const session = resolveSubmissionTarget(this, body.target, door !== 'steer')
  if (session === null) {
    throw new HrcRuntimeUnavailableError('submission target is unavailable', {
      target: body.target,
      door,
    })
  }
  const executionFormat = body.executionFormat ?? 'format1'
  const wait = 'wait' in body && body.wait === true
  const idempotencyKey = body.idempotencyKey
  const sessionBoundBody =
    door === 'steer'
      ? undefined
      : (body as EnqueueSubmissionRequest | InvokeSubmissionRequest | PreemptSubmissionRequest)
  const runId = executionFormat === 'format2' ? undefined : `run-${randomUUID()}`
  const invokeColdBirthPromptMode =
    door === 'invoke' ? (body as InvokeSubmissionRequest).coldBirth?.promptMode : undefined
  const allowLaunchReceipt = door === 'invoke' && !wait && invokeColdBirthPromptMode !== undefined
  const admitted = await submitThroughAdmission(
    this,
    {
      door: 'submission',
      signal: request.signal,
      intent: door,
      target: session,
      body: body.body,
      principal: body.origin.principalRef,
      executionFormat,
      responseFormat: body.responseFormat,
      runtimeIntent: sessionBoundBody?.runtimeIntent,
      carried: {
        ownershipProof: sessionBoundBody?.establishedBrokerInvocationId,
        idempotencyKey,
        freshContext: body.freshContext,
      },
      ...(door === 'preempt' ? { preemptRequest: body as PreemptSubmissionRequest } : {}),
      options: { ...(runId !== undefined ? { runId } : {}), executionFormat, submissionDoor: door },
      pendingReplay: async (resolvedSession) => {
        if (idempotencyKey === undefined) return undefined
        const pending = idempotentDispatches
          .get(this)
          ?.get(`${resolvedSession.hostSessionId}\u0000${idempotencyKey}`)
        if (pending === undefined) return undefined
        const recorded = echoPersistedBrokerExecutionFormat(this, await pending.promise)
        return {
          format: recorded.executionFormat ?? 'format1',
          project: () =>
            waitForPublicDispatchStage(
              this,
              recorded,
              wait ? 'terminal' : 'accepted',
              true,
              request.signal,
              true,
              publicDoorReport(door, submissionDoorReport(this, session, door))
            ),
        }
      },
      replay: async (run) =>
        waitForPublicDispatchStage(
          this,
          replayDispatchBody(this, run),
          wait ? 'terminal' : 'accepted',
          true,
          request.signal,
          true,
          publicDoorReport(door, submissionDoorReport(this, session, door))
        ),
    },
    async (plan) => {
      const session = plan.session
      const intent = plan.runtimeIntent
      const doorReport = plan.doorReport ?? submissionDoorReport(this, session, door)
      const effectiveDoor = plan.effectiveDoor
      const operationKey =
        idempotencyKey !== undefined ? `${session.hostSessionId}\u0000${idempotencyKey}` : undefined
      const operations =
        idempotentDispatches.get(this) ?? new Map<string, InFlightIdempotentDispatch>()
      if (!idempotentDispatches.has(this)) idempotentDispatches.set(this, operations)
      const dispatchPromise = dispatchPublicSubmission(this, session, intent, body.body, {
        ...plan.options,
        admissionPlan: plan,
        ...(runId !== undefined ? { runId } : {}),
        executionFormat,
        ...(executionFormat === 'format2'
          ? {
              format2RequestHash: format2RequestHash({
                hostSessionId: session.hostSessionId,
                door,
                request: body,
              }),
            }
          : {}),
        // An ordinary submission response is not complete until the broker has
        // minted its identity. A non-waiting cold invoke instead ends at the
        // durable start graph so provider execution cannot hold the launch RPC.
        waitForCompletion: !allowLaunchReceipt,
        submissionDoor: door === 'invoke' ? 'invoke' : effectiveDoor,
        submissionOrigin: body.origin,
        origin: runOriginFromSubmission(body.origin),
        responseFormat: body.responseFormat,
        freshContext: body.freshContext,
        ...(invokeColdBirthPromptMode !== undefined
          ? { coldBirthPromptMode: invokeColdBirthPromptMode }
          : {}),
        ...('ttlMs' in body && body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
        ...('turnPolicy' in body && body.turnPolicy !== undefined
          ? { turnPolicy: body.turnPolicy }
          : {}),
        ...(sessionBoundBody?.establishedBrokerInvocationId !== undefined
          ? { establishedBrokerInvocationId: sessionBoundBody.establishedBrokerInvocationId }
          : {}),
        ...(idempotencyKey !== undefined ? { dispatchIdempotencyKey: idempotencyKey } : {}),
        requireSubmissionIdentity: true,
      })
      if (operationKey !== undefined) operations.set(operationKey, { promise: dispatchPromise })
      let publicResponse: DispatchTurnResponse
      try {
        publicResponse = await dispatchPromise
      } finally {
        if (
          operationKey !== undefined &&
          operations.get(operationKey)?.promise === dispatchPromise
        ) {
          operations.delete(operationKey)
        }
      }
      if (doorReport.requestedDoor !== undefined) {
        const runtimeId = publicResponse.runtimeId ?? doorReport.runtime?.runtimeId
        const invocationId =
          publicResponse.observation?.broker?.selector.invocationId ??
          doorReport.runtime?.activeInvocationId
        const payload = {
          ...(runtimeId !== undefined ? { runtimeId } : {}),
          ...(invocationId !== undefined ? { invocationId } : {}),
          ...(publicResponse.submissionId !== undefined
            ? { submissionId: publicResponse.submissionId }
            : {}),
          requestedDoor: doorReport.requestedDoor,
          effectiveDoor,
          reason: doorReport.downgradeReason,
          ...(body.origin.envelopeId !== undefined ? { envelopeId: body.origin.envelopeId } : {}),
        }
        appendHrcEvent(this.db, 'submission.door_downgraded', {
          ts: timestamp(),
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          ...(runtimeId !== undefined ? { runtimeId } : {}),
          runId,
          payload,
        })
      }
      const response = await waitForPublicDispatchStage(
        this,
        publicResponse,
        wait ? 'terminal' : 'accepted',
        false,
        request.signal,
        true,
        publicDoorReport(door, doorReport)
      )
      return publicResponse.admission === 'rejected'
        ? {
            kind: 'rejected_unlanded',
            rejection: { source: 'positive-rejection', value: response },
          }
        : { kind: 'accepted', value: response }
    }
  )
  return submissionResponse(admitted)
}

function publicDispatchBody(
  body: Omit<DispatchTurnResponse, 'stage' | 'status' | 'outcome' | 'replayed' | 'error'> & {
    status?: string | undefined
  },
  stage: DispatchTurnResponse['stage'],
  options: {
    replayed: boolean
    outcome?: DispatchTurnTerminalOutcome | undefined
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
): DispatchTurnResponse {
  const status =
    stage === 'accepted'
      ? 'accepted'
      : stage === 'turn_started'
        ? 'started'
        : (options.outcome ?? 'failed')
  return {
    ...body,
    stage,
    status,
    replayed: options.replayed,
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...(options.errorMessage !== undefined
      ? {
          error: {
            ...(options.errorCode !== undefined ? { code: options.errorCode } : {}),
            message: options.errorMessage,
          },
        }
      : {}),
  } as DispatchTurnResponse
}

export async function dispatchPublicSubmission(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  /** Absent for a participant, which is routed by durable linkage (R7.6). */
  intent: HrcRuntimeIntent | undefined,
  prompt: string,
  options: DispatchTurnForSessionOptions & { requireSubmissionIdentity?: boolean | undefined }
): Promise<DispatchTurnResponse> {
  const { requireSubmissionIdentity = false, ...dispatchOptions } = options
  const response = await server.dispatchTurnForSession(session, intent, prompt, dispatchOptions)
  const dispatched = (await response.json()) as DispatchTurnResponse
  const isFormat2InputReceipt =
    dispatchOptions.executionFormat === 'format2' && dispatched.inputId !== undefined
  if (
    requireSubmissionIdentity &&
    !isFormat2InputReceipt &&
    (dispatched.submissionId === undefined || dispatched.admission === undefined)
  ) {
    throw new HrcRuntimeUnavailableError('broker submission returned no admission identity', {
      hostSessionId: session.hostSessionId,
      runId: dispatchOptions.runId,
      door: dispatchOptions.submissionDoor,
    })
  }
  const run =
    dispatchOptions.runId !== undefined
      ? server.db.runs.getByRunId(dispatchOptions.runId)
      : undefined
  const outcome = run ? terminalOutcome(run.status) : undefined
  return publicDispatchBody(dispatched, outcome === undefined ? 'accepted' : 'terminal', {
    replayed: false,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run?.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run?.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
}

export function replayDispatchBody(
  server: HrcServerInstanceForHandlers,
  run: NonNullable<ReturnType<HrcServerInstanceForHandlers['db']['runs']['getByRunId']>>
): DispatchTurnResponse {
  const runtime =
    run.runtimeId !== undefined ? server.db.runtimes.getByRuntimeId(run.runtimeId) : null
  const invocationId = run.invocationId ?? runtime?.activeInvocationId
  const firstLifecycleSeq =
    server.db.hrcEvents.listByRun(run.runId).map((event) => event.hrcSeq)[0] ??
    server.db.hrcEvents.maxHrcSeq() + 1
  const base = {
    runId: run.runId,
    hostSessionId: run.hostSessionId,
    generation: run.generation,
    ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
    transport: (runtime?.transport ?? run.transport) as DispatchTurnResponse['transport'],
    // Broker-headless runtime rows remain queue-capable internally, but the
    // public in-flight endpoint is SDK-only. Preserve the same truthful
    // capability projection on idempotent replay as on the original response.
    supportsInFlightInput:
      runtime === null || runtime.transport === 'headless' ? false : runtime.supportsInflightInput,
    ...(invocationId !== undefined
      ? { startIdentity: { kind: 'broker', invocationId } as const }
      : runtime !== null
        ? { startIdentity: { kind: 'sdk' } as const }
        : {}),
    observation: {
      lifecycle: {
        selector: {
          runId: run.runId,
          ...(run.runtimeId !== undefined ? { runtimeId: run.runtimeId } : {}),
          generation: run.generation,
        },
        fromSeq: firstLifecycleSeq,
      },
      ...(invocationId !== undefined && run.runtimeId !== undefined
        ? {
            broker: {
              selector: {
                invocationId,
                runId: run.runId,
                runtimeId: run.runtimeId,
                generation: run.generation,
              },
              afterSeq: 0,
            },
          }
        : {}),
    },
    ...(run.brokerSubmissionId !== undefined
      ? { submissionId: run.brokerSubmissionId, admission: 'admitted' as const }
      : {}),
  }
  const outcome = terminalOutcome(run.status)
  return publicDispatchBody(base, outcome === undefined ? 'accepted' : 'terminal', {
    replayed: true,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
}

/**
 * A broker-backed public receipt must report the format HRC froze durably for
 * that exact invocation. Request data cannot prove the selected format: it may
 * be a stale retry or a client talking to an older server. Legacy non-broker
 * responses have no invocation to prove and retain their existing shape.
 */
export function echoPersistedBrokerExecutionFormat(
  server: Pick<HrcServerInstanceForHandlers, 'db'>,
  dispatch: DispatchTurnResponse
): DispatchTurnResponse {
  const startInvocationId =
    dispatch.startIdentity?.kind === 'broker' ? dispatch.startIdentity.invocationId : undefined
  const observedInvocationId = dispatch.observation?.broker?.selector.invocationId
  if (
    startInvocationId !== undefined &&
    observedInvocationId !== undefined &&
    startInvocationId !== observedInvocationId
  ) {
    throw new HrcRuntimeUnavailableError('broker response has conflicting invocation identities', {
      code: 'execution_format_unproved',
      startInvocationId,
      observedInvocationId,
    })
  }
  const invocationId = startInvocationId ?? observedInvocationId
  if (invocationId === undefined) return dispatch

  const invocation = server.db.brokerInvocations.getByInvocationId(invocationId)
  if (invocation === null) {
    throw new HrcRuntimeUnavailableError('broker response has no persisted invocation format', {
      code: 'execution_format_unproved',
      invocationId,
    })
  }
  return { ...dispatch, executionFormat: invocation.executionFormat ?? 'format1' }
}

export async function waitForPublicDispatchStage(
  server: HrcServerInstanceForHandlers,
  base: DispatchTurnResponse,
  requested: PublicDispatchWaitStage,
  replayed: boolean,
  signal: AbortSignal = new AbortController().signal,
  requireSubmissionIdentity = false,
  /** Submission doors only: which door the body actually went through (T-08536). */
  doorReport: HrcSubmissionDoorReport | undefined = undefined
): Promise<Response> {
  const provenBase = echoPersistedBrokerExecutionFormat(server, base)
  const invocationId = provenBase.observation?.broker?.selector.invocationId
  // Legacy drivers can report terminal without broker identity. Preserve their
  // projection-less success; identified submissions can be projected from the
  // durable ledger even when completion won the race with waiter attachment.
  if (
    requested === 'accepted' ||
    (provenBase.stage === 'terminal' &&
      (provenBase.submissionId === undefined || invocationId === undefined))
  ) {
    const dispatch = { ...provenBase, replayed }
    return json(
      { ...projectSubmissionResponse(dispatch, {}, requireSubmissionIdentity), ...doorReport },
      provenBase.stage === 'accepted' && provenBase.admission !== 'rejected' ? 202 : 200
    )
  }

  if (provenBase.submissionId === undefined || invocationId === undefined) {
    throw new HrcRuntimeUnavailableError('dispatch wait requires broker submission identity', {
      runId: provenBase.runId,
      requested,
    })
  }
  assertDispatchRunId(provenBase)
  const projection = await waitForSubmissionTerminal(server, {
    invocationId,
    runId: provenBase.runId,
    submissionId: provenBase.submissionId,
    signal,
    waitForTurnTerminal: requested === 'terminal',
  })
  const run = server.db.runs.getByRunId(provenBase.runId)
  const outcome =
    run === null ? undefined : (terminalOutcome(run.status) ?? joinedOutcome(projection))
  const dispatch = publicDispatchBody(provenBase, requested, {
    replayed,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(run?.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(run?.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
  })
  return json(
    {
      ...projectSubmissionResponse(dispatch, projection, requireSubmissionIdentity),
      ...doorReport,
    },
    200
  )
}

export function projectSubmissionResponse(
  dispatch: DispatchTurnResponse,
  projection: Pick<HrcSubmissionResponse, 'disposition' | 'terminal'> = {},
  requireSubmissionIdentity = false
): DispatchTurnResponse | HrcSubmissionResponse {
  if (dispatch.submissionId === undefined || dispatch.admission === undefined) {
    // Format2's durable admission is its inputId; it has no broker submission
    // or execution run until native observation later establishes one.
    if (requireSubmissionIdentity && dispatch.inputId === undefined) {
      throw new HrcRuntimeUnavailableError('broker submission returned no admission identity', {
        runId: dispatch.runId,
      })
    }
    return dispatch
  }
  const disposition = projection.disposition
  if (dispatch.admission === 'rejected') {
    return {
      submissionId: dispatch.submissionId,
      admission: 'rejected',
      ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      disposition: disposition ?? {
        type: 'rejected',
        reason: dispatch.reason ?? 'rejected',
      },
    } satisfies HrcSubmissionResponse
  }
  if (
    disposition?.type === 'rejected' ||
    disposition?.type === 'expired' ||
    disposition?.type === 'cancelled' ||
    disposition?.type === 'lost'
  ) {
    return {
      submissionId: dispatch.submissionId,
      admission: 'admitted',
      ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
      disposition,
    } satisfies HrcSubmissionResponse
  }
  return {
    ...dispatch,
    submissionId: dispatch.submissionId,
    admission: 'admitted',
    ...(dispatch.reason !== undefined ? { reason: dispatch.reason } : {}),
    ...projection,
  }
}
