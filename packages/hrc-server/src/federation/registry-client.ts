import type {
  ActivateRetiredBindingResult,
  BindingEstablishResult,
  BindingRegistry,
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
  PlacementBinding,
  RegistryRetirementRecord,
  RetargetRetiredBindingResult,
  RetireBindingResult,
} from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { PeerEntry } from './federation-config.js'
import { isTailnetHost } from './registry-bind.js'

const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 2_000
const DEFAULT_TOTAL_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 250

const ESTABLISHMENT_PROVENANCE = new Set<EstablishmentProvenance>([
  'pin',
  'task_default',
  'default_home_node',
  'default_home_node(local)',
  'explicit_local',
  'rebind',
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

export type RegistryConsultResult =
  | { outcome: 'bound'; binding: PlacementBinding }
  | { outcome: 'retired'; retirement: RegistryRetirementRecord }
  | { outcome: 'unbound' }

export interface BindingRegistryClient {
  consult(scopeRef: string, options?: { signal?: AbortSignal }): Promise<RegistryConsultResult>
  establish(request: Parameters<BindingRegistry['establish']>[0]): Promise<BindingEstablishResult>
  retire?(request: Parameters<BindingRegistry['retire']>[0]): Promise<RetireBindingResult>
  activateRetired?(
    request: Parameters<BindingRegistry['activateRetired']>[0]
  ): Promise<ActivateRetiredBindingResult>
  retargetRetired?(
    request: Parameters<BindingRegistry['retargetRetired']>[0]
  ): Promise<RetargetRetiredBindingResult>
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

  constructor(
    registry: BindingRegistry,
    localNodeId: string,
    options: Pick<BindingRegistryClientOptions, 'log'> = {}
  ) {
    this.#registry = registry
    this.#localNodeId = localNodeId
    this.#log = options.log ?? writeServerLog
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
      const record = this.#registry.getRecord(scopeRef)
      let result: RegistryConsultResult
      if (record === undefined) result = { outcome: 'unbound' }
      else if (record.state === 'retired') result = { outcome: 'retired', retirement: record }
      else {
        const binding = this.#registry.get(scopeRef)
        if (binding === undefined) {
          throw new Error('active registry record mapping failed')
        }
        result = { outcome: 'bound', binding }
      }
      this.#log('INFO', `federation.registry.consult.${result.outcome}`, {
        scopeRef,
        transport: 'local',
        ...(result.outcome === 'bound'
          ? {
              homeNodeId: result.binding.homeNodeId,
              placementEpoch: result.binding.placementEpoch,
            }
          : result.outcome === 'retired'
            ? {
                retiredHomeNodeId: result.retirement.retiredHomeNodeId,
                placementEpoch: result.retirement.placementEpoch,
                successorNodeId: result.retirement.successorNodeId,
              }
            : {}),
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
        ...(result.outcome === 'retired'
          ? {
              retiredHomeNodeId: result.retirement.retiredHomeNodeId,
              placementEpoch: result.retirement.placementEpoch,
            }
          : {
              homeNodeId: result.binding.homeNodeId,
              placementEpoch: result.binding.placementEpoch,
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

  async retire(request: Parameters<BindingRegistry['retire']>[0]): Promise<RetireBindingResult> {
    if (request.expectedHomeNodeId !== this.#localNodeId) {
      throw new RegistryRefusedError(400, 'invalid_request')
    }
    return this.#registry.retire(request)
  }

  async activateRetired(
    request: Parameters<BindingRegistry['activateRetired']>[0]
  ): Promise<ActivateRetiredBindingResult> {
    if (request.successorNodeId !== this.#localNodeId) {
      throw new RegistryRefusedError(400, 'invalid_request')
    }
    return this.#registry.activateRetired(request)
  }

  async retargetRetired(
    request: Parameters<BindingRegistry['retargetRetired']>[0]
  ): Promise<RetargetRetiredBindingResult> {
    const current = this.#registry.getRecord(request.scopeRef)
    if (current?.state !== 'retired' || current.retiredHomeNodeId !== this.#localNodeId) {
      throw new RegistryRefusedError(400, 'invalid_request')
    }
    return this.#registry.retargetRetired(request)
  }
}

export function createLocalBindingRegistryClient(
  registry: BindingRegistry,
  localNodeId: string,
  options: Pick<BindingRegistryClientOptions, 'log'> = {}
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

function parseBirthClass(value: unknown): FederationBirthClass | undefined {
  return value === 'policy-born' || value === 'mechanism-born' ? value : undefined
}

function parseAuthorityProvenance(value: unknown): BirthAuthorityProvenance | undefined {
  if (!isRecord(value) || !isNonemptyString(value['kind'])) return undefined
  return value as BirthAuthorityProvenance
}

function parseBinding(value: unknown, expectedScopeRef: string): PlacementBinding | undefined {
  if (!isRecord(value)) return undefined
  if (value['scopeRef'] !== expectedScopeRef || !isNonemptyString(value['homeNodeId'])) {
    return undefined
  }
  const placementEpoch = value['placementEpoch']
  if (!Number.isSafeInteger(placementEpoch) || Number(placementEpoch) < 1) return undefined
  const birthClass = parseBirthClass(value['birthClass'])
  const authorityProvenance = parseAuthorityProvenance(value['authorityProvenance'])
  const establishmentProvenance = value['establishmentProvenance']
  if (
    birthClass === undefined ||
    authorityProvenance === undefined ||
    typeof establishmentProvenance !== 'string' ||
    !ESTABLISHMENT_PROVENANCE.has(establishmentProvenance as EstablishmentProvenance) ||
    !isNonemptyString(value['createdAt']) ||
    !isNonemptyString(value['updatedAt'])
  ) {
    return undefined
  }
  const priorHomeNodeId = value['priorHomeNodeId']
  if (priorHomeNodeId !== undefined && !isNonemptyString(priorHomeNodeId)) return undefined

  return {
    scopeRef: expectedScopeRef,
    homeNodeId: value['homeNodeId'],
    placementEpoch: Number(placementEpoch),
    birthClass,
    authorityProvenance,
    establishmentProvenance: establishmentProvenance as EstablishmentProvenance,
    ...(priorHomeNodeId === undefined ? {} : { priorHomeNodeId }),
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  }
}

function parseRetirement(
  value: unknown,
  expectedScopeRef: string
): RegistryRetirementRecord | undefined {
  if (!isRecord(value) || value['state'] !== 'retired' || value['scopeRef'] !== expectedScopeRef) {
    return undefined
  }
  const placementEpoch = value['placementEpoch']
  const successorNodeId = value['successorNodeId']
  const birthClass = parseBirthClass(value['birthClass'])
  const authorityProvenance = parseAuthorityProvenance(value['authorityProvenance'])
  if (
    !Number.isSafeInteger(placementEpoch) ||
    Number(placementEpoch) < 1 ||
    birthClass === undefined ||
    authorityProvenance === undefined ||
    !isNonemptyString(value['retiredHomeNodeId']) ||
    !isNonemptyString(value['retiredAt']) ||
    !isNonemptyString(value['reason']) ||
    !isNonemptyString(value['createdAt']) ||
    !isNonemptyString(value['updatedAt']) ||
    (successorNodeId !== null && !isNonemptyString(successorNodeId))
  ) {
    return undefined
  }
  return {
    state: 'retired',
    scopeRef: expectedScopeRef,
    placementEpoch: Number(placementEpoch),
    birthClass,
    authorityProvenance,
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    retiredHomeNodeId: value['retiredHomeNodeId'],
    retiredAt: value['retiredAt'],
    reason: value['reason'],
    successorNodeId,
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
          ...(result.outcome === 'bound'
            ? {
                homeNodeId: result.binding.homeNodeId,
                placementEpoch: result.binding.placementEpoch,
              }
            : result.outcome === 'retired'
              ? {
                  retiredHomeNodeId: result.retirement.retiredHomeNodeId,
                  placementEpoch: result.retirement.placementEpoch,
                  successorNodeId: result.retirement.successorNodeId,
                }
              : {}),
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
    const retirement =
      isRecord(body) && body['ok'] === true && body['outcome'] === 'retired'
        ? parseRetirement(body['retirement'], scopeRef)
        : undefined
    if (retirement !== undefined) return { outcome: 'retired', retirement }
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
    if (outcome === 'retired') {
      const retirement = isRecord(body)
        ? parseRetirement(body['retirement'], request.scopeRef)
        : undefined
      if (retirement === undefined) {
        throw new RegistryUnreachableError(
          'federation binding registry returned an invalid retirement result'
        )
      }
      return { outcome, retirement }
    }
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

  async retire(request: Parameters<BindingRegistry['retire']>[0]): Promise<RetireBindingResult> {
    const body = await this.#mutationAttempt('/v1/federation/registry/retire', request)
    const outcome = body['outcome']
    if (
      outcome !== 'retired' &&
      outcome !== 'idempotent' &&
      outcome !== 'conflict' &&
      outcome !== 'not_found'
    ) {
      throw new RegistryUnreachableError('federation registry returned invalid retirement result')
    }
    const retirement = parseRetirement(body['retirement'], request.scopeRef)
    const binding = parseBinding(body['binding'], request.scopeRef)
    return {
      outcome,
      ...(retirement === undefined ? {} : { retirement }),
      ...(binding === undefined ? {} : { binding }),
    }
  }

  async activateRetired(
    request: Parameters<BindingRegistry['activateRetired']>[0]
  ): Promise<ActivateRetiredBindingResult> {
    const body = await this.#mutationAttempt('/v1/federation/registry/activate-retired', request)
    const outcome = body['outcome']
    if (
      outcome !== 'activated' &&
      outcome !== 'idempotent' &&
      outcome !== 'conflict' &&
      outcome !== 'not_found' &&
      outcome !== 'mechanism_refused' &&
      outcome !== 'epoch_exhausted'
    ) {
      throw new RegistryUnreachableError('federation registry returned invalid activation result')
    }
    const retirement = parseRetirement(body['retirement'], request.scopeRef)
    const binding = parseBinding(body['binding'], request.scopeRef)
    return {
      outcome,
      ...(retirement === undefined ? {} : { retirement }),
      ...(binding === undefined ? {} : { binding }),
    }
  }

  async retargetRetired(
    request: Parameters<BindingRegistry['retargetRetired']>[0]
  ): Promise<RetargetRetiredBindingResult> {
    const body = await this.#mutationAttempt('/v1/federation/registry/retarget-retired', request)
    const outcome = body['outcome']
    if (
      outcome !== 'updated' &&
      outcome !== 'idempotent' &&
      outcome !== 'conflict' &&
      outcome !== 'not_found' &&
      outcome !== 'epoch_exhausted'
    ) {
      throw new RegistryUnreachableError('federation registry returned invalid retarget result')
    }
    const retirement = parseRetirement(body['retirement'], request.scopeRef)
    const binding = parseBinding(body['binding'], request.scopeRef)
    return {
      outcome,
      ...(retirement === undefined ? {} : { retirement }),
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
