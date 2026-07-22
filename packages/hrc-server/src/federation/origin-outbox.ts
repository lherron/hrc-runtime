import { randomUUID } from 'node:crypto'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  isCodexAppOwnedScopeRef,
} from 'hrc-core'
import type {
  FederationInteractiveLifecycleSignal,
  FederationMessageDelivery,
  FederationMessageEnvelope,
  FederationPendingMessageEnvelope,
  HrcMessageRecord,
  SemanticDmRequest,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { FederationOutboxDeliveryRecord, HrcDatabase } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { parseSessionRef } from '../server-parsers.js'
import { sendFederationEnvelope } from './accept-client.js'
import { InMemoryBindingHintCache, createStalePlacementRedirectHandler } from './binding-cache.js'
import { sendRemoteEstablish } from './establish-client.js'
import type { FederationConfig } from './federation-config.js'
import { parseNodeId } from './node-id.js'
import {
  FederationOutboxDeliveryEngine,
  type FederationOutboxRetryPolicy,
} from './outbox-delivery.js'
import { PEER_PROTOCOL_VERSION } from './peer-protocol.js'
import type { BindingRegistryClient } from './registry-client.js'
import { resolveFederationRegistryClient } from './registry-resolution.js'
import {
  FederationRoutingResolutionError,
  resolveFederationRoutingBinding,
} from './routing-resolution.js'
import type { ResolvedFederationRoutingBinding } from './routing-resolution.js'
import type { PlacementDisposition } from './summon-gate.js'

export type FederationOriginOutboxOptions = {
  db: HrcDatabase
  config: FederationConfig
  localRegistryClient?: BindingRegistryClient | undefined
  retryPolicy?: FederationOutboxRetryPolicy | undefined
  pollIntervalMs?: number | undefined
  resolvePlacement?:
    | ((input: {
        scopeRef: string
        body: SemanticDmRequest
      }) => Promise<PlacementDisposition | undefined>)
    | undefined
}

export type FederationOriginRouteResult =
  | { outcome: 'local' }
  | { outcome: 'queued'; delivery: FederationOutboxDeliveryRecord }

export type FederationTargetPlacement =
  | { outcome: 'local' }
  | {
      outcome: 'remote-bound'
      binding: {
        scopeRef: string
        homeNodeId: string
        placementEpoch: number
        source?: ResolvedFederationRoutingBinding['source'] | undefined
      }
    }
  | {
      outcome: 'remote-establish'
      scopeRef: string
      candidateHomeNodeId: string
      policyProvenance: Extract<
        PlacementDisposition,
        { outcome: 'remote-establish' }
      >['policyProvenance']
    }

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

function pendingEnvelopeFor(
  record: HrcMessageRecord,
  body: SemanticDmRequest | undefined
): FederationPendingMessageEnvelope {
  const delivery = deliveryContext(body)
  const interactiveSignal = record.metadataJson?.['federationInteractiveSignal'] as
    | FederationInteractiveLifecycleSignal
    | undefined
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
    ...(delivery === undefined ? {} : { delivery }),
    ...(interactiveSignal === undefined ? {} : { interactiveSignal }),
  }
}

