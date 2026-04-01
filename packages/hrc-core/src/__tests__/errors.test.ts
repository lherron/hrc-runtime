/**
 * RED/GREEN TDD tests for HRC error codes and HTTP status mapping (T-00949)
 *
 * Spec reference: HRC_IMPLEMENTATION_PLAN.md § HTTP error model
 *
 * All non-streaming failures return:
 *   { error: { code: string, message: string, detail: {} } }
 *
 * Required status mapping:
 *   400 — malformed request body, invalid selector, invalid fence shape
 *   404 — unknown session, unknown host session, unknown runtime
 *   409 — stale_context, runtime_busy, run_mismatch
 *   422 — missing_runtime_intent, provider_mismatch, inflight_unsupported
 *   503 — runtime_unavailable
 *   500 — unexpected internal error
 *
 * Error codes in HTTP responses must match the HRC domain error code strings
 * so CLI, SDK, and tests can assert the same values.
 */

import { describe, expect, test } from 'bun:test'

import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  createHrcError,
  httpStatusForErrorCode,
} from '../errors.js'

// ===================================================================
// Error code enum completeness
// ===================================================================

describe('HrcErrorCode completeness (T-00949)', () => {
  test('defines all required 400-class error codes', () => {
    expect(HrcErrorCode.MALFORMED_REQUEST).toBeDefined()
    expect(HrcErrorCode.INVALID_SELECTOR).toBeDefined()
    expect(HrcErrorCode.INVALID_FENCE).toBeDefined()
  })

  test('defines all required 404-class error codes', () => {
    expect(HrcErrorCode.UNKNOWN_SESSION).toBeDefined()
    expect(HrcErrorCode.UNKNOWN_HOST_SESSION).toBeDefined()
    expect(HrcErrorCode.UNKNOWN_RUNTIME).toBeDefined()
  })

  test('defines all required 409-class error codes', () => {
    expect(HrcErrorCode.STALE_CONTEXT).toBeDefined()
    expect(HrcErrorCode.RUNTIME_BUSY).toBeDefined()
    expect(HrcErrorCode.RUN_MISMATCH).toBeDefined()
  })

  test('defines all required 422-class error codes', () => {
    expect(HrcErrorCode.MISSING_RUNTIME_INTENT).toBeDefined()
    expect(HrcErrorCode.PROVIDER_MISMATCH).toBeDefined()
    expect(HrcErrorCode.INFLIGHT_UNSUPPORTED).toBeDefined()
  })

  test('defines 503 runtime_unavailable', () => {
    expect(HrcErrorCode.RUNTIME_UNAVAILABLE).toBeDefined()
  })

  test('defines 500 internal_error', () => {
    expect(HrcErrorCode.INTERNAL_ERROR).toBeDefined()
  })
})

// ===================================================================
// Error code values are stable strings
// ===================================================================

describe('HrcErrorCode values are string constants (T-00949)', () => {
  test('error codes are lowercase snake_case strings', () => {
    expect(HrcErrorCode.STALE_CONTEXT).toBe('stale_context')
    expect(HrcErrorCode.RUNTIME_BUSY).toBe('runtime_busy')
    expect(HrcErrorCode.RUN_MISMATCH).toBe('run_mismatch')
    expect(HrcErrorCode.MALFORMED_REQUEST).toBe('malformed_request')
    expect(HrcErrorCode.INVALID_SELECTOR).toBe('invalid_selector')
    expect(HrcErrorCode.INVALID_FENCE).toBe('invalid_fence')
    expect(HrcErrorCode.UNKNOWN_SESSION).toBe('unknown_session')
    expect(HrcErrorCode.UNKNOWN_HOST_SESSION).toBe('unknown_host_session')
    expect(HrcErrorCode.UNKNOWN_RUNTIME).toBe('unknown_runtime')
    expect(HrcErrorCode.MISSING_RUNTIME_INTENT).toBe('missing_runtime_intent')
    expect(HrcErrorCode.PROVIDER_MISMATCH).toBe('provider_mismatch')
    expect(HrcErrorCode.INFLIGHT_UNSUPPORTED).toBe('inflight_unsupported')
    expect(HrcErrorCode.RUNTIME_UNAVAILABLE).toBe('runtime_unavailable')
    expect(HrcErrorCode.INTERNAL_ERROR).toBe('internal_error')
  })
})

// ===================================================================
// HTTP status mapping
// ===================================================================

