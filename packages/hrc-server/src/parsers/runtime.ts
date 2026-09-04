import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  AttachRuntimeRequest,
  BrokerInspectRequest,
  ClearContextRequest,
  DispatchTurnRequest,
  DropContinuationRequest,
  EnqueueSubmissionRequest,
  EnsureRuntimeRequest,
  ExactStartRuntimeRequest,
  HrcDispatchOrigin,
  HrcHarness,
  HrcProvider,
  HrcRuntimeIntent,
  HrcTurnResponseFormat,
  InspectRuntimeRequest,
  InvokeSubmissionRequest,
  OpenBrokerSessionRequest,
  PreemptSubmissionRequest,
  PrepareAttachedRunRequest,
  ResumeAttachedRunRequest,
  StartRuntimeRequest,
  SteerSubmissionRequest,
  TerminateRuntimeRequest,
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
  requireOneOf,
  requireOptionalOneOf,
  requireTrimmedStringField,
} from './common.js'
import { parseOptionalProvisionBlock } from './provision.js'
import { resolveHarnessFromPlacement } from './runtime-harness-resolver.js'

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

function parseInlineHarness(harness: Record<string, unknown>): HrcRuntimeIntent['harness'] {
  const provider = requireOneOf(
    requireTrimmedStringField(harness, 'provider'),
    ['anthropic', 'openai'],
    'harness.provider must be "anthropic" or "openai"',
    { field: 'harness.provider' }
  )

  const interactive = harness['interactive']
  if (typeof interactive !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'harness.interactive must be a boolean',
      { field: 'harness.interactive' }
    )
  }

  return {
    provider: provider as HrcProvider,
    interactive,
    ...(typeof harness['id'] === 'string' ? { id: harness['id'] as HrcHarness } : {}),
    ...(typeof harness['fallback'] === 'string' ? { fallback: harness['fallback'] } : {}),
    ...(harness['model'] !== undefined ? { model: String(harness['model']) } : {}),
    ...(harness['yolo'] === true ? { yolo: true } : {}),
  }
}

export function parseRuntimeIntent(input: Record<string, unknown>): HrcRuntimeIntent {
  const placement = input['placement'] ?? 'workspace'
  const execution = input['execution']
  const harness = input['harness']
  const launch = input['launch']
  const initialPrompt = input['initialPrompt']
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const resolvedHarness = isRecord(harness)
    ? parseInlineHarness(harness)
    : resolveHarnessFromPlacement(placement, execution)

  const presentation = parseOptionalPresentationIntent(input['presentation'])
  // T-07398: re-validated HERE, at the dispatch boundary, then carried verbatim.
  // Every surface that already accepts a runtimeIntent therefore accepts a
  // directive block without a new request-body field of its own.
  const provision = parseOptionalProvisionBlock(input['provision'])

  return {
    placement: placement as import('spaces-config').RuntimePlacement,
    harness: resolvedHarness,
    ...(provision === undefined ? {} : { provision }),
    ...(isRecord(execution) ? { execution: execution as HrcRuntimeIntent['execution'] } : {}),
    ...(isRecord(launch) ? { launch: launch as HrcRuntimeIntent['launch'] } : {}),
    ...(typeof initialPrompt === 'string' ? { initialPrompt } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(presentation !== undefined ? { presentation } : {}),
  }
}

/**
 * Viewer placement hint (T-07118). Free-form key, validated only as a non-empty
 * string: the presentation layer normalizes it, and an absent/blank value is the
 * implicit default key, i.e. today's behavior.
 */
function parseOptionalPresentationIntent(
  value: unknown
): HrcRuntimeIntent['presentation'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'presentation must be an object', {
      field: 'presentation',
    })
  }
  const viewerWindow = value['viewerWindow']
  if (viewerWindow === undefined) return {}
  if (typeof viewerWindow !== 'string' || viewerWindow.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'presentation.viewerWindow must be a non-empty string',
      { field: 'presentation.viewerWindow' }
    )
  }
  return { viewerWindow: viewerWindow.trim() }
}

function parseOptionalAttachmentRefs(
  input: Record<string, unknown>,
  field: string
): HrcRuntimeIntent['attachments'] | undefined {
  const value = input[field]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an array`, {
      field,
    })
  }
  return value.map((entry, index) => parseAttachmentRef(entry, `${field}[${index}]`))
}

function parseAttachmentRef(
  input: unknown,
  field: string
): NonNullable<HrcRuntimeIntent['attachments']>[number] {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an object`, {
      field,
    })
  }
  const kind = input['kind']
  if (kind !== 'url' && kind !== 'file') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.kind must be "url" or "file"`,
      { field: `${field}.kind` }
    )
  }

  const url = readOptionalNonEmptyStringField(input, 'url')
  const path = readOptionalNonEmptyStringField(input, 'path')
  if (kind === 'url' && url === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.url is required for url attachments`,
      { field: `${field}.url` }
    )
  }
  if (kind === 'file' && path === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.path is required for file attachments`,
      { field: `${field}.path` }
    )
  }

  const filename = readOptionalNonEmptyStringField(input, 'filename')
  const contentType = readOptionalNonEmptyStringField(input, 'contentType')
  const sizeBytes = input['sizeBytes']
  if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field}.sizeBytes must be a non-negative safe integer`,
      { field: `${field}.sizeBytes` }
    )
  }

  return {
    kind,
    ...(url !== undefined ? { url } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(filename !== undefined ? { filename } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes: sizeBytes as number } : {}),
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

  return {
    hostSessionId: hostSessionId.trim(),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
    ...(waitForReady !== undefined ? { waitForReady } : {}),
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
    ...(door === 'enqueue' || door === 'preempt' ? ['ttlMs'] : []),
    ...(door === 'steer'
      ? []
      : ['turnPolicy', 'wait', 'runtimeIntent', 'establishedBrokerInvocationId']),
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
  }
  if (door === 'steer') return common

  const turnPolicy = requireOptionalOneOf(
    input['turnPolicy'],
    ['open', 'guarded'],
    'turnPolicy must be "open" or "guarded"',
    { field: 'turnPolicy' }
  )
  const wait = readOptionalBooleanField(input, 'wait')
  const runtimeIntent = input['runtimeIntent']
  const establishedBrokerInvocationId = readOptionalNonEmptyStringField(
    input,
    'establishedBrokerInvocationId'
  )
  const ttlMs =
    door === 'enqueue' || door === 'preempt'
      ? parseOptionalSubmissionTtlMs(input['ttlMs'])
      : undefined
  return {
    ...common,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(turnPolicy !== undefined ? { turnPolicy } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(establishedBrokerInvocationId !== undefined ? { establishedBrokerInvocationId } : {}),
  }
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

  return {
    hostSessionId: hostSessionId.trim(),
    ...(typeof relaunch === 'boolean' ? { relaunch } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
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
