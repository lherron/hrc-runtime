/**
 * The wrkq collaboration ledger, as HRC sees it (T-07612 §2, §10).
 *
 * wrkq owns rooms and envelopes; HRC is a consumer and never the owner. These
 * declarations are therefore a deliberate STRUCTURAL SUBSET of the wrkq DTOs —
 * exactly the fields the kicker, the §7 presentation, and the stop-hook read.
 * They are not a second spelling of `@wrkq/client`: taking that dependency
 * would pin hrc-server to a protocol schema hash and make a wrkq release able
 * to take the HRC daemon down, which is the failure wave 1 hit on its own
 * consumers (T-07613, "I installed consumers before the server").
 *
 * Envelope ids are `EN-\d{5}` — NOT `EV-`, which wrkq had already minted for
 * evidence items (mable's erratum on T-07612, C-16371). The id is internal: the
 * injected presentation never shows it.
 */

export type WrkqEnvelopeObligation = 'reply_required' | 'fyi' | 'none'

export type WrkqEnvelopeState = 'pending' | 'presented' | 'acked' | 'deferred' | 'failed'

/**
 * Why an obligation ended without a reply (rev 5.1 §2).
 *
 * `legacy` is written ONLY by wrkq's flag-day migration, for rows that were
 * `dead` under rev 4 rounds. HRC never writes it and `wrkq.envelope.fail`
 * refuses it; it is declared here because HRC READS it off a migrated row.
 */
export type WrkqEnvelopeFailureReason =
  | 'runtime_terminated'
  | 'ignored'
  | 'undeliverable'
  | 'legacy'

export type WrkqRoomKind = 'campaign' | 'task' | 'project' | 'adhoc'

/** One end of an envelope. `scopeRef` is absent for a scope-less principal (a human). */
export type WrkqEnvelopeParty = {
  principalRef: string
  scopeRef?: string | undefined
}

/** One presentation receipt: the join between wrkq's ledger and HRC's execution world. */
export type WrkqEnvelopePresentation = {
  memberRef: string
  node?: string | undefined
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  generation?: string | undefined
  runId?: string | undefined
  /** Broker input accepted for this presentation, when the delivery class has one. */
  inputId?: string | undefined
  driveAttemptId?: string | undefined
  /** HRC's own class for HOW this delivery landed; wrkq never validates it. */
  deliveryOutcome?: string | undefined
  presentedAt: string
}

export type WrkqEnvelope = {
  uuid: string
  /** `EN-xxxxx`. */
  id: string
  roomUuid: string
  /** A room's ADDRESSING TOKEN is its key, not its id: derived rooms have no id. */
  roomKey: string
  roomKind: WrkqRoomKind
  groupId?: string | undefined
  from: WrkqEnvelopeParty
  to: WrkqEnvelopeParty | null
  obligation: WrkqEnvelopeObligation
  body: string
  taskId?: string | undefined
  state: WrkqEnvelopeState
  terminal: boolean
  /** Present only on a `failed` row. */
  failureReason?: WrkqEnvelopeFailureReason | undefined
  /**
   * The reader's OWN words when they deferred (rev 5.1 §4). It survives the
   * retry promise firing, which is what lets the defer-retry pointer form quote
   * the reason back rather than re-pushing a body nobody asked for again.
   */
  deferReason?: string | undefined
  /** When a deferral's retry promise is due. */
  retryAt?: string | undefined
  /** HRC birth directives, stored verbatim by wrkq and parsed here at kick time. */
  materializationIntent?: string | undefined
  presentedTo: WrkqEnvelopePresentation[]
  createdAt: string
  updatedAt: string
}

export type WrkqRoomShowParams = {
  room: string
  principalRef?: string | undefined
}

/**
 * The subset of a room HRC renders. The ledger's room surface is the agent's,
 * through `wrkc`.
 */
export type WrkqRoomView = {
  key: string
  kind: WrkqRoomKind
}

