import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

/**
 * Address-level and incarnation-level durable state for the selected-address
 * host participant policy (host-participant-lifecycle contract rev 5 §5.2).
 *
 * The two entities are deliberately separate rows. A reservation exists before
 * any incarnation and outlives every one of them; a binding names exactly one
 * application-process lifetime. Neither is a state of the other.
 */

export type ParticipantReservationState = 'held' | 'released'

export type ParticipantAddressReservation = {
  reservationId: string
  /**
   * Absent for a classless direct join (R6.2). A configured class selects
   * delivery defaults; it is not what makes an address reservable, so an
   * address reserved without one stores no class rather than a placeholder.
   */
  classId?: string | undefined
  scopeRef: string
  laneRef: string
  /**
   * Established through `establishLocalPlacement`, never merely resolved. It
   * equals the collective registry binding's home node, which is what makes a
   * reservation a claim on an address the collective has actually bound.
   */
  homeNodeId: string
  state: ParticipantReservationState
  createdAt: string
  updatedAt: string
  releasedAt?: string | undefined
  releasedBy?: string | undefined
  releaseReason?: string | undefined
}

export type ParticipantHostBindingState = 'BINDING' | 'BOUND' | 'DETACHED' | 'RETIRING' | 'RETIRED'

export type ParticipantHostBinding = {
  bindingId: string
  reservationId: string
  registrationId: string
  /** Host-issued, opaque to HRC: never parsed for a PID, a path or a time. */
  hostIncarnationId: string
  hostSessionId: string
  generation: number
  /** Incarnation-scoped per P-6.1.a; every attempt of this binding copies it. */
  runtimeId: string
  state: ParticipantHostBindingState
  predecessorBindingId?: string | undefined
  admittedAt: string
  updatedAt: string
  boundAt?: string | undefined
  retiredAt?: string | undefined
  /** The verbatim `WriterEvidence` that authorized entering `RETIRING`. */
  retirementReceiptJson?: string | undefined
  dispositionReason?: string | undefined
}

/**
 * §5.2.3. Every path out of a binding leaves the reservation held; no binding
 * transition releases an address. `DETACHED` is explicitly not host death, so
 * it returns to `BOUND` on the same incarnation's reattach rather than
 * requiring a succession.
 */
const bindingTransitions: Readonly<
  Record<ParticipantHostBindingState, readonly ParticipantHostBindingState[]>
> = {
  BINDING: ['BOUND', 'RETIRED'],
  BOUND: ['DETACHED', 'RETIRING', 'RETIRED'],
  DETACHED: ['BOUND', 'RETIRING', 'RETIRED'],
  RETIRING: ['RETIRED'],
  RETIRED: [],
}

const INCARNATION_HOLDING_STATES = "('BINDING', 'BOUND')"

export function allowsParticipantHostBindingTransition(
  from: ParticipantHostBindingState,
  to: ParticipantHostBindingState
): boolean {
  return bindingTransitions[from].includes(to)
}

type ReservationRow = {
  reservation_id: string
  class_id: string | null
  scope_ref: string
  lane_ref: string
  home_node_id: string
  state: ParticipantReservationState
  created_at: string
  updated_at: string
  released_at: string | null
  released_by: string | null
  release_reason: string | null
}

type BindingRow = {
  binding_id: string
  reservation_id: string
  registration_id: string
  host_incarnation_id: string
  host_session_id: string
  generation: number
  runtime_id: string
  state: ParticipantHostBindingState
  predecessor_binding_id: string | null
  admitted_at: string
  updated_at: string
  bound_at: string | null
  retired_at: string | null
  retirement_receipt_json: string | null
  disposition_reason: string | null
}

const RESERVATION_COLUMNS = `
  reservation_id, class_id, scope_ref, lane_ref, home_node_id, state,
  created_at, updated_at, released_at, released_by, release_reason`

const BINDING_COLUMNS = `
  binding_id, reservation_id, registration_id, host_incarnation_id, host_session_id,
  generation, runtime_id, state, predecessor_binding_id, admitted_at, updated_at,
  bound_at, retired_at, retirement_receipt_json, disposition_reason`

