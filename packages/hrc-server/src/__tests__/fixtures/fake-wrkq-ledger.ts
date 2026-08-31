import type { WrkqLedgerClient } from '../../wrkq/ledger-client.js'
import { WrkqLedgerRequestError, WrkqLedgerUnavailableError } from '../../wrkq/ledger-client.js'
import { newestPresentationReceipt } from '../../wrkq/ledger-types.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopeBirth,
  WrkqEnvelopeBirthEnvelopeParams,
  WrkqEnvelopeFailParams,
  WrkqEnvelopeObligation,
  WrkqEnvelopePendingView,
  WrkqEnvelopePendingViewParams,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
  WrkqEnvelopeShowParams,
  WrkqMonitorEventsView,
  WrkqMonitorEventsViewParams,
  WrkqRoomLogView,
  WrkqRoomLogViewParams,
  WrkqRoomSayParams,
  WrkqRoomSayResult,
  WrkqRoomShowParams,
  WrkqRoomView,
} from '../../wrkq/ledger-types.js'

/**
 * A wrkq collaboration ledger, standing in for wrkqd.
 *
 * It reproduces the CONTRACT wrkqd publishes rather than a convenient subset —
 * `present` is exactly-once per `driveAttemptId`, `historyHint` is keyed to the
 * RUNTIME and not the generation, a `fyi` auto-acks at its own presentation,
 * `blocking` names only what was actually presented, and `fail` REFUSES a
 * runtime that does not own the newest receipt, refuses `legacy`, and gates
 * `undeliverable` to a `pending` row. Those are the behaviours HRC's kicker
 * leans on, so a double that faked them would prove nothing.
 *
 * PAIRED AGAINST THE REAL SERVER, not against this file's own idea of the wire
 * (T-07704, mini's wrkqd at wrkq 88b133a). Three things came back from that
 * pairing that a hand-written double would have got wrong, and every one of
 * them is load-bearing here:
 *
 *  - the envelope wire carries NO `roundCount` any more, and `failureReason`
 *    only on a failed row;
 *  - `envelope.failed` payload is `{state, reason, room_uuid[, runtime_id]}` —
 *    it does NOT carry the envelope id, which lives on the event row's
 *    `resource_id`, so the fake emits `resourceId` and the §5 notice reads it
 *    from there;
 *  - a runtime that does not own the newest receipt is refused with
 *    `WRKQ_CONFLICT` rather than silently failing someone else's presentation.
 */

let nextEnvelopeSeq = 0

export type SeedEnvelope = {
  toScopeRef: string
  fromScopeRef?: string
  fromPrincipalRef?: string
  body?: string
  obligation?: WrkqEnvelopeObligation
  roomKey?: string
  roomKind?: WrkqEnvelope['roomKind']
  materializationIntent?: string
}

export class FakeWrkqLedger implements WrkqLedgerClient {
  readonly envelopes = new Map<string, WrkqEnvelope>()
  readonly rooms = new Map<string, WrkqRoomView>()
  readonly events: {
    id: number
    eventType: string
    payload: string
    resourceId?: string | undefined
  }[] = []
  /** Every (envelope, runtime) pair already presented, for the history cue. */
  private readonly runtimesSeenPerRoom = new Map<string, Set<string>>()
  readonly attemptReceipts = new Set<string>()
  private eventSeq = 0
  unavailable = false
  presentCalls = 0
  readonly presentRequests: WrkqEnvelopePresentParams[] = []
  readonly failRequests: WrkqEnvelopeFailParams[] = []
  readonly roomSayRequests: WrkqRoomSayParams[] = []
  roomLogCalls = 0

