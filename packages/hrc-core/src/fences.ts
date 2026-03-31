import { HrcConflictError, HrcErrorCode, type HrcHttpError, createHrcError } from './errors.js'

export { HrcErrorCode } from './errors.js'

export type HrcFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  followLatest?: boolean | undefined
}

export type HrcActiveSessionState = {
  activeHostSessionId: string
  generation: number
}

export type HrcFenceValidationSuccess = {
  ok: true
  resolvedHostSessionId: string
  resolvedGeneration: number
}

export type HrcFenceValidationFailure = {
  ok: false
  errorCode: HrcErrorCode
  message: string
  detail: HrcHttpError['error']['detail']
}

export type HrcFenceValidationResult = HrcFenceValidationSuccess | HrcFenceValidationFailure

function parseExpectedHostSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new TypeError('expectedHostSessionId must be a string when provided')
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new TypeError('expectedHostSessionId must not be empty')
  }

  return normalized
}

function parseExpectedGeneration(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError('expectedGeneration must be an integer when provided')
  }
  if (value < 0) {
    throw new RangeError('expectedGeneration must be zero or greater')
  }
  return value
}

function parseFollowLatest(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new TypeError('followLatest must be a boolean when provided')
  }
  return value
}

export function parseFence(input?: HrcFence | undefined): HrcFence {
  if (input === undefined) {
    return {}
  }
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('fence must be an object when provided')
  }

  const expectedHostSessionId = parseExpectedHostSessionId(input.expectedHostSessionId)
  const expectedGeneration = parseExpectedGeneration(input.expectedGeneration)
  const followLatest = parseFollowLatest(input.followLatest)

  if (expectedHostSessionId !== undefined && followLatest === true) {
    throw new TypeError('expectedHostSessionId and followLatest cannot be combined')
  }

  return {
    ...(expectedHostSessionId !== undefined ? { expectedHostSessionId } : {}),
    ...(expectedGeneration !== undefined ? { expectedGeneration } : {}),
    ...(followLatest !== undefined ? { followLatest } : {}),
  }
}

export function validateFence(
  input: HrcFence | undefined,
  currentState: HrcActiveSessionState
): HrcFenceValidationResult {
  const fence = parseFence(input)

  if (fence.followLatest === true) {
    return {
      ok: true,
      resolvedHostSessionId: currentState.activeHostSessionId,
      resolvedGeneration: currentState.generation,
    }
  }

  if (
    fence.expectedHostSessionId !== undefined &&
    fence.expectedHostSessionId !== currentState.activeHostSessionId
  ) {
    const error = new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session fence is stale', {
      expectedHostSessionId: fence.expectedHostSessionId,
      activeHostSessionId: currentState.activeHostSessionId,
    })

    return {
      ok: false,
      errorCode: error.code,
      message: error.message,
      detail: error.detail,
    }
  }

  if (
    fence.expectedGeneration !== undefined &&
    fence.expectedGeneration !== currentState.generation
  ) {
    const error = new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'generation fence is stale', {
      expectedGeneration: fence.expectedGeneration,
      activeGeneration: currentState.generation,
    })

    return {
      ok: false,
      errorCode: error.code,
      message: error.message,
      detail: error.detail,
    }
  }

  return {
    ok: true,
    resolvedHostSessionId: currentState.activeHostSessionId,
    resolvedGeneration: currentState.generation,
  }
}

export function createInvalidFenceError(
  message: string,
  detail: Record<string, unknown> = {}
): HrcHttpError {
  return createHrcError(HrcErrorCode.INVALID_FENCE, message, detail)
}
