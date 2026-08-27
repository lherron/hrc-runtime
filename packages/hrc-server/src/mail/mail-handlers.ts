import { createHash, randomUUID } from 'node:crypto'

import {
  type FederationMailPayload,
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  type HrcMailAckRequest,
  type HrcMailAckResponse,
  type HrcMailActor,
  type HrcMailCatRequest,
  type HrcMailCatResponse,
  type HrcMailDeferRequest,
  type HrcMailDeferResponse,
  type HrcMailEnvelopeState,
  type HrcMailInboxRequest,
  type HrcMailInboxResponse,
  type HrcMailListRequest,
  type HrcMailListResponse,
  type HrcMailPayload,
  type HrcMailReplySchema,
  type HrcMailSendRequest,
  type HrcMailSendResponse,
  type HrcMessageAddress,
  type HrcMessageRecord,
  sessionRefFor,
} from 'hrc-core'
import { HrcMailRepositoryError } from 'hrc-store-sqlite'
import type { HrcMailStopEnvelopeSummary } from 'hrc-store-sqlite'

import type { FederationTargetPlacement } from '../federation/origin-outbox.js'
import { normalizeTargetSessionRef } from '../messages.js'
import { parseRuntimeIntent } from '../parsers/runtime.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { json } from '../server-util.js'
import { envelopeIdSequence } from '../wrkq/ledger-types.js'
import { persistMailIngress } from './mail-ingress.js'

const MAIL_STATES = new Set<HrcMailEnvelopeState>([
  'pending',
  'presented',
  'acked',
  'deferred',
  'dead',
])
const MAIL_STOP_SUMMARY_LIMIT = 8
const MAIL_STOP_BODY_PREVIEW_CHARS = 160
const MAIL_STOP_REASON_MAX_CHARS = 4_096

function malformed(message: string, field?: string): never {
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    message,
    field === undefined ? {} : { field }
  )
}

function parseNonEmptyString(input: unknown, field: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return malformed(`${field} must be a non-empty string`, field)
  }
  return input.trim()
}

function parseNonBlankText(input: unknown, field: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return malformed(`${field} must be a non-empty string`, field)
  }
  return input
}

function parseMailActor(input: unknown, field = 'actor'): HrcMailActor {
  if (!isRecord(input)) return malformed(`${field} must be an object`, field)
  if (input['kind'] === 'scope') {
    return {
      kind: 'scope',
      sessionRef: normalizeTargetSessionRef(
        parseNonEmptyString(input['sessionRef'], `${field}.sessionRef`)
      ),
    }
  }
  if (input['kind'] === 'operator') {
    return {
      kind: 'operator',
      principal: parseNonEmptyString(input['principal'], `${field}.principal`),
    }
  }
  return malformed(`${field}.kind must be "scope" or "operator"`, `${field}.kind`)
}

function parsePayload(input: unknown): HrcMailPayload {
  if (!isRecord(input)) return malformed('payload must be an object', 'payload')
  const kind = input['kind']
  if (kind !== 'request' && kind !== 'conversational') {
    return malformed('payload.kind must be "request" or "conversational"', 'payload.kind')
  }
  const body = parseNonBlankText(input['body'], 'payload.body')
  const metadata = input['metadata']
  if (metadata !== undefined && !isRecord(metadata)) {
    return malformed('payload.metadata must be an object', 'payload.metadata')
  }
  return {
    kind,
    body,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseReplySchema(input: unknown): HrcMailReplySchema | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)) return malformed('replySchema must be an object', 'replySchema')
  return input
}

function mapMailRepositoryError(error: unknown): never {
  if (!(error instanceof HrcMailRepositoryError)) throw error

  if (
    error.code === 'target_mismatch' ||
    error.code === 'conflicting_disposition' ||
    error.code === 'ingress_conflict' ||
    error.code === 'invalid_transition'
  ) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, error.message, {
      mailCode: error.code,
      ...error.detail,
    })
  }
  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, error.message, {
    mailCode: error.code,
    ...error.detail,
  })
}

function runMailMutation<T>(mutate: () => T): T {
  try {
    return mutate()
  } catch (error) {
    return mapMailRepositoryError(error)
  }
}

function mailActorAddress(actor: HrcMailActor): HrcMessageAddress {
  return actor.kind === 'scope'
    ? { kind: 'session', sessionRef: actor.sessionRef }
    : { kind: 'entity', entity: 'human' }
}

