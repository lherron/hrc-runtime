import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  DispatchTurnRequest,
  EnqueueSubmissionRequest,
  HrcDispatchOrigin,
  HrcTurnResponseFormat,
  InvokeSubmissionRequest,
  PreemptSubmissionRequest,
  SteerSubmissionRequest,
} from 'hrc-core'

import {
  isRecord,
  parseFenceInput,
  readOptionalBooleanField,
  readOptionalNonEmptyStringField,
  requireOneOf,
  requireOptionalOneOf,
  requireTrimmedStringField,
} from './common.js'
import {
  parseExecutionFormatSelector,
  parseOptionalAttachmentRefs,
  parseRuntimeIntent,
} from './runtime-intent.js'

export function parseDispatchTurnRequest(input: unknown): DispatchTurnRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  rejectUnknownFields(input, [
    'hostSessionId',
    'idempotencyKey',
    'prompt',
    'responseFormat',
    'attachments',
    'fences',
    'runtimeIntent',
    'waitFor',
    'waitForCompletion',
    'repair',
    'establishedBrokerInvocationId',
    'allowStaleGeneration',
    'firstTurnTimeoutMs',
    'origin',
    'executionFormat',
  ])

  const hostSessionId = input['hostSessionId']
  const prompt = input['prompt']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }

  const runtimeIntent = input['runtimeIntent']
  const idempotencyKey = readOptionalNonEmptyStringField(input, 'idempotencyKey')
  const responseFormat = parseOptionalTurnResponseFormat(input['responseFormat'])
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const fences = input['fences']
  const waitForCompletion = readOptionalBooleanField(input, 'waitForCompletion')
  const waitFor = requireOptionalOneOf(
    input['waitFor'],
    ['accepted', 'turn_started', 'terminal'],
    'waitFor must be "accepted", "turn_started", or "terminal"',
    { field: 'waitFor' }
  )
  const allowStaleGeneration = readOptionalBooleanField(input, 'allowStaleGeneration')
  // T-07397 surface-ownership proof; validated as a non-empty string so an empty
  // value can never masquerade as "I established this invocation".
  const establishedBrokerInvocationId = readOptionalNonEmptyStringField(
    input,
    'establishedBrokerInvocationId'
  )
  const repair = parseOptionalDispatchTurnRepair(input['repair'])
  const firstTurnTimeoutMs = parseOptionalFirstTurnTimeoutMs(input['firstTurnTimeoutMs'])
  const origin = parseOptionalDispatchOrigin(input['origin'])
  const executionFormat = parseExecutionFormatSelector(input)

  return {
    hostSessionId: hostSessionId.trim(),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    prompt: prompt.trim(),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
    ...(waitForCompletion !== undefined ? { waitForCompletion } : {}),
    ...(waitFor !== undefined ? { waitFor } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
    ...(establishedBrokerInvocationId !== undefined ? { establishedBrokerInvocationId } : {}),
    ...(repair !== undefined ? { repair } : {}),
    ...(firstTurnTimeoutMs !== undefined ? { firstTurnTimeoutMs } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(executionFormat !== undefined ? { executionFormat } : {}),
  }
}

type ParsedSubmissionRequest =
  | SteerSubmissionRequest
  | EnqueueSubmissionRequest
  | InvokeSubmissionRequest
  | PreemptSubmissionRequest

export function parseSubmissionRequest(input: unknown, door: 'steer'): SteerSubmissionRequest
export function parseSubmissionRequest(input: unknown, door: 'enqueue'): EnqueueSubmissionRequest
export function parseSubmissionRequest(input: unknown, door: 'invoke'): InvokeSubmissionRequest
export function parseSubmissionRequest(input: unknown, door: 'preempt'): PreemptSubmissionRequest
export function parseSubmissionRequest(
  input: unknown,
  door: 'steer' | 'enqueue' | 'invoke' | 'preempt'
): ParsedSubmissionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const allowed = [
    'target',
    'body',
    'origin',
    'responseFormat',
    'freshContext',
    'executionFormat',
    ...(door === 'enqueue' || door === 'preempt' || door === 'invoke' ? ['ttlMs'] : []),
    // A steer joins the running turn or starts one, so it has a turn to wait on.
    'wait',
    'idempotencyKey',
    ...(door === 'steer' ? [] : ['turnPolicy', 'runtimeIntent', 'establishedBrokerInvocationId']),
    ...(door === 'invoke' ? ['coldBirth'] : []),
  ]
  rejectUnknownFields(input, allowed)

  const target = requireTrimmedStringField(input, 'target')
  const body = requireTrimmedStringField(input, 'body')
  const originInput = input['origin']
  if (!isRecord(originInput)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'origin is required', {
      field: 'origin',
    })
  }
  rejectUnknownFields(originInput, ['principalRef', 'scopeRef', 'envelopeId'], 'origin')
  const principalRef = requireTrimmedStringField(originInput, 'principalRef')
  const scopeRef = readOptionalNonEmptyStringField(originInput, 'scopeRef')
  const envelopeId = readOptionalNonEmptyStringField(originInput, 'envelopeId')
  const responseFormat = parseOptionalTurnResponseFormat(input['responseFormat'])
  const freshContext = readOptionalBooleanField(input, 'freshContext')
  const executionFormat = parseExecutionFormatSelector(input)
  const wait = readOptionalBooleanField(input, 'wait')
  const common = {
    target,
    body,
    origin: {
      principalRef,
      ...(scopeRef !== undefined ? { scopeRef } : {}),
      ...(envelopeId !== undefined ? { envelopeId } : {}),
    },
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    ...(freshContext !== undefined ? { freshContext } : {}),
    ...(executionFormat !== undefined ? { executionFormat } : {}),
  }
  const idempotencyKey = readOptionalNonEmptyStringField(input, 'idempotencyKey')
  if (door === 'steer') {
    return {
      ...common,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      ...(wait !== undefined ? { wait } : {}),
    }
  }

  const turnPolicy = requireOptionalOneOf(
    input['turnPolicy'],
    ['open', 'guarded'],
    'turnPolicy must be "open" or "guarded"',
    { field: 'turnPolicy' }
  )
  const runtimeIntent = input['runtimeIntent']
  const establishedBrokerInvocationId = readOptionalNonEmptyStringField(
    input,
    'establishedBrokerInvocationId'
  )
  const ttlMs =
    door === 'enqueue' || door === 'preempt' || door === 'invoke'
      ? parseOptionalSubmissionTtlMs(input['ttlMs'])
      : undefined
  const coldBirth = door === 'invoke' ? parseOptionalInvokeColdBirth(input['coldBirth']) : undefined
  return {
    ...common,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(coldBirth !== undefined ? { coldBirth } : {}),
    ...(turnPolicy !== undefined ? { turnPolicy } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(establishedBrokerInvocationId !== undefined ? { establishedBrokerInvocationId } : {}),
  }
}

