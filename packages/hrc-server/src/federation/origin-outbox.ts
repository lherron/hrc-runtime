import { randomUUID } from 'node:crypto'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  isCodexAppOwnedScopeRef,
} from 'hrc-core'
import type {
  FederationInteractiveLifecycleSignal,
  FederationMailPayload,
  FederationMessageDelivery,
  FederationMessageEnvelope,
  FederationPendingMessageEnvelope,
  FederationSemanticTurnSignal,
  HrcMailActor,
  HrcMailSendRequest,
  HrcMessageAddress,
  HrcMessageRecord,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { FederationOutboxDeliveryRecord, HrcDatabase } from 'hrc-store-sqlite'

import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import type { CompleteSemanticDmRequest } from '../messages.js'
import { writeServerLog } from '../server-log.js'
import { parseSessionRef } from '../server-parsers.js'
import { sendFederationEnvelope } from './accept-client.js'
import { InMemoryBindingHintCache, createStalePlacementRedirectHandler } from './binding-cache.js'
import { sendRemoteEstablish } from './establish-client.js'
import type { FederationConfig, PeerEntry } from './federation-config.js'
import { parseNodeId } from './node-id.js'
import {
  FederationOutboxDeliveryEngine,
  type FederationOutboxRetryPolicy,
} from './outbox-delivery.js'
import { probePeerHealth } from './peer-observer.js'
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
        body: CompleteSemanticDmRequest
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

/** Refuse federated envelopes from an unbound/noncanonical EPR shadow. */
export function assertExternalParticipantFederatedEgress(
  db: HrcDatabase,
  localNodeId: string,
  record: Pick<HrcMessageRecord, 'from'>
): void {
  if (record.from.kind !== 'session') return
  const scopeRef = parseSessionRef(record.from.sessionRef).scopeRef
  const runtime = db.runtimes
    .listAll()
    .find((candidate) => candidate.scopeRef === scopeRef && isExternalLifecycleOwner(candidate))
  if (runtime === undefined) return

  const external = runtime.runtimeStateJson?.['externalRegistration']
  const collective = isRecord(external)
    ? (external['collectiveEstablishment'] as unknown)
    : undefined
  const state = isRecord(collective) ? collective['state'] : undefined
  const cause = isRecord(collective) ? collective['cause'] : undefined
  const binding = createPlacementLedgerRepository(db.sqlite).activeAuthority(scopeRef)
  if (state === 'CANONICAL' && binding !== undefined && binding.homeNodeId === localNodeId) return

  const reason =
    state === 'QUARANTINED'
      ? 'collective_establishment_quarantined'
      : state === 'NONCANONICAL' && (cause === 'placement_refused' || cause === 'binding_conflict')
        ? cause
        : binding?.homeNodeId !== undefined && binding.homeNodeId !== localNodeId
          ? 'binding_conflict'
          : 'binding_unbound'
  throw new HrcConflictError(
    HrcErrorCode.STALE_CONTEXT,
    `federated egress for external participant ${scopeRef} is fenced (${reason})`,
    {
      scopeRef,
      reason,
      retryable: reason === 'binding_unbound',
      ...(state === 'QUARANTINED' && isRecord(collective)
        ? {
            attemptCount: collective['attemptCount'],
            attemptBudget: collective['attemptBudget'],
          }
        : {}),
      ...(binding === undefined ? {} : { homeNodeId: binding.homeNodeId }),
    }
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deliveryContext(
  body: CompleteSemanticDmRequest | undefined,
  options?: { semanticTurnHandoff?: boolean | undefined }
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
    // T-07214: only the tolerant best-effort class ever rides ordinary
    // carriage; strict steer is refused at the origin for remote targets and
    // never reaches this envelope.
    ...(body.whenBusy === 'steer_else_queue' ? { whenBusy: 'steer_else_queue' as const } : {}),
    ...(options?.semanticTurnHandoff === true
      ? body.freshContext === true
        ? { semanticTurnHandoff: { version: 2 as const, freshContext: true as const } }
        : { semanticTurnHandoff: { version: 1 as const } }
      : {}),
  }
  return Object.keys(context).length === 0 ? undefined : context
}

function pendingEnvelopeFor(
  record: HrcMessageRecord,
  body: CompleteSemanticDmRequest | undefined,
  options?: { semanticTurnHandoff?: boolean | undefined }
): FederationPendingMessageEnvelope {
  const delivery = deliveryContext(body, options)
  const semanticTurnSignal = record.metadataJson?.['federationSemanticTurnSignal'] as
    | FederationSemanticTurnSignal
    | undefined
  const interactiveSignal = record.metadataJson?.['federationInteractiveSignal'] as
    | FederationInteractiveLifecycleSignal
    | undefined
  const mail = record.metadataJson?.['federationMail'] as FederationMailPayload | undefined
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
    ...(semanticTurnSignal === undefined ? {} : { semanticTurnSignal }),
    ...(interactiveSignal === undefined ? {} : { interactiveSignal }),
    ...(mail === undefined ? {} : { mail }),
  }
}

function mailActorAddress(actor: HrcMailActor): HrcMessageAddress {
  return actor.kind === 'scope'
    ? { kind: 'session', sessionRef: actor.sessionRef }
    : { kind: 'entity', entity: 'human' }
}

function envelopeFor(
  record: HrcMessageRecord,
  body: CompleteSemanticDmRequest | undefined,
  expected: { homeNodeId: string; placementEpoch: number },
  options?: { semanticTurnHandoff?: boolean | undefined }
): FederationMessageEnvelope {
  return { ...pendingEnvelopeFor(record, body, options), expected }
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
    const sendEnvelope = async (peer: PeerEntry, envelope: FederationMessageEnvelope) => {
      // T-07155 — urgent envelopes go to the distinct urgent route and NEVER
      // fall back to the ordinary one. The health capability below is advisory
      // (it produces a clearer error sooner); the route itself is the
      // fail-closed fence, because a peer without it refuses at the transport
      // before parsing an envelope or scheduling any local delivery.
      const urgent = envelope.delivery?.urgent !== undefined
      if (urgent) {
        const probe = await probePeerHealth(peer)
        if (probe.health.capabilities?.urgentDelivery !== true) {
          return {
            outcome: 'refused' as const,
            status: 409,
            code: 'urgent_delivery_unroutable',
            message: `peer ${peer.nodeId} does not advertise urgentDelivery`,
            retryable: false,
          }
        }
      }
      if (envelope.delivery?.semanticTurnHandoff !== undefined) {
        const probe = await probePeerHealth(peer)
        if (probe.health.state !== 'healthy') {
          return {
            outcome: 'refused' as const,
            status: 503,
            code: 'peer_health_unavailable',
            message: probe.health.detail ?? `peer ${peer.nodeId} health unavailable`,
            retryable: true,
          }
        }
        if (probe.health.capabilities?.semanticTurnHandoff !== true) {
          return {
            outcome: 'refused' as const,
            status: 409,
            code: 'peer_semantic_turn_unsupported',
            message: `peer ${peer.nodeId} does not advertise semanticTurnHandoff`,
            retryable: false,
          }
        }
      }
      return sendFederationEnvelope({
        ...(urgent ? { urgent: true } : {}),
        db: options.db,
        peer,
        envelope,
        onStaleRedirect: handleRedirect,
      })
    }
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
          return sendEnvelope(peer, advanced.envelope)
        }
        return sendEnvelope(peer, delivery.envelope)
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
  async resolveTargetPlacement(
    body: CompleteSemanticDmRequest
  ): Promise<FederationTargetPlacement> {
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
          if (
            body.runtimeIntent?.provision?.node !== undefined &&
            placement.policyProvenance === 'default_home_node'
          ) {
            throw new HrcConflictError(
              HrcErrorCode.STALE_CONTEXT,
              `${scopeRef} routes to ${placement.candidateHomeNodeId} by provisioning.node; this node is ${this.options.config.nodeId}. Summon it on ${placement.candidateHomeNodeId}.`,
              {
                scopeRef,
                reason: placement.reason,
                retryable: false,
                homeNodeId: placement.candidateHomeNodeId,
              }
            )
          }
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

  async resolveMailTargetPlacement(
    request: HrcMailSendRequest
  ): Promise<FederationTargetPlacement> {
    return this.resolveTargetPlacement({
      from: mailActorAddress(request.from),
      to: { kind: 'session', sessionRef: request.targetSessionRef },
      body: request.payload.body,
      ...(request.materializationIntent === undefined
        ? { createIfMissing: false }
        : { createIfMissing: true, runtimeIntent: request.materializationIntent }),
    })
  }

  async isRemoteTarget(scopeRef: string): Promise<boolean> {
    const binding = await this.resolveMessageStorageBinding(scopeRef)
    if (binding === undefined) return false
    return binding.homeNodeId !== this.options.config.nodeId
  }

  /**
   * Whether an explicit reply can use the authenticated ingress route recorded
   * on its direct parent. Callers use this before node-local admission checks:
   * a loser-node retirement fence bars execution, not a fenced response back
   * to the peer that delivered the parent message.
   */
  canRouteResponseToPeer(parent: HrcMessageRecord): boolean {
    return this.responseRouteForParent(parent) !== undefined
  }

  async route(
    body: CompleteSemanticDmRequest,
    record: HrcMessageRecord,
    resolvedPlacement?: FederationTargetPlacement | undefined,
    options?: { semanticTurnHandoff?: boolean | undefined }
  ): Promise<FederationOriginRouteResult> {
    const responseRoute = this.responseRoute(record)
    if (responseRoute !== undefined) {
      // An explicit reply carries its delivery context so the destination can
      // inject it into the recipient runtime, matching local reply semantics.
      // Daemon-bridged turn-final responses (routeResponse) stay context-free
      // and are store-only at the destination.
      return this.enqueue(
        record,
        body,
        responseRoute.peerNodeId,
        responseRoute.expected,
        { responseFence: true },
        options
      )
    }
    if (record.to.kind !== 'session') return { outcome: 'local' }
    const placement = resolvedPlacement ?? (await this.resolveTargetPlacement(body))
    if (placement.outcome === 'local') return { outcome: 'local' }
    if (placement.outcome === 'remote-establish') {
      return this.enqueueEstablishing(
        record,
        body,
        placement.scopeRef,
        placement.candidateHomeNodeId,
        options
      )
    }
    const binding = placement.binding

    return this.enqueue(
      record,
      body,
      binding.homeNodeId,
      binding,
      { routingSource: binding.source },
      options
    )
  }

  async routeMail(
    request: HrcMailSendRequest,
    record: HrcMessageRecord,
    resolvedPlacement?: FederationTargetPlacement | undefined
  ): Promise<FederationOriginRouteResult> {
    const placement = resolvedPlacement ?? (await this.resolveMailTargetPlacement(request))
    if (placement.outcome === 'local') return { outcome: 'local' }
    if (placement.outcome === 'remote-establish') {
      return this.enqueueEstablishing(
        record,
        undefined,
        placement.scopeRef,
        placement.candidateHomeNodeId
      )
    }
    return this.enqueue(record, undefined, placement.binding.homeNodeId, placement.binding, {
      routingSource: placement.binding.source,
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
    const ledger = createPlacementLedgerRepository(this.options.db.sqlite)
    const retirement = readScopeRetirement(this.options.db.sqlite, scopeRef)
    const localAuthority = ledger.activeAuthority(scopeRef)
    const excludedHomeNodeId =
      retirement?.retiredNodeId === this.options.config.nodeId &&
      (localAuthority === undefined ||
        localAuthority.placementEpoch <= retirement.retiredPlacementEpoch)
        ? retirement.retiredNodeId
        : undefined
    return resolveFederationRoutingBinding({
      scopeRef,
      ledger,
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
    const parent = this.options.db.messages.getById(record.replyToMessageId)
    return this.responseRouteForParent(parent)
  }

  private responseRouteForParent(parent: HrcMessageRecord | undefined):
    | {
        peerNodeId: string
        expected: { homeNodeId: string; placementEpoch: number }
      }
    | undefined {
    const ingress = parent?.metadataJson?.['federationIngress']
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

  /** EPR shadows are locally observable but cannot speak for the canonical seat. */
  private assertExternalSenderHome(record: HrcMessageRecord): void {
    assertExternalParticipantFederatedEgress(this.options.db, this.options.config.nodeId, record)
  }

  private enqueue(
    record: HrcMessageRecord,
    body: CompleteSemanticDmRequest | undefined,
    peerNodeId: string,
    expected: { homeNodeId: string; placementEpoch: number },
    log: {
      routingSource?: string | undefined
      responseFence?: boolean | undefined
    },
    options?: { semanticTurnHandoff?: boolean | undefined }
  ): FederationOriginRouteResult {
    this.assertExternalSenderHome(record)
    const existing = this.options.db.federationOutbox.getByMessageId(record.messageId)
    if (existing !== undefined) return { outcome: 'queued', delivery: existing }
    const delivery = this.options.db.federationOutbox.enqueue({
      deliveryId: `delivery-${randomUUID()}`,
      messageId: record.messageId,
      peerNodeId,
      envelope: envelopeFor(record, body, expected, options),
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
    body: CompleteSemanticDmRequest | undefined,
    scopeRef: string,
    peerNodeId: string,
    options?: { semanticTurnHandoff?: boolean | undefined }
  ): FederationOriginRouteResult {
    this.assertExternalSenderHome(record)
    const existing = this.options.db.federationOutbox.getByMessageId(record.messageId)
    if (existing !== undefined) return { outcome: 'queued', delivery: existing }
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
      envelope: pendingEnvelopeFor(record, body, options),
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

  cancel(deliveryId: string): FederationOutboxDeliveryRecord {
    const cancelled = this.engine.cancel(deliveryId)
    writeServerLog('WARN', 'federation.outbox.operator_cancelled', {
      deliveryId: cancelled.deliveryId,
      messageId: cancelled.messageId,
      peerNodeId: cancelled.peerNodeId,
      priorAttempts: cancelled.totalAttempts,
    })
    return cancelled
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
