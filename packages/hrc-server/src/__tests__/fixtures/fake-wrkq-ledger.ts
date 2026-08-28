import type { WrkqLedgerClient } from '../../wrkq/ledger-client.js'
import { WrkqLedgerUnavailableError } from '../../wrkq/ledger-client.js'
import type {
  WrkqEnvelope,
  WrkqEnvelopeBirth,
  WrkqEnvelopeBirthEnvelopeParams,
  WrkqEnvelopeObligation,
  WrkqEnvelopePendingView,
  WrkqEnvelopePendingViewParams,
  WrkqEnvelopePresentParams,
  WrkqEnvelopePresentResult,
  WrkqEnvelopeRoundParams,
  WrkqMonitorEventsView,
  WrkqMonitorEventsViewParams,
  WrkqRoomShowParams,
  WrkqRoomView,
} from '../../wrkq/ledger-types.js'

/**
 * A wrkq collaboration ledger, standing in for wrkqd.
 *
 * It reproduces the CONTRACT wave 1 published rather than a convenient subset —
 * `present` is exactly-once per `driveAttemptId`, `historyHint` is keyed to the
 * RUNTIME and not the generation, a `fyi` auto-acks at its own presentation,
 * `blocking` names only what was actually presented, and `roundEnded` advances
 * only a still-presented envelope. Those are the behaviours HRC's kicker leans
 * on, so a double that faked them would prove nothing.
 *
 * Verified against the live surface in the wave-1 rehearsal
 * (`smoke-wait-and-hrc-surface.txt`, T-07613).
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
  readonly events: { id: number; eventType: string; payload: string }[] = []
  /** Every (envelope, runtime) pair already presented, for the history cue. */
  private readonly runtimesSeenPerRoom = new Map<string, Set<string>>()
  readonly attemptReceipts = new Set<string>()
  private eventSeq = 0
  unavailable = false
  presentCalls = 0
  readonly presentRequests: WrkqEnvelopePresentParams[] = []
  roundEndedCalls: string[] = []

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
      roundCount: 0,
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
    // and presented, because a fyi is auto-acked at its own presentation.
    const obligations = params.includeFyi === true ? ['reply_required', 'fyi'] : ['reply_required']
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
   * T-07655 — the birth envelope: the LOWEST-seq `reply_required` row addressed
   * to the scope, in ANY state. The fake reproduces the real rule rather than
   * "the oldest pending one", because state-independence is the whole property
   * a designation rests on.
   */
  async birthEnvelope(params: WrkqEnvelopeBirthEnvelopeParams): Promise<WrkqEnvelopeBirth | null> {
    this.guard('wrkq.envelope.birthEnvelope')
    const candidates = [...this.envelopes.values()]
      .filter(
        (envelope) =>
          envelope.obligation === 'reply_required' && envelope.to?.scopeRef === params.scopeRef
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
      if (envelope.state === 'pending') envelope.state = 'presented'
      // A fyi is auto-acked at its OWN presentation and never summons again.
      if (envelope.obligation === 'fyi') {
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

  async roundEnded(params: WrkqEnvelopeRoundParams): Promise<WrkqEnvelope> {
    this.guard('wrkq.envelope.roundEnded')
    this.roundEndedCalls.push(params.envelope)
    const envelope = this.envelopes.get(params.envelope)
    if (envelope === undefined) throw new Error(`unknown envelope ${params.envelope}`)
    if (envelope.state !== 'presented') return envelope
    envelope.roundCount += 1
    if (envelope.roundCount >= (params.maxRounds ?? 5)) {
      envelope.state = 'dead'
      envelope.terminal = true
    }
    return envelope
  }

  async roomShow(params: WrkqRoomShowParams): Promise<WrkqRoomView> {
    this.guard('wrkq.room.show')
    const room = this.rooms.get(params.room)
    if (room === undefined) throw new Error(`unknown room ${params.room}`)
    return room
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
          eventType: event.eventType,
          payload: event.payload,
        })),
      highWater: page.length === 0 ? params.cursor : (page[page.length - 1]?.id ?? params.cursor),
    }
  }

  async close(): Promise<void> {}
}
