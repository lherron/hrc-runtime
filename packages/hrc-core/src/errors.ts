export const HrcErrorCode = {
  MALFORMED_REQUEST: 'malformed_request',
  INVALID_SELECTOR: 'invalid_selector',
  INVALID_FENCE: 'invalid_fence',
  UNKNOWN_SESSION: 'unknown_session',
  UNKNOWN_HOST_SESSION: 'unknown_host_session',
  UNKNOWN_RUNTIME: 'unknown_runtime',
  UNKNOWN_SURFACE: 'unknown_surface',
  STALE_CONTEXT: 'stale_context',
  RUNTIME_BUSY: 'runtime_busy',
  RUN_MISMATCH: 'run_mismatch',
  MISSING_RUNTIME_INTENT: 'missing_runtime_intent',
  PROVIDER_MISMATCH: 'provider_mismatch',
  INFLIGHT_UNSUPPORTED: 'inflight_unsupported',
  RUNTIME_UNAVAILABLE: 'runtime_unavailable',
  INTERNAL_ERROR: 'internal_error',
} as const

export type HrcErrorCode = (typeof HrcErrorCode)[keyof typeof HrcErrorCode]

export type HrcHttpStatus = 400 | 404 | 409 | 422 | 500 | 503

export type HrcHttpError = {
  error: {
    code: HrcErrorCode
    message: string
    detail: Record<string, unknown>
  }
}

const HRC_ERROR_STATUS_BY_CODE: Record<HrcErrorCode, HrcHttpStatus> = {
  [HrcErrorCode.MALFORMED_REQUEST]: 400,
  [HrcErrorCode.INVALID_SELECTOR]: 400,
  [HrcErrorCode.INVALID_FENCE]: 400,
  [HrcErrorCode.UNKNOWN_SESSION]: 404,
  [HrcErrorCode.UNKNOWN_HOST_SESSION]: 404,
  [HrcErrorCode.UNKNOWN_RUNTIME]: 404,
  [HrcErrorCode.UNKNOWN_SURFACE]: 404,
  [HrcErrorCode.STALE_CONTEXT]: 409,
  [HrcErrorCode.RUNTIME_BUSY]: 409,
  [HrcErrorCode.RUN_MISMATCH]: 409,
  [HrcErrorCode.MISSING_RUNTIME_INTENT]: 422,
  [HrcErrorCode.PROVIDER_MISMATCH]: 422,
  [HrcErrorCode.INFLIGHT_UNSUPPORTED]: 422,
  [HrcErrorCode.RUNTIME_UNAVAILABLE]: 503,
  [HrcErrorCode.INTERNAL_ERROR]: 500,
}

export function httpStatusForErrorCode(code: HrcErrorCode): HrcHttpStatus {
  return HRC_ERROR_STATUS_BY_CODE[code]
}

export function createHrcError(
  code: HrcErrorCode,
  message: string,
  detail: Record<string, unknown> = {}
): HrcHttpError {
  return {
    error: {
      code,
      message,
      detail,
    },
  }
}

export class HrcDomainError extends Error {
  readonly code: HrcErrorCode
  readonly status: HrcHttpStatus
  readonly detail: Record<string, unknown>

  constructor(code: HrcErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HrcDomainError'
    this.code = code
    this.status = httpStatusForErrorCode(code)
    this.detail = detail
  }

  toResponse(): HrcHttpError {
    return createHrcError(this.code, this.message, this.detail)
  }
}

export class HrcBadRequestError extends HrcDomainError {
  constructor(
    code: Extract<HrcErrorCode, 'malformed_request' | 'invalid_selector' | 'invalid_fence'>,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(code, message, detail)
    this.name = 'HrcBadRequestError'
  }
}

export class HrcNotFoundError extends HrcDomainError {
  constructor(
    code: Extract<
      HrcErrorCode,
      'unknown_session' | 'unknown_host_session' | 'unknown_runtime' | 'unknown_surface'
    >,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(code, message, detail)
    this.name = 'HrcNotFoundError'
  }
}

export class HrcConflictError extends HrcDomainError {
  constructor(
    code: Extract<HrcErrorCode, 'stale_context' | 'runtime_busy' | 'run_mismatch'>,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(code, message, detail)
    this.name = 'HrcConflictError'
  }
}

export class HrcUnprocessableEntityError extends HrcDomainError {
  constructor(
    code: Extract<
      HrcErrorCode,
      'missing_runtime_intent' | 'provider_mismatch' | 'inflight_unsupported'
    >,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(code, message, detail)
    this.name = 'HrcUnprocessableEntityError'
  }
}

export class HrcRuntimeUnavailableError extends HrcDomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(HrcErrorCode.RUNTIME_UNAVAILABLE, message, detail)
    this.name = 'HrcRuntimeUnavailableError'
  }
}

export class HrcInternalError extends HrcDomainError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(HrcErrorCode.INTERNAL_ERROR, message, detail)
    this.name = 'HrcInternalError'
  }
}
