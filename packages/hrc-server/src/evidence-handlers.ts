import { HrcBadRequestError, HrcErrorCode, HrcInternalError, HrcNotFoundError } from 'hrc-core'
import type {
  BrokerEventWireRecord,
  BrokerEventsFollowResponse,
  BrokerEventsQueryResponse,
  BrokerEventsQueryResult,
  EventsHeadResponse,
  HrcBrokerInvocationEventRecord,
  SubscriberDeclareResponse,
} from 'hrc-core'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { isRecord, parseJsonBody } from './server-parsers.js'
import { json } from './server-util.js'

const QUERY_OPS = [
  'admission-rejection',
  'input-accepted',
  'unique-submission-after',
  'disposition',
  'input-rejection-evidence',
] as const

type QueryOp = (typeof QUERY_OPS)[number]

function isQueryOp(value: string): value is QueryOp {
  return (QUERY_OPS as readonly string[]).includes(value)
}

function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value.length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${name} is required`, {
      field: name,
    })
  }
  return value
}

function parseIncludeRetained(url: URL): boolean {
  const value = url.searchParams.get('includeRetained')
  if (value === null) return false
  if (value === 'true') return true
  if (value === 'false') return false
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    'includeRetained must be "true" or "false"',
    { field: 'includeRetained' }
  )
}

/**
 * Injector evidence surface (T-08607): head, committed-evidence query, and
 * commit-ordinal follow over broker_invocation_events, plus the retained
 * fence on every row read.
 */

/** `GET /v1/events/head` — positional high-water for recovery replans. */
export async function handleEventsHead(this: HrcServerInstanceForHandlers): Promise<Response> {
  return json({
    hrcSeq: this.db.hrcEvents.maxHrcSeq(),
    brokerCommit: this.db.brokerInvocationEvents.maxBrokerCommitId(),
  } satisfies EventsHeadResponse)
}

/** `GET /v1/broker-events/query` — one of event-drive's five evidence reads. */
export async function handleBrokerEventsQuery(
  this: HrcServerInstanceForHandlers,
  _request: Request,
  url: URL
): Promise<Response> {
  const opParam = requireParam(url, 'op')
  if (!isQueryOp(opParam)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `op must be one of ${QUERY_OPS.join(', ')}`,
      { field: 'op' }
    )
  }
  const includeRetained = parseIncludeRetained(url)
  const runtimeId = requireParam(url, 'runtimeId')
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }
  const events = this.db.brokerInvocationEvents
  let result: BrokerEventsQueryResult | null = null
  switch (opParam) {
    case 'admission-rejection': {
      const submissionId = requireParam(url, 'submissionId')
      const found = events.findAdmissionRejection(runtimeId, submissionId, { includeRetained })
      result = found === undefined ? null : { op: opParam, ...found }
      break
    }
    case 'input-accepted': {
      const inputId = requireParam(url, 'inputId')
      result = {
        op: opParam,
        accepted: events.hasInputAccepted(runtimeId, inputId, { includeRetained }),
      }
      break
    }
    case 'unique-submission-after': {
      const submissionId = events.findUniqueSubmissionForEnvelopeAfter({
        runtimeId,
        invocationId: requireParam(url, 'invocationId'),
        envelopeId: requireParam(url, 'envelopeId'),
        afterSeq: parseNonNegativeInt(url, 'afterSeq'),
        includeRetained,
      })
      result = submissionId === undefined ? null : { op: opParam, submissionId }
      break
    }
    case 'disposition': {
      const submissionId = requireParam(url, 'submissionId')
      const found = events.findSubmissionDisposition(runtimeId, submissionId, { includeRetained })
      result = found === undefined ? null : { op: opParam, ...found }
      break
    }
    case 'input-rejection-evidence': {
      const submissionId = requireParam(url, 'submissionId')
      const deliveryEvidence = events.findInputRejectionDeliveryEvidence(runtimeId, submissionId, {
        includeRetained,
      })
      result = deliveryEvidence === undefined ? null : { op: opParam, deliveryEvidence }
      break
    }
  }
  return json({ result } satisfies BrokerEventsQueryResponse)
}

function parseNonNegativeInt(url: URL, name: string): number {
  const raw = requireParam(url, name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${name} must be an integer >= 0`,
      {
        field: name,
      }
    )
  }
  return value
}

function toWireRecord(
  record: HrcBrokerInvocationEventRecord,
  runtimeId: string
): BrokerEventWireRecord {
  if (record.id === undefined) {
    throw new HrcInternalError('broker event row has no commit ordinal', { runtimeId })
  }
  const { id, evidenceOrigin, ...rest } = record
  return { ...rest, commitOrdinal: id, evidenceOrigin: evidenceOrigin ?? 'live' }
}