describe('httpStatusForErrorCode (T-00949)', () => {
  test('400 for malformed request codes', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.MALFORMED_REQUEST)).toBe(400)
    expect(httpStatusForErrorCode(HrcErrorCode.INVALID_SELECTOR)).toBe(400)
    expect(httpStatusForErrorCode(HrcErrorCode.INVALID_FENCE)).toBe(400)
  })

  test('404 for unknown resource codes', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.UNKNOWN_SESSION)).toBe(404)
    expect(httpStatusForErrorCode(HrcErrorCode.UNKNOWN_HOST_SESSION)).toBe(404)
    expect(httpStatusForErrorCode(HrcErrorCode.UNKNOWN_RUNTIME)).toBe(404)
  })

  test('409 for conflict codes', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.STALE_CONTEXT)).toBe(409)
    expect(httpStatusForErrorCode(HrcErrorCode.RUNTIME_BUSY)).toBe(409)
    expect(httpStatusForErrorCode(HrcErrorCode.RUN_MISMATCH)).toBe(409)
  })

  test('422 for semantic validation codes', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.MISSING_RUNTIME_INTENT)).toBe(422)
    expect(httpStatusForErrorCode(HrcErrorCode.PROVIDER_MISMATCH)).toBe(422)
    expect(httpStatusForErrorCode(HrcErrorCode.INFLIGHT_UNSUPPORTED)).toBe(422)
  })

  test('503 for runtime_unavailable', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.RUNTIME_UNAVAILABLE)).toBe(503)
  })

  test('500 for internal_error', () => {
    expect(httpStatusForErrorCode(HrcErrorCode.INTERNAL_ERROR)).toBe(500)
  })

  test('every HrcErrorCode has a mapping (no undefined returns)', () => {
    const allCodes = Object.values(HrcErrorCode)
    for (const code of allCodes) {
      const status = httpStatusForErrorCode(code)
      expect(typeof status).toBe('number')
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThanOrEqual(599)
    }
  })
})

// ===================================================================
// Error construction
// ===================================================================

describe('createHrcError (T-00949)', () => {
  test('creates error with code, message, and empty detail', () => {
    const err = createHrcError(HrcErrorCode.STALE_CONTEXT, 'session moved on')
    expect(err.error.code).toBe('stale_context')
    expect(err.error.message).toBe('session moved on')
    expect(err.error.detail).toEqual({})
  })

  test('creates error with detail object', () => {
    const err = createHrcError(HrcErrorCode.STALE_CONTEXT, 'generation mismatch', {
      expected: 3,
      actual: 5,
    })
    expect(err.error.code).toBe('stale_context')
    expect(err.error.detail).toEqual({ expected: 3, actual: 5 })
  })

  test('error shape matches HTTP error model spec', () => {
    const err = createHrcError(HrcErrorCode.UNKNOWN_SESSION, 'not found')
    // Must have exactly { error: { code, message, detail } }
    expect(err).toHaveProperty('error')
    expect(err.error).toHaveProperty('code')
    expect(err.error).toHaveProperty('message')
    expect(err.error).toHaveProperty('detail')
    expect(typeof err.error.code).toBe('string')
    expect(typeof err.error.message).toBe('string')
    expect(typeof err.error.detail).toBe('object')
  })

  test('error code string matches domain enum value (CLI/SDK parity)', () => {
    const err = createHrcError(HrcErrorCode.RUNTIME_BUSY, 'busy')
    // The serialized code must equal the enum value exactly
    expect(err.error.code).toBe(HrcErrorCode.RUNTIME_BUSY)
  })
})

// ===================================================================
// n-31: Error subclass constructor coverage (T-00985)
// ===================================================================

describe('HrcDomainError base class (n-31 / T-00985)', () => {
  test('sets name, code, status, message, and detail', () => {
    const err = new HrcDomainError(HrcErrorCode.STALE_CONTEXT, 'stale', { gen: 5 })
    expect(err.name).toBe('HrcDomainError')
    expect(err.code).toBe('stale_context')
    expect(err.status).toBe(409)
    expect(err.message).toBe('stale')
    expect(err.detail).toEqual({ gen: 5 })
  })

  test('defaults detail to empty object', () => {
    const err = new HrcDomainError(HrcErrorCode.INTERNAL_ERROR, 'boom')
    expect(err.detail).toEqual({})
  })

  test('is an instance of Error', () => {
    const err = new HrcDomainError(HrcErrorCode.INTERNAL_ERROR, 'boom')
    expect(err).toBeInstanceOf(Error)
  })

  test('toResponse() returns correct HrcHttpError shape', () => {
    const err = new HrcDomainError(HrcErrorCode.RUNTIME_BUSY, 'busy', { runtimeId: 'rt-1' })
    const resp = err.toResponse()
    expect(resp).toEqual({
      error: {
        code: 'runtime_busy',
        message: 'busy',
        detail: { runtimeId: 'rt-1' },
      },
    })
  })

  test('toResponse() preserves empty detail', () => {
    const err = new HrcDomainError(HrcErrorCode.INTERNAL_ERROR, 'oops')
    const resp = err.toResponse()
    expect(resp.error.detail).toEqual({})
  })
})

