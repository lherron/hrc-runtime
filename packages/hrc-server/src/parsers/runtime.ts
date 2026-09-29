import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  AttachRuntimeRequest,
  BrokerInspectRequest,
  ClearContextRequest,
  DropContinuationRequest,
  EnsureRuntimeRequest,
  ExactStartRuntimeRequest,
  InspectRuntimeRequest,
  OpenBrokerSessionRequest,
  PrepareAttachedRunRequest,
  ResumeAttachedRunRequest,
  StartRuntimeRequest,
  TerminateRuntimeRequest,
  WithdrawSubmissionRequest,
} from 'hrc-core'

import {
  isRecord,
  normalizeOptionalQuery,
  parseDurationMs,
  parseFenceInput,
  parseOptionalBooleanQuery,
  parseOptionalNonNegativeIntegerQuery,
  pickOptionalQuery,
  readOptionalBooleanField,
  readOptionalNonEmptyStringField,
  readOptionalRawStringField,
  readOptionalStringField,
  requireOptionalOneOf,
  requireTrimmedStringField,
} from './common.js'
import { parseExecutionFormatSelector, parseRuntimeIntent } from './runtime-intent.js'

// Re-exported so the original import path keeps its full surface.
export { parseRuntimeIntent } from './runtime-intent.js'
export {
  parseDispatchTurnRequest,
  parseOptionalDispatchOrigin,
  parseOptionalFirstTurnTimeoutMs,
  parseOptionalTurnResponseFormat,
  parseSubmissionRequest,
} from './runtime-dispatch.js'

export type InFlightInputRequest = {
  runtimeId: string
  runId: string
  inputApplicationId?: string | undefined
  idempotencyKey?: string | undefined
  prompt: string
  inputType?: string | undefined
  semantics?: 'append_context' | 'interrupt_and_continue' | undefined
}

