import type {
  BindingEstablishResult,
  BindingRegistry,
  BirthDesignationRecord,
  BirthDesignationResult,
  DeleteBindingResult,
} from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import type { BirthEnvelopeReader } from './birth-designation.js'
import { BirthEnvelopeUnavailableError, designateBirthOnHost } from './birth-designation.js'
import type {
  BindingRegistryClient,
  BindingRegistryClientOptions,
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
    refuseBlank(scopeRef)

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
      throw asRegistryError(error)
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
      throw asRegistryError(error)
    }
  }

  async designateBirth(scopeRef: string): Promise<BirthDesignationResult> {
    refuseBlank(scopeRef)
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
      throw asRegistryError(error)
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
    refuseBlank(scopeRef)
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
