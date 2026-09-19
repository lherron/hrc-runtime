import { HrcBadRequestError, HrcErrorCode, HrcInternalError, HrcNotFoundError } from 'hrc-core'
import type {
  BrokerEventWireRecord,
  BrokerEventsFollowResponse,
  BrokerEventsQueryResponse,
  BrokerEventsQueryResult,
  EventsHeadResponse,
  HrcBrokerInvocationEventRecord,
} from 'hrc-core'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody } from './server-parsers.js'
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

/** `POST /v1/broker-events/follow` — bounded newer-or-equal commit page. */
export async function handleBrokerEventsFollow(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = await parseJsonBody(request)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const record = body as Record<string, unknown>
  const { afterCommit, limit, includeRetained } = parseFollowBody(record)
  const rows = this.db.brokerInvocationEvents.listBrokerEventsAfterCommit({
    afterCommit,
    limit,
    ...(includeRetained ? { includeRetained } : {}),
  })
  const events = rows.map((row) => toWireRecord(row, row.runtimeId))
  const nextCommit = events.length === 0 ? afterCommit : events[events.length - 1]!.commitOrdinal
  return json({ events, nextCommit } satisfies BrokerEventsFollowResponse)
}

function parseFollowBody(record: Record<string, unknown>): {
  afterCommit: number
  limit: number
  includeRetained: boolean
} {
  const { afterCommit, limit, includeRetained } = record
  if (typeof afterCommit !== 'number' || !Number.isInteger(afterCommit) || afterCommit < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'afterCommit must be an integer >= 0',
      { field: 'afterCommit' }
    )
  }
  let resolvedLimit = 100
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'limit must be an integer between 1 and 1000',
        { field: 'limit' }
      )
    }
    resolvedLimit = limit
  }
  if (includeRetained !== undefined && typeof includeRetained !== 'boolean') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'includeRetained must be a boolean',
      { field: 'includeRetained' }
    )
  }
  return { afterCommit, limit: resolvedLimit, includeRetained: includeRetained === true }
}

export const evidenceHandlersMethods = {
  handleEventsHead,
  handleBrokerEventsQuery,
  handleBrokerEventsFollow,
}

export type EvidenceHandlersMethods = typeof evidenceHandlersMethods