function envelopeFor(
  record: HrcMessageRecord,
  body: SemanticDmRequest | undefined,
  expected: { homeNodeId: string; placementEpoch: number }
): FederationMessageEnvelope {
  return { ...pendingEnvelopeFor(record, body), expected }
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
        let peer = options.config.peers.get(
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
        if (delivery.stage === 'establishing') {
          const establishment = await sendRemoteEstablish({
            peer,
            request: delivery.establish,
          })
          if (establishment.outcome === 'refused') {
            return {
              outcome: 'refused',
              status: establishment.status,
              code: establishment.code,
              message: establishment.message,
              reason: establishment.reason,
              retryable: establishment.retryable,
              ...(establishment.homeNodeId === undefined
                ? {}
                : { homeNodeId: establishment.homeNodeId }),
            }
          }

          // The peer response is evidence that establishment completed, not
          // an authority fence. Only a fresh registry read may fence delivery.
          const binding = await this.resolveRoutingBinding(delivery.establish.scopeRef)
          const expected = {
            homeNodeId: binding.homeNodeId,
            placementEpoch: binding.placementEpoch,
          }
          const advanced = options.db.federationOutbox.advanceToDelivery(
            delivery.deliveryId,
            binding.homeNodeId,
            { ...delivery.envelope, expected },
            new Date().toISOString()
          )
          if (advanced.stage !== 'delivering') {
            throw new Error('outbox establish transition did not produce a delivery fence')
          }
          peer = options.config.peers.get(
            parseNodeId(advanced.peerNodeId, 'federation outbox established peerNodeId')
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
            envelope: advanced.envelope,
            onStaleRedirect: handleRedirect,
          })
        }
        return sendFederationEnvelope({
          db: options.db,
          peer,
          envelope: delivery.envelope,
          onStaleRedirect: handleRedirect,
        })
      },
      onStaleRedirect: (delivery, redirect) => {
        if (delivery.stage !== 'delivering') {
          throw new Error('stale placement redirect cannot target an establishing delivery')
        }
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
  async resolveTargetPlacement(body: SemanticDmRequest): Promise<FederationTargetPlacement> {
    if (body.to.kind !== 'session') return { outcome: 'local' }
    const scopeRef = parseSessionRef(body.to.sessionRef).scopeRef
    let binding: ResolvedFederationRoutingBinding | undefined
    try {
      binding = await this.resolveMessageStorageBinding(scopeRef)
    } catch (error) {
      if (
        !(error instanceof FederationRoutingResolutionError) ||
        error.code !== 'binding_unbound'
      ) {
        throw error
      }

      const summonCapable = body.createIfMissing !== false && body.runtimeIntent !== undefined
      if (!summonCapable) {
        throw new HrcConflictError(
          HrcErrorCode.STALE_CONTEXT,
          `${scopeRef} is unbound and this message does not carry summon authority.`,
          {
            scopeRef,
            reason: 'summon-intent-required',
            retryable: false,
          }
        )
      }

      const placement = await this.options.resolvePlacement?.({ scopeRef, body })
      if (placement === undefined) throw error
      switch (placement.outcome) {
        case 'local-bound':
        case 'local-establish':
          return { outcome: 'local' }
        case 'remote-bound':
          return { outcome: 'remote-bound', binding: placement.binding }
        case 'remote-establish':
          return {
            outcome: 'remote-establish',
            scopeRef,
            candidateHomeNodeId: placement.candidateHomeNodeId,
            policyProvenance: placement.policyProvenance,
          }
        case 'refuse':
          this.throwPlacementRefusal(scopeRef, placement)
      }
    }
    if (binding === undefined || binding.homeNodeId === this.options.config.nodeId) {
      return { outcome: 'local' }
    }
    return { outcome: 'remote-bound', binding }
  }

  async isRemoteTarget(scopeRef: string): Promise<boolean> {
    const binding = await this.resolveMessageStorageBinding(scopeRef)
    if (binding === undefined) return false
    return binding.homeNodeId !== this.options.config.nodeId
  }

  /**
   * Whether an explicit reply can use the authenticated ingress route recorded
   * on its parent request. Callers use this before node-local admission checks:
   * a loser-node retirement fence bars execution, not a fenced response back
   * to the peer that delivered the request.
   */
  canRouteResponseToPeer(parent: HrcMessageRecord): boolean {
    return this.responseRouteForRequest(parent) !== undefined
  }

  async route(
    body: SemanticDmRequest,
    record: HrcMessageRecord,
    resolvedPlacement?: FederationTargetPlacement | undefined
  ): Promise<FederationOriginRouteResult> {
    const responseRoute = this.responseRoute(record)
    if (responseRoute !== undefined) {
      return this.enqueue(record, undefined, responseRoute.peerNodeId, responseRoute.expected, {
        responseFence: true,
      })
    }
    if (record.to.kind !== 'session') return { outcome: 'local' }
    const placement = resolvedPlacement ?? (await this.resolveTargetPlacement(body))
    if (placement.outcome === 'local') return { outcome: 'local' }
    if (placement.outcome === 'remote-establish') {
      return this.enqueueEstablishing(
        record,
        body,
        placement.scopeRef,
        placement.candidateHomeNodeId
      )
    }
    const binding = placement.binding

    return this.enqueue(record, body, binding.homeNodeId, binding, {
      routingSource: binding.source,
    })
  }

  private throwPlacementRefusal(
    scopeRef: string,
    placement: Extract<PlacementDisposition, { outcome: 'refuse' }>
  ): never {
    const detail = {
      scopeRef,
      reason: placement.reason,
      retryable: placement.retryable,
      ...(placement.homeNodeId === undefined ? {} : { homeNodeId: placement.homeNodeId }),
    }
    if (placement.reason === 'registry-unreachable') {
      throw new HrcRuntimeUnavailableError(placement.diagnostic, detail)
    }
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, placement.diagnostic, detail)
  }

  /**
   * Codex.app UUID targets are external inboxes, not HRC runtime births. An
   * established binding still chooses the node that stores the inbox, but an
   * intentionally unbound target falls back to this node's message store for
   * Codex.app to poll. Every other routing refusal remains fail-closed, and
   * local delivery still stops at the shared Codex.app no-dispatch fence.
   */
  private async resolveMessageStorageBinding(scopeRef: string) {
    try {
      return await this.resolveRoutingBinding(scopeRef)
    } catch (error) {
      if (
        isCodexAppOwnedScopeRef(scopeRef) &&
        error instanceof FederationRoutingResolutionError &&
        error.code === 'binding_unbound'
      ) {
        return undefined
      }
      throw error
    }
  }

  private resolveRoutingBinding(scopeRef: string) {
    const retirement = readScopeRetirement(this.options.db.sqlite, scopeRef)
    const excludedHomeNodeId =
      retirement?.retiredNodeId === this.options.config.nodeId
        ? retirement.retiredNodeId
        : undefined
    return resolveFederationRoutingBinding({
      scopeRef,
      ledger: createPlacementLedgerRepository(this.options.db.sqlite),
      cache: this.cache,
      registry: this.registry,
      ...(excludedHomeNodeId === undefined ? {} : { excludedHomeNodeId }),
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
    return this.responseRouteForRequest(request)
  }

  private responseRouteForRequest(request: HrcMessageRecord | undefined):
    | {
        peerNodeId: string
        expected: { homeNodeId: string; placementEpoch: number }
      }
    | undefined {
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
    log: {
      routingSource?: string | undefined
      responseFence?: boolean | undefined
    }
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

  private enqueueEstablishing(
    record: HrcMessageRecord,
    body: SemanticDmRequest,
    scopeRef: string,
    peerNodeId: string
  ): FederationOriginRouteResult {
    const deliveryId = `delivery-${randomUUID()}`
    const delivery = this.options.db.federationOutbox.enqueueEstablishing({
      deliveryId,
      messageId: record.messageId,
      peerNodeId,
      establish: {
        scopeRef,
        intent: 'implicit',
        correlationId: `establish-${deliveryId}`,
      },
      envelope: pendingEnvelopeFor(record, body),
      now: new Date().toISOString(),
    })
    writeServerLog('INFO', 'federation.outbox.queued', {
      deliveryId,
      messageId: record.messageId,
      peerNodeId,
      phase: record.phase,
      rootMessageId: record.rootMessageId,
      replyToMessageId: record.replyToMessageId,
      stage: 'establishing',
    })
    void this.engine.drainDue().catch((error: unknown) =>
      writeServerLog('WARN', 'federation.outbox.immediate_drain_failed', {
        deliveryId,
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
    this.drainAfterReplay({ deliveryId })
    return replayed
  }

  replayPeer(peerNodeId: string): FederationOutboxDeliveryRecord[] {
    const replayed = this.list()
      .filter((delivery) => delivery.peerNodeId === peerNodeId && delivery.state === 'dead_letter')
      .map((delivery) => this.engine.replay(delivery.deliveryId))
    this.drainAfterReplay({ peerNodeId, deliveryCount: replayed.length })
    return replayed
  }

  dropDeadLetter(deliveryId: string): FederationOutboxDeliveryRecord {
    const dropped = this.options.db.federationOutbox.dropDeadLetter(deliveryId)
    writeServerLog('INFO', 'federation.outbox.dropped', {
      deliveryId: dropped.deliveryId,
      messageId: dropped.messageId,
      peerNodeId: dropped.peerNodeId,
      deadLetteredAt: dropped.deadLetteredAt,
      lastErrorCode: dropped.lastErrorCode,
    })
    return dropped
  }

  private drainAfterReplay(context: Record<string, unknown>): void {
    void this.engine.drainDue().catch((error: unknown) =>
      writeServerLog('WARN', 'federation.outbox.replay_drain_failed', {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      })
    )
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