export type ListRuntimesFilter = {
  hostSessionId?: string | undefined
  transport?: 'tmux' | 'headless' | 'sdk' | undefined
  status?: string[] | undefined
  scope?: string | undefined
  agent?: string | undefined
  task?: string | undefined
  stale?: boolean | undefined
  olderThan?: string | undefined
  olderThanMs?: number | undefined
  json?: boolean | undefined
  all?: boolean | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

export type ListRunsFilter = {
  runId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status?: string[] | undefined
  limit?: number | undefined
}

export function parseListRuntimesFilter(url: URL): ListRuntimesFilter {
  const transportRaw = normalizeOptionalQuery(url.searchParams.get('transport'))
  const transport = requireOptionalOneOf(
    transportRaw,
    ['tmux', 'headless', 'sdk'],
    'transport must be one of: tmux, headless, sdk',
    { field: 'transport', value: transportRaw }
  )

  const statusRaw = normalizeOptionalQuery(url.searchParams.get('status'))
  const status = statusRaw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const stale = parseOptionalBooleanQuery(url.searchParams.get('stale'), 'stale')
  const json = parseOptionalBooleanQuery(url.searchParams.get('json'), 'json')
  const all = parseOptionalBooleanQuery(url.searchParams.get('all'), 'all')
  const limit = parseOptionalNonNegativeIntegerQuery(url.searchParams.get('limit'), 'limit')
  const olderThan = normalizeOptionalQuery(url.searchParams.get('olderThan'))

  return {
    ...pickOptionalQuery(url, 'hostSessionId'),
    ...(transport !== undefined ? { transport } : {}),
    ...(status !== undefined && status.length > 0 ? { status } : {}),
    ...pickOptionalQuery(url, 'scope'),
    ...pickOptionalQuery(url, 'agent'),
    ...pickOptionalQuery(url, 'task'),
    ...(stale !== undefined ? { stale } : {}),
    ...(olderThan !== undefined ? { olderThan, olderThanMs: parseDurationMs(olderThan) } : {}),
    ...(json !== undefined ? { json } : {}),
    ...(all !== undefined ? { all } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...pickOptionalQuery(url, 'cursor'),
  }
}

export function parseListRunsFilter(url: URL): ListRunsFilter {
  const generation = parseOptionalNonNegativeIntegerQuery(
    url.searchParams.get('generation'),
    'generation'
  )
  const limit = parseOptionalNonNegativeIntegerQuery(url.searchParams.get('limit'), 'limit')

  const statusRaw = normalizeOptionalQuery(url.searchParams.get('status'))
  const status = statusRaw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  return {
    ...pickOptionalQuery(url, 'runId'),
    ...pickOptionalQuery(url, 'hostSessionId'),
    ...(generation !== undefined ? { generation } : {}),
    ...pickOptionalQuery(url, 'runtimeId'),
    ...pickOptionalQuery(url, 'scopeRef'),
    ...pickOptionalQuery(url, 'laneRef'),
    ...(status !== undefined && status.length > 0 ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

export function parseEnsureRuntimeRequest(input: unknown): EnsureRuntimeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const intent = input['intent']
  if (!isRecord(intent)) {
    throw new HrcUnprocessableEntityError(HrcErrorCode.MISSING_RUNTIME_INTENT, 'intent is required')
  }

  const restartStyle = requireOptionalOneOf(
    input['restartStyle'],
    ['reuse_pty', 'fresh_pty'],
    'restartStyle must be "reuse_pty" or "fresh_pty"'
  )
  const allowStaleGeneration = readOptionalBooleanField(input, 'allowStaleGeneration')

  return {
    hostSessionId: hostSessionId.trim(),
    intent: parseRuntimeIntent(intent),
    restartStyle,
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

/**
 * START accepts three shapes:
 *
 *  - the canonical `{ hostSessionId, intent }` ensure-shape,
 *  - the suffix collision-roster shape `{ baseSessionRef, runtimeIntent,
 *    conflictPolicy: 'suffix', idempotencyKey }` (T-07118), and
 *  - the exact-scope shape `{ sessionRef, runtimeIntent, conflictPolicy:
 *    'reject', summonIntent: 'implicit', idempotencyKey }` (T-07302).
 *
 * Neither claim-and-start shape carries a `hostSessionId`: the daemon picks and
 * claims the session inside the request. `idempotencyKey` is REQUIRED on both —
 * without operation identity a lost-response retry would walk the roster and
 * claim a second slot, or rotate the exact scope a second time.
 */
export function parseStartRuntimeRequest(input: unknown): StartRuntimeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const conflictPolicy = input['conflictPolicy']
  if (conflictPolicy === undefined) {
    return parseEnsureRuntimeRequest(input)
  }
  if (conflictPolicy === 'reject') {
    return parseExactStartRuntimeRequest(input)
  }
  if (conflictPolicy !== 'suffix') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'conflictPolicy must be "suffix" or "reject" when present',
      { field: 'conflictPolicy' }
    )
  }

  const baseSessionRef = input['baseSessionRef']
  if (typeof baseSessionRef !== 'string' || baseSessionRef.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'baseSessionRef is required for conflictPolicy "suffix"',
      { field: 'baseSessionRef' }
    )
  }
  if (input['hostSessionId'] !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hostSessionId must not be supplied with conflictPolicy "suffix"',
      { field: 'hostSessionId' }
    )
  }

  const runtimeIntent = input['runtimeIntent']
  if (!isRecord(runtimeIntent)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required for conflictPolicy "suffix"'
    )
  }

  const idempotencyKey = input['idempotencyKey']
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'idempotencyKey is required for conflictPolicy "suffix"',
      { field: 'idempotencyKey' }
    )
  }

  const restartStyle = requireOptionalOneOf(
    input['restartStyle'],
    ['reuse_pty', 'fresh_pty'],
    'restartStyle must be "reuse_pty" or "fresh_pty"'
  )
  const summonIntent = requireOptionalOneOf(
    input['summonIntent'],
    ['implicit', 'explicit_local'],
    'summonIntent must be "implicit" or "explicit_local"'
  )

  return {
    baseSessionRef: baseSessionRef.trim(),
    runtimeIntent: parseRuntimeIntent(runtimeIntent),
    conflictPolicy: 'suffix',
    idempotencyKey: idempotencyKey.trim(),
    ...(restartStyle !== undefined ? { restartStyle } : {}),
    ...(summonIntent !== undefined ? { summonIntent } : {}),
  }
}

