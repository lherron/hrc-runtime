import { randomUUID } from 'node:crypto'

import type {
  FederationMessageDelivery,
  FederationMessageEnvelope,
  HrcMessageRecord,
  SemanticDmRequest,
} from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { FederationOutboxDeliveryRecord, HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { parseSessionRef } from '../server-parsers.js'
import { sendFederationEnvelope } from './accept-client.js'
import { InMemoryBindingHintCache, createStalePlacementRedirectHandler } from './binding-cache.js'
import type { FederationConfig } from './federation-config.js'
import { parseNodeId } from './node-id.js'
import {
  FederationOutboxDeliveryEngine,
  type FederationOutboxRetryPolicy,
} from './outbox-delivery.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import type { BindingRegistryClient } from './registry-client.js'
import { resolveFederationRegistryClient } from './registry-resolution.js'
import { resolveFederationRoutingBinding } from './routing-resolution.js'

export type FederationOriginOutboxOptions = {
  db: HrcDatabase
  config: FederationConfig
  localRegistryClient?: BindingRegistryClient | undefined
  retryPolicy?: FederationOutboxRetryPolicy | undefined
  pollIntervalMs?: number | undefined
}

export type FederationOriginRouteResult =
  | { outcome: 'local' }
  | { outcome: 'queued'; delivery: FederationOutboxDeliveryRecord }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deliveryContext(
  body: SemanticDmRequest | undefined
): FederationMessageDelivery | undefined {
  if (body === undefined) return undefined
  const context: FederationMessageDelivery = {
    ...(body.runtimeIntent === undefined ? {} : { runtimeIntent: body.runtimeIntent }),
    ...(body.createIfMissing === undefined ? {} : { createIfMissing: body.createIfMissing }),
    ...(body.parsedScopeJson === undefined ? {} : { parsedScopeJson: body.parsedScopeJson }),
    ...(body.respondTo === undefined ? {} : { respondTo: body.respondTo }),
    ...(body.responseFormat === undefined ? {} : { responseFormat: body.responseFormat }),
    ...(body.allowStaleGeneration === undefined
      ? {}
      : { allowStaleGeneration: body.allowStaleGeneration }),
  }
  return Object.keys(context).length === 0 ? undefined : context
}

function envelopeFor(
  record: HrcMessageRecord,
  body: SemanticDmRequest | undefined,
  expected: { homeNodeId: string; placementEpoch: number }
): FederationMessageEnvelope {
  const delivery = deliveryContext(body)
  return {
    protocolVersion: PEER_PROTOCOL_VERSION,
    messageId: record.messageId,
    kind: record.kind,
    phase: record.phase,
    from: record.from,
    to: record.to,
    body: record.body,
    rootMessageId: record.rootMessageId,
    ...(record.replyToMessageId === undefined ? {} : { replyToMessageId: record.replyToMessageId }),
    expected,
    ...(delivery === undefined ? {} : { delivery }),
  }
}

/**
 * Origin-side routing + durable transport controller. It is constructed for
 * enforcing nodes with at least one configured peer. Originating delivery does
 * not require this node to expose an inbound peer listener: registry-hosting
 * nodes may be outbound-only while another peer owns the target scope.
 */
export class FederationOriginOutbox {
  private readonly cache = new InMemoryBindingHintCache()
  private readonly engine: FederationOutboxDeliveryEngine
  private readonly registry: BindingRegistryClient

  constructor(private readonly options: FederationOriginOutboxOptions) {
    this.registry = resolveFederationRegistryClient(options.config, options.localRegistryClient)
    const handleRedirect = createStalePlacementRedirectHandler(this.cache)
    this.engine = new FederationOutboxDeliveryEngine({
      db: options.db,
      ...(options.retryPolicy === undefined ? {} : { policy: options.retryPolicy }),
      onError: (error) =>
        writeServerLog('WARN', 'federation.outbox.drain_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      onObservation: (observation) =>
        writeServerLog(
          observation.transition === 'attempt_started' || observation.transition === 'delivered'
            ? 'INFO'
            : 'WARN',
          `federation.outbox.${observation.transition}`,
          observation
        ),
      send: async (delivery) => {
        const peer = options.config.peers.get(
          parseNodeId(delivery.peerNodeId, 'federation outbox peerNodeId')
        )
        if (peer === undefined) {
          return {
            outcome: 'refused',
            status: 503,
            code: 'peer_not_configured',
            retryable: true,
          }
        }
        return sendFederationEnvelope({
          db: options.db,
          peer,
          envelope: delivery.envelope,
          onStaleRedirect: handleRedirect,
        })
      },
      onStaleRedirect: (delivery, redirect) => {
        if (delivery.envelope.to.kind !== 'session') {
          throw new Error('stale placement redirect requires a session target')
        }
        return {
          peerNodeId: redirect.homeNodeId,
          envelope: {
            ...delivery.envelope,
            expected: redirect,
          },
        }
      },
    })
    this.engine.start(options.pollIntervalMs)
  }

  /**
   * Resolve whether a session target is authoritative on another configured
   * node before local admission inspects node-local loser state.
   *
   * Namespace reconciliation deliberately leaves a retirement fence on every
   * losing node. That fence bars local execution, but it must not mask the
   * registry's active binding when the same node originates a federated DM to
   * the winner.
   */
  async isRemoteTarget(scopeRef: string): Promise<boolean> {
    const binding = await this.resolveRoutingBinding(scopeRef)
    return binding.homeNodeId !== this.options.config.nodeId
  }

  async route(
    body: SemanticDmRequest,
    record: HrcMessageRecord
  ): Promise<FederationOriginRouteResult> {
    const responseRoute = this.responseRoute(record)
    if (responseRoute !== undefined) {
      return this.enqueue(record, undefined, responseRoute.peerNodeId, responseRoute.expected, {
        responseFence: true,
      })
    }
    if (record.to.kind !== 'session') return { outcome: 'local' }
    const scopeRef = parseSessionRef(record.to.sessionRef).scopeRef
    const binding = await this.resolveRoutingBinding(scopeRef)
    if (binding.homeNodeId === this.options.config.nodeId) return { outcome: 'local' }

    return this.enqueue(record, body, binding.homeNodeId, binding, {
      routingSource: binding.source,
    })
  }

  private resolveRoutingBinding(scopeRef: string) {
    return resolveFederationRoutingBinding({
      scopeRef,
      ledger: createPlacementLedgerRepository(this.options.db.sqlite),
      cache: this.cache,
      registry: this.registry,
    })
  }

  /** Route a daemon-generated response after local turn finalization. */
  async routeResponse(record: HrcMessageRecord): Promise<FederationOriginRouteResult> {
    const route = this.responseRoute(record)
    if (route === undefined) return { outcome: 'local' }
    return this.enqueue(record, undefined, route.peerNodeId, route.expected, {
      responseFence: true,
    })
  }

  private responseRoute(record: HrcMessageRecord):
    | {
        peerNodeId: string
        expected: { homeNodeId: string; placementEpoch: number }
      }
    | undefined {
    if (record.phase !== 'response' || record.replyToMessageId === undefined) return undefined
    const request = this.options.db.messages.getById(record.replyToMessageId)
    const ingress = request?.metadataJson?.['federationIngress']
    if (!isRecord(ingress)) return undefined
    const authenticatedNodeId = ingress['authenticatedNodeId']
    const expected = ingress['expected']
    if (
      typeof authenticatedNodeId !== 'string' ||
      !isRecord(expected) ||
      typeof expected['homeNodeId'] !== 'string' ||
      !Number.isSafeInteger(expected['placementEpoch']) ||
      (expected['placementEpoch'] as number) < 1
    ) {
      return undefined
    }
    return {
      peerNodeId: authenticatedNodeId,
      expected: {
        homeNodeId: expected['homeNodeId'],
        placementEpoch: expected['placementEpoch'] as number,
      },
    }
  }

  private enqueue(
    record: HrcMessageRecord,
    body: SemanticDmRequest | undefined,
    peerNodeId: string,
    expected: { homeNodeId: string; placementEpoch: number },
    log: { routingSource?: string | undefined; responseFence?: boolean | undefined }
  ): FederationOriginRouteResult {
    const delivery = this.options.db.federationOutbox.enqueue({
      deliveryId: `delivery-${randomUUID()}`,
      messageId: record.messageId,
      peerNodeId,
      envelope: envelopeFor(record, body, expected),
      now: new Date().toISOString(),
    })
    writeServerLog('INFO', 'federation.outbox.queued', {
      deliveryId: delivery.deliveryId,
      messageId: delivery.messageId,
      peerNodeId,
      phase: record.phase,
      rootMessageId: record.rootMessageId,
      replyToMessageId: record.replyToMessageId,
      placementEpoch: expected.placementEpoch,
      ...log,
    })
    void this.engine.drainDue().catch((error: unknown) =>
      writeServerLog('WARN', 'federation.outbox.immediate_drain_failed', {
        deliveryId: delivery.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return { outcome: 'queued', delivery }
  }

  list(): FederationOutboxDeliveryRecord[] {
    return this.options.db.federationOutbox.list()
  }

  replay(deliveryId: string): FederationOutboxDeliveryRecord {
    const replayed = this.engine.replay(deliveryId)
    void this.engine.drainDue().catch((error: unknown) =>
      writeServerLog('WARN', 'federation.outbox.replay_drain_failed', {
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    return replayed
  }

  stop(): Promise<void> {
    return this.engine.stop()
  }
}

export function createFederationOriginOutbox(
  options: FederationOriginOutboxOptions
): FederationOriginOutbox | undefined {
  if (
    !options.config.sourceExists ||
    options.config.gate.mode !== 'enforce' ||
    options.config.peers.size === 0
  ) {
    return undefined
  }
  return new FederationOriginOutbox(options)
}
