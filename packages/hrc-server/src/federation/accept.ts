import type {
  FederationInteractiveLifecycleSignal,
  FederationMessageDelivery,
  FederationMessageEnvelope,
  HrcMessageAddress,
  HrcMessageKind,
  HrcMessagePhase,
  HrcMessageRecord,
  HrcRuntimeIntent,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { parseOptionalTurnResponseFormat, parseSessionRef } from '../server-parsers.js'
import type { PeerAcceptHandler, PeerAcceptRequest, PeerAcceptResult } from './peer-protocol.js'

const MESSAGE_ID_PATTERN =
  /^(?:msg-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MESSAGE_KINDS = new Set<HrcMessageKind>(['dm', 'literal', 'system'])
const MESSAGE_PHASES = new Set<HrcMessagePhase>(['request', 'response', 'oneway'])

export class InvalidFederationEnvelopeError extends Error {
  constructor() {
    super('invalid federation envelope')
    this.name = 'InvalidFederationEnvelopeError'
  }
}

/** Test-only fault marker used to prove the durable-insert/ACK crash window. */
export class FederationAcceptCrashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FederationAcceptCrashError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidFederationEnvelopeError()
  }
  return value.trim()
}

function requiredText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new InvalidFederationEnvelopeError()
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidFederationEnvelopeError()
  }
  return value.trim()
}

function parseAddress(value: unknown): HrcMessageAddress {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  if (value['kind'] === 'session') {
    return { kind: 'session', sessionRef: requiredString(value, 'sessionRef') }
  }
  if (value['kind'] === 'entity' && (value['entity'] === 'human' || value['entity'] === 'system')) {
    return { kind: 'entity', entity: value['entity'] }
  }
  throw new InvalidFederationEnvelopeError()
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new InvalidFederationEnvelopeError()
  return value
}

function parseDelivery(value: unknown): FederationMessageDelivery | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  const runtimeIntent = value['runtimeIntent']
  if (runtimeIntent !== undefined && !isRecord(runtimeIntent)) {
    throw new InvalidFederationEnvelopeError()
  }
  const parsedScopeJson = value['parsedScopeJson']
  if (parsedScopeJson !== undefined && !isRecord(parsedScopeJson)) {
    throw new InvalidFederationEnvelopeError()
  }
  let responseFormat: FederationMessageDelivery['responseFormat']
  try {
    responseFormat = parseOptionalTurnResponseFormat(value['responseFormat'])
  } catch {
    throw new InvalidFederationEnvelopeError()
  }
  const createIfMissing = optionalBoolean(value, 'createIfMissing')
  const allowStaleGeneration = optionalBoolean(value, 'allowStaleGeneration')
  return {
    ...(runtimeIntent === undefined ? {} : { runtimeIntent: runtimeIntent as HrcRuntimeIntent }),
    ...(createIfMissing === undefined ? {} : { createIfMissing }),
    ...(parsedScopeJson === undefined ? {} : { parsedScopeJson }),
    ...(value['respondTo'] === undefined ? {} : { respondTo: parseAddress(value['respondTo']) }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(allowStaleGeneration === undefined ? {} : { allowStaleGeneration }),
  }
}

function parseInteractiveSignal(value: unknown): FederationInteractiveLifecycleSignal | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value['version'] !== 1 || value['type'] !== 'ask_user_question') {
    throw new InvalidFederationEnvelopeError()
  }
  const sourceHrcSeq = value['sourceHrcSeq']
  if (!Number.isSafeInteger(sourceHrcSeq) || (sourceHrcSeq as number) < 1) {
    throw new InvalidFederationEnvelopeError()
  }
  const event = value['event']
  if (!isRecord(event) || event['eventKind'] !== 'turn.tool_call' || !isRecord(event['payload'])) {
    throw new InvalidFederationEnvelopeError()
  }
  const generation = event['generation']
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new InvalidFederationEnvelopeError()
  }
  const transport = event['transport']
  if (
    transport !== undefined &&
    transport !== 'sdk' &&
    transport !== 'tmux' &&
    transport !== 'headless' &&
    transport !== 'ghostty'
  ) {
    throw new InvalidFederationEnvelopeError()
  }
  const acpRunId = optionalString(value, 'acpRunId')
  return {
    version: 1,
    type: 'ask_user_question',
    sourceHrcSeq: sourceHrcSeq as number,
    ...(acpRunId === undefined ? {} : { acpRunId }),
    event: {
      eventKind: 'turn.tool_call',
      ts: requiredString(event, 'ts'),
      hostSessionId: requiredString(event, 'hostSessionId'),
      scopeRef: requiredString(event, 'scopeRef'),
      laneRef: requiredString(event, 'laneRef'),
      generation: generation as number,
      ...(optionalString(event, 'runtimeId') === undefined
        ? {}
        : { runtimeId: optionalString(event, 'runtimeId') }),
      runId: requiredString(event, 'runId'),
      ...(transport === undefined
        ? {}
        : { transport: transport as FederationInteractiveLifecycleSignal['event']['transport'] }),
      payload: event['payload'],
    },
  }
}