  say(seed: SeedEnvelope): WrkqEnvelope {
    nextEnvelopeSeq += 1
    const id = `EN-${String(nextEnvelopeSeq).padStart(5, '0')}`
    const roomKey = seed.roomKey ?? 'T-07615'
    const now = new Date().toISOString()
    const envelope: WrkqEnvelope = {
      uuid: `uuid-${id}`,
      id,
      roomUuid: `room-${roomKey}`,
      roomKey,
      roomKind: seed.roomKind ?? 'task',
      from: {
        principalRef: seed.fromPrincipalRef ?? 'agent:mable',
        ...(seed.fromScopeRef === undefined ? {} : { scopeRef: seed.fromScopeRef }),
      },
      to: { principalRef: 'agent:kicker-proof', scopeRef: seed.toScopeRef },
      obligation: seed.obligation ?? 'reply_required',
      body: seed.body ?? 'prove the durable kicker',
      state: 'pending',
      terminal: false,
      ...(seed.materializationIntent === undefined
        ? {}
        : { materializationIntent: seed.materializationIntent }),
      presentedTo: [],
      createdAt: now,
      updatedAt: now,
    }
    this.envelopes.set(id, envelope)
    this.eventSeq += 1
    this.events.push({
      id: this.eventSeq,
      eventType: 'envelope.created',
      resourceId: id,
      payload: JSON.stringify({
        id,
        room_uuid: envelope.roomUuid,
        obligation: envelope.obligation,
        state: 'pending',
        from_principal_ref: envelope.from.principalRef,
        to_scope_ref: seed.toScopeRef,
        ...(seed.materializationIntent === undefined
          ? {}
          : { materialization_intent: seed.materializationIntent }),
      }),
    })
    return envelope
  }

  /** The reply that discharges an obligation. wrkq derives this from a say. */
  ack(envelopeId: string): void {
    const envelope = this.envelopes.get(envelopeId)
    if (envelope === undefined) return
    envelope.state = 'acked'
    envelope.terminal = true
  }

  /**
   * The reader's own hold. `wrkc defer` writes the reason and a retry promise;
   * the reason SURVIVES the re-pend (wrkq clears `retry_at`, never
   * `defer_reason`), which is what lets D6's pointer form quote it back.
   */
  defer(envelopeId: string, reason: string, retryAt?: string): void {
    const envelope = this.envelopes.get(envelopeId)
    if (envelope === undefined) return
    envelope.state = 'deferred'
    envelope.deferReason = reason
    if (retryAt !== undefined) envelope.retryAt = retryAt
  }

  /** The retry promise firing: back to `pending` with `presented_to` intact. */
  repend(envelopeId: string): void {
    const envelope = this.envelopes.get(envelopeId)
    if (envelope === undefined || envelope.state !== 'deferred') return
    envelope.state = 'pending'
    envelope.retryAt = undefined
  }

  private guard(method: string): void {
    if (this.unavailable) {
      throw new WrkqLedgerUnavailableError('fake wrkq is unreachable', method)
    }
  }

  /** wrkq matches on the SCOPE; HRC passes its session ref with the lane intact. */
  private matchesScope(envelope: WrkqEnvelope, scopes: readonly string[]): boolean {
    const to = envelope.to?.scopeRef
    if (to === undefined) return false
    return scopes.some((scope) => scope.split('/lane:')[0] === to.split('/lane:')[0])
  }

  async pendingView(params: WrkqEnvelopePendingViewParams): Promise<WrkqEnvelopePendingView> {
    this.guard('wrkq.envelope.pendingView')
    const scopes = params.scopes ?? []
    // T-07627: `includeFyi` widens `items` only. `blocking` stays reply_required
    // and presented, because an unobliged envelope is auto-acked at its own
    // presentation.
    //
    // T-07746: `notify` rides the widened read exactly as `fyi` does. The
    // PARAM keeps its `includeFyi` spelling on purpose — renaming it was a
    // rollout hazard (wrkq silently ignores unknown RPC keys, so an old HRC
    // sending the old name would be given a DIFFERENT read), and the rename
    // belongs to T-07745.
    const obligations =
      params.includeFyi === true ? ['reply_required', 'notify', 'fyi'] : ['reply_required']
    const items = [...this.envelopes.values()].filter(
      (envelope) =>
        obligations.includes(envelope.obligation) &&
        (envelope.state === 'pending' || envelope.state === 'presented') &&
        this.matchesScope(envelope, scopes)
    )
    return {
      items,
      blocking: items
        .filter((e) => e.obligation === 'reply_required' && e.state === 'presented')
        .map((e) => e.id),
      repended: 0,
    }
  }