function deterministicDispositionMessageId(requestMessageId: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`hrcmail-disposition:${requestMessageId}`).digest().subarray(0, 16)
  )
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `msg-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function mailRequestPayload(
  request: HrcMailSendRequest,
  envelopeId: string
): Extract<FederationMailPayload, { type: 'request' }> {
  return { version: 1, type: 'request', envelopeId, request }
}

function ensureFederatedMailRequest(
  server: HrcServerInstanceForHandlers,
  request: HrcMailSendRequest,
  envelopeId: string,
  messageId: string
): HrcMessageRecord {
  const mail = mailRequestPayload(request, envelopeId)
  return server.db.messages.insertIdempotent({
    messageId,
    kind: 'system',
    phase: 'request',
    from: mailActorAddress(request.from),
    to: { kind: 'session', sessionRef: request.targetSessionRef },
    body: request.payload.body,
    execution: { state: 'not_applicable' },
    metadataJson: { federationMail: mail },
  }).record
}

async function routeFederatedMailRequest(
  server: HrcServerInstanceForHandlers,
  request: HrcMailSendRequest,
  record: HrcMessageRecord,
  resolvedPlacement?: FederationTargetPlacement
): Promise<void> {
  const route = await server.federationOriginOutbox?.routeMail(request, record, resolvedPlacement)
  if (route?.outcome === 'local') {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'federated mail path no longer resolves to a remote authority',
      { targetSessionRef: request.targetSessionRef }
    )
  }
}

export async function handleMailSend(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')

  const parsed: HrcMailSendRequest = {
    ingressId: parseNonEmptyString(body['ingressId'], 'ingressId'),
    from: parseMailActor(body['from'], 'from'),
    targetSessionRef: normalizeTargetSessionRef(
      parseNonEmptyString(body['targetSessionRef'], 'targetSessionRef')
    ),
    payload: parsePayload(body['payload']),
    ...(body['replySchema'] === undefined
      ? {}
      : { replySchema: parseReplySchema(body['replySchema']) as HrcMailReplySchema }),
    ...(body['materializationIntent'] === undefined
      ? {}
      : {
          materializationIntent: isRecord(body['materializationIntent'])
            ? parseRuntimeIntent(body['materializationIntent'])
            : malformed('materializationIntent must be an object', 'materializationIntent'),
        }),
  }
  const priorReceipt = this.db.mailEnvelopes.getIngressReceipt(parsed.ingressId)
  if (priorReceipt !== undefined) {
    const local = this.db.mailEnvelopes.get(priorReceipt.envelopeId)
    if (local !== undefined) {
      const result = runMailMutation(() => persistMailIngress(this.db, parsed))
      this.requestMailKickerWake(result.envelope.targetSessionRef, 'insert')
      return json(result satisfies HrcMailSendResponse)
    }
    const origin = this.db.mailFederatedOrigins.getByIngressId(parsed.ingressId)
    if (origin !== undefined) {
      const result = runMailMutation(() =>
        this.db.mailFederatedOrigins.create({
          request: parsed,
          envelopeId: origin.envelopeId,
          requestMessageId: origin.requestMessageId,
        })
      )
      const record = ensureFederatedMailRequest(
        this,
        parsed,
        origin.envelopeId,
        origin.requestMessageId
      )
      await routeFederatedMailRequest(this, parsed, record)
      return json(result satisfies HrcMailSendResponse)
    }
  }

  const resolvedPlacement = await this.federationOriginOutbox?.resolveMailTargetPlacement(parsed)
  if (resolvedPlacement !== undefined && resolvedPlacement.outcome !== 'local') {
    const envelopeId = `mail-${randomUUID()}`
    const requestMessageId = `msg-${randomUUID()}`
    const stored = runMailMutation(() =>
      this.db.sqlite
        .transaction(() => {
          const result = this.db.mailFederatedOrigins.create({
            request: parsed,
            envelopeId,
            requestMessageId,
          })
          const origin = this.db.mailFederatedOrigins.getByIngressId(parsed.ingressId)
          if (origin === undefined) throw new Error('failed to reload federated mail origin')
          const record = ensureFederatedMailRequest(
            this,
            parsed,
            origin.envelopeId,
            origin.requestMessageId
          )
          return { result, record }
        })
        .immediate()
    )
    await routeFederatedMailRequest(this, parsed, stored.record, resolvedPlacement)
    return json(stored.result satisfies HrcMailSendResponse)
  }

  const result = runMailMutation(() => persistMailIngress(this.db, parsed))
  this.requestMailKickerWake(result.envelope.targetSessionRef, 'insert')
  return json(result satisfies HrcMailSendResponse)
}

export async function handleMailInbox(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const parsed: HrcMailInboxRequest = {
    actor: parseMailActor(body['actor']),
    targetSessionRef: normalizeTargetSessionRef(
      parseNonEmptyString(body['targetSessionRef'], 'targetSessionRef')
    ),
  }
  // Authorize the claimed mailbox before presentation mutates any envelope.
  runMailMutation(() => this.db.mailEnvelopes.inbox(parsed.actor, parsed.targetSessionRef))
  runMailMutation(() => this.db.mailEnvelopes.presentPendingForTarget(parsed.targetSessionRef))
  const envelopes = runMailMutation(() =>
    this.db.mailEnvelopes.inbox(parsed.actor, parsed.targetSessionRef)
  )
  return json({ envelopes } satisfies HrcMailInboxResponse)
}

export async function handleMailAck(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const rawIds = body['envelopeIds']
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return malformed('envelopeIds must be a non-empty string array', 'envelopeIds')
  }
  const envelopeIds = rawIds as string[]
  if (envelopeIds.length === 0) {
    return malformed('envelopeIds must contain at least one id', 'envelopeIds')
  }
  const parsed: HrcMailAckRequest = {
    actor: parseMailActor(body['actor']),
    envelopeIds,
    ...(Object.hasOwn(body, 'response') ? { response: body['response'] } : {}),
  }
  const results = runMailMutation(() => this.db.mailEnvelopes.ack(parsed))
  await Promise.all(results.map((result) => this.publishFederatedMailDisposition(result.envelope)))
  return json({ results } satisfies HrcMailAckResponse)
}

export async function handleMailDefer(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const retryAfterMs = body['retryAfterMs']
  if (
    retryAfterMs !== undefined &&
    (!Number.isSafeInteger(retryAfterMs) || (retryAfterMs as number) <= 0)
  ) {
    return malformed('retryAfterMs must be a positive integer', 'retryAfterMs')
  }
  const parsed: HrcMailDeferRequest = {
    actor: parseMailActor(body['actor']),
    envelopeId: parseNonEmptyString(body['envelopeId'], 'envelopeId'),
    reason: parseNonEmptyString(body['reason'], 'reason'),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs: retryAfterMs as number }),
  }
  const result = runMailMutation(() => this.db.mailEnvelopes.defer(parsed))
  return json(result satisfies HrcMailDeferResponse)
}

export async function handleMailCat(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const parsed: HrcMailCatRequest = {
    envelopeId: parseNonEmptyString(body['envelopeId'], 'envelopeId'),
  }
  const envelope = runMailMutation(() => {
    const local = this.db.mailEnvelopes.get(parsed.envelopeId)
    if (local !== undefined) return local
    const federated = this.db.mailFederatedOrigins.getByEnvelopeId(parsed.envelopeId)
    if (federated !== undefined) return federated.envelope
    return this.db.mailEnvelopes.require(parsed.envelopeId)
  })
  return json({ envelope } satisfies HrcMailCatResponse)
}

export async function publishFederatedMailDisposition(
  this: HrcServerInstanceForHandlers,
  envelope: HrcMailCatResponse['envelope']
): Promise<void> {
  if (envelope.state !== 'acked' && envelope.state !== 'dead') return
  const request = this.db.messages.getById(envelope.ingressId)
  const mail = request?.metadataJson?.['federationMail']
  if (
    request === undefined ||
    request.phase !== 'request' ||
    !isRecord(mail) ||
    mail['type'] !== 'request'
  ) {
    return
  }
  const disposition: FederationMailPayload = {
    version: 1,
    type: 'disposition',
    envelope,
  }
  const response = this.db.messages.insertIdempotent({
    messageId: deterministicDispositionMessageId(request.messageId),
    kind: 'system',
    phase: 'response',
    from: request.to,
    to: request.from,
    body: '',
    replyToMessageId: request.messageId,
    rootMessageId: request.rootMessageId,
    execution: { state: 'not_applicable' },
    metadataJson: { federationMail: disposition },
  }).record
  await this.federationOriginOutbox?.routeResponse(response)
}

export async function handleMailList(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const state = body['state']
  if (state !== undefined && (typeof state !== 'string' || !MAIL_STATES.has(state as never))) {
    return malformed('state is not a valid mail envelope state', 'state')
  }
  const limit = body['limit']
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) <= 0)) {
    return malformed('limit must be a positive integer', 'limit')
  }
  const targetSessionRef =
    body['targetSessionRef'] === undefined
      ? undefined
      : normalizeTargetSessionRef(parseNonEmptyString(body['targetSessionRef'], 'targetSessionRef'))
  const parsed: HrcMailListRequest = {
    ...(targetSessionRef === undefined ? {} : { targetSessionRef }),
    ...(state === undefined ? {} : { state: state as HrcMailEnvelopeState }),
    ...(body['dead'] === true ? { dead: true } : {}),
    ...(limit === undefined ? {} : { limit: limit as number }),
  }
  const envelopes = this.db.mailEnvelopes.list(parsed)
  return json({ envelopes } satisfies HrcMailListResponse)
}

/**
 * The Stop-hook gate (T-07612 §8): refuse a turn end while presented
 * `reply_required` envelopes addressed to this scope are neither replied nor
 * deferred.
 *
 * The predicate is a wrkq query. `pendingView.blocking` is exactly the §8 set —
 * PRESENTED and undisposed — so an obligation the agent was never shown cannot
 * trap its turn. Caps are unchanged (refusal cap 3, reset on new arrival, hard
 * max 50 per turn) and live in HRC, because a refusal count references a run.
 *
 * FAIL-OPEN. If wrkq is unreachable, the turn ends. A collaboration ledger that
 * is down must not be able to hold every agent on the fleet inside its turn.
 */
export async function handleMailStopDecision(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) return malformed('request body must be an object')
  const runtimeId = parseNonEmptyString(body['runtimeId'], 'runtimeId')
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null || runtime.activeRunId === undefined) {
    return json({ decision: 'allow', reason: 'no_active_turn' })
  }

  const run = this.db.runs.getByRunId(runtime.activeRunId)
  if (
    run === null ||
    run.runtimeId !== runtimeId ||
    run.scopeRef !== runtime.scopeRef ||
    run.laneRef !== runtime.laneRef ||
    !isActiveMailStopRunStatus(run.status)
  ) {
    return json({ decision: 'allow', reason: 'stale_active_turn' })
  }

  const targetSessionRef = normalizeTargetSessionRef(sessionRefFor(run))
  let blocking: HrcMailStopEnvelopeSummary[]
  try {
    // The scope ref goes RAW, lane suffix and all: wrkq strips the lane and
    // keeps the scope, and trimming it here would be HRC guessing at a grammar
    // it does not own.
    const view = await this.wrkqLedger.pendingView({ scopes: [targetSessionRef] })
    const blockingIds = new Set(view.blocking)
    blocking = view.items
      .filter((envelope) => blockingIds.has(envelope.id))
      .map((envelope) => ({
        envelopeId: envelope.id,
        from: envelope.from.scopeRef ?? envelope.from.principalRef,
        roomKey: envelope.roomKey,
        body: envelope.body,
      }))
  } catch (error) {
    writeServerLog('WARN', 'wrkq.stop_hook.fail_open', {
      runId: run.runId,
      targetSessionRef,
      error: error instanceof Error ? error.message : String(error),
    })
    return json({
      decision: 'allow',
      reason: 'ledger_unavailable',
      runId: run.runId,
      targetSessionRef,
    })
  }

  const newestEnvelopeSeq = blocking.reduce(
    (newest, envelope) => Math.max(newest, envelopeIdSequence(envelope.envelopeId)),
    0
  )
  const decision = this.db.mailStopRefusals.evaluate(
    run.runId,
    targetSessionRef,
    blocking,
    newestEnvelopeSeq,
    MAIL_STOP_SUMMARY_LIMIT
  )
  if (decision.decision === 'allow') {
    return json({
      decision: 'allow',
      reason: decision.reason,
      runId: run.runId,
      targetSessionRef,
      unackedCount: decision.unackedCount,
      refusalCount: decision.refusalCount,
      totalRefusalCount: decision.totalRefusalCount,
    })
  }

  return json({
    decision: 'block',
    reason: formatMailStopReason(decision),
    runId: run.runId,
    targetSessionRef,
    unackedCount: decision.unackedCount,
    refusalCount: decision.refusalCount,
    totalRefusalCount: decision.totalRefusalCount,
  })
}

function isActiveMailStopRunStatus(status: string): boolean {
  return status === 'accepted' || status === 'started' || status === 'running'
}

function formatMailStopReason(
  decision: Extract<
    ReturnType<HrcServerInstanceForHandlers['db']['mailStopRefusals']['evaluate']>,
    { decision: 'block' }
  >
): string {
  const lines = [
    `Turn finish paused: ${decision.unackedCount} unanswered ${decision.unackedCount === 1 ? 'envelope' : 'envelopes'} remain (refusal ${decision.refusalCount}/3).`,
  ]
  for (const envelope of decision.envelopes) {
    lines.push(
      `- ${clip(envelope.roomKey, 80)} from ${clip(envelope.from, 120)}: ${clip(normalizePreview(envelope.body), MAIL_STOP_BODY_PREVIEW_CHARS)}`
    )
  }
  if (decision.unackedCount > decision.envelopes.length) {
    lines.push(`- … and ${decision.unackedCount - decision.envelopes.length} more`)
  }
  lines.push(
    'Run `wrkc inbox`, then reply (`wrkc say <room> --to <sender>`) or `wrkc defer` every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate.'
  )
  return clip(lines.join('\n'), MAIL_STOP_REASON_MAX_CHARS)
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(maxChars - 1, 0))}…`
}

export const mailHandlersMethods = {
  handleMailSend,
  handleMailInbox,
  handleMailAck,
  handleMailDefer,
  handleMailCat,
  handleMailList,
  handleMailStopDecision,
  publishFederatedMailDisposition,
}

export type MailHandlersMethods = typeof mailHandlersMethods
