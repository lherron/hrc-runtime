export const HrcErrorCode = {
  MALFORMED_REQUEST: 'malformed_request',
  /** External-participant registration request failed its wire-contract validation. */
  MALFORMED_REGISTRATION: 'malformed',
  INVALID_SELECTOR: 'invalid_selector',
  INVALID_FENCE: 'invalid_fence',
  UNKNOWN_SESSION: 'unknown_session',
  UNKNOWN_HOST_SESSION: 'unknown_host_session',
  UNKNOWN_RUNTIME: 'unknown_runtime',
  /** External-participant grant request named no operator-ratified registration class. */
  UNKNOWN_REGISTRATION_CLASS: 'unknown_class',
  UNKNOWN_SURFACE: 'unknown_surface', // Phase 4 forward declaration — surfaces are resolved in phase 4
  UNKNOWN_BRIDGE: 'unknown_bridge', // Phase 5 forward declaration — bridges are resolved in phase 5
  /** @deprecated Use STALE_CONTEXT instead. Alias retained for backward compatibility with existing server/SDK references. */
  CONFLICT: 'stale_context',
  STALE_CONTEXT: 'stale_context',
  RUNTIME_BUSY: 'runtime_busy',
  RUN_MISMATCH: 'run_mismatch',
  MISSING_RUNTIME_INTENT: 'missing_runtime_intent',
  PROVIDER_MISMATCH: 'provider_mismatch',
  INFLIGHT_UNSUPPORTED: 'inflight_unsupported',
  UNSUPPORTED_WHEN_BUSY: 'unsupported_when_busy',
  /**
   * T-07155 urgent (`whenBusy: 'steer'`) delivery outcomes. Each is terminal at
   * RPC return and none falls back to the ordinary deferred queue: a supervisor
   * must never believe an order landed when it did not.
   */
  /** The live broker process cannot execute the steer policy (old process, or an unsteerable driver). */
  URGENT_DELIVERY_UNSUPPORTED: 'urgent_delivery_unsupported',
  /** The active turn ended between the busy check and the steer; the sender retries deliberately. */
  URGENT_DELIVERY_RACE_LOST: 'urgent_delivery_race_lost',
  /** The steer RPC timed out or was interrupted; whether the harness applied it is genuinely unknown. */
  URGENT_DELIVERY_AMBIGUOUS: 'urgent_delivery_ambiguous',
  /** The destination peer cannot accept urgent delivery, so the origin refuses before send. */
  URGENT_DELIVERY_UNROUTABLE: 'urgent_delivery_unroutable',
  BROKER_DESCRIPTOR_ABSENT: 'broker_descriptor_absent',
  ASK_CLIENT_UNSUPPORTED: 'ask_client_unsupported',
  /** The daemon has durably closed new turn admission for a drained restart. */
  SERVER_DRAINING: 'server_draining',
  RUNTIME_UNAVAILABLE: 'runtime_unavailable',
  RUN_ZOMBIE_TIMEOUT: 'run_zombie_timeout',
  RUNTIME_TERMINATED_WITH_ACTIVE_RUN: 'runtime_terminated_with_active_run',
  RUNTIME_DEAD_WITH_ACTIVE_RUN: 'runtime_dead_with_active_run',
  RUNTIME_READY_WITH_ACTIVE_RUN: 'runtime_ready_with_active_run',
  RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN: 'runtime_process_exited_with_active_run',
  RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN: 'runtime_unavailable_with_active_run',
  RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN: 'runtime_busy_timeout_with_active_run',
  INTERNAL_ERROR: 'internal_error',
  UNKNOWN_APP_SESSION: 'unknown_app_session',
  APP_SESSION_REMOVED: 'app_session_removed',
  SESSION_KIND_MISMATCH: 'session_kind_mismatch',
  UNSUPPORTED_CAPABILITY: 'unsupported_capability',
  MISSING_SESSION_SPEC: 'missing_session_spec',
  /** A `--reply-to` anchor lives in a different conversation scope than the target. */
  REPLY_TO_SCOPE_MISMATCH: 'reply_to_scope_mismatch',
  /** `hrc resume` found no latest non-invalidated continuation candidate to resume. */
  NO_RESUMABLE_CONTINUATION: 'no_resumable_continuation',
  /** `hrc resume` selected a prior whose runtime is still live — attach/terminate first. */
  RESUME_RUNTIME_LIVE: 'resume_runtime_live',
  /**
   * Suffix-roster start (T-07118): every slot for the base scope is occupied by
   * a live session. Never destructive — the caller shows "too many open
   * sessions" rather than hijacking a live `:primary`.
   */
  SESSION_ROSTER_EXHAUSTED: 'session_roster_exhausted',
  /**
   * Suffix-roster retry (T-07118): the recorded claim's successor is no longer
   * the slot's active session (the original start died pre-runtime-row and a
   * newer press recycled the slot). The logical press failed; a fresh press
   * needs a fresh idempotency key. Never starts the archived predecessor.
   */
  ROSTER_CLAIM_SUPERSEDED: 'roster_claim_superseded',
  /**
   * Exact-scope start (T-07302): the one scope the caller named is occupied by
   * a live session or an in-flight start. `conflictPolicy: 'reject'` has no
   * reuse option and no next slot to walk, so this is the whole answer — and it
   * is returned with NO mutation of the occupying conversation.
   */
  SESSION_SCOPE_OCCUPIED: 'session_scope_occupied',
  /**
   * A durable idempotency key was replayed with a semantically different
   * request body (T-07118). Returned BEFORE any start path runs, so a
   * conflicting replay can never mutate the claimed session's persisted intent.
   */
  IDEMPOTENCY_KEY_CONFLICT: 'idempotency_key_conflict',
  /** Every live or established slot in an external-participant class is occupied. */
  REGISTRATION_INSTANCES_EXHAUSTED: 'instances_exhausted',
  /**
   * A prompt was dispatched to a runtime generation and the harness never
   * produced `turn.started` before the generation's durable deadline (T-07235).
   * Recorded once, durably, by the armed-row evaluation pass; every waiter
   * (`hrc start --wait`, the ACP pending-run path) reads that one fact rather
   * than timing out privately.
   */
  FIRST_TURN_MISSING: 'first_turn_missing',
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
  [HrcErrorCode.MALFORMED_REGISTRATION]: 400,
  [HrcErrorCode.INVALID_SELECTOR]: 400,
  [HrcErrorCode.INVALID_FENCE]: 400,
  [HrcErrorCode.UNKNOWN_SESSION]: 404,
  [HrcErrorCode.UNKNOWN_HOST_SESSION]: 404,
  [HrcErrorCode.UNKNOWN_RUNTIME]: 404,
  [HrcErrorCode.UNKNOWN_REGISTRATION_CLASS]: 404,
  [HrcErrorCode.UNKNOWN_SURFACE]: 404,
  [HrcErrorCode.UNKNOWN_BRIDGE]: 404,
  [HrcErrorCode.STALE_CONTEXT]: 409,
  [HrcErrorCode.RUNTIME_BUSY]: 409,
  [HrcErrorCode.RUN_MISMATCH]: 409,
  [HrcErrorCode.MISSING_RUNTIME_INTENT]: 422,
  [HrcErrorCode.PROVIDER_MISMATCH]: 422,
  [HrcErrorCode.INFLIGHT_UNSUPPORTED]: 422,
  [HrcErrorCode.UNSUPPORTED_WHEN_BUSY]: 422,
  [HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED]: 422,
  [HrcErrorCode.URGENT_DELIVERY_RACE_LOST]: 409,
  [HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS]: 503,
  [HrcErrorCode.URGENT_DELIVERY_UNROUTABLE]: 409,
  [HrcErrorCode.BROKER_DESCRIPTOR_ABSENT]: 422,
  [HrcErrorCode.ASK_CLIENT_UNSUPPORTED]: 422,
  [HrcErrorCode.SERVER_DRAINING]: 503,
  [HrcErrorCode.RUNTIME_UNAVAILABLE]: 503,
  [HrcErrorCode.RUN_ZOMBIE_TIMEOUT]: 500,
  [HrcErrorCode.RUNTIME_TERMINATED_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.RUNTIME_DEAD_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.RUNTIME_READY_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN]: 500,
  [HrcErrorCode.INTERNAL_ERROR]: 500,
  [HrcErrorCode.UNKNOWN_APP_SESSION]: 404,
  [HrcErrorCode.APP_SESSION_REMOVED]: 409,
  [HrcErrorCode.SESSION_KIND_MISMATCH]: 422,
  [HrcErrorCode.UNSUPPORTED_CAPABILITY]: 422,
  [HrcErrorCode.MISSING_SESSION_SPEC]: 422,
  [HrcErrorCode.REPLY_TO_SCOPE_MISMATCH]: 409,
  [HrcErrorCode.NO_RESUMABLE_CONTINUATION]: 422,
  [HrcErrorCode.RESUME_RUNTIME_LIVE]: 409,
  [HrcErrorCode.SESSION_ROSTER_EXHAUSTED]: 409,
  [HrcErrorCode.ROSTER_CLAIM_SUPERSEDED]: 409,
  [HrcErrorCode.SESSION_SCOPE_OCCUPIED]: 409,
  [HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT]: 409,
  [HrcErrorCode.REGISTRATION_INSTANCES_EXHAUSTED]: 409,
  // The provisioned runtime accepted the prompt and never produced a turn: the
  // upstream harness, not the caller's request, is what failed.
  [HrcErrorCode.FIRST_TURN_MISSING]: 503,
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
    code: Extract<
      HrcErrorCode,
      'malformed_request' | 'malformed' | 'invalid_selector' | 'invalid_fence'
    >,
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
      | 'unknown_session'
      | 'unknown_host_session'
      | 'unknown_runtime'
      | 'unknown_class'
      | 'unknown_surface'
      | 'unknown_bridge'
      | 'unknown_app_session'
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
    code: Extract<
      HrcErrorCode,
      | 'stale_context'
      | 'runtime_busy'
      | 'run_mismatch'
      | 'app_session_removed'
      | 'reply_to_scope_mismatch'
      | 'resume_runtime_live'
      | 'session_roster_exhausted'
      | 'roster_claim_superseded'
      | 'session_scope_occupied'
      | 'idempotency_key_conflict'
      | 'instances_exhausted'
    >,
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
      | 'missing_runtime_intent'
      | 'provider_mismatch'
      | 'inflight_unsupported'
      | 'unsupported_when_busy'
      | 'urgent_delivery_unsupported'
      | 'broker_descriptor_absent'
      | 'ask_client_unsupported'
      | 'session_kind_mismatch'
      | 'unsupported_capability'
      | 'missing_session_spec'
      | 'no_resumable_continuation'
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