  /**
   * T-07655 — the birth envelope: the LOWEST-seq SUMMONING row addressed to the
   * scope, in ANY state. The fake reproduces the real rule rather than "the
   * oldest pending one", because state-independence is the whole property a
   * designation rests on.
   *
   * T-07746 widened the candidate set from `reply_required` alone to
   * `reply_required | notify`: a scope's birth designation may now come from an
   * envelope that owes nothing. That is sound because the designation is only a
   * PLACEMENT input and the sender is read off the ledger row either way, so no
   * caller gains steering it did not have. A legacy `fyi` is still excluded —
   * those rows were written when they could not summon.
   */
  async birthEnvelope(params: WrkqEnvelopeBirthEnvelopeParams): Promise<WrkqEnvelopeBirth | null> {
    this.guard('wrkq.envelope.birthEnvelope')
    const candidates = [...this.envelopes.values()]
      .filter(
        (envelope) =>
          (envelope.obligation === 'reply_required' || envelope.obligation === 'notify') &&
          envelope.to?.scopeRef === params.scopeRef
      )
      .sort((a, b) => a.id.localeCompare(b.id))
    const first = candidates[0]
    if (first === undefined) return null
    return {
      envelopeId: first.id,
      seq: Number(first.id.slice(3)),
      from: {
        principalRef: first.from.principalRef,
        ...(first.from.scopeRef === undefined ? {} : { scopeRef: first.from.scopeRef }),
      },
    }
  }

  async present(params: WrkqEnvelopePresentParams): Promise<WrkqEnvelopePresentResult> {
    this.guard('wrkq.envelope.present')
    this.presentCalls += 1
    this.presentRequests.push({ ...params })
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)

    const receiptKey = `${params.driveAttemptId ?? ''}:${envelope.id}`
    const alreadyRecorded =
      params.driveAttemptId !== undefined && this.attemptReceipts.has(receiptKey)

    // Keyed to the RUNTIME: /quit clears continuation without rotating the
    // generation, so a new runtime in the same generation reads cold.
    const seen = this.runtimesSeenPerRoom.get(envelope.roomUuid) ?? new Set<string>()
    const runtimeKey = params.runtimeId ?? params.hostSessionId ?? 'unknown'
    const messageCount = [...this.envelopes.values()].filter(
      (candidate) => candidate.roomUuid === envelope.roomUuid
    ).length
    const historyHint = messageCount > 1 && !seen.has(runtimeKey)

    if (params.preview !== true && !alreadyRecorded) {
      if (params.driveAttemptId !== undefined) this.attemptReceipts.add(receiptKey)
      envelope.presentedTo.push({
        memberRef: params.memberRef ?? envelope.to?.scopeRef ?? '',
        ...(params.node === undefined ? {} : { node: params.node }),
        ...(params.runtimeId === undefined ? {} : { runtimeId: params.runtimeId }),
        ...(params.hostSessionId === undefined ? {} : { hostSessionId: params.hostSessionId }),
        ...(params.generation === undefined ? {} : { generation: params.generation }),
        ...(params.runId === undefined ? {} : { runId: params.runId }),
        ...(params.inputId === undefined ? {} : { inputId: params.inputId }),
        ...(params.driveAttemptId === undefined ? {} : { driveAttemptId: params.driveAttemptId }),
        // Stored opaquely and never validated, exactly as wrkq does it: the
        // steer class is HRC's vocabulary and the ledger does not learn it.
        ...(params.deliveryOutcome === undefined
          ? {}
          : { deliveryOutcome: params.deliveryOutcome }),
        presentedAt: new Date().toISOString(),
      })
      // A TERMINAL envelope keeps its state: wrkq's `present` re-asserts the
      // current state when `IsEnvelopeTerminal`, so a receipt never resurrects
      // a failed or acked row.
      if (envelope.state === 'pending') envelope.state = 'presented'
      // T-07746: anything that does not OWE a reply is terminal at its own
      // presentation — `notify` and the legacy `fyi` alike. Without this a
      // delivered notify would sit in `presented`, which HRC reads as an
      // obligation regardless of token, arming a reminder and eventually
      // failing it as ignored.
      if (envelope.obligation !== 'reply_required' && !envelope.terminal) {
        envelope.state = 'acked'
        envelope.terminal = true
      }
      seen.add(runtimeKey)
      this.runtimesSeenPerRoom.set(envelope.roomUuid, seen)
    }

