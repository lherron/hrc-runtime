import type {
  BindingEstablishResult,
  BindingRegistry,
  BirthDesignationRecord,
  BirthDesignationResult,
  DeleteBindingResult,
} from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { PeerEntry } from './federation-config.js'
import { HRC_SERVER_USER_AGENT } from './peer-request.js'
import {
  MAX_ATTEMPTS,
  RegistryAttempts,
  isProvablyPreSendConnectFailure,
} from './registry-attempt.js'
import { isTailnetHost } from './registry-bind.js'
import type {
  BindingRegistryClient,
  BindingRegistryClientOptions,
  RegistryClientFetch,
  RegistryClientLog,
  RegistryConsultResult,
  RegistryDesignationRead,
} from './registry-client.js'
import {
  RegistryRefusedError,
  RegistryUnreachableError,
  asRegistryError,
  refuseBlank,
} from './registry-client.js'
import {
  checkStatus,
  isRecord,
  parseBinding,
  parseDesignation,
  responseBody,
} from './registry-reply.js'

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

/** The authenticated HTTP client every node but the registry host uses. */
export class HttpBindingRegistryClient implements BindingRegistryClient {
  readonly #endpoint: URL
  readonly #authorizationHeader: string
  readonly #attempts: RegistryAttempts
  readonly #fetch: RegistryClientFetch
  readonly #log: RegistryClientLog

