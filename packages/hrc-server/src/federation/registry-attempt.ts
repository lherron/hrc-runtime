import type { BindingRegistryClientOptions } from './registry-client.js'
import {
  RegistryRefusedError,
  RegistryUnreachableError,
  classifyUnreachable,
} from './registry-client.js'
import { isRecord } from './registry-reply.js'

/**
 * The bounded attempt discipline every registry HTTP route runs under: one
 * per-attempt timer raced against the caller's abort, a total wall-clock
 * deadline across attempts, and jittered exponential backoff that never sleeps
 * past that deadline.
 */

const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 2_000
const DEFAULT_TOTAL_TIMEOUT_MS = 5_000
export const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 250

const PROVABLY_PRE_SEND_CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

class AttemptTimedOut extends Error {}
class CallerAborted extends Error {}

export type AttemptOptions = Pick<
  BindingRegistryClientOptions,
  'perAttemptTimeoutMs' | 'totalTimeoutMs' | 'now' | 'random' | 'sleep'
>

/**
 * How one retrying call decides and reports. Retry eligibility is the only
 * policy difference between routes; the hooks let each route keep its own log
 * events without owning the loop.
 */
export type RetryPolicy<T> = {
  signal?: AbortSignal | undefined
  /** Whether a failed attempt may be retried at all; the budget is checked after. */
  mayRetryAfter?: ((error: unknown) => boolean) | undefined
  /** Runs before each attempt, outside the attempt's failure handling. */
  onAttempt?: ((attempt: number) => void) | undefined
  onSuccess?: ((attempt: number, result: T) => void) | undefined
  onRefused?: ((attempt: number, error: RegistryRefusedError) => void) | undefined
  onRetry?: ((attempt: number, failure: RegistryUnreachableError) => void) | undefined
  onGiveUp?: ((attempt: number, failure: RegistryUnreachableError) => void) | undefined
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RegistryRefusedError(400, 'invalid_request')
  }
  return value
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CallerAborted())
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      reject(new CallerAborted())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function errorCode(error: unknown): string | undefined {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && isRecord(candidate); depth += 1) {
    if (typeof candidate['code'] === 'string') return candidate['code']
    candidate = candidate['cause']
  }
  return undefined
}

/** A connect failure that proves the request never reached the registry. */
export function isProvablyPreSendConnectFailure(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && PROVABLY_PRE_SEND_CONNECT_CODES.has(code)
}

export class RegistryAttempts {
  readonly #perAttemptTimeoutMs: number
  readonly #totalTimeoutMs: number
  readonly #now: () => number
  readonly #random: () => number
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(options: AttemptOptions = {}) {
    this.#perAttemptTimeoutMs = positiveDuration(
      options.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS
    )
    this.#totalTimeoutMs = positiveDuration(options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
    this.#now = options.now ?? (() => performance.now())
    this.#random = options.random ?? Math.random
    this.#sleep = options.sleep ?? defaultSleep
  }

  /** A single bounded attempt under a fresh total deadline; never retried. */
  async once<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    return await this.#runAttempt(this.#now() + this.#totalTimeoutMs, operation, callerSignal)
  }

  /**
   * Up to MAX_ATTEMPTS bounded attempts under one total deadline. A refusal is
   * final; any other failure becomes RegistryUnreachableError and is retried
   * while the policy allows it, the caller has not aborted, and budget remains.
   */
  async retrying<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    policy: RetryPolicy<T> = {}
  ): Promise<T> {
    const deadline = this.#now() + this.#totalTimeoutMs
    let lastFailure: RegistryUnreachableError | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      policy.onAttempt?.(attempt)
      try {
        const result = await this.#runAttempt(deadline, operation, policy.signal)
        policy.onSuccess?.(attempt, result)
        return result
      } catch (error) {
        if (error instanceof RegistryRefusedError) {
          policy.onRefused?.(attempt, error)
          throw error
        }
        lastFailure = classifyUnreachable(error)
        const mayRetry =
          attempt < MAX_ATTEMPTS &&
          (policy.mayRetryAfter?.(error) ?? true) &&
          !policy.signal?.aborted &&
          this.#remaining(deadline) > 0
        if (!mayRetry) {
          policy.onGiveUp?.(attempt, lastFailure)
          throw lastFailure
        }
        policy.onRetry?.(attempt, lastFailure)
        await this.#backoff(attempt, deadline, policy.signal)
      }
    }

    throw lastFailure ?? new RegistryUnreachableError()
  }

  async #runAttempt<T>(
    deadline: number,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal
  ): Promise<T> {
    const remaining = this.#remaining(deadline)
    if (remaining <= 0) {
      throw new AttemptTimedOut('federation binding registry total budget exhausted')
    }
    if (callerSignal?.aborted) throw new CallerAborted()

    const attemptBudget = Math.min(this.#perAttemptTimeoutMs, remaining)
    const controller = new AbortController()
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', onCallerAbort)
        callback()
      }
      const onCallerAbort = () => {
        controller.abort(callerSignal?.reason)
        finish(() => reject(new CallerAborted()))
      }
      const timer = setTimeout(
        () => {
          controller.abort(new AttemptTimedOut())
          finish(() => reject(new AttemptTimedOut()))
        },
        Math.max(1, Math.ceil(attemptBudget))
      )

      callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
      Promise.resolve(operation(controller.signal)).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error))
      )
    })
  }

  async #backoff(attempt: number, deadline: number, signal?: AbortSignal): Promise<void> {
    const remaining = this.#remaining(deadline)
    if (remaining <= 0) throw new AttemptTimedOut()
    const ceiling = INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
    const random = Math.max(0, Math.min(1, this.#random()))
    const jittered = ceiling * (0.5 + random * 0.5)
    const delay = Math.min(remaining, jittered)
    try {
      await this.#sleep(delay, signal)
    } catch (error) {
      throw new RegistryUnreachableError('federation binding registry retry aborted', error)
    }
  }

  #remaining(deadline: number): number {
    return Math.max(0, deadline - this.#now())
  }
}