export type WrkqEnvelopePendingViewParams = {
  scopes?: string[] | undefined
  /**
   * Include pending `fyi` rows in `items` (T-07627). `blocking` is unchanged:
   * a fyi is auto-acked at its own presentation and never gates a turn end.
   */
  includeFyi?: boolean | undefined
  principalRef?: string | undefined
  scopeRef?: string | undefined
}

/**
 * T-07655 — the birth-envelope request. It carries the TARGET scope and
 * nothing else on purpose: the sender is read off the ledger row, so no caller
 * can steer which node a virgin scope is born on.
 */
export type WrkqEnvelopeBirthEnvelopeParams = {
  scopeRef: string
}

/**
 * The lowest-seq `reply_required` envelope ever addressed to a scope, in any
 * state. A null result means nothing has ever fired at it — fyi never summons.
 *
 * As everywhere in ledger-types.ts this is the STRUCTURAL SUBSET HRC reads, not
 * wrkq's whole DTO; additive change on the wrkq side is tolerated by design.
 */
export type WrkqEnvelopeBirth = {
  envelopeId: string
  seq: number
  from: {
    principalRef: string
    scopeRef?: string | undefined
  }
}

/** The kicker wake set AND the stop-hook predicate in one read model. */
export type WrkqEnvelopePendingView = {
  items: WrkqEnvelope[]
  /** Envelope ids actually PRESENTED and left neither replied nor deferred. */
  blocking: string[]
  /** How many due deferrals this read's sweep returned to pending. */
  repended: number
}

export type WrkqEnvelopePresentParams = {
  envelope: string
  /** Compute the presentation result without writing a receipt or auto-acking a fyi. */
  preview?: boolean | undefined
  memberRef?: string | undefined
  node?: string | undefined
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  generation?: string | undefined
  runId?: string | undefined
  /** Broker input accepted for this presentation, when the delivery class has one. */
  inputId?: string | undefined
  /** One drive attempt presents an envelope exactly once. */
  driveAttemptId?: string | undefined
  /**
   * The T-07203 outcome class for a steer, written DURABLY on the receipt
   * rather than only on a log line (T-07638 added the field; T-07644 C-16658
   * ruled that the class belongs on the presentation, per C-16526).
   *
   * wrkq stores it opaquely and never validates the vocabulary, which is the
   * right split: the class is HRC's execution vocabulary and the ledger is not
   * the place to teach it. Absent stays null on the receipt, so an ordinary
   * kicker-driven presentation carries nothing here and only a steer does.
   */
  deliveryOutcome?: string | undefined
  principalRef?: string | undefined
}

export type WrkqEnvelopePresentResult = {
  envelope: WrkqEnvelope
  /** False when this drive attempt had already presented the envelope. */
  recorded: boolean
  /**
   * The §7 `history:` cue decision, keyed to the RUNTIME and not the
   * generation: `/quit` clears continuation without rotating the generation, so
   * every post-quit runtime reads cold and gets the cue.
   */
  historyHint: boolean
  messageCount: number
  /**
   * The wire field is `lastMessageAt`. Spelling it `lastMessage` here once cost
   * the `history:` line its "last 2h ago" clause silently, and no fixture could
   * have caught it: a double written from this same declaration agrees with the
   * mistake. Only the real server disagrees.
   */
  lastMessageAt?: string | undefined
}

/**
 * The unsuccessful terminal transition (rev 5.1 §2, D3/D5/D7).
 *
 * `runtime` names the runtime HRC is failing the obligation ON, and wrkqd
 * REFUSES the call unless that runtime owns the envelope's newest presentation
 * receipt (`WRKQ_CONFLICT`, retryable). That refusal is the ledger enforcing D2
 * on HRC's behalf: a node cannot fail an obligation that has since been
 * presented somewhere else. Repeating the same (envelope, runtime) failure is
 * an idempotent read of the terminal row.
 *
 * `undeliverable` is the one reason that carries no runtime: it fails a
 * `pending` envelope that was never presented at all.
 */
export type WrkqEnvelopeFailParams = {
  envelope: string
  reason: Exclude<WrkqEnvelopeFailureReason, 'legacy'>
  runtime?: string | undefined
  principalRef?: string | undefined
}

