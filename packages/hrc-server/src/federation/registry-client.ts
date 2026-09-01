import type {
  BindingEstablishResult,
  BindingRegistry,
  BirthDesignationProvenance,
  BirthDesignationRecord,
  BirthDesignationResult,
  BirthDesignationState,
  BirthDesignationSupersededBy,
  DeleteBindingResult,
  PlacementBinding,
} from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { BirthEnvelopeReader } from './birth-designation.js'
import { BirthEnvelopeUnavailableError, designateBirthOnHost } from './birth-designation.js'
import type { PeerEntry } from './federation-config.js'
import { isTailnetHost } from './registry-bind.js'

const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 2_000
const DEFAULT_TOTAL_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 250

const DESIGNATION_SUPERSESSION_SOURCES = new Set<BirthDesignationSupersededBy>([
  'pin',
  'task_default',
  'default_home_node',
  'explicit_local',
])

const DESIGNATION_PROVENANCE = new Set<string>([
  'default_home_node(sender)',
  'default_home_node(sender-retired)',
])

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

type RegistryClientLog = (
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

/**
 * In-process client for the node that owns the binding registry.
 *
 * It deliberately shares the endpoint's open registry handle: a local consult
 * is an authority read, not a peer request, and must not require a self-peer
 * bearer token. The endpoint remains the authenticated transport for every
 * other node.
 */
export class LocalBindingRegistryClient implements BindingRegistryClient {
  readonly #registry: BindingRegistry
  readonly #localNodeId: string
  readonly #log: RegistryClientLog
  readonly #birthEnvelopeFor: BirthEnvelopeReader | undefined

  constructor(
    registry: BindingRegistry,
    localNodeId: string,
    options: Pick<BindingRegistryClientOptions, 'log' | 'birthEnvelopeFor'> = {}
  ) {
    this.#registry = registry
    this.#localNodeId = localNodeId
    this.#log = options.log ?? writeServerLog
    this.#birthEnvelopeFor = options.birthEnvelopeFor
  }

  async consult(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RegistryConsultResult> {
    if (options.signal?.aborted) {
      throw new RegistryUnreachableError('federation binding registry consultation aborted')
    }
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')

    try {
      const record = this.#registry.get(scopeRef)
      let result: RegistryConsultResult
      if (record === undefined) result = { outcome: 'unbound' }
      else result = { outcome: 'bound', binding: record }
      this.#log('INFO', `federation.registry.consult.${result.outcome}`, {
        scopeRef,
        transport: 'local',
        ...(result.outcome === 'bound' ? { homeNodeId: result.binding.homeNodeId } : {}),
      })
      return result
    } catch (error) {
      if (error instanceof RegistryRefusedError || error instanceof RegistryUnreachableError) {
        throw error
      }
      throw classifyUnreachable(error)
    }
  }

  async establish(
    request: Parameters<BindingRegistry['establish']>[0]
  ): Promise<BindingEstablishResult> {
    if (request.homeNodeId !== this.#localNodeId) {
      throw new RegistryRefusedError(400, 'invalid_request')
    }
    try {
      const result = this.#registry.establish(request)
      this.#log('INFO', `federation.registry.establish.${result.outcome}`, {
        scopeRef: request.scopeRef,
        ...(result.outcome === 'designation-mismatch'
          ? {
              designatedHomeNodeId: result.designation.homeNodeId,
              designationEpoch: result.designation.designationEpoch,
            }
          : {
              homeNodeId: result.binding.homeNodeId,
            }),
        transport: 'local',
      })
      return result
    } catch (error) {
      if (error instanceof RegistryRefusedError || error instanceof RegistryUnreachableError) {
        throw error
      }
      throw classifyUnreachable(error)
    }
  }

  async designateBirth(scopeRef: string): Promise<BirthDesignationResult> {
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')
    // This node HOSTS the registry, so it runs the host routine in-process
    // rather than calling itself over HTTP — the same shape every other local
    // authority read takes here, and it needs no self-peer bearer token.
    try {
      const result = await designateBirthOnHost(
        {
          registry: this.#registry,
          ...(this.#birthEnvelopeFor === undefined
            ? {}
            : { birthEnvelopeFor: this.#birthEnvelopeFor }),
        },
        scopeRef
      )
      this.#log('INFO', `federation.registry.designate_birth.${result.kind}`, {
        scopeRef,
        transport: 'local',
        ...(result.kind === 'designated'
          ? {
              homeNodeId: result.designation.homeNodeId,
              provenance: result.designation.provenance,
              designationEpoch: result.designation.designationEpoch,
              senderScopeRef: result.designation.senderScopeRef,
              birthEnvelopeId: result.designation.birthEnvelopeId,
            }
          : {}),
      })
      return result
    } catch (error) {
      if (error instanceof BirthEnvelopeUnavailableError) {
        throw new RegistryUnreachableError(error.message, error)
      }
      if (error instanceof RegistryRefusedError || error instanceof RegistryUnreachableError) {
        throw error
      }
      throw classifyUnreachable(error)
    }
  }

  /**
   * The host's own answer, in-process. Refused for any node but this one, for
   * the same reason the HTTP route is: the answer is scoped to the asker, so it
   * can never be read as an instruction to birth somebody else's scope.
   */
  async listUnbornDesignations(homeNodeId: string): Promise<BirthDesignationRecord[]> {
    if (homeNodeId !== this.#localNodeId) throw new RegistryRefusedError(400, 'invalid_request')
    return this.#registry.listUnbornDesignationsForNode(homeNodeId)
  }

  async readDesignation(scopeRef: string): Promise<RegistryDesignationRead> {
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')
    const record = this.#registry.latestDesignation(scopeRef)
    if (record === undefined) return { outcome: 'none' }
    return { outcome: record.state === 'live' ? 'designated' : 'superseded', designation: record }
  }

  async deleteBinding(
    request: Parameters<BindingRegistry['deleteBinding']>[0]
  ): Promise<DeleteBindingResult> {
    if (request.expectedHomeNodeId !== this.#localNodeId) {
      throw new RegistryRefusedError(400, 'invalid_request')
    }
    return this.#registry.deleteBinding(request)
  }
}