/**
 * The exact-scope claim-and-start shape (T-07302).
 *
 * Every refusal here is a REFUSAL, never a coercion: an inbound `hostSessionId`
 * or `baseSessionRef` would mean the caller — not HRC — picked the session, and
 * a `summonIntent` other than `implicit` would mean the caller declared its own
 * placement. Both are exactly what this contract exists to forbid, so they are
 * rejected before anything reads the intent.
 */
function parseExactStartRuntimeRequest(input: Record<string, unknown>): ExactStartRuntimeRequest {
  const sessionRef = input['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef is required for conflictPolicy "reject"',
      { field: 'sessionRef' }
    )
  }
  if (input['hostSessionId'] !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hostSessionId must not be supplied with conflictPolicy "reject"',
      { field: 'hostSessionId' }
    )
  }
  if (input['baseSessionRef'] !== undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'baseSessionRef must not be supplied with conflictPolicy "reject"',
      { field: 'baseSessionRef' }
    )
  }

  const runtimeIntent = input['runtimeIntent']
  if (!isRecord(runtimeIntent)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required for conflictPolicy "reject"'
    )
  }

  const idempotencyKey = input['idempotencyKey']
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'idempotencyKey is required for conflictPolicy "reject"',
      { field: 'idempotencyKey' }
    )
  }

  if (input['summonIntent'] !== 'implicit') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'summonIntent must be "implicit" for conflictPolicy "reject"',
      { field: 'summonIntent' }
    )
  }

  const restartStyle = requireOptionalOneOf(
    input['restartStyle'],
    ['reuse_pty', 'fresh_pty'],
    'restartStyle must be "reuse_pty" or "fresh_pty"'
  )

  return {
    sessionRef: sessionRef.trim(),
    runtimeIntent: parseRuntimeIntent(runtimeIntent),
    conflictPolicy: 'reject',
    summonIntent: 'implicit',
    idempotencyKey: idempotencyKey.trim(),
    ...(restartStyle !== undefined ? { restartStyle } : {}),
  }
}

export function parseOpenBrokerSessionRequest(input: unknown): OpenBrokerSessionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const runtimeIntent = input['runtimeIntent']
  const fences = input['fences']
  const allowStaleGeneration = readOptionalBooleanField(input, 'allowStaleGeneration')
  const waitForReady = readOptionalBooleanField(input, 'waitForReady')
  const executionFormat = parseExecutionFormatSelector(input)

  return {
    hostSessionId: hostSessionId.trim(),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
    ...(waitForReady !== undefined ? { waitForReady } : {}),
    ...(executionFormat !== undefined ? { executionFormat } : {}),
  }
}

export function parsePrepareAttachedRunRequest(input: unknown): PrepareAttachedRunRequest {
  const parsed = parseEnsureRuntimeRequest(input)
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const prompt = input['prompt']
  if (prompt !== undefined && typeof prompt !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt must be a string', {
      field: 'prompt',
    })
  }
  return {
    ...parsed,
    // The attached door (`hrc run` / `hrc resume`) always puts an operator
    // terminal on the seat, so it requests presentation at the compile-request
    // layer: that outranks summon directives, project target, agent profile
    // and the catalog default, and overrides an explicit false.
    intent: {
      ...parsed.intent,
      selection: { ...parsed.intent.selection, presentation: true },
    },
    ...(typeof prompt === 'string' && prompt.trim().length > 0 ? { prompt } : {}),
  }
}

export function parseResumeAttachedRunRequest(input: unknown): ResumeAttachedRunRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const pendingStartId = input['pendingStartId']
  if (typeof pendingStartId !== 'string' || pendingStartId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'pendingStartId is required', {
      field: 'pendingStartId',
    })
  }
  return { pendingStartId: pendingStartId.trim() }
}

export function parseInFlightInputRequest(input: unknown): InFlightInputRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  const runId = input['runId']
  const promptValue = typeof input['prompt'] === 'string' ? input['prompt'] : input['input']
  const inputType = input['inputType']

  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runId is required', {
      field: 'runId',
    })
  }
  if (typeof promptValue !== 'string' || promptValue.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }
  if (inputType !== undefined && typeof inputType !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'inputType must be a string', {
      field: 'inputType',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
    runId: runId.trim(),
    prompt: promptValue.trim(),
    ...(typeof inputType === 'string' && inputType.trim().length > 0
      ? { inputType: inputType.trim() }
      : {}),
  }
}