function parseOptionalInvokeColdBirth(input: unknown): InvokeSubmissionRequest['coldBirth'] {
  if (input === undefined) return undefined
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'coldBirth must be an object', {
      field: 'coldBirth',
    })
  }
  rejectUnknownFields(input, ['promptMode'], 'coldBirth')
  const promptMode = requireOptionalOneOf(
    input['promptMode'],
    ['replace-priming', 'append-to-priming'],
    'coldBirth.promptMode must be "replace-priming" or "append-to-priming"',
    { field: 'coldBirth.promptMode' }
  )
  if (promptMode === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'coldBirth.promptMode is required',
      { field: 'coldBirth.promptMode' }
    )
  }
  return { promptMode }
}

function parseOptionalSubmissionTtlMs(input: unknown): number | undefined {
  if (input === undefined) return undefined
  if (!Number.isInteger(input) || typeof input !== 'number' || input < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'ttlMs must be a non-negative integer',
      { field: 'ttlMs' }
    )
  }
  return input
}

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  prefix?: string
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key))
  if (unknown === undefined) return
  const field = prefix === undefined ? unknown : `${prefix}.${unknown}`
  throw new HrcUnprocessableEntityError(HrcErrorCode.UNKNOWN_FIELD, `unknown field "${field}"`, {
    field,
  })
}

/**
 * T-07236 dispatch origin. Validated strictly and NEVER coerced: an origin that
 * arrives malformed is a caller bug, and quietly dropping it would relabel a
 * known cause as unattributed — which is exactly the bypass the bridge's
 * origin-policy promise depends on not happening.
 *
 * An origin with no actor and no kind is rejected rather than accepted as an
 * empty block: sending `origin: {}` means the caller believed it was
 * transporting provenance, and it was not.
 */