export function parseFederationMessageEnvelope(value: unknown): FederationMessageEnvelope {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  const protocolVersion = requiredString(value, 'protocolVersion')
  if (!/^\d+\.\d+$/.test(protocolVersion)) throw new InvalidFederationEnvelopeError()
  const messageId = requiredString(value, 'messageId')
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new InvalidFederationEnvelopeError()
  const kind = value['kind']
  const phase = value['phase']
  if (!MESSAGE_KINDS.has(kind as HrcMessageKind) || !MESSAGE_PHASES.has(phase as HrcMessagePhase)) {
    throw new InvalidFederationEnvelopeError()
  }
  const expected = value['expected']
  if (!isRecord(expected)) throw new InvalidFederationEnvelopeError()
  const placementEpoch = expected['placementEpoch']
  if (!Number.isSafeInteger(placementEpoch) || (placementEpoch as number) < 1) {
    throw new InvalidFederationEnvelopeError()
  }

  const replyToMessageId = optionalString(value, 'replyToMessageId')
  const interactiveSignal = parseInteractiveSignal(value['interactiveSignal'])
  if (interactiveSignal !== undefined && (kind !== 'system' || phase !== 'response')) {
    throw new InvalidFederationEnvelopeError()
  }
  return {
    protocolVersion,
    messageId,
    kind: kind as HrcMessageKind,
    phase: phase as HrcMessagePhase,
    from: parseAddress(value['from']),
    to: parseAddress(value['to']),
    body: requiredText(value, 'body'),
    rootMessageId: requiredString(value, 'rootMessageId'),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    expected: {
      homeNodeId: requiredString(expected, 'homeNodeId'),
      placementEpoch: placementEpoch as number,
    },
    ...(value['delivery'] === undefined ? {} : { delivery: parseDelivery(value['delivery']) }),
    ...(interactiveSignal === undefined ? {} : { interactiveSignal }),
  }
}

export type FederationAcceptedMessage = {
  readonly authenticatedNodeId: string
  readonly envelope: FederationMessageEnvelope
  readonly record: HrcMessageRecord
}

export type CreateFederationAcceptHandlerOptions = {
  readonly db: HrcDatabase
  readonly localNodeId: string
  readonly onAccepted?: ((message: FederationAcceptedMessage) => Promise<void> | void) | undefined
  /** Fault-injection seam. Production leaves this absent. */
  readonly afterDurableAcceptance?: (() => Promise<void> | void) | undefined
}

function refused(
  code: string,
  retryable: boolean,
  redirect?: { homeNodeId: string; placementEpoch: number }
): PeerAcceptResult {
  return {
    outcome: 'refused',
    code,
    retryable,
    status: 409,
    ...(redirect === undefined ? {} : { redirect }),
  }
}

