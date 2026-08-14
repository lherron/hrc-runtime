/**
 * VENDORED CONFORMANCE FIXTURE — do not hand-edit to make a test pass.
 *
 * Verbatim copy of ACP's `parseAcpWebhookEvent`, the parser that stands between
 * this emitter and ACP's jobs inbox. HRC's repo-split boundary check bars
 * importing `acp-core` directly (scripts/check-boundaries.ts), so conformance is
 * proven against a pinned copy instead.
 *
 * Provenance:
 *   agent-control-plane packages/acp-core/src/webhook/acp-event.ts
 *   last changed at c267871f5aaa4412166ab082c24990febeed7bad
 *   vendored from tree f0107cd52cab931d04e11b4e95390337a790993a (2026-08-14)
 *
 * The point of vendoring the PARSER rather than writing a fake is the known
 * false-green trap: a stand-in more permissive than the real parser passes
 * envelopes that ACP would reject with a 400, and the emitter looks green on
 * both sides while nothing is ever ingested. The companion test therefore
 * asserts this fixture's REJECTIONS as well as its acceptances — the rejection
 * cases are the ones a permissive fake silently loses. Only the wrkq adapter
 * (irrelevant to HRC) and the exported type surface are omitted.
 *
 * Re-vendor when ACP's parser changes; the law's `reopen_when` covers exactly
 * that ("the ACP event envelope ... changes").
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type VendoredAcpWebhookOrigin = {
  actor?: string | undefined
  kind?: 'human' | 'agent' | 'system' | undefined
  run_id?: string | null | undefined
  causation_ref?: string | undefined
  via?: string | undefined
  [key: string]: unknown
}

export type VendoredAcpWebhookSubject = {
  type: string
  id?: string | undefined
  [key: string]: unknown
}

export type VendoredAcpWebhookEvent = {
  schema_version: 1
  source: string
  event_id: string
  canonical_event_id: string
  event_seq: number
  event: string
  occurred_at?: string | undefined
  origin?: VendoredAcpWebhookOrigin | undefined
  subject?: VendoredAcpWebhookSubject | undefined
  payload: Readonly<Record<string, unknown>>
}

export type VendoredParseResult =
  | { ok: true; event: VendoredAcpWebhookEvent }
  | { ok: false; error: string }

const SUPPORTED_SCHEMA_VERSION = 1
const SOURCE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/

function actorKind(actor: string): 'human' | 'agent' | 'system' | undefined {
  const idx = actor.indexOf(':')
  const kind = idx === -1 ? actor : actor.slice(0, idx)
  return kind === 'human' || kind === 'agent' || kind === 'system' ? kind : undefined
}

function parseOrigin(value: unknown): VendoredAcpWebhookOrigin | undefined | string {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'origin must be an object'
  }
  const actor = value['actor']
  const kind = value['kind']
  const causationRef = value['causation_ref']
  if (actor !== undefined && typeof actor !== 'string') {
    return 'origin.actor must be a string when present'
  }
  if (kind !== undefined && kind !== 'human' && kind !== 'agent' && kind !== 'system') {
    return "origin.kind must be 'human', 'agent', or 'system' when present"
  }
  if (causationRef !== undefined && typeof causationRef !== 'string') {
    return 'origin.causation_ref must be a string when present'
  }
  return {
    ...value,
    ...(typeof actor === 'string' ? { actor } : {}),
    ...(typeof causationRef === 'string' ? { causation_ref: causationRef } : {}),
    ...(kind === 'human' || kind === 'agent' || kind === 'system'
      ? { kind }
      : typeof actor === 'string' && actorKind(actor) !== undefined
        ? { kind: actorKind(actor) }
        : {}),
  } as VendoredAcpWebhookOrigin
}

function parseSubject(value: unknown): VendoredAcpWebhookSubject | undefined | string {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    return 'subject must be an object'
  }
  const type = value['type']
  if (typeof type !== 'string' || type.trim().length === 0) {
    return 'subject.type is required when subject is present'
  }
  const id = value['id']
  if (id !== undefined && typeof id !== 'string') {
    return 'subject.id must be a string when present'
  }
  return {
    ...value,
    type,
    ...(typeof id === 'string' ? { id } : {}),
  } as VendoredAcpWebhookSubject
}

export function vendoredCanonicalAcpEventId(source: string, eventId: string): string {
  return `${source}:${eventId}`
}

export function vendoredParseAcpWebhookEvent(body: unknown): VendoredParseResult {
  if (!isRecord(body)) {
    return { ok: false, error: 'webhook body must be a JSON object' }
  }

  const schemaVersion = body['schema_version']
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported schema_version: ${String(schemaVersion)} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    }
  }

  const source = body['source']
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return {
      ok: false,
      error: 'source must match /^[a-z][a-z0-9._-]{0,79}$/',
    }
  }

  const eventId = body['event_id']
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'event_id is required' }
  }

  const eventSeq = body['event_seq']
  if (typeof eventSeq !== 'number' || !Number.isInteger(eventSeq) || eventSeq < 0) {
    return { ok: false, error: 'event_seq must be a non-negative integer' }
  }

  const event = body['event']
  if (typeof event !== 'string' || event.trim().length === 0) {
    return { ok: false, error: 'event is required' }
  }

  const occurredAt = body['occurred_at']
  if (occurredAt !== undefined && typeof occurredAt !== 'string') {
    return { ok: false, error: 'occurred_at must be a string when present' }
  }

  const origin = parseOrigin(body['origin'])
  if (typeof origin === 'string') {
    return { ok: false, error: origin }
  }

  const subject = parseSubject(body['subject'])
  if (typeof subject === 'string') {
    return { ok: false, error: subject }
  }

  const payload = body['payload']
  if (payload !== undefined && !isRecord(payload)) {
    return { ok: false, error: 'payload must be an object when present' }
  }

  const canonicalEventId = vendoredCanonicalAcpEventId(source, eventId)
  const canonicalFromBody = body['canonical_event_id']
  if (canonicalFromBody !== undefined && canonicalFromBody !== canonicalEventId) {
    return { ok: false, error: 'canonical_event_id does not match source:event_id' }
  }

  return {
    ok: true,
    event: {
      schema_version: SUPPORTED_SCHEMA_VERSION,
      source,
      event_id: eventId,
      canonical_event_id: canonicalEventId,
      event_seq: eventSeq,
      event,
      ...(typeof occurredAt === 'string' ? { occurred_at: occurredAt } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(subject !== undefined ? { subject } : {}),
      payload: (payload ?? {}) as Record<string, unknown>,
    },
  }
}

/** True when ACP's default agent-origin deny would apply to this event. */
export function vendoredIsAgentOriginEvent(event: VendoredAcpWebhookEvent): boolean {
  const actor = event.origin?.actor
  if (typeof actor === 'string' && actor.startsWith('agent:')) {
    return true
  }
  return event.origin?.kind === 'agent'
}