describe('HrcBadRequestError (n-31 / T-00985)', () => {
  test('sets name to HrcBadRequestError and status to 400', () => {
    const err = new HrcBadRequestError('malformed_request', 'bad body', { field: 'x' })
    expect(err.name).toBe('HrcBadRequestError')
    expect(err.status).toBe(400)
    expect(err.code).toBe('malformed_request')
    expect(err.message).toBe('bad body')
    expect(err.detail).toEqual({ field: 'x' })
  })

  test('works with invalid_selector code', () => {
    const err = new HrcBadRequestError('invalid_selector', 'bad selector')
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_selector')
  })

  test('works with invalid_fence code', () => {
    const err = new HrcBadRequestError('invalid_fence', 'bad fence')
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_fence')
  })

  test('toResponse() roundtrips correctly', () => {
    const err = new HrcBadRequestError('malformed_request', 'oops', { key: 'val' })
    const resp = err.toResponse()
    expect(resp.error.code).toBe('malformed_request')
    expect(resp.error.message).toBe('oops')
    expect(resp.error.detail).toEqual({ key: 'val' })
  })

  test('is instanceof HrcDomainError and Error', () => {
    const err = new HrcBadRequestError('malformed_request', 'test')
    expect(err).toBeInstanceOf(HrcDomainError)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('HrcNotFoundError (n-31 / T-00985)', () => {
  test('sets name and status 404 for each code', () => {
    const codes = [
      'unknown_session',
      'unknown_host_session',
      'unknown_runtime',
      'unknown_surface',
      'unknown_bridge',
    ] as const

    for (const code of codes) {
      const err = new HrcNotFoundError(code, `${code} not found`)
      expect(err.name).toBe('HrcNotFoundError')
      expect(err.status).toBe(404)
      expect(err.code).toBe(code)
    }
  })

  test('toResponse() preserves detail', () => {
    const err = new HrcNotFoundError('unknown_runtime', 'gone', { runtimeId: 'rt-999' })
    const resp = err.toResponse()
    expect(resp.error.detail).toEqual({ runtimeId: 'rt-999' })
  })
})

describe('HrcConflictError (n-31 / T-00985)', () => {
  test('sets name and status 409 for each code', () => {
    const codes = ['stale_context', 'runtime_busy', 'run_mismatch'] as const
    for (const code of codes) {
      const err = new HrcConflictError(code, `${code} conflict`)
      expect(err.name).toBe('HrcConflictError')
      expect(err.status).toBe(409)
      expect(err.code).toBe(code)
    }
  })
})

describe('HrcUnprocessableEntityError (n-31 / T-00985)', () => {
  test('sets name and status 422 for each code', () => {
    const codes = ['missing_runtime_intent', 'provider_mismatch', 'inflight_unsupported'] as const
    for (const code of codes) {
      const err = new HrcUnprocessableEntityError(code, `${code} invalid`)
      expect(err.name).toBe('HrcUnprocessableEntityError')
      expect(err.status).toBe(422)
      expect(err.code).toBe(code)
    }
  })
})

describe('HrcRuntimeUnavailableError (n-31 / T-00985)', () => {
  test('hardcodes code to runtime_unavailable and status to 503', () => {
    const err = new HrcRuntimeUnavailableError('not ready', { retry: true })
    expect(err.name).toBe('HrcRuntimeUnavailableError')
    expect(err.code).toBe('runtime_unavailable')
    expect(err.status).toBe(503)
    expect(err.message).toBe('not ready')
    expect(err.detail).toEqual({ retry: true })
  })

  test('toResponse() includes hardcoded code', () => {
    const err = new HrcRuntimeUnavailableError('unavailable')
    expect(err.toResponse().error.code).toBe('runtime_unavailable')
  })
})

describe('HrcInternalError (n-31 / T-00985)', () => {
  test('hardcodes code to internal_error and status to 500', () => {
    const err = new HrcInternalError('unexpected', { stack: 'trace' })
    expect(err.name).toBe('HrcInternalError')
    expect(err.code).toBe('internal_error')
    expect(err.status).toBe(500)
    expect(err.message).toBe('unexpected')
    expect(err.detail).toEqual({ stack: 'trace' })
  })

  test('toResponse() includes hardcoded code', () => {
    const err = new HrcInternalError('crash')
    expect(err.toResponse().error.code).toBe('internal_error')
  })
})
