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

function deliveryContext(body: SemanticDmRequest): FederationMessageDelivery | undefined {
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
  body: SemanticDmRequest,
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
 * Origin-side routing + durable transport controller. It is constructed only
 * for an explicitly enabled F1 peer listener on an enforcing node, keeping the
 * production path dark during the F0 rollout.
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

  async route(
    body: SemanticDmRequest,
    record: HrcMessageRecord
  ): Promise<FederationOriginRouteResult> {
    if (record.to.kind !== 'session') return { outcome: 'local' }
    const scopeRef = parseSessionRef(record.to.sessionRef).scopeRef
    const binding = await resolveFederationRoutingBinding({
      scopeRef,
      ledger: createPlacementLedgerRepository(this.options.db.sqlite),
      cache: this.cache,
      registry: this.registry,
    })
    if (binding.homeNodeId === this.options.config.nodeId) return { outcome: 'local' }

    const delivery = this.options.db.federationOutbox.enqueue({
      deliveryId: `delivery-${randomUUID()}`,
      messageId: record.messageId,
      peerNodeId: binding.homeNodeId,
      envelope: envelopeFor(record, body, binding),
      now: new Date().toISOString(),
    })
    writeServerLog('INFO', 'federation.outbox.queued', {
      deliveryId: delivery.deliveryId,
      messageId: delivery.messageId,
      peerNodeId: delivery.peerNodeId,
      placementEpoch: binding.placementEpoch,
      routingSource: binding.source,
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
    options.config.peerListener === undefined
  ) {
    return undefined
  }
  return new FederationOriginOutbox(options)
}