export function parseClearContextRequest(input: unknown): ClearContextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  const relaunch = readOptionalBooleanField(input, 'relaunch')
  const dropContinuation = readOptionalBooleanField(input, 'dropContinuation')
  const runtimeIntent = input['runtimeIntent']
  if (runtimeIntent !== undefined && !isRecord(runtimeIntent)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent must be an object',
      { field: 'runtimeIntent' }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    ...(typeof relaunch === 'boolean' ? { relaunch } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
    ...(runtimeIntent !== undefined ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) } : {}),
  }
}

export function parseRuntimeActionBody(input: unknown): {
  runtimeId: string
  ownerRunId?: string | undefined
} {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }

  const ownerRunId = readOptionalNonEmptyStringField(input, 'ownerRunId')

  return {
    runtimeId: runtimeId.trim(),
    ...(ownerRunId !== undefined ? { ownerRunId } : {}),
  }
}

export function parseTerminateRuntimeRequest(input: unknown): TerminateRuntimeRequest {
  const body = parseRuntimeActionBody(input)
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const dropContinuation = readOptionalBooleanField(input, 'dropContinuation')

  const reason = readOptionalRawStringField(input, 'reason')
  const source = readOptionalRawStringField(input, 'source')
  const actor = readOptionalRawStringField(input, 'actor')

  return {
    runtimeId: body.runtimeId,
    ...(body.ownerRunId !== undefined ? { ownerRunId: body.ownerRunId } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(actor !== undefined ? { actor } : {}),
  }
}

export function parseInspectRuntimeRequest(input: unknown): InspectRuntimeRequest {
  return parseRuntimeActionBody(input)
}

export function parseBrokerInspectRequest(input: unknown): BrokerInspectRequest {
  const body = parseRuntimeActionBody(input)
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const probeLiveness = readOptionalBooleanField(input, 'probeLiveness')
  const includeDisposed = readOptionalBooleanField(input, 'includeDisposed')
  const includeInvocations = readOptionalBooleanField(input, 'includeInvocations')
  const recoverFinalSummaryRaw = input['recoverFinalSummary']
  let recoverFinalSummary: BrokerInspectRequest['recoverFinalSummary']
  if (recoverFinalSummaryRaw !== undefined) {
    if (!isRecord(recoverFinalSummaryRaw)) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'recoverFinalSummary must be an object',
        { field: 'recoverFinalSummary' }
      )
    }
    const timeoutMs = recoverFinalSummaryRaw['timeoutMs']
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'recoverFinalSummary.timeoutMs must be a non-negative number',
        { field: 'recoverFinalSummary.timeoutMs' }
      )
    }
    recoverFinalSummary = {
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    }
  }

  return {
    runtimeId: body.runtimeId,
    ...(typeof probeLiveness === 'boolean' ? { probeLiveness } : {}),
    ...(typeof includeDisposed === 'boolean' ? { includeDisposed } : {}),
    ...(typeof includeInvocations === 'boolean' ? { includeInvocations } : {}),
    ...(recoverFinalSummary !== undefined ? { recoverFinalSummary } : {}),
  }
}

export function parseWithdrawSubmissionRequest(input: unknown): WithdrawSubmissionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const body = parseRuntimeActionBody(input)
  const submissionId = readOptionalNonEmptyStringField(input, 'submissionId')
  const envelopeId = readOptionalNonEmptyStringField(input, 'envelopeId')
  if ((submissionId === undefined) === (envelopeId === undefined)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'exactly one of submissionId or envelopeId is required',
      { field: 'submissionId' }
    )
  }
  return {
    runtimeId: body.runtimeId,
    ...(submissionId !== undefined ? { submissionId } : {}),
    ...(envelopeId !== undefined ? { envelopeId } : {}),
    reason: requireTrimmedStringField(input, 'reason'),
  }
}

export function parseDropContinuationRequest(input: unknown): DropContinuationRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    hostSessionId: requireTrimmedStringField(input, 'hostSessionId'),
    ...readOptionalStringField(input, 'reason'),
  }
}

export function parseAttachRuntimeRequest(input: unknown): AttachRuntimeRequest {
  return parseRuntimeActionBody(input)
}
