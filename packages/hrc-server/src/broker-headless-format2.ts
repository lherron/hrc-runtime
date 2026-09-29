import { randomUUID } from 'node:crypto'
import { HrcConflictError, HrcErrorCode, HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcInputRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcTurnResponseFormat,
} from 'hrc-core'
import { trackAppIdentityOperation } from './app-session-identity.js'
import { CALLER_SURFACE_REUSE_REFUSAL } from './broker-decisions.js'
import { submissionOrigin, submitThroughBrokerDoor } from './broker/submission-doors.js'
import { appendHrcEventWithinExistingTransaction } from './hrc-event-helper.js'
import { recordStartBirth, startBirthOfIntent } from './presentation-operator.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { type DispatchRunPersistenceOptions, dispatchRunPersistence } from './server-types.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { toBrokerResponseFormat } from './turn-response-format.js'

type Format2HeadlessDispatchOptions = DispatchRunPersistenceOptions & {
  executionFormat: 'format2'
  waitForCompletion?: boolean | undefined
  responseFormat?: HrcTurnResponseFormat | undefined
  establishedBrokerInvocationId?: string | undefined
}

type Format2AcceptedStart = {
  runtime: HrcRuntimeSnapshot
  input: HrcInputRecord
}

function format2AdmissionAfterSeq(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  input: HrcInputRecord
): number {
  if (input.invocationId === undefined || input.runtimeId === undefined) {
    throw new HrcRuntimeUnavailableError('format2 input has no durable invocation placement', {
      inputId: input.inputId,
      hostSessionId: session.hostSessionId,
    })
  }
  const afterSeq = server.db.hrcEvents.findInputAdmissionAfterSeq({
    inputId: input.inputId,
    runtimeId: input.runtimeId,
    invocationId: input.invocationId,
  })
  if (afterSeq === null) {
    throw new HrcRuntimeUnavailableError('format2 input is missing its durable admission fence', {
      inputId: input.inputId,
      runtimeId: input.runtimeId,
      invocationId: input.invocationId,
      hostSessionId: session.hostSessionId,
    })
  }
  return afterSeq
}

function format2Receipt(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  accepted: Format2AcceptedStart
): Response {
  const { runtime, input } = accepted
  if (input.invocationId === undefined || input.runtimeId === undefined) {
    throw new HrcRuntimeUnavailableError('format2 input has no durable invocation placement', {
      inputId: input.inputId,
      hostSessionId: session.hostSessionId,
    })
  }
  const afterSeq = format2AdmissionAfterSeq(server, session, input)
  return json({
    inputId: input.inputId,
    hostSessionId: session.hostSessionId,
    generation: runtime.generation,
    runtimeId: input.runtimeId,
    transport: 'headless',
    executionFormat: 'format2',
    status: 'accepted',
    supportsInFlightInput: false,
    startIdentity: { kind: 'broker', invocationId: input.invocationId },
    observation: {
      broker: {
        selector: {
          invocationId: input.invocationId,
          runtimeId: input.runtimeId,
          generation: runtime.generation,
        },
        afterSeq,
      },
    },
  })
}

function assertFormat2DispatchIdentity(
  session: HrcSessionRecord,
  options: Format2HeadlessDispatchOptions
): { idempotencyKey: string; requestHash: string } {
  if (options.dispatchIdempotencyKey === undefined || options.format2RequestHash === undefined) {
    throw new HrcConflictError(
      HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
      'format2 dispatch requires an idempotency key and canonical request hash',
      {
        hostSessionId: session.hostSessionId,
        ...(options.dispatchIdempotencyKey === undefined
          ? { missing: 'dispatchIdempotencyKey' }
          : {}),
        ...(options.format2RequestHash === undefined ? { missing: 'format2RequestHash' } : {}),
      }
    )
  }
  return {
    idempotencyKey: options.dispatchIdempotencyKey,
    requestHash: options.format2RequestHash,
  }
}

function reserveWarmFormat2Input(
  server: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  input: { inputId: string; idempotencyKey: string; requestHash: string },
  options: Format2HeadlessDispatchOptions
): HrcInputRecord {
  const invocationId = runtime.activeInvocationId
  const operationId = runtime.activeOperationId
  if (invocationId === undefined || operationId === undefined) {
    throw new HrcRuntimeUnavailableError('format2 runtime has no invocation placement', {
      runtimeId: runtime.runtimeId,
      hostSessionId: session.hostSessionId,
    })
  }
  const now = timestamp()
  return server.db.sqlite.transaction(() => {
    const afterSeq = server.db.brokerInvocationEvents.maxBrokerSeq(invocationId)
    const admitted = server.db.inputs.insert({
      inputId: input.inputId,
      admissionHostSessionId: session.hostSessionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      operationId,
      invocationId,
      door: options.submissionDoor,
      admissionClass: options.submissionDoor,
      ...(options.origin !== undefined ? { origin: JSON.stringify(options.origin) } : {}),
      status: 'accepted',
      cleanupProtection: 'protected',
      admittedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    appendHrcEventWithinExistingTransaction(server.db, 'input.admitted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      payload: {
        inputId: admitted.inputId,
        idempotencyKey: admitted.idempotencyKey,
        requestHash: admitted.requestHash,
        invocationId: admitted.invocationId,
        afterSeq,
        door: admitted.door,
      },
    })
    return admitted
  })()
}

/**
 * Rev11's runless admission path. A format-2 initial input is reserved by the
 * start graph; a later input into the same frozen invocation receives the
 * identical durable reservation before its submission RPC. Neither path mints
 * an admission run or stores `submission_admissions.run_id`.
 */