    return {
      envelope,
      recorded: params.preview === true ? false : !alreadyRecorded,
      historyHint,
      messageCount,
      lastMessageAt: envelope.createdAt,
    }
  }

  /**
   * rev 5.1's unsuccessful terminal transition, with wrkqd's own refusals.
   *
   * The refusals are the point. HRC calls this from three places that can all
   * observe a stale view — a completed attempt, a lifecycle wake, and a
   * backstop sweep — so a double that accepted every call would let a bug
   * through that the real server catches on the wire.
   */
  async fail(params: WrkqEnvelopeFailParams): Promise<WrkqEnvelope> {
    this.guard('wrkq.envelope.fail')
    this.failRequests.push({ ...params })
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    if (params.runtime !== undefined) {
      const newest = newestPresentationReceipt(envelope)
      if (newest === undefined || newest.runtimeId !== params.runtime) {
        throw new WrkqLedgerRequestError(
          'envelope runtime does not own the newest presentation',
          'wrkq.envelope.fail',
          -32021,
          { code: 'WRKQ_CONFLICT', envelope: envelope.id, runtime: params.runtime }
        )
      }
    }
    if (envelope.state === 'failed') return envelope
    const wantedFrom =
      params.reason === 'undeliverable' ? 'pending' : ('presented' as WrkqEnvelope['state'])
    if (envelope.state !== wantedFrom) {
      throw new WrkqLedgerRequestError('wrong_state', 'wrkq.envelope.fail', -32028, {
        code: 'WRKQ_WRONG_STATE',
        envelope: envelope.id,
        state: envelope.state,
        verb: 'fail',
      })
    }
    envelope.state = 'failed'
    envelope.terminal = true
    envelope.failureReason = params.reason
    this.eventSeq += 1
    this.events.push({
      id: this.eventSeq,
      eventType: 'envelope.failed',
      resourceId: envelope.id,
      payload: JSON.stringify({
        state: 'failed',
        reason: params.reason,
        room_uuid: envelope.roomUuid,
        ...(params.runtime === undefined ? {} : { runtime_id: params.runtime }),
      }),
    })
    return envelope
  }

  async envelopeShow(params: WrkqEnvelopeShowParams): Promise<WrkqEnvelope> {
    this.guard('wrkq.envelope.show')
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    return envelope
  }

  async roomShow(params: WrkqRoomShowParams): Promise<WrkqRoomView> {
    this.guard('wrkq.room.show')
    const room = this.rooms.get(params.room)
    if (room === undefined) throw new Error(`unknown room ${params.room}`)
    return room
  }

  async roomLog(params: WrkqRoomLogViewParams): Promise<WrkqRoomLogView> {
    this.guard('wrkq.room.logView')
    this.roomLogCalls += 1
    const items = [...this.envelopes.values()].filter(
      (envelope) => envelope.roomKey === params.room || envelope.roomUuid === params.room
    )
    const first = items[0]
    const room =
      this.rooms.get(params.room) ??
      (first === undefined ? undefined : { key: first.roomKey, kind: first.roomKind })
    if (room === undefined) throw new Error(`unknown room ${params.room}`)
    const limited =
      params.limit === undefined || params.limit <= 0 ? items : items.slice(-params.limit)
    return { room, items: limited }
  }

  async roomSay(params: WrkqRoomSayParams): Promise<WrkqRoomSayResult> {
    this.guard('wrkq.room.say')
    this.roomSayRequests.push({
      ...params,
      to: params.to === undefined ? undefined : [...params.to],
    })
    if (
      params.idempotencyKey !== undefined &&
      [...this.envelopes.values()].some(
        (envelope) =>
          envelope.from.principalRef === params.principalRef &&
          envelope.idempotencyKey === params.idempotencyKey
      )
    ) {
      // The production refusal is intentionally untyped for rev 6. HRC must
      // classify it by reading the room, never by inspecting this error.
      throw new WrkqLedgerRequestError('idempotency key already used', 'wrkq.room.say', -32000, {
        message: 'duplicate',
      })
    }
    const roomKey = params.ref ?? 'R-auto-reply'
    const existing = [...this.envelopes.values()].find((envelope) => envelope.roomKey === roomKey)
    const roomKind = existing?.roomKind ?? 'adhoc'
    const room = this.rooms.get(roomKey) ?? { key: roomKey, kind: roomKind }
    this.rooms.set(roomKey, room)
    nextEnvelopeSeq += 1
    const id = `EN-${String(nextEnvelopeSeq).padStart(5, '0')}`
    const now = new Date().toISOString()
    const toToken = params.to?.[0]
    const toPrincipal = `agent:${toToken?.split('@')[0] ?? 'unknown'}`
    const envelope: WrkqEnvelope = {
      uuid: `uuid-${id}`,
      id,
      roomUuid: existing?.roomUuid ?? `room-${roomKey}`,
      roomKey,
      roomKind,
      groupId: id,
      from: {
        principalRef: params.principalRef ?? 'agent:hrc',
        ...(params.scopeRef === undefined ? {} : { scopeRef: params.scopeRef }),
      },
      to:
        toToken === undefined
          ? null
          : {
              principalRef: toPrincipal,
              ...(toToken.includes('@') ? { scopeRef: toToken } : {}),
            },
      ...(toToken === undefined ? {} : { replyTo: params.scopeRef ?? params.principalRef }),
      obligation: toToken === undefined ? 'none' : params.fyi === true ? 'fyi' : 'reply_required',
      body: params.body.trim(),
      state: toToken === undefined ? 'acked' : 'pending',
      terminal: toToken === undefined,
      ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
      meta: params.meta ?? {},
      presentedTo: [],
      createdAt: now,
      updatedAt: now,
    }
    this.envelopes.set(id, envelope)

    const acked: string[] = []
    for (const candidate of this.envelopes.values()) {
      if (
        candidate.id !== id &&
        candidate.roomKey === roomKey &&
        candidate.state === 'presented' &&
        candidate.to?.scopeRef === params.scopeRef &&
        (candidate.from.scopeRef === toToken || candidate.from.principalRef === toPrincipal)
      ) {
        candidate.state = 'acked'
        candidate.terminal = true
        acked.push(candidate.id)
      }
    }
    return { room, groupId: id, envelopes: [envelope], acked }
  }

  async eventsView(params: WrkqMonitorEventsViewParams): Promise<WrkqMonitorEventsView> {
    this.guard('wrkq.monitor.eventsView')
    if (params.lastN !== undefined && params.lastN > 0) {
      const last = this.events[this.events.length - 1]
      return { items: [], highWater: last === undefined ? 0 : Math.max(last.id - 1, 0) }
    }
    const page = this.events
      .filter((event) => event.id > params.cursor)
      .slice(0, params.limit ?? 200)
    const wanted = params.eventTypes
    return {
      items: page
        .filter((event) => wanted === undefined || wanted.includes(event.eventType))
        .map((event) => ({
          id: event.id,
          timestamp: new Date().toISOString(),
          resourceType: 'envelope',
          // The REAL row carries the envelope id here and not in the payload;
          // the §5 notice reads it from exactly this field.
          ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
          eventType: event.eventType,
          payload: event.payload,
        })),
      highWater: page.length === 0 ? params.cursor : (page[page.length - 1]?.id ?? params.cursor),
    }
  }

  async close(): Promise<void> {}
}
