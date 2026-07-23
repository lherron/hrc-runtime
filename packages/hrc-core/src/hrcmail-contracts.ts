/**
 * hrcmail — durable embedded-envelope contracts.
 *
 * The mailbox is deliberately separate from hrcchat history. These DTOs are
 * shared by the SQLite owner, daemon routes, SDK, and the hrcmail CLI.
 */

import type { HrcRuntimeIntent } from './contracts.js'

export const HRC_MAIL_REPLY_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
export const HRC_MAIL_REPLY_SCHEMA_MAX_BYTES = 64 * 1024

export type HrcMailEnvelopeState = 'pending' | 'presented' | 'acked' | 'deferred' | 'dead'

export type HrcMailPayloadKind = 'request' | 'conversational'

export type HrcMailActor =
  | { kind: 'scope'; sessionRef: string }
  | { kind: 'operator'; principal: string }

export type HrcMailPayload = {
  kind: HrcMailPayloadKind
  body: string
  metadata?: Record<string, unknown> | undefined
}

export type HrcMailReplySchema = Record<string, unknown>

export type HrcMailEnvelope = {
  envelopeId: string
  ingressId: string
  from: HrcMailActor
  targetSessionRef: string
  payload: HrcMailPayload
  replySchema?: HrcMailReplySchema | undefined
  state: HrcMailEnvelopeState
  roundCount: number
  response?: unknown
  deferReason?: string | undefined
  retryAt?: string | undefined
  presentedAt?: string | undefined
  ackedAt?: string | undefined
  deferredAt?: string | undefined
  deadAt?: string | undefined
  terminalActor?: HrcMailActor | undefined
  createdAt: string
  updatedAt: string
}

export type HrcMailIngressPath = 'mail' | 'v1_inline'

export type HrcMailReceipt = {
  ingressId: string
  envelopeId: string
  path: HrcMailIngressPath
  createdAt: string
}

export type HrcMailSendRequest = {
  ingressId: string
  from: HrcMailActor
  targetSessionRef: string
  payload: HrcMailPayload
  replySchema?: HrcMailReplySchema | undefined
  /**
   * Persist-only materialization hint used by the kicker when the target scope
   * has never been born. Ingress never acts on it; the kicker is the sole
   * consumer and enters the normal summon gate before provisioning.
   */
  materializationIntent?: HrcRuntimeIntent | undefined
}

export type HrcMailSendResponse = {
  receipt: HrcMailReceipt
  envelope: HrcMailEnvelope
}

export type HrcMailInboxRequest = {
  actor: HrcMailActor
  targetSessionRef: string
}

export type HrcMailInboxResponse = {
  envelopes: HrcMailEnvelope[]
}

export type HrcMailAckRequest = {
  actor: HrcMailActor
  envelopeIds: string[]
  response?: unknown
}

export type HrcMailDispositionOutcome = 'applied' | 'idempotent'

export type HrcMailDispositionResult = {
  outcome: HrcMailDispositionOutcome
  envelope: HrcMailEnvelope
}

export type HrcMailAckResponse = {
  results: HrcMailDispositionResult[]
}

export type HrcMailDeferRequest = {
  actor: HrcMailActor
  envelopeId: string
  reason: string
  retryAfterMs?: number | undefined
}

export type HrcMailDeferResponse = HrcMailDispositionResult

export type HrcMailCatRequest = {
  envelopeId: string
}

export type HrcMailCatResponse = {
  envelope: HrcMailEnvelope
}

export type HrcMailListRequest = {
  targetSessionRef?: string | undefined
  state?: HrcMailEnvelopeState | undefined
  dead?: boolean | undefined
  limit?: number | undefined
}

export type HrcMailListResponse = {
  envelopes: HrcMailEnvelope[]
}