export function parseOptionalDispatchOrigin(input: unknown): HrcDispatchOrigin | undefined {
  if (input === undefined || input === null) return undefined
  if (!isRecord(input)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'origin must be an object when present',
      { field: 'origin' }
    )
  }

  const actor = input['actor']
  if (actor !== undefined && (typeof actor !== 'string' || actor.trim().length === 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'origin.actor must be a non-empty string when present',
      { field: 'origin.actor' }
    )
  }
  const kind = requireOptionalOneOf(
    input['kind'],
    ['human', 'agent', 'system'],
    'origin.kind must be "human", "agent", or "system"',
    { field: 'origin.kind' }
  )
  const causationRef = input['causationRef']
  if (
    causationRef !== undefined &&
    (typeof causationRef !== 'string' || causationRef.trim().length === 0)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'origin.causationRef must be a non-empty string when present',
      { field: 'origin.causationRef' }
    )
  }
  if (actor === undefined && kind === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'origin requires at least one of actor or kind',
      { field: 'origin' }
    )
  }

  return {
    ...(typeof actor === 'string' ? { actor: actor.trim() } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(typeof causationRef === 'string' ? { causationRef: causationRef.trim() } : {}),
  }
}

/**
 * T-07235 per-request watchdog window. Validated strictly (a positive integer
 * number of milliseconds) rather than coerced: a malformed policy value must
 * not silently become the global default on a request that asked for a
 * different one.
 */
export function parseOptionalFirstTurnTimeoutMs(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isInteger(input) ||
    input <= 0
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'firstTurnTimeoutMs must be a positive integer number of milliseconds',
      { field: 'firstTurnTimeoutMs' }
    )
  }
  return input
}

export function parseOptionalTurnResponseFormat(input: unknown): HrcTurnResponseFormat | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!isPlainJsonObject(input)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'responseFormat must be an object',
      { field: 'responseFormat' }
    )
  }

  const kind = input['kind']
  if (kind === 'text') {
    if (Object.prototype.hasOwnProperty.call(input, 'schema')) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'text responseFormat must not include schema',
        { field: 'responseFormat.schema' }
      )
    }
    return { kind: 'text' }
  }

  if (kind === 'json_schema') {
    const schema = input['schema']
    if (!isPlainJsonObject(schema)) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'json_schema responseFormat schema must be an object',
        { field: 'responseFormat.schema' }
      )
    }
    const badPath = firstNonJsonCompatiblePath(schema, 'responseFormat.schema')
    if (badPath !== undefined) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'responseFormat schema must be JSON-compatible',
        { field: badPath }
      )
    }
    return { kind: 'json_schema', schema }
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    'responseFormat kind is unsupported',
    { field: 'responseFormat.kind' }
  )
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function firstNonJsonCompatiblePath(value: unknown, path: string): string | undefined {
  if (value === null) {
    return undefined
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : path
    case 'object':
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const child = firstNonJsonCompatiblePath(value[index], `${path}[${index}]`)
          if (child !== undefined) return child
        }
        return undefined
      }
      if (!isPlainJsonObject(value)) {
        return path
      }
      for (const [key, childValue] of Object.entries(value)) {
        const child = firstNonJsonCompatiblePath(childValue, `${path}.${key}`)
        if (child !== undefined) return child
      }
      return undefined
    default:
      return path
  }
}

function parseOptionalDispatchTurnRepair(
  input: unknown
): DispatchTurnRequest['repair'] | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'repair must be an object', {
      field: 'repair',
    })
  }

  const kind = requireOneOf(
    requireTrimmedStringField(input, 'kind'),
    ['json_validation', 'json_repair'],
    'repair.kind must be "json_validation" or "json_repair"',
    { field: 'repair.kind' }
  )
  const sourceRunId = requireTrimmedStringField(input, 'sourceRunId')
  const failedValidationRunId = readOptionalNonEmptyStringField(input, 'failedValidationRunId')
  const reason = readOptionalNonEmptyStringField(input, 'reason')

  return {
    kind,
    sourceRunId,
    ...(failedValidationRunId !== undefined ? { failedValidationRunId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}