  constructor(peer: PeerEntry, options: BindingRegistryClientOptions = {}) {
    this.#endpoint = normalizedRegistryEndpoint(peer)
    // T-06663 / Mable DM #179 sanctions this as the sole PeerToken secret egress site.
    this.#authorizationHeader = `Bearer ${peer.token.reveal()}`
    this.#attempts = new RegistryAttempts(options)
    this.#fetch =
      options.fetch ??
      ((url, init) =>
        globalThis.fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string>),
            'user-agent': HRC_SERVER_USER_AGENT,
          },
        }))
    this.#log = options.log ?? writeServerLog
  }

  async consult(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RegistryConsultResult> {
    try {
      refuseBlank(scopeRef)
      return await this.#attempts.retrying((signal) => this.#consultAttempt(scopeRef, signal), {
        signal: options.signal,
        onAttempt: (attempt) => {
          if (options.signal?.aborted) {
            throw new RegistryUnreachableError('federation binding registry consultation aborted')
          }
          this.#log('INFO', 'federation.registry.consult.attempt', {
            scopeRef,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
          })
        },
        onSuccess: (attempt, result) => {
          this.#log('INFO', `federation.registry.consult.${result.outcome}`, {
            scopeRef,
            attempt,
            ...(result.outcome === 'bound' ? { homeNodeId: result.binding.homeNodeId } : {}),
          })
        },
        onRefused: (attempt, error) => {
          this.#log('ERROR', 'federation.registry.consult.refused', {
            scopeRef,
            attempt,
            status: error.status,
            code: error.code,
            retryable: error.retryable,
          })
        },
        onGiveUp: (attempt, failure) => {
          this.#log('ERROR', 'federation.registry.consult.unreachable', {
            scopeRef,
            attempt,
            retryable: failure.retryable,
          })
        },
        onRetry: (attempt, failure) => {
          this.#log('WARN', 'federation.registry.consult.retry', {
            scopeRef,
            attempt,
            nextAttempt: attempt + 1,
            retryable: failure.retryable,
          })
        },
      })
    } catch (error) {
      throw asRegistryError(error)
    }
  }

  async #consultAttempt(scopeRef: string, signal: AbortSignal): Promise<RegistryConsultResult> {
    const response = await this.#get('/v1/federation/registry/consult', { scopeRef }, signal)
    checkStatus(response.status, [200, 404])
    if (response.status === 404) {
      const body = await responseBody(response)
      if (isRecord(body) && body['ok'] === false && body['error'] === 'unbound') {
        return { outcome: 'unbound' }
      }
      throw new RegistryUnreachableError('federation binding registry returned an unknown 404')
    }

    const body = await responseBody(response)
    const binding =
      isRecord(body) && body['ok'] === true ? parseBinding(body['binding'], scopeRef) : undefined
    if (binding === undefined) {
      throw new RegistryUnreachableError('federation binding registry returned an invalid binding')
    }
    return { outcome: 'bound', binding }
  }

  /** Retried only when the failure proves the request never reached the host. */
  async establish(
    request: Parameters<BindingRegistry['establish']>[0]
  ): Promise<BindingEstablishResult> {
    try {
      return await this.#attempts.retrying((signal) => this.#establishAttempt(request, signal), {
        mayRetryAfter: isProvablyPreSendConnectFailure,
      })
    } catch (error) {
      throw asRegistryError(error)
    }
  }

  async #establishAttempt(
    request: Parameters<BindingRegistry['establish']>[0],
    signal: AbortSignal
  ): Promise<BindingEstablishResult> {
    const response = await this.#post('/v1/federation/registry/establish', request, signal)
    checkStatus(response.status, [200])
    const body = await responseBody(response)
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
    refuseBlank(scopeRef)
    return await this.#attempts.retrying(
      (signal) => this.#designateBirthAttempt(scopeRef, signal),
      {
        signal: options.signal,
        onSuccess: (attempt, result) => {
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
        },
        onGiveUp: (attempt, failure) => {
          this.#log('ERROR', 'federation.registry.designate_birth.unreachable', {
            scopeRef,
            attempt,
            retryable: failure.retryable,
          })
        },
      }
    )
  }

  async #designateBirthAttempt(
    scopeRef: string,
    signal: AbortSignal
  ): Promise<BirthDesignationResult> {
    const response = await this.#post(
      '/v1/federation/registry/designate-birth',
      { scopeRef },
      signal
    )
    checkStatus(response.status, [200, 404, 503])
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

    const body = await responseBody(response)
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
    refuseBlank(homeNodeId)
    const response = await this.#attempts.once(
      (signal) => this.#get('/v1/federation/registry/unborn-designations', { homeNodeId }, signal),
      options.signal
    )
    checkStatus(response.status, [200, 404])
    // Same rollout rule as designateBirth and readDesignation: a host that
    // predates T-07661 does not serve this route, and a host that owes this
    // node no virgin births is exactly what that means. Treating it as
    // unreachable instead would put a WARN on every sweep of every upgraded
    // node for the whole length of a rollout window, for a backstop that is
    // simply not there yet.
    if (response.status === 404) return []
    const invalidList = () =>
      new RegistryUnreachableError(
        'federation binding registry returned an invalid unborn-designation list'
      )
    const body = await responseBody(response)
    const raw = isRecord(body) ? body['designations'] : undefined
    if (!Array.isArray(raw)) throw invalidList()
    return raw.map((entry: unknown) => {
      const scopeRef = isRecord(entry) ? entry['scopeRef'] : undefined
      const parsed = typeof scopeRef === 'string' ? parseDesignation(entry, scopeRef) : undefined
      if (parsed === undefined) throw invalidList()
      return parsed
    })
  }

  async readDesignation(
    scopeRef: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RegistryDesignationRead> {
    refuseBlank(scopeRef)
    const response = await this.#attempts.once(
      (signal) => this.#get('/v1/federation/registry/designation', { scopeRef }, signal),
      options.signal
    )
    checkStatus(response.status, [200, 404])
    // Same rollout rule as designateBirth: an older host serves no designations,
    // so locate reports none rather than rendering the whole layer as unknown.
    if (response.status === 404) return { outcome: 'none' }
    const body = await responseBody(response)
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
    const body = await this.#attempts.once(async (signal) => {
      const response = await this.#post('/v1/federation/registry/delete', request, signal)
      checkStatus(response.status, [200, 404, 409])
      const parsed = await responseBody(response)
      if (!isRecord(parsed) || typeof parsed['outcome'] !== 'string') {
        throw new RegistryUnreachableError(
          'federation registry returned unreadable mutation result'
        )
      }
      return parsed
    })
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

  #get(pathname: string, query: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const url = new URL(pathname, this.#endpoint)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return this.#fetch(url.toString(), {
      method: 'GET',
      headers: { authorization: this.#authorizationHeader },
      redirect: 'error',
      signal,
    })
  }

  #post(pathname: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const url = new URL(pathname, this.#endpoint)
    return this.#fetch(url.toString(), {
      method: 'POST',
      headers: {
        authorization: this.#authorizationHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  }
}

export function createBindingRegistryClient(
  peer: PeerEntry,
  options?: BindingRegistryClientOptions
): BindingRegistryClient {
  return new HttpBindingRegistryClient(peer, options)
}
