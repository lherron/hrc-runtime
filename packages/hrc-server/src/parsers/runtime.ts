import { HrcBadRequestError, HrcErrorCode, HrcUnprocessableEntityError } from 'hrc-core'
import type {
  AttachRuntimeRequest,
  ClearContextRequest,
  DispatchTurnRequest,
  DropContinuationRequest,
  EnsureRuntimeRequest,
  HrcHarness,
  HrcProvider,
  HrcRuntimeIntent,
  InspectRuntimeRequest,
  PrepareAttachedRunRequest,
  ResumeAttachedRunRequest,
  StartRuntimeRequest,
  TerminateRuntimeRequest,
} from 'hrc-core'

import {
  isRecord,
  normalizeOptionalQuery,
  parseDurationMs,
  parseFenceInput,
  parseOptionalBooleanQuery,
  parseOptionalNonNegativeIntegerQuery,
  readOptionalNonEmptyStringField,
  readOptionalStringField,
  requireTrimmedStringField,
} from './common.js'
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
  stale?: boolean | undefined
  olderThan?: string | undefined
  olderThanMs?: number | undefined
  json?: boolean | undefined
}

export type ListRunsFilter = {
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  limit?: number | undefined
}

export function parseListRuntimesFilter(url: URL): ListRuntimesFilter {
  const transport = normalizeOptionalQuery(url.searchParams.get('transport'))
  if (
    transport !== undefined &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'sdk'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'transport must be one of: tmux, headless, sdk',
      { field: 'transport', value: transport }
    )
  }

  const statusRaw = normalizeOptionalQuery(url.searchParams.get('status'))
  const status = statusRaw
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const stale = parseOptionalBooleanQuery(url.searchParams.get('stale'), 'stale')
  const json = parseOptionalBooleanQuery(url.searchParams.get('json'), 'json')
  const olderThan = normalizeOptionalQuery(url.searchParams.get('olderThan'))

  return {
    ...(normalizeOptionalQuery(url.searchParams.get('hostSessionId'))
      ? { hostSessionId: normalizeOptionalQuery(url.searchParams.get('hostSessionId')) }
      : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(status !== undefined && status.length > 0 ? { status } : {}),
    ...(normalizeOptionalQuery(url.searchParams.get('scope'))
      ? { scope: normalizeOptionalQuery(url.searchParams.get('scope')) }
      : {}),
    ...(stale !== undefined ? { stale } : {}),
    ...(olderThan !== undefined ? { olderThan, olderThanMs: parseDurationMs(olderThan) } : {}),
    ...(json !== undefined ? { json } : {}),
  }
}

export function parseListRunsFilter(url: URL): ListRunsFilter {
  const generation = parseOptionalNonNegativeIntegerQuery(
    url.searchParams.get('generation'),
    'generation'
  )
  const limit = parseOptionalNonNegativeIntegerQuery(url.searchParams.get('limit'), 'limit')

  return {
    ...(normalizeOptionalQuery(url.searchParams.get('hostSessionId'))
      ? { hostSessionId: normalizeOptionalQuery(url.searchParams.get('hostSessionId')) }
      : {}),
    ...(generation !== undefined ? { generation } : {}),
    ...(normalizeOptionalQuery(url.searchParams.get('runtimeId'))
      ? { runtimeId: normalizeOptionalQuery(url.searchParams.get('runtimeId')) }
      : {}),
    ...(limit !== undefined ? { limit } : {}),
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
    ? (() => {
        const provider = requireTrimmedStringField(harness, 'provider')
        if (provider !== 'anthropic' && provider !== 'openai') {
          throw new HrcBadRequestError(
            HrcErrorCode.MALFORMED_REQUEST,
            'harness.provider must be "anthropic" or "openai"',
            { field: 'harness.provider' }
          )
        }

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
      })()
    : resolveHarnessFromPlacement(placement, execution)

  return {
    placement: placement as import('spaces-config').RuntimePlacement,
    harness: resolvedHarness,
    ...(isRecord(execution) ? { execution: execution as HrcRuntimeIntent['execution'] } : {}),
    ...(isRecord(launch) ? { launch: launch as HrcRuntimeIntent['launch'] } : {}),
    ...(typeof initialPrompt === 'string' ? { initialPrompt } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
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

  const restartStyle = input['restartStyle']
  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'restartStyle must be "reuse_pty" or "fresh_pty"'
    )
  }

  const allowStaleGeneration = input['allowStaleGeneration']
  if (allowStaleGeneration !== undefined && typeof allowStaleGeneration !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'allowStaleGeneration must be a boolean',
      { field: 'allowStaleGeneration' }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    intent: parseRuntimeIntent(intent),
    restartStyle,
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

export function parseStartRuntimeRequest(input: unknown): StartRuntimeRequest {
  return parseEnsureRuntimeRequest(input)
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
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'pendingStartId is required',
      { field: 'pendingStartId' }
    )
  }
  return { pendingStartId: pendingStartId.trim() }
}

export function parseDispatchTurnRequest(input: unknown): DispatchTurnRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

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
  const attachments = parseOptionalAttachmentRefs(input, 'attachments')
  const fences = input['fences']
  const waitForCompletion = input['waitForCompletion']
  if (waitForCompletion !== undefined && typeof waitForCompletion !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'waitForCompletion must be a boolean',
      { field: 'waitForCompletion' }
    )
  }
  const allowStaleGeneration = input['allowStaleGeneration']
  if (allowStaleGeneration !== undefined && typeof allowStaleGeneration !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'allowStaleGeneration must be a boolean',
      { field: 'allowStaleGeneration' }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    prompt: prompt.trim(),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: parseRuntimeIntent(runtimeIntent) }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
    ...(waitForCompletion !== undefined ? { waitForCompletion } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
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
  const relaunch = input['relaunch']
  const dropContinuation = input['dropContinuation']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (relaunch !== undefined && typeof relaunch !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'relaunch must be a boolean', {
      field: 'relaunch',
    })
  }
  if (dropContinuation !== undefined && typeof dropContinuation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'dropContinuation must be a boolean',
      {
        field: 'dropContinuation',
      }
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    ...(typeof relaunch === 'boolean' ? { relaunch } : {}),
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
  }
}

export function parseRuntimeActionBody(input: unknown): { runtimeId: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
  }
}

export function parseTerminateRuntimeRequest(input: unknown): TerminateRuntimeRequest {
  const body = parseRuntimeActionBody(input)
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const dropContinuation = input['dropContinuation']
  if (dropContinuation !== undefined && typeof dropContinuation !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'dropContinuation must be a boolean',
      {
        field: 'dropContinuation',
      }
    )
  }

  return {
    runtimeId: body.runtimeId,
    ...(typeof dropContinuation === 'boolean' ? { dropContinuation } : {}),
  }
}

export function parseInspectRuntimeRequest(input: unknown): InspectRuntimeRequest {
  return parseRuntimeActionBody(input)
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
