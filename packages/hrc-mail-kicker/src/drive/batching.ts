import type { HrcMailAutoReplyCandidate } from 'hrc-store-sqlite'

import { envelopeReplyAddressee } from '../ledger/presentation.js'
import type { WrkqEnvelope } from '../ledger/types.js'

function senderIdentity(envelope: WrkqEnvelope): string {
  return envelope.from.scopeRef?.trim() || envelope.from.principalRef.trim()
}

/** Stable identity shared by one presentation input and its automatic reply. */
export function presentationKeyFor(envelope: WrkqEnvelope): string | undefined {
  const counterpartyRef = envelopeReplyAddressee(envelope)
  if (counterpartyRef === undefined) return undefined
  return JSON.stringify([
    envelope.roomKey,
    senderIdentity(envelope),
    counterpartyRef,
    envelope.groupId ?? envelope.id,
  ])
}

/** Select the exact pending fan-out group eligible for one automatic reply. */
export function autoReplyCandidateFor(
  envelopes: readonly WrkqEnvelope[]
): HrcMailAutoReplyCandidate | undefined {
  const first = envelopes[0]
  if (first === undefined || envelopes.some((envelope) => envelope.state !== 'pending')) {
    return undefined
  }
  const presentationKey = presentationKeyFor(first)
  if (presentationKey === undefined) return undefined
  const groupId = first.groupId ?? first.id
  const counterpartyRef = envelopeReplyAddressee(first)
  if (counterpartyRef === undefined) return undefined
  if (envelopes.some((envelope) => presentationKeyFor(envelope) !== presentationKey)) {
    return undefined
  }
  return {
    sourceRef: envelopes.length === 1 ? first.id : groupId,
    sourceEnvelopeIds: envelopes.map((envelope) => envelope.id),
    roomKey: first.roomKey,
    counterpartyRef,
  }
}