export type WrkqEnvelopeShowParams = {
  envelope: string
  principalRef?: string | undefined
}

/**
 * The receipt that BINDS the obligation, per rev 5.1 D2/D3: the newest one.
 *
 * `>=` on the comparison so a tie resolves to the LAST row, which matches
 * wrkqd's own `ORDER BY presented_at DESC, rowid DESC` — and wrkq's receipts
 * carry a second-resolution timestamp, so two inside one second is the ordinary
 * shape of a replayed commit rather than an exotic case. Getting the tie wrong
 * would make `fail{runtime}` name the older runtime and be REFUSED by the
 * ledger, which is the safe direction but a silent one.
 */
export function newestPresentationReceipt(
  envelope: Pick<WrkqEnvelope, 'presentedTo'>
): WrkqEnvelopePresentation | undefined {
  let newest: WrkqEnvelopePresentation | undefined
  let newestAt = Number.NEGATIVE_INFINITY
  for (const receipt of envelope.presentedTo) {
    const at = Date.parse(receipt.presentedAt)
    const rank = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
    if (rank >= newestAt) {
      newestAt = rank
      newest = receipt
    }
  }
  return newest
}

/**
 * The numeric tail of an `EN-xxxxx` id.
 *
 * The stop-hook's "reset the refusal count when new mail arrives" rule needs a
 * monotonic marker for "newest obligation I have already refused over". wrkq's
 * envelope sequence is not exposed, but EN ids are minted in order, so their
 * numeric tail is the same marker.
 */
export function envelopeIdSequence(envelopeId: string): number {
  const match = /^EN-(\d+)$/.exec(envelopeId.trim())
  if (match?.[1] === undefined) return 0
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

// ── The event tail HRC's kicker wakes on ─────────────────────────────────────

/**
 * One row of wrkq's event ledger.
 *
 * `envelope.created` is the kicker's wake signal (T-07612 §10). It arrives on
 * the SAME stream as `task.*` and `container.*` — §3.4's whole point — which is
 * why HRC follows it the way any other consumer follows a room, rather than
 * standing up an inbound webhook surface on every node (mable's erratum, T-07615
 * C-16400).
 */
export type WrkqMonitorEvent = {
  id: number
  timestamp: string
  resourceType: string
  resourceUuid?: string | undefined
  resourceId?: string | undefined
  eventType: string
  /** A JSON document, carried as a string by the ledger. */
  payload?: string | undefined
}

export type WrkqMonitorEventsView = {
  items: WrkqMonitorEvent[]
  /**
   * The id of the LAST RAW ROW SCANNED, not the last matched one, so a caller
   * that carries it forward never re-scans an event it already advanced past.
   */
  highWater: number
}

export type WrkqMonitorEventsViewParams = {
  /** ALWAYS explicit: a read with no cursor replays the log (T-07620). */
  cursor: number
  eventTypes?: string[] | undefined
  limit?: number | undefined
  /** Resolves a start cursor from row identity instead of returning a page. */
  lastN?: number | undefined
  principalRef?: string | undefined
}

/**
 * The `envelope.failed` payload, as the real wrkqd writes it.
 *
 * Paired against mini's wrkqd at wrkq 88b133a before this declaration was
 * written: the payload carries `{state, reason, room_uuid}` plus `runtime_id`
 * when the failure named one, and NOTHING ELSE. In particular it does NOT carry
 * the envelope id, the room KEY, or either party — the id is on the event row's
 * `resource_id`, and the rest is an `envelope.show` away. The §5 sender notice
 * therefore reads the row back rather than rendering from the payload, which is
 * exactly the mistake a fixture written from this file could not have caught.
 */
export type WrkqEnvelopeFailedPayload = {
  state?: string
  reason?: string
  room_uuid?: string
  runtime_id?: string
}

/** The fields of an `envelope.created` payload that decide where a wake goes. */
export type WrkqEnvelopeCreatedPayload = {
  id?: string
  to_scope_ref?: string
  to_principal_ref?: string
  obligation?: string
  materialization_intent?: string
}