export function createLocalBindingRegistryClient(
  registry: BindingRegistry,
  localNodeId: string,
  options: Pick<BindingRegistryClientOptions, 'log' | 'birthEnvelopeFor'> = {}
): BindingRegistryClient {
  return new LocalBindingRegistryClient(registry, localNodeId, options)
}

class AttemptTimedOut extends Error {}
class CallerAborted extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseDesignation(
  value: unknown,
  expectedScopeRef: string
): BirthDesignationRecord | undefined {
  if (!isRecord(value)) return undefined
  if (value['scopeRef'] !== expectedScopeRef) return undefined
  const provenance = value['provenance']
  const state = value['state']
  const designationEpoch = value['designationEpoch']
  if (
    !isNonemptyString(value['homeNodeId']) ||
    typeof provenance !== 'string' ||
    !DESIGNATION_PROVENANCE.has(provenance) ||
    !isNonemptyString(value['birthEnvelopeId']) ||
    !isNonemptyString(value['senderScopeRef']) ||
    !isNonemptyString(value['designatedAt']) ||
    (state !== 'live' && state !== 'superseded') ||
    !Number.isSafeInteger(designationEpoch) ||
    Number(designationEpoch) < 1
  ) {
    return undefined
  }
  const supersededBy = value['supersededBy']
  const supersededAt = value['supersededAt']
  return {
    scopeRef: expectedScopeRef,
    homeNodeId: value['homeNodeId'],
    provenance: provenance as BirthDesignationProvenance,
    birthEnvelopeId: value['birthEnvelopeId'],
    senderScopeRef: value['senderScopeRef'],
    designationEpoch: Number(designationEpoch),
    designatedAt: value['designatedAt'],
    state: state as BirthDesignationState,
    ...(isNonemptyString(supersededBy) &&
    DESIGNATION_SUPERSESSION_SOURCES.has(supersededBy as BirthDesignationSupersededBy)
      ? { supersededBy: supersededBy as BirthDesignationSupersededBy }
      : {}),
    ...(isNonemptyString(supersededAt) ? { supersededAt } : {}),
  }
}

