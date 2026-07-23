import {
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
} from 'hrc-core'
import { HrcMailRepositoryError } from 'hrc-store-sqlite'

import { normalizeTargetSessionRef } from '../messages.js'
import { parseRuntimeIntent } from '../parsers/runtime.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { isRecord, parseJsonBody } from '../server-parsers.js'
import { json } from '../server-util.js'
import { persistMailIngress } from './mail-ingress.js'

const MAIL_STATES = new Set<HrcMailEnvelopeState>([
  'pending',
  'presented',
  'acked',
  'deferred',
  'dead',
])

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
  const envelope = runMailMutation(() => this.db.mailEnvelopes.require(parsed.envelopeId))
  return json({ envelope } satisfies HrcMailCatResponse)
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

export const mailHandlersMethods = {
  handleMailSend,
  handleMailInbox,
  handleMailAck,
  handleMailDefer,
  handleMailCat,
  handleMailList,
}

export type MailHandlersMethods = typeof mailHandlersMethods
