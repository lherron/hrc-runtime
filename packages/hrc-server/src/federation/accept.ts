import type {
  FederationInteractiveLifecycleSignal,
  FederationMailPayload,
  FederationMessageDelivery,
  FederationMessageEnvelope,
  HrcMailActor,
  HrcMailEnvelope,
  HrcMailPayload,
  HrcMailSendRequest,
  HrcMessageAddress,
  HrcMessageKind,
  HrcMessagePhase,
  HrcMessageRecord,
  HrcRuntimeIntent,
} from 'hrc-core'
import { createPlacementLedgerRepository, readScopeRetirement } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { parseRuntimeIntent } from '../parsers/runtime.js'
import { parseOptionalTurnResponseFormat, parseSessionRef } from '../server-parsers.js'
import type { PeerAcceptHandler, PeerAcceptRequest, PeerAcceptResult } from './peer-protocol.js'
import type { BindingRegistryClient } from './registry-client.js'

const MESSAGE_ID_PATTERN =
  /^(?:msg-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAIL_ENVELOPE_ID_PATTERN =
  /^mail-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

function parseMailActor(value: unknown): HrcMailActor {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  if (value['kind'] === 'scope') {
    return { kind: 'scope', sessionRef: requiredString(value, 'sessionRef') }
  }
  if (value['kind'] === 'operator') {
    return { kind: 'operator', principal: requiredString(value, 'principal') }
  }
  throw new InvalidFederationEnvelopeError()
}

function parseMailPayload(value: unknown): HrcMailPayload {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  const kind = value['kind']
  if (kind !== 'request' && kind !== 'conversational') {
    throw new InvalidFederationEnvelopeError()
  }
  const metadata = value['metadata']
  if (metadata !== undefined && !isRecord(metadata)) throw new InvalidFederationEnvelopeError()
  return {
    kind,
    body: requiredText(value, 'body'),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseMailSendRequest(value: unknown): HrcMailSendRequest {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  const replySchema = value['replySchema']
  if (replySchema !== undefined && !isRecord(replySchema)) {
    throw new InvalidFederationEnvelopeError()
  }
  const materializationIntent = value['materializationIntent']
  if (materializationIntent !== undefined && !isRecord(materializationIntent)) {
    throw new InvalidFederationEnvelopeError()
  }
  let parsedIntent: HrcMailSendRequest['materializationIntent']
  try {
    parsedIntent =
      materializationIntent === undefined ? undefined : parseRuntimeIntent(materializationIntent)
  } catch {
    throw new InvalidFederationEnvelopeError()
  }
  return {
    ingressId: requiredString(value, 'ingressId'),
    from: parseMailActor(value['from']),
    targetSessionRef: requiredString(value, 'targetSessionRef'),
    payload: parseMailPayload(value['payload']),
    ...(replySchema === undefined ? {} : { replySchema }),
    ...(parsedIntent === undefined ? {} : { materializationIntent: parsedIntent }),
  }
}

function parseOptionalTimestamp(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = optionalString(record, field)
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new InvalidFederationEnvelopeError()
  }
  return value
}

function parseTerminalMailEnvelope(value: unknown): HrcMailEnvelope {
  if (!isRecord(value)) throw new InvalidFederationEnvelopeError()
  const state = value['state']
  if (state !== 'acked' && state !== 'dead') throw new InvalidFederationEnvelopeError()
  const roundCount = value['roundCount']
  if (!Number.isSafeInteger(roundCount) || (roundCount as number) < 0) {
    throw new InvalidFederationEnvelopeError()
  }
  const replySchema = value['replySchema']
  if (replySchema !== undefined && !isRecord(replySchema)) {
    throw new InvalidFederationEnvelopeError()
  }
  const terminalActor = value['terminalActor']
  const parsedTerminalActor =
    terminalActor === undefined ? undefined : parseMailActor(terminalActor)
  return {
    envelopeId: requiredString(value, 'envelopeId'),
    ingressId: requiredString(value, 'ingressId'),
    from: parseMailActor(value['from']),
    targetSessionRef: requiredString(value, 'targetSessionRef'),
    payload: parseMailPayload(value['payload']),
    ...(replySchema === undefined ? {} : { replySchema }),
    state,
    roundCount: roundCount as number,
    ...(Object.hasOwn(value, 'response') ? { response: value['response'] } : {}),
    ...(parseOptionalTimestamp(value, 'presentedAt') === undefined
      ? {}
      : { presentedAt: parseOptionalTimestamp(value, 'presentedAt') }),
    ...(parseOptionalTimestamp(value, 'ackedAt') === undefined
      ? {}
      : { ackedAt: parseOptionalTimestamp(value, 'ackedAt') }),
    ...(parseOptionalTimestamp(value, 'deadAt') === undefined
      ? {}
      : { deadAt: parseOptionalTimestamp(value, 'deadAt') }),
    ...(parsedTerminalActor === undefined ? {} : { terminalActor: parsedTerminalActor }),
    createdAt: requiredString(value, 'createdAt'),
    updatedAt: requiredString(value, 'updatedAt'),
  }
}

function parseFederationMailPayload(value: unknown): FederationMailPayload | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value['version'] !== 1) {
    throw new InvalidFederationEnvelopeError()
  }
  if (value['type'] === 'request') {
    const envelopeId = requiredString(value, 'envelopeId')
    if (!MAIL_ENVELOPE_ID_PATTERN.test(envelopeId)) {
      throw new InvalidFederationEnvelopeError()
    }
    return {
      version: 1,
      type: 'request',
      envelopeId,
      request: parseMailSendRequest(value['request']),
    }
  }
  if (value['type'] === 'disposition') {
    return {
      version: 1,
      type: 'disposition',
      envelope: parseTerminalMailEnvelope(value['envelope']),
    }
  }
  throw new InvalidFederationEnvelopeError()
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
  const mail = parseFederationMailPayload(value['mail'])
  if (interactiveSignal !== undefined && (kind !== 'system' || phase !== 'response')) {
    throw new InvalidFederationEnvelopeError()
  }
  if (
    mail !== undefined &&
    (kind !== 'system' ||
      (mail.type === 'request' && phase !== 'request') ||
      (mail.type === 'disposition' && phase !== 'response'))
  ) {
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
    ...(mail === undefined ? {} : { mail }),
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
  readonly registry?: Pick<BindingRegistryClient, 'consult'> | undefined
  readonly onAccepted?: ((message: FederationAcceptedMessage) => Promise<void> | void) | undefined
  readonly onMailAccepted?:
    | ((
        message: FederationAcceptedMessage & {
          envelope: FederationMessageEnvelope & {
            mail: Extract<FederationMailPayload, { type: 'request' }>
          }
        }
      ) => Promise<void> | void)
    | undefined
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
    const directParent = options.db.messages.getById(envelope.replyToMessageId)
    if (directParent === undefined) {
      return refused('response_parent_unknown', true)
    }
    if (directParent.phase !== 'request' && directParent.phase !== 'response') {
      return refused('response_parent_phase_invalid', false)
    }
    if (envelope.rootMessageId !== directParent.rootMessageId) {
      return refused('response_root_mismatch', false)
    }
    const acceptance = options.db.federationPeerAcceptances.get(envelope.replyToMessageId)
    if (acceptance === undefined) {
      return refused('response_parent_not_accepted', true)
    }
    if (acceptance.acceptedByNodeId !== request.authenticatedNodeId) {
      return refused('response_node_mismatch', false)
    }

    // Completion is fenced by direct-parent, same-peer ACK provenance,
    // deliberately not by the current placement ledger or the correlation
    // root. Per-hop proof composes across reply chains and placement rebinds;
    // root equality above only keeps the transcript coherent (§6).
    if (options.db.messages.getById(envelope.messageId) !== undefined) {
      return { outcome: 'duplicate', messageId: envelope.messageId }
    }
  } else {
    // A prior durable request acceptance wins over a later placement change.
    // This is the retry half of the insert-before-ACK crash contract.
    if (options.db.messages.getById(envelope.messageId) !== undefined) {
      if (
        envelope.mail?.type === 'request' &&
        options.db.mailEnvelopes.get(envelope.mail.envelopeId) === undefined
      ) {
        return refused('mail_acceptance_incomplete', true)
      }
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

    const ledger = createPlacementLedgerRepository(options.db.sqlite)
    let placement = ledger.get(scopeRef)
    if (placement === undefined && options.registry !== undefined) {
      try {
        const registry = await options.registry.consult(scopeRef)
        if (
          registry.outcome === 'bound' &&
          registry.binding.homeNodeId === options.localNodeId &&
          registry.binding.establishmentProvenance !== 'rebind'
        ) {
          // Registry-first establishment can leave this exact crash window:
          // the collective binding committed, but the destination's local
          // authority row did not. Startup repairs scopes that were already
          // live at boot; an existing session resumed later can expose the
          // same gap. Heal only the registry's exact non-rebind tuple, then
          // apply the ordinary envelope epoch/home fences below.
          ledger.installActive(registry.binding)
          placement = ledger.get(scopeRef)
        }
      } catch {
        // Preserve the receiver's retryable placement_unknown contract when
        // registry authority cannot be read. The origin outbox will retry.
      }
    }
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

  if (
    envelope.mail?.type === 'request' &&
    (envelope.to.kind !== 'session' ||
      envelope.mail.request.targetSessionRef !== envelope.to.sessionRef ||
      envelope.mail.request.payload.body !== envelope.body ||
      (envelope.mail.request.from.kind === 'scope'
        ? envelope.from.kind !== 'session' ||
          envelope.mail.request.from.sessionRef !== envelope.from.sessionRef
        : envelope.from.kind !== 'entity' || envelope.from.entity !== 'human'))
  ) {
    return { outcome: 'refused', code: 'mail_envelope_mismatch', retryable: false, status: 400 }
  }

  let inserted: ReturnType<HrcDatabase['messages']['insertIdempotent']>
  try {
    inserted = options.db.sqlite
      .transaction(() => {
        const message = options.db.messages.insertIdempotent({
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
            ...(envelope.mail === undefined ? {} : { federationMail: envelope.mail }),
          },
        })
        if (message.outcome === 'duplicate') return message

        if (envelope.mail?.type === 'request') {
          options.db.mailEnvelopes.create({
            ...envelope.mail.request,
            ingressId: envelope.messageId,
            envelopeId: envelope.mail.envelopeId,
          })
        } else if (
          envelope.mail?.type === 'disposition' &&
          envelope.replyToMessageId !== undefined
        ) {
          options.db.mailFederatedOrigins.applyDisposition({
            requestMessageId: envelope.replyToMessageId,
            dispositionMessageId: envelope.messageId,
            envelope: envelope.mail.envelope,
          })
        }
        return message
      })
      .immediate()
  } catch (error) {
    if (envelope.mail === undefined) throw error
    return {
      outcome: 'refused',
      code: envelope.mail?.type === 'disposition' ? 'invalid_mail_disposition' : 'invalid_mail',
      retryable: false,
      status: 400,
    }
  }
  if (inserted.outcome === 'duplicate') {
    return { outcome: 'duplicate', messageId: envelope.messageId }
  }

  await options.afterDurableAcceptance?.()
  return {
    outcome: 'accepted',
    messageId: envelope.messageId,
    ...(envelope.mail?.type === 'request'
      ? options.onMailAccepted === undefined
        ? {}
        : {
            afterAck: async () =>
              options.onMailAccepted?.({
                authenticatedNodeId: request.authenticatedNodeId,
                envelope: envelope as FederationMessageEnvelope & {
                  mail: Extract<FederationMailPayload, { type: 'request' }>
                },
                record: inserted.record,
              }),
          }
      : envelope.mail?.type === 'disposition' || options.onAccepted === undefined
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