function parseBinding(value: unknown, expectedScopeRef: string): PlacementBinding | undefined {
  if (!isRecord(value)) return undefined
  if (value['scopeRef'] !== expectedScopeRef || !isNonemptyString(value['homeNodeId'])) {
    return undefined
  }
  if (!isNonemptyString(value['createdAt']) || !isNonemptyString(value['updatedAt'])) {
    return undefined
  }

  return {
    scopeRef: expectedScopeRef,
    homeNodeId: value['homeNodeId'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  }
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RegistryRefusedError(400, 'invalid_request')
  }
  return value
}

function normalizedRegistryEndpoint(peer: PeerEntry): URL {
  let endpoint: URL
  try {
    endpoint = new URL(peer.registryEndpoint ?? peer.endpoint)
  } catch {
    throw new RegistryRefusedError(400, 'invalid_request')
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.port.length === 0 ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    !isTailnetHost(endpoint.hostname)
  ) {
    throw new RegistryRefusedError(400, 'invalid_request')
  }
  return endpoint
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

function refusedForStatus(status: number): RegistryRefusedError | undefined {
  if (status === 401) return new RegistryRefusedError(401, 'unauthorized')
  if (status === 400) return new RegistryRefusedError(400, 'invalid_request')
  if (status === 403) return new RegistryRefusedError(403, 'authenticated_node_mismatch')
  return undefined
}

function classifyUnreachable(error: unknown): RegistryUnreachableError {
  if (error instanceof RegistryUnreachableError) return error
  return new RegistryUnreachableError(undefined, error)
}

function errorCode(error: unknown): string | undefined {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && isRecord(candidate); depth += 1) {
    if (typeof candidate['code'] === 'string') return candidate['code']
    candidate = candidate['cause']
  }
  return undefined
}

function isProvablyPreSendConnectFailure(error: unknown): boolean {
  const code = errorCode(error)
  return code !== undefined && PROVABLY_PRE_SEND_CONNECT_CODES.has(code)
}

export class HttpBindingRegistryClient implements BindingRegistryClient {
  readonly #endpoint: URL
  readonly #authorizationHeader: string
  readonly #perAttemptTimeoutMs: number
  readonly #totalTimeoutMs: number
  readonly #fetch: RegistryClientFetch
  readonly #now: () => number
  readonly #random: () => number
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly #log: RegistryClientLog