export const SUBSCRIBER_NAME_HEADER = 'x-hrc-subscriber-name'

function parseFollowLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return 100
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'limit must be an integer between 1 and 1000',
      { field: 'limit' }
    )
  }
  return value
}

/**
 * `GET /v1/broker-events/follow` — bounded newer-or-equal commit page for a
 * named delivery consumer (T-08608). The `x-hrc-subscriber-name` header is
 * required and must name a declared admission: absent and undeclared are both
 * 400. A named consumer asking for retained rows is refused (400) — delivery
 * consumers cannot launder retained evidence. Every served page heartbeats
 * the named admission through the existing consumer-receipt accounting.
 */
export async function handleBrokerEventsFollow(
  this: HrcServerInstanceForHandlers,
  request: Request,
  url: URL
): Promise<Response> {
  const name = request.headers.get(SUBSCRIBER_NAME_HEADER)?.trim() ?? ''
  if (name.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${SUBSCRIBER_NAME_HEADER} is required: follow is a named delivery-consumer read`,
      { field: SUBSCRIBER_NAME_HEADER }
    )
  }
  const admission = this.subscriberAdmissions.findByName(name)
  const entry = this.subscriberAdmissions
    .snapshot()
    .active.find((candidate) => candidate.subscriberId === admission?.subscriberId)
  if (admission === undefined || entry?.route !== 'broker-events') {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_SELECTOR,
      `subscriber "${name}" is not declared for broker-events follow`,
      { field: SUBSCRIBER_NAME_HEADER }
    )
  }
  const includeRetained = parseIncludeRetained(url)
  if (includeRetained) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_FENCE,
      'includeRetained is refused for named delivery consumers',
      { field: 'includeRetained' }
    )
  }
  const afterCommit = parseNonNegativeInt(url, 'afterCommit')
  const limit = parseFollowLimit(url)
  const rows = this.db.brokerInvocationEvents.listBrokerEventsAfterCommit({
    afterCommit,
    limit,
    includeRetained: false,
  })
  const events = rows.map((row) => toWireRecord(row, row.runtimeId))
  const nextCommit = events.at(-1)?.commitOrdinal ?? afterCommit
  // Heartbeat: the served page is both produced and consumed — the named
  // admission's stream-accepted head advances through the existing accounting.
  admission.recordEnqueued(nextCommit, null)
  admission.recordStreamAccepted(nextCommit, null)
  return json({ events, nextCommit } satisfies BrokerEventsFollowResponse)
}

/**
 * `POST /v1/server/subscribers` — declares a named delivery consumer
 * (T-08608). Idempotent: re-declaring an open name returns the existing
 * admission rather than minting a duplicate.
 */
export async function handleDeclareSubscriber(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (!isRecord(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  if (name.length === 0 || name.length > 128) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'name must be a non-empty string of at most 128 characters',
      { field: 'name' }
    )
  }
  const route = body['route'] ?? 'broker-events'
  if (route !== 'events' && route !== 'broker-events') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'route must be "events" or "broker-events"',
      { field: 'route' }
    )
  }
  const receiptMode = body['receiptMode'] ?? 'none'
  if (receiptMode !== 'none' && receiptMode !== 'consumer-ack-v1') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'receiptMode must be "none" or "consumer-ack-v1"',
      { field: 'receiptMode' }
    )
  }
  const existing = this.subscriberAdmissions.findByName(name)
  const existingEntry = this.subscriberAdmissions
    .snapshot()
    .active.find((candidate) => candidate.subscriberId === existing?.subscriberId)
  if (existing !== undefined && existingEntry?.route === route) {
    return json({
      subscriberId: existing.subscriberId,
      name,
      route,
      receiptMode: existing.receiptMode,
      ...(existing.receiptToken !== undefined ? { receiptToken: existing.receiptToken } : {}),
    } satisfies SubscriberDeclareResponse)
  }
  const admission = this.subscriberAdmissions.open({
    route,
    selector: { subscriberName: name },
    receiptMode,
    name,
    openedAt: new Date().toISOString(),
  })
  return json({
    subscriberId: admission.subscriberId,
    name,
    route,
    receiptMode: admission.receiptMode,
    ...(admission.receiptToken !== undefined ? { receiptToken: admission.receiptToken } : {}),
  } satisfies SubscriberDeclareResponse)
}

export const evidenceHandlersMethods = {
  handleEventsHead,
  handleBrokerEventsQuery,
  handleBrokerEventsFollow,
  handleDeclareSubscriber,
}

export type EvidenceHandlersMethods = typeof evidenceHandlersMethods