async function acceptFederationEnvelope(
  options: CreateFederationAcceptHandlerOptions,
  request: PeerAcceptRequest
): Promise<PeerAcceptResult> {
  let envelope: FederationMessageEnvelope
  try {
    envelope = parseFederationMessageEnvelope(request.envelope)
  } catch (error) {
    if (error instanceof InvalidFederationEnvelopeError) {
      return { outcome: 'refused', code: 'invalid_envelope', retryable: false, status: 400 }
    }
    throw error
  }

  if (envelope.protocolVersion !== request.protocolVersion) {
    return {
      outcome: 'refused',
      code: 'envelope_protocol_mismatch',
      retryable: false,
      status: 400,
    }
  }

  if (envelope.phase === 'response') {
    if (envelope.replyToMessageId === undefined) {
      return { outcome: 'refused', code: 'response_reply_required', retryable: false, status: 400 }
    }
    const repliedTo = options.db.messages.getById(envelope.replyToMessageId)
    if (repliedTo === undefined || repliedTo.phase !== 'request') {
      return refused('response_request_unknown', true)
    }
    const acceptance = options.db.federationAcceptedRequests.get(envelope.replyToMessageId)
    if (acceptance === undefined) {
      return refused('response_request_not_accepted', true)
    }
    if (acceptance.acceptedByNodeId !== request.authenticatedNodeId) {
      return refused('response_node_mismatch', false)
    }

    // Completion is fenced by the durable ACK provenance above, deliberately
    // not by the current placement ledger. A response may arrive after either
    // endpoint's scope has rebound; applying the request-placement fence here
    // would turn an ordinary transport delay into transcript loss (§6).
    if (options.db.messages.getById(envelope.messageId) !== undefined) {
      return { outcome: 'duplicate', messageId: envelope.messageId }
    }
  } else {
    // A prior durable request acceptance wins over a later placement change.
    // This is the retry half of the insert-before-ACK crash contract.
    if (options.db.messages.getById(envelope.messageId) !== undefined) {
      return { outcome: 'duplicate', messageId: envelope.messageId }
    }
  }

  if (envelope.phase !== 'response') {
    if (envelope.to.kind !== 'session') {
      return { outcome: 'refused', code: 'session_target_required', retryable: false, status: 400 }
    }
    let scopeRef: string
    try {
      scopeRef = parseSessionRef(envelope.to.sessionRef).scopeRef
    } catch {
      return { outcome: 'refused', code: 'invalid_target', retryable: false, status: 400 }
    }

    const placement = createPlacementLedgerRepository(options.db.sqlite).get(scopeRef)
    const fence = readScopeRetirement(options.db.sqlite, scopeRef)
    if (
      fence !== undefined &&
      fence.retiredNodeId === options.localNodeId &&
      (placement === undefined || placement.placementEpoch <= fence.retiredPlacementEpoch)
    ) {
      if (fence.successorNodeId === null) {
        return refused('scope_retired_terminal', false)
      }
      if (fence.retiredPlacementEpoch === Number.MAX_SAFE_INTEGER) {
        return refused('placement_epoch_exhausted', false)
      }
      return refused('stale_placement', true, {
        homeNodeId: fence.successorNodeId,
        placementEpoch: fence.retiredPlacementEpoch + 1,
      })
    }
    if (placement === undefined) return refused('placement_unknown', true)
    const current = {
      homeNodeId: placement.homeNodeId,
      placementEpoch: placement.placementEpoch,
    }
    if (placement.placementEpoch > envelope.expected.placementEpoch) {
      return refused('stale_placement', true, current)
    }
    if (placement.placementEpoch < envelope.expected.placementEpoch) {
      return refused('receiver_placement_stale', true)
    }
    if (
      placement.state !== 'active' ||
      placement.homeNodeId !== envelope.expected.homeNodeId ||
      placement.homeNodeId !== options.localNodeId
    ) {
      return refused('placement_mismatch', true, current)
    }
  }

  const inserted = options.db.messages.insertIdempotent({
    messageId: envelope.messageId,
    kind: envelope.kind,
    phase: envelope.phase,
    from: envelope.from,
    to: envelope.to,
    body: envelope.body,
    ...(envelope.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: envelope.replyToMessageId }),
    rootMessageId: envelope.rootMessageId,
    execution: { state: 'not_applicable' },
    metadataJson: {
      federationIngress: {
        authenticatedNodeId: request.authenticatedNodeId,
        protocolVersion: request.protocolVersion,
        expected: envelope.expected,
        ...(envelope.delivery === undefined ? {} : { delivery: envelope.delivery }),
      },
      ...(envelope.interactiveSignal === undefined
        ? {}
        : { federationInteractiveSignal: envelope.interactiveSignal }),
    },
  })
  if (inserted.outcome === 'duplicate') {
    return { outcome: 'duplicate', messageId: envelope.messageId }
  }

  await options.afterDurableAcceptance?.()
  return {
    outcome: 'accepted',
    messageId: envelope.messageId,
    ...(options.onAccepted === undefined
      ? {}
      : {
          afterAck: async () =>
            options.onAccepted?.({
              authenticatedNodeId: request.authenticatedNodeId,
              envelope,
              record: inserted.record,
            }),
        }),
  }
}

export function createFederationAcceptHandler(
  options: CreateFederationAcceptHandlerOptions
): PeerAcceptHandler {
  return (request) => acceptFederationEnvelope(options, request)
}