  constructor(peer: PeerEntry, options: BindingRegistryClientOptions = {}) {
    this.#endpoint = normalizedRegistryEndpoint(peer)
    // T-06663 / Mable DM #179 sanctions this as the sole PeerToken secret egress site.
    this.#authorizationHeader = `Bearer ${peer.token.reveal()}`
    this.#perAttemptTimeoutMs = positiveDuration(
      options.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS
    )
    this.#totalTimeoutMs = positiveDuration(options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.#now = options.now ?? (() => performance.now())
    this.#random = options.random ?? Math.random
    this.#sleep = options.sleep ?? defaultSleep
    this.#log = options.log ?? writeServerLog
  }

  async consult(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RegistryConsultResult> {
    try {
      return await this.#consult(scopeRef, options)
    } catch (error) {
      if (error instanceof RegistryRefusedError || error instanceof RegistryUnreachableError) {
        throw error
      }
      throw classifyUnreachable(error)
    }
  }

  async #consult(
    scopeRef: string,
    options: { signal?: AbortSignal }
  ): Promise<RegistryConsultResult> {
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')
    const deadline = this.#now() + this.#totalTimeoutMs
    let lastFailure: RegistryUnreachableError | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) {
        throw new RegistryUnreachableError('federation binding registry consultation aborted')
      }
      this.#log('INFO', 'federation.registry.consult.attempt', {
        scopeRef,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
      })

      try {
        const result = await this.#runAttempt(
          deadline,
          (signal) => this.#consultAttempt(scopeRef, signal),
          options.signal
        )
        this.#log('INFO', `federation.registry.consult.${result.outcome}`, {
          scopeRef,
          attempt,
          ...(result.outcome === 'bound' ? { homeNodeId: result.binding.homeNodeId } : {}),
        })
        return result
      } catch (error) {
        if (error instanceof RegistryRefusedError) {
          this.#log('ERROR', 'federation.registry.consult.refused', {
            scopeRef,
            attempt,
            status: error.status,
            code: error.code,
            retryable: error.retryable,
          })
          throw error
        }
        lastFailure = classifyUnreachable(error)
        const mayRetry =
          attempt < MAX_ATTEMPTS && !options.signal?.aborted && this.#remaining(deadline) > 0
        if (!mayRetry) {
          this.#log('ERROR', 'federation.registry.consult.unreachable', {
            scopeRef,
            attempt,
            retryable: lastFailure.retryable,
          })
          throw lastFailure
        }
        this.#log('WARN', 'federation.registry.consult.retry', {
          scopeRef,
          attempt,
          nextAttempt: attempt + 1,
          retryable: lastFailure.retryable,
        })
        await this.#backoff(attempt, deadline, options.signal)
      }
    }

    throw lastFailure ?? new RegistryUnreachableError()
  }

  async establish(
    request: Parameters<BindingRegistry['establish']>[0]
  ): Promise<BindingEstablishResult> {
    try {
      return await this.#establish(request)
    } catch (error) {
      if (error instanceof RegistryRefusedError || error instanceof RegistryUnreachableError) {
        throw error
      }
      throw classifyUnreachable(error)
    }
  }

  async #establish(
    request: Parameters<BindingRegistry['establish']>[0]
  ): Promise<BindingEstablishResult> {
    const deadline = this.#now() + this.#totalTimeoutMs
    let lastFailure: RegistryUnreachableError | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.#runAttempt(deadline, (signal) => this.#establishAttempt(request, signal))
      } catch (error) {
        if (error instanceof RegistryRefusedError) throw error
        lastFailure = classifyUnreachable(error)
        const mayRetry =
          attempt < MAX_ATTEMPTS &&
          isProvablyPreSendConnectFailure(error) &&
          this.#remaining(deadline) > 0
        if (!mayRetry) throw lastFailure
        await this.#backoff(attempt, deadline)
      }
    }

    throw lastFailure ?? new RegistryUnreachableError()
  }

  async #consultAttempt(scopeRef: string, signal: AbortSignal): Promise<RegistryConsultResult> {
    const url = new URL('/v1/federation/registry/consult', this.#endpoint)
    url.searchParams.set('scopeRef', scopeRef)
    const response = await this.#fetch(url.toString(), {
      method: 'GET',
      headers: { authorization: this.#authorizationHeader },
      redirect: 'error',
      signal,
    })

    const refused = refusedForStatus(response.status)
    if (refused !== undefined) throw refused
    if (response.status === 404) {
      const body = await this.#responseBody(response)
      if (isRecord(body) && body['ok'] === false && body['error'] === 'unbound') {
        return { outcome: 'unbound' }
      }
      throw new RegistryUnreachableError('federation binding registry returned an unknown 404')
    }
    if (response.status !== 200) {
      throw new RegistryUnreachableError(
        `federation binding registry returned unexpected status ${response.status}`
      )
    }

    const body = await this.#responseBody(response)
    const binding =
      isRecord(body) && body['ok'] === true ? parseBinding(body['binding'], scopeRef) : undefined
    if (binding === undefined) {
      throw new RegistryUnreachableError('federation binding registry returned an invalid binding')
    }
    return { outcome: 'bound', binding }
  }

  async #establishAttempt(
    request: Parameters<BindingRegistry['establish']>[0],
    signal: AbortSignal
  ): Promise<BindingEstablishResult> {
    const url = new URL('/v1/federation/registry/establish', this.#endpoint)
    const response = await this.#fetch(url.toString(), {
      method: 'POST',
      headers: {
        authorization: this.#authorizationHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal,
    })

    const refused = refusedForStatus(response.status)
    if (refused !== undefined) throw refused
    if (response.status !== 200) {
      throw new RegistryUnreachableError(
        `federation binding registry returned unexpected status ${response.status}`
      )
    }
    const body = await this.#responseBody(response)
    const outcome = isRecord(body) ? body['outcome'] : undefined
    const binding =
      isRecord(body) && body['ok'] === true
        ? parseBinding(body['binding'], request.scopeRef)
        : undefined
    if ((outcome !== 'created' && outcome !== 'existing') || binding === undefined) {
      throw new RegistryUnreachableError(
        'federation binding registry returned an invalid establishment result'
      )
    }
    return { outcome, binding }
  }

  async designateBirth(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<BirthDesignationResult> {
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')
    const deadline = this.#now() + this.#totalTimeoutMs
    let lastFailure: RegistryUnreachableError | undefined

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.#runAttempt(
          deadline,
          (signal) => this.#designateBirthAttempt(scopeRef, signal),
          options.signal
        )
        this.#log('INFO', `federation.registry.designate_birth.${result.kind}`, {
          scopeRef,
          attempt,
          ...(result.kind === 'designated'
            ? {
                homeNodeId: result.designation.homeNodeId,
                provenance: result.designation.provenance,
                designationEpoch: result.designation.designationEpoch,
                senderScopeRef: result.designation.senderScopeRef,
              }
            : {}),
        })
        return result
      } catch (error) {
        if (error instanceof RegistryRefusedError) throw error
        lastFailure = classifyUnreachable(error)
        const mayRetry =
          attempt < MAX_ATTEMPTS && !options.signal?.aborted && this.#remaining(deadline) > 0
        if (!mayRetry) {
          this.#log('ERROR', 'federation.registry.designate_birth.unreachable', {
            scopeRef,
            attempt,
            retryable: lastFailure.retryable,
          })
          throw lastFailure
        }
        await this.#backoff(attempt, deadline, options.signal)
      }
    }

    throw lastFailure ?? new RegistryUnreachableError()
  }

  async #designateBirthAttempt(
    scopeRef: string,
    signal: AbortSignal
  ): Promise<BirthDesignationResult> {
    const url = new URL('/v1/federation/registry/designate-birth', this.#endpoint)
    const response = await this.#fetch(url.toString(), {
      method: 'POST',
      headers: {
        authorization: this.#authorizationHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ scopeRef }),
      redirect: 'error',
      signal,
    })

    const refused = refusedForStatus(response.status)
    if (refused !== undefined) throw refused
    if (response.status === 404) {
      // A registry host that predates T-07655 does not serve this route, and a
      // host that has designated nothing is exactly what that means. Reporting
      // it as unreachable instead would refuse every virgin implicit birth on
      // an upgraded node until the HOST upgraded too — a fleet-wide dispatch
      // outage for the whole length of a rollout window, caused by the very
      // change meant to make births orderly. An upgraded host never 404s here:
      // it answers 200 or 503, so this is unambiguous.
      return { kind: 'none' }
    }
    if (response.status === 503) {
      // The host could not read wrkq. Retryable and, crucially, NOT `none`:
      // treating an outage as "nothing designated" would drop every node back
      // to a local birth, which is the simultaneous birth this prevents.
      throw new RegistryUnreachableError(
        'federation binding registry could not read the birth envelope'
      )
    }
    if (response.status !== 200) {
      throw new RegistryUnreachableError(
        `federation binding registry returned unexpected status ${response.status}`
      )
    }

    const body = await this.#responseBody(response)
    const kind = isRecord(body) ? body['kind'] : undefined
    if (kind === 'none') return { kind: 'none' }
    const designation = isRecord(body) ? parseDesignation(body['designation'], scopeRef) : undefined
    if (kind !== 'designated' || designation === undefined) {
      throw new RegistryUnreachableError(
        'federation binding registry returned an invalid birth designation'
      )
    }
    return { kind: 'designated', designation }
  }

  async listUnbornDesignations(
    homeNodeId: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<BirthDesignationRecord[]> {
    if (!isNonemptyString(homeNodeId)) throw new RegistryRefusedError(400, 'invalid_request')
    const deadline = this.#now() + this.#totalTimeoutMs
    const url = new URL('/v1/federation/registry/unborn-designations', this.#endpoint)
    url.searchParams.set('homeNodeId', homeNodeId)
    const response = await this.#runAttempt(
      deadline,
      async (signal) =>
        await this.#fetch(url.toString(), {
          method: 'GET',
          headers: { authorization: this.#authorizationHeader },
          redirect: 'error',
          signal,
        }),
      options.signal
    )
    const refused = refusedForStatus(response.status)
    if (refused !== undefined) throw refused
    // Same rollout rule as designateBirth and readDesignation: a host that
    // predates T-07661 does not serve this route, and a host that owes this
    // node no virgin births is exactly what that means. Treating it as
    // unreachable instead would put a WARN on every sweep of every upgraded
    // node for the whole length of a rollout window, for a backstop that is
    // simply not there yet.
    if (response.status === 404) return []
    if (response.status !== 200) {
      throw new RegistryUnreachableError(
        `federation binding registry returned unexpected status ${response.status}`
      )
    }
    const body = await this.#responseBody(response)
    const raw = isRecord(body) ? body['designations'] : undefined
    if (!Array.isArray(raw)) {
      throw new RegistryUnreachableError(
        'federation binding registry returned an invalid unborn-designation list'
      )
    }
    const designations: BirthDesignationRecord[] = []
    for (const entry of raw) {
      const scopeRef = isRecord(entry) ? entry['scopeRef'] : undefined
      if (typeof scopeRef !== 'string') {
        throw new RegistryUnreachableError(
          'federation binding registry returned an invalid unborn-designation list'
        )
      }
      const parsed = parseDesignation(entry, scopeRef)
      if (parsed === undefined) {
        throw new RegistryUnreachableError(
          'federation binding registry returned an invalid unborn-designation list'
        )
      }
      designations.push(parsed)
    }
    return designations
  }

  async readDesignation(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RegistryDesignationRead> {
    if (!isNonemptyString(scopeRef)) throw new RegistryRefusedError(400, 'invalid_request')
    const deadline = this.#now() + this.#totalTimeoutMs
    const url = new URL('/v1/federation/registry/designation', this.#endpoint)
    url.searchParams.set('scopeRef', scopeRef)
    const response = await this.#runAttempt(
      deadline,
      async (signal) =>
        await this.#fetch(url.toString(), {
          method: 'GET',
          headers: { authorization: this.#authorizationHeader },
          redirect: 'error',
          signal,
        }),
      options.signal
    )
    const refused = refusedForStatus(response.status)
    if (refused !== undefined) throw refused
    // Same rollout rule as designateBirth: an older host serves no designations,
    // so locate reports none rather than rendering the whole layer as unknown.
    if (response.status === 404) return { outcome: 'none' }
    if (response.status !== 200) {
      throw new RegistryUnreachableError(
        `federation binding registry returned unexpected status ${response.status}`
      )
    }
    const body = await this.#responseBody(response)
    const outcome = isRecord(body) ? body['outcome'] : undefined
    if (outcome === 'none') return { outcome: 'none' }
    const designation = isRecord(body) ? parseDesignation(body['designation'], scopeRef) : undefined
    if ((outcome !== 'designated' && outcome !== 'superseded') || designation === undefined) {
      throw new RegistryUnreachableError(
        'federation binding registry returned an invalid designation read'
      )
    }
    return { outcome, designation }
  }

  async deleteBinding(
    request: Parameters<BindingRegistry['deleteBinding']>[0]
  ): Promise<DeleteBindingResult> {
    const body = await this.#mutationAttempt('/v1/federation/registry/delete', request)
    const outcome = body['outcome']
    if (outcome !== 'deleted' && outcome !== 'idempotent' && outcome !== 'conflict') {
      throw new RegistryUnreachableError('federation registry returned invalid deletion result')
    }
    const binding = parseBinding(body['binding'], request.scopeRef)
    return {
      outcome,
      ...(binding === undefined ? {} : { binding }),
    }
  }

  async #mutationAttempt(
    pathname: string,
    request: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const deadline = this.#now() + this.#totalTimeoutMs
    const body = await this.#runAttempt(deadline, async (signal) => {
      const url = new URL(pathname, this.#endpoint)
      const response = await this.#fetch(url.toString(), {
        method: 'POST',
        headers: {
          authorization: this.#authorizationHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        redirect: 'error',
        signal,
      })
      const refused = refusedForStatus(response.status)
      if (refused !== undefined) throw refused
      if (response.status !== 200 && response.status !== 404 && response.status !== 409) {
        throw new RegistryUnreachableError(
          `federation binding registry returned unexpected status ${response.status}`
        )
      }
      const parsed = await this.#responseBody(response)
      if (!isRecord(parsed) || typeof parsed['outcome'] !== 'string') {
        throw new RegistryUnreachableError(
          'federation registry returned unreadable mutation result'
        )
      }
      return parsed
    })
    return body
  }

  async #responseBody(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      throw new RegistryUnreachableError(
        'federation binding registry returned an unreadable response',
        error
      )
    }
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

export function createBindingRegistryClient(
  peer: PeerEntry,
  options?: BindingRegistryClientOptions
): BindingRegistryClient {
  return new HttpBindingRegistryClient(peer, options)
}