export async function executeHeadlessBrokerFormat2DispatchTurn(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  prompt: string,
  options: Format2HeadlessDispatchOptions
): Promise<Response> {
  const identity = assertFormat2DispatchIdentity(session, options)
  const existing = this.db.inputs.getByAdmission(session.hostSessionId, identity.idempotencyKey)
  if (existing !== null) {
    if (existing.requestHash !== identity.requestHash) {
      throw new HrcConflictError(
        HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'format2 idempotency key was replayed with a different request',
        {
          hostSessionId: session.hostSessionId,
          idempotencyKey: identity.idempotencyKey,
          existingInputId: existing.inputId,
        }
      )
    }
    const runtime =
      existing.runtimeId === undefined ? null : this.db.runtimes.getByRuntimeId(existing.runtimeId)
    if (runtime === null || runtime === undefined || existing.invocationId === undefined) {
      throw new HrcRuntimeUnavailableError('format2 admission has no live durable placement', {
        inputId: existing.inputId,
        hostSessionId: session.hostSessionId,
      })
    }
    if (
      options.establishedBrokerInvocationId !== undefined &&
      existing.invocationId !== options.establishedBrokerInvocationId
    ) {
      throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        route: 'broker',
        reason: CALLER_SURFACE_REUSE_REFUSAL,
        expectedInvocationId: options.establishedBrokerInvocationId,
        actualInvocationId: existing.invocationId,
      })
    }
    return format2Receipt(this, session, {
      runtime,
      input: existing,
    })
  }

  const existingRuntime = this.db.runtimes
    .listByHostSessionId(session.hostSessionId)
    .filter(
      (runtime) =>
        runtime.controllerKind === 'harness-broker' &&
        runtime.activeInvocationId !== undefined &&
        !isRuntimeUnavailableStatus(runtime.status)
    )
    .at(-1)
  if (existingRuntime !== undefined) {
    if (
      options.establishedBrokerInvocationId !== undefined &&
      existingRuntime.activeInvocationId !== options.establishedBrokerInvocationId
    ) {
      throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
        hostSessionId: session.hostSessionId,
        runtimeId: existingRuntime.runtimeId,
        route: 'broker',
        reason: CALLER_SURFACE_REUSE_REFUSAL,
        expectedInvocationId: options.establishedBrokerInvocationId,
        actualInvocationId: existingRuntime.activeInvocationId,
      })
    }
    const invocation = this.db.brokerInvocations.getByInvocationId(
      existingRuntime.activeInvocationId!
    )
    if (invocation?.executionFormat !== 'format2') {
      throw new HrcConflictError(
        HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        'format2 dispatch cannot join a format1 invocation',
        {
          hostSessionId: session.hostSessionId,
          runtimeId: existingRuntime.runtimeId,
          invocationId: existingRuntime.activeInvocationId,
        }
      )
    }
    const input = reserveWarmFormat2Input(
      this,
      session,
      existingRuntime,
      { inputId: `input-${randomUUID()}`, ...identity },
      options
    )
    try {
      await this.brokerWarmupComplete
      const result = await submitThroughBrokerDoor(
        this.getHarnessBrokerController(),
        options.submissionDoor ?? 'invoke',
        {
          runtimeId: existingRuntime.runtimeId,
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
      if (result.ok) {
        this.db.inputs.bindBrokerSubmissionId(
          input.inputId,
          result.response.submissionId,
          timestamp()
        )
      }
    } catch (error) {
      // A transport error says only that the body may have crossed. The durable
      // reservation remains protected for same-key replay and exact evidence.
      writeServerLog('WARN', 'format2.input.dispatch_uncertain', {
        inputId: input.inputId,
        runtimeId: existingRuntime.runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return format2Receipt(this, session, { runtime: existingRuntime, input })
  }

  if (options.establishedBrokerInvocationId !== undefined) {
    throw new HrcRuntimeUnavailableError(CALLER_SURFACE_REUSE_REFUSAL, {
      hostSessionId: session.hostSessionId,
      route: 'broker',
      reason: CALLER_SURFACE_REUSE_REFUSAL,
      expectedInvocationId: options.establishedBrokerInvocationId,
    })
  }

  let resolveAccepted!: (value: Format2AcceptedStart) => void
  let rejectAccepted!: (error: unknown) => void
  const accepted = new Promise<Format2AcceptedStart>((resolve, reject) => {
    resolveAccepted = resolve
    rejectAccepted = reject
  })
  void accepted.catch(() => undefined)
  const bootOperation = this.startHeadlessBrokerRuntime(session, intent, prompt, undefined, {
    ...dispatchRunPersistence(options),
    executionFormat: 'format2',
    responseFormat: options.responseFormat,
    onAccepted: (runtime) => {
      const input = this.db.inputs.getByAdmission(session.hostSessionId, identity.idempotencyKey)
      if (input === null || input.invocationId === undefined) {
        rejectAccepted(
          new HrcRuntimeUnavailableError('format2 start graph did not reserve its initial input', {
            hostSessionId: session.hostSessionId,
            runtimeId: runtime.runtimeId,
          })
        )
        return
      }
      resolveAccepted({
        runtime,
        input,
      })
    },
  })
  trackAppIdentityOperation(session, bootOperation)
  recordStartBirth(bootOperation, startBirthOfIntent('headless', intent))
  this.runtimeStartOperations.set(session.hostSessionId, bootOperation)
  void bootOperation
    .catch((error) => {
      rejectAccepted(error)
    })
    .finally(() => {
      if (this.runtimeStartOperations.get(session.hostSessionId) === bootOperation) {
        this.runtimeStartOperations.delete(session.hostSessionId)
      }
    })

  return format2Receipt(this, session, await accepted)
}