function mapReservation(row: ReservationRow): ParticipantAddressReservation {
  return {
    reservationId: row.reservation_id,
    ...(row.class_id === null ? {} : { classId: row.class_id }),
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    homeNodeId: row.home_node_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
    ...(row.released_by === null ? {} : { releasedBy: row.released_by }),
    ...(row.release_reason === null ? {} : { releaseReason: row.release_reason }),
  }
}

function mapBinding(row: BindingRow): ParticipantHostBinding {
  return {
    bindingId: row.binding_id,
    reservationId: row.reservation_id,
    registrationId: row.registration_id,
    hostIncarnationId: row.host_incarnation_id,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    runtimeId: row.runtime_id,
    state: row.state,
    ...(row.predecessor_binding_id === null
      ? {}
      : { predecessorBindingId: row.predecessor_binding_id }),
    admittedAt: row.admitted_at,
    updatedAt: row.updated_at,
    ...(row.bound_at === null ? {} : { boundAt: row.bound_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.retirement_receipt_json === null
      ? {}
      : { retirementReceiptJson: row.retirement_receipt_json }),
    ...(row.disposition_reason === null ? {} : { dispositionReason: row.disposition_reason }),
  }
}

/** The binding states that occupy an address's one live slot (§5.2.2). */
const LIVE_BINDING_STATES = "('BINDING', 'BOUND', 'DETACHED', 'RETIRING')"

export class ParticipantHostBindingRepository {
  constructor(private readonly db: Database) {}

  insertReservation(record: ParticipantAddressReservation): ParticipantAddressReservation {
    execute(
      this.db,
      `INSERT INTO participant_address_reservations (${RESERVATION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.reservationId,
      record.classId ?? null,
      record.scopeRef,
      record.laneRef,
      record.homeNodeId,
      record.state,
      record.createdAt,
      record.updatedAt,
      record.releasedAt ?? null,
      record.releasedBy ?? null,
      record.releaseReason ?? null
    )
    return record
  }

  getReservationByAddress(scopeRef: string, laneRef: string): ParticipantAddressReservation | null {
    const row = this.db
      .query<ReservationRow, [string, string]>(
        `SELECT ${RESERVATION_COLUMNS} FROM participant_address_reservations
         WHERE scope_ref = ? AND lane_ref = ?`
      )
      .get(scopeRef, laneRef)
    return row === null ? null : mapReservation(row)
  }

  getReservationById(reservationId: string): ParticipantAddressReservation | null {
    const row = this.db
      .query<ReservationRow, [string]>(
        `SELECT ${RESERVATION_COLUMNS} FROM participant_address_reservations
         WHERE reservation_id = ?`
      )
      .get(reservationId)
    return row === null ? null : mapReservation(row)
  }

  /**
   * R-4.3.1's storage half: does this exact address carry a held reservation?
   *
   * The question is asked by scope and lane alone, with no reference to runtime
   * status, session status or binding state — an absent external host is
   * exactly a terminated runtime whose address must survive, so consulting a
   * runtime here would answer the wrong question.
   */
  hasHeldReservationForScope(scopeRef: string): boolean {
    const row = this.db
      .query<{ held: number }, [string]>(
        `SELECT COUNT(*) AS held FROM participant_address_reservations
         WHERE scope_ref = ? AND state = 'held'`
      )
      .get(scopeRef)
    return (row?.held ?? 0) > 0
  }

  listReservationsByClassId(classId: string): ParticipantAddressReservation[] {
    return this.db
      .query<ReservationRow, [string]>(
        `SELECT ${RESERVATION_COLUMNS} FROM participant_address_reservations
         WHERE class_id = ? ORDER BY created_at`
      )
      .all(classId)
      .map(mapReservation)
  }

  /**
   * The one and only release. It is explicit, attributed and reasoned, and it
   * is never reachable from eviction, stop, terminal or GC (R-4.3.4).
   */
  releaseReservation(input: {
    reservationId: string
    releasedBy: string
    reason: string
    now: string
  }): boolean {
    const result = this.db
      .query(
        `UPDATE participant_address_reservations
            SET state = 'released', released_at = ?, released_by = ?, release_reason = ?,
                updated_at = ?
          WHERE reservation_id = ? AND state = 'held'`
      )
      .run(input.now, input.releasedBy, input.reason, input.now, input.reservationId)
    return result.changes > 0
  }

  insertBinding(record: ParticipantHostBinding): ParticipantHostBinding {
    execute(
      this.db,
      `INSERT INTO participant_host_bindings (${BINDING_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.bindingId,
      record.reservationId,
      record.registrationId,
      record.hostIncarnationId,
      record.hostSessionId,
      record.generation,
      record.runtimeId,
      record.state,
      record.predecessorBindingId ?? null,
      record.admittedAt,
      record.updatedAt,
      record.boundAt ?? null,
      record.retiredAt ?? null,
      record.retirementReceiptJson ?? null,
      record.dispositionReason ?? null
    )
    return record
  }

  getBindingById(bindingId: string): ParticipantHostBinding | null {
    const row = this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings WHERE binding_id = ?`
      )
      .get(bindingId)
    return row === null ? null : mapBinding(row)
  }

  getBindingByHostIncarnationId(hostIncarnationId: string): ParticipantHostBinding | null {
    const row = this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings WHERE host_incarnation_id = ?`
      )
      .get(hostIncarnationId)
    return row === null ? null : mapBinding(row)
  }

  /** Only a binding being established or established counts as this incarnation's held address. */
  getLiveBindingByHostIncarnationId(hostIncarnationId: string): ParticipantHostBinding | null {
    const row = this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings
         WHERE host_incarnation_id = ? AND state IN ${INCARNATION_HOLDING_STATES}`
      )
      .get(hostIncarnationId)
    return row === null ? null : mapBinding(row)
  }

  /** The at-most-one incarnation currently occupying this address's live slot. */
  getLiveBindingByReservationId(reservationId: string): ParticipantHostBinding | null {
    const row = this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings
         WHERE reservation_id = ? AND state IN ${LIVE_BINDING_STATES}`
      )
      .get(reservationId)
    return row === null ? null : mapBinding(row)
  }

  listBindingsByReservationId(reservationId: string): ParticipantHostBinding[] {
    return this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings
         WHERE reservation_id = ? ORDER BY admitted_at`
      )
      .all(reservationId)
      .map(mapBinding)
  }

  getBindingByRegistrationId(registrationId: string): ParticipantHostBinding | null {
    const row = this.db
      .query<BindingRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM participant_host_bindings
         WHERE registration_id = ? AND state IN ${LIVE_BINDING_STATES}`
      )
      .get(registrationId)
    return row === null ? null : mapBinding(row)
  }

  /**
   * Compare-and-set on the binding's own state. The `from` set is always given
   * by the caller so a re-driven replacement cannot silently move a binding it
   * did not observe, and a refused move is reported rather than thrown — §5.3.1
   * requires a re-run after TX-D to read a refused from-state as "already
   * done", not as an error.
   */
  transitionBinding(input: {
    bindingId: string
    from: readonly ParticipantHostBindingState[]
    to: ParticipantHostBindingState
    now: string
    retirementReceiptJson?: string | undefined
    dispositionReason?: string | undefined
  }): boolean {
    const current = this.getBindingById(input.bindingId)
    if (current === null) return false
    if (!input.from.includes(current.state)) return false
    if (!allowsParticipantHostBindingTransition(current.state, input.to)) return false
    if (input.to === 'RETIRING') {
      const receipt = input.retirementReceiptJson ?? current.retirementReceiptJson
      if (receipt === undefined || receipt.trim().length === 0) return false
    }
    if (input.to === 'RETIRED') {
      const reason = input.dispositionReason ?? current.dispositionReason
      if (reason === undefined || reason.trim().length === 0) return false
    }
    const placeholders = input.from.map(() => '?').join(', ')
    const result = this.db
      .query(
        `UPDATE participant_host_bindings
            SET state = ?,
                updated_at = ?,
                bound_at = CASE WHEN ? = 'BOUND' AND bound_at IS NULL THEN ? ELSE bound_at END,
                retired_at = CASE WHEN ? = 'RETIRED' THEN ? ELSE retired_at END,
                retirement_receipt_json = COALESCE(?, retirement_receipt_json),
                disposition_reason = COALESCE(?, disposition_reason)
          WHERE binding_id = ? AND state IN (${placeholders})`
      )
      .run(
        input.to,
        input.now,
        input.to,
        input.now,
        input.to,
        input.now,
        input.retirementReceiptJson ?? null,
        input.dispositionReason ?? null,
        input.bindingId,
        ...input.from
      )
    return result.changes > 0
  }
}
