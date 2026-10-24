import type {
  BindingEstablishResult,
  BindingRegistry,
  BirthDesignationRecord,
  BirthDesignationResult,
  DeleteBindingResult,
  PlacementBinding,
} from 'hrc-store-sqlite'

import type { BirthEnvelopeReader } from './birth-designation.js'

/**
 * The federation binding-registry client contract: what every caller (summon
 * gate, locate, retirement, startup repair) may ask the registry, and the two
 * error types it may branch on. The registry host answers in-process
 * (registry-local-client.ts); every other node asks over authenticated HTTP
 * (registry-http-client.ts).
 */

/** What the registry knows about a scope's tier-5 designation, for locate. */
export type RegistryDesignationRead =
  | { outcome: 'designated' | 'superseded'; designation: BirthDesignationRecord }
  | { outcome: 'none' }

export type RegistryConsultResult =
  | { outcome: 'bound'; binding: PlacementBinding }
  | { outcome: 'unbound' }

export interface BindingRegistryClient {
  consult(scopeRef: string, options?: { signal?: AbortSignal }): Promise<RegistryConsultResult>
  establish(request: Parameters<BindingRegistry['establish']>[0]): Promise<BindingEstablishResult>
  /**
   * T-07655 — ask the registry host which node a VIRGIN scope should be born
   * on, when nothing has declared a home for it.
   *
   * The request carries the target scope and NOTHING ELSE. The host reads the
   * scope's birth envelope from wrkq itself and follows the home of the scope
   * that sent it, so a caller cannot influence the answer, and every node that
   * tailed the same ledger insert receives the same one.
   *
   * Optional only for the direct unit consumers that build a partial double;
   * every client a running daemon holds implements it.
   */
  designateBirth?(
    scopeRef: string,
    options?: { signal?: AbortSignal }
  ): Promise<BirthDesignationResult>
  /**
   * T-07661 — the virgin births THIS node still owes: live designations naming
   * it whose scope has never been established.
   *
   * It is a READ of decisions the host already took, never a way to take one:
   * the host answers only about the authenticated caller, so no node can learn
   * of, or be handed, a birth designated to somebody else. The kicker's
   * periodic sweep uses it as a candidate source for scopes NOBODY seats, which
   * is the one class its seated-scopes candidate set can never contain.
   */
  listUnbornDesignations?(
    homeNodeId: string,
    options?: { signal?: AbortSignal }
  ): Promise<BirthDesignationRecord[]>
  /**
   * The READ-ONLY companion, for `hrc target locate`. It never records a
   * designation: a report that decided placement as a side effect of being read
   * would change the very thing it reports.
   */
  readDesignation?(
    scopeRef: string,
    options?: { signal?: AbortSignal }
  ): Promise<RegistryDesignationRead>
  deleteBinding(
    request: Parameters<BindingRegistry['deleteBinding']>[0]
  ): Promise<DeleteBindingResult>
}

export class RegistryUnreachableError extends Error {
  readonly retryable = true
  override readonly cause: unknown | undefined

  constructor(message = 'federation binding registry is unreachable', cause?: unknown) {
    super(message)
    this.name = 'RegistryUnreachableError'
    this.cause = cause
  }
}

export class RegistryRefusedError extends Error {
  readonly retryable = false

  constructor(
    readonly status: number,
    readonly code: 'unauthorized' | 'invalid_request' | 'authenticated_node_mismatch'
  ) {
    super(`federation binding registry refused the request (${code})`)
    this.name = 'RegistryRefusedError'
  }
}

export type RegistryClientFetch = (url: string, init: RequestInit) => Promise<Response>

export type RegistryClientLog = (
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  details?: Record<string, unknown>
) => void

export type BindingRegistryClientOptions = {
  /**
   * The registry HOST's wrkq birth-envelope read (T-07655). Only the local
   * client uses it: a peer's designation is answered by the host, never
   * re-derived from the asking node's own ledger view.
   */
  birthEnvelopeFor?: BirthEnvelopeReader | undefined
  /** Per HTTP attempt; defaults to 2 seconds. */
  perAttemptTimeoutMs?: number | undefined
  /** Total wall-clock budget including retries and backoff; defaults to 5 seconds. */
  totalTimeoutMs?: number | undefined
  /** Test seams; production callers should leave these unset. */
  fetch?: RegistryClientFetch | undefined
  now?: (() => number) | undefined
  random?: (() => number) | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
  log?: RegistryClientLog | undefined
}

/** Turns any non-taxonomy failure into an unreachable (retryable) registry. */
export function classifyUnreachable(error: unknown): RegistryUnreachableError {
  if (error instanceof RegistryUnreachableError) return error
  return new RegistryUnreachableError(undefined, error)
}

/** Passes a refusal through unchanged; anything else is an unreachable registry. */
export function asRegistryError(error: unknown): RegistryRefusedError | RegistryUnreachableError {
  return error instanceof RegistryRefusedError ? error : classifyUnreachable(error)
}

/** A blank scope or node id is a malformed request on every transport. */
export function refuseBlank(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RegistryRefusedError(400, 'invalid_request')
  }
}
