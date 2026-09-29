import type { Database } from 'bun:sqlite'
import { HrcConflictError } from 'hrc-core'

/**
 * T-08576 D5 (rev 8): run ids are one database-wide namespace, and a runtime or
 * steer contribution that names a run as active is a mutation handle every
 * finalizer trusts. An app birth reserves its run id; the run's authority is
 * then the exact tuple {runId, runtimeId, operationId, hostSessionId,
 * generation}. Before the run is sealed (its row bound to a runtime) only the
 * reservation token may establish that tuple; afterwards the persisted row is
 * the authority. Host-session equality alone is never authority.
 */
export class RunIdReservedError extends HrcConflictError {
  constructor(runId: string) {
    super('run_mismatch', `run id "${runId}" is reserved by another app session birth`, {
      reason: 'run-id-reserved',
      runId,
    })
    this.name = 'RunIdReservedError'
  }
}

export class RunIdOwnershipError extends HrcConflictError {
  constructor(runId: string, refusal: string) {
    super('run_mismatch', `run id "${runId}" is not owned by this writer`, {
      reason: 'run-id-not-owned',
      runId,
      refusal,
    })
    this.name = 'RunIdOwnershipError'
  }
}

export type RunIdReservationOutcome = 'reserved' | 'exists' | 'reserved-by-other'

/** The writer tuple a run-id handle write would establish. */
export type RunHandleWriter = {
  runtimeId?: string | undefined
  operationId?: string | undefined
  hostSessionId: string
  generation: number
}

type RunIdReservation = {
  token: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  operationId?: string | undefined
}

type RunTupleRow = {
  host_session_id: string
  generation: number
  runtime_id: string | null
  operation_id: string | null
  scope_ref: string
}

export class RunIdOwnershipRegistry {
  readonly #reservations = new Map<string, RunIdReservation>()
  #tokenReader: (runId: string) => string | undefined = () => undefined

  constructor(private readonly db: Database) {}

  /**
   * Installs the carrier of the holder's reservation token. The daemon supplies
   * one that answers only inside the owner context holding a grant for exactly
   * that run id; the tuple checks below still bind whatever it returns.
   */
  setReservationTokenReader(reader: (runId: string) => string | undefined): void {
    this.#tokenReader = reader
  }

  reserveRunId(
    runId: string,
    token: string,
    hostSessionId: string,
    generation: number
  ): RunIdReservationOutcome {
    const held = this.#reservations.get(runId)
    if (held !== undefined) return held.token === token ? 'reserved' : 'reserved-by-other'
    if (this.#handleExists(runId)) return 'exists'
    this.#reservations.set(runId, { token, hostSessionId, generation })
    return 'reserved'
  }

  releaseRunId(runId: string, token: string): void {
    if (this.#reservations.get(runId)?.token === token) this.#reservations.delete(runId)
  }

  reservationFor(runId: string): string | undefined {
    return this.#reservations.get(runId)?.token
  }

  /** True when a reservation, run row or run-id handle already names the id. */
  isNamed(runId: string): boolean {
    return this.#reservations.has(runId) || this.#handleExists(runId)
  }

  /** Guard for creating a run row; unreserved ids insert exactly as before. */
  assertCanCreateRun(runId: string, writer: RunHandleWriter): void {
    const reservation = this.#reservations.get(runId)
    if (reservation === undefined) return
    const refusal = this.#tokenRefusal(reservation, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
    this.#bind(reservation, writer)
  }

  /** Guard for a runtime or contribution naming `runId` as its active run. */
  assertCanNameActiveRun(runId: string | undefined, writer: RunHandleWriter): void {
    if (runId === undefined) return
    const refusal = this.#handleRefusal(runId, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
  }

  /** Steer contributions carry no runtime or operation tuple: never for app runs. */
  assertContributionMayNameRun(runId: string): void {
    if (this.#reservations.has(runId)) throw new RunIdReservedError(runId)
    if (this.#row(runId)?.scope_ref.startsWith('app:') === true) {
      throw new RunIdOwnershipError(runId, 'contribution-cannot-name-app-run')
    }
  }

  /**
   * Token-free projection predicate (clauses B/C). Broker event projection is
   * never inside the issuing context, so it may only follow the persisted row.
   */
  mayNameActiveRun(runId: string, writer: RunHandleWriter): boolean {
    return this.#handleRefusal(runId, writer, undefined) === undefined
  }

  /** Write-once binding columns of a reserved or app run (runs.update, claimQueued). */
  assertRunBindingUpdate(
    runId: string,
    patch: {
      runtimeId?: string | undefined
      operationId?: string | undefined
      hostSessionId?: string | undefined
      generation?: number | undefined
    }
  ): void {
    if (
      patch.runtimeId === undefined &&
      patch.operationId === undefined &&
      patch.hostSessionId === undefined &&
      patch.generation === undefined
    ) {
      return
    }
    const reservation = this.#reservations.get(runId)
    const row = this.#row(runId)
    if (row === null) return
    if (reservation === undefined && !row.scope_ref.startsWith('app:')) return
    if (patch.hostSessionId !== undefined && patch.hostSessionId !== row.host_session_id) {
      throw new RunIdOwnershipError(runId, 'host-session-immutable')
    }
    if (patch.generation !== undefined && patch.generation !== row.generation) {
      throw new RunIdOwnershipError(runId, 'generation-immutable')
    }
    if (
      patch.operationId !== undefined &&
      row.operation_id !== null &&
      patch.operationId !== row.operation_id
    ) {
      throw new RunIdOwnershipError(runId, 'operation-immutable')
    }
    if (
      patch.runtimeId !== undefined &&
      row.runtime_id !== null &&
      patch.runtimeId !== row.runtime_id
    ) {
      throw new RunIdOwnershipError(runId, 'runtime-immutable')
    }
    const runtimeFill = patch.runtimeId !== undefined && row.runtime_id === null
    const operationFill = patch.operationId !== undefined && row.operation_id === null
    if (!runtimeFill && !operationFill) return
    // Every first binding of a tuple column is clause (A): only the holder's
    // live token, for the reserved tuple. Once sealed the token is unobtainable,
    // so a late first binding is refused too.
    if (reservation === undefined) {
      throw new RunIdOwnershipError(runId, 'unbound-without-reservation')
    }
    const writer: RunHandleWriter = {
      runtimeId: patch.runtimeId ?? row.runtime_id ?? undefined,
      operationId: patch.operationId ?? row.operation_id ?? undefined,
      hostSessionId: row.host_session_id,
      generation: row.generation,
    }
    const refusal = this.#tokenRefusal(reservation, writer, this.#tokenReader(runId))
    if (refusal === 'no-token') throw new RunIdReservedError(runId)
    if (refusal !== undefined) throw new RunIdOwnershipError(runId, refusal)
    this.#bind(reservation, writer)
  }

  #handleRefusal(
    runId: string,
    writer: RunHandleWriter,
    token: string | undefined
  ): string | undefined {
    const reservation = this.#reservations.get(runId)
    const row = this.#row(runId)
    // (C) neither reserved nor an app run: unchanged.
    if (reservation === undefined && (row === null || !row.scope_ref.startsWith('app:'))) {
      return undefined
    }
    const sealed = row !== null && row.runtime_id !== null
    if (!sealed) {
      // (A) token, unsealed only.
      if (reservation === undefined) return 'unbound-without-reservation'
      const refusal = this.#tokenRefusal(reservation, writer, token)
      if (refusal === undefined) this.#bind(reservation, writer)
      return refusal
    }
    // (B) exact persisted tuple.
    if (writer.runtimeId !== row.runtime_id) return 'runtime-mismatch'
    if (writer.hostSessionId !== row.host_session_id) return 'host-session-mismatch'
    if (writer.generation !== row.generation) return 'generation-mismatch'
    if (row.operation_id !== null && writer.operationId !== row.operation_id) {
      return 'operation-mismatch'
    }
    return undefined
  }

  #tokenRefusal(
    reservation: RunIdReservation,
    writer: RunHandleWriter,
    token: string | undefined
  ): string | undefined {
    if (token !== reservation.token) return 'no-token'
    if (writer.hostSessionId !== reservation.hostSessionId) return 'host-session-mismatch'
    if (writer.generation !== reservation.generation) return 'generation-mismatch'
    if (reservation.runtimeId !== undefined && writer.runtimeId !== reservation.runtimeId) {
      return 'runtime-mismatch'
    }
    if (
      reservation.operationId !== undefined &&
      writer.operationId !== undefined &&
      writer.operationId !== reservation.operationId
    ) {
      return 'operation-mismatch'
    }
    return undefined
  }

  #bind(reservation: RunIdReservation, writer: RunHandleWriter): void {
    if (reservation.runtimeId === undefined && writer.runtimeId !== undefined) {
      reservation.runtimeId = writer.runtimeId
    }
    if (reservation.operationId === undefined && writer.operationId !== undefined) {
      reservation.operationId = writer.operationId
    }
  }

  #row(runId: string): RunTupleRow | null {
    return this.db
      .query<RunTupleRow, [string]>(
        'SELECT host_session_id, generation, runtime_id, operation_id, scope_ref FROM runs WHERE run_id = ?'
      )
      .get(runId)
  }

  #handleExists(runId: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string, string]>(
          `SELECT EXISTS (SELECT 1 FROM runs WHERE run_id = ?)
               OR EXISTS (SELECT 1 FROM runtimes WHERE active_run_id = ?)
               OR EXISTS (SELECT 1 FROM steer_contributions WHERE active_run_id = ?) AS found`
        )
        .get(runId, runId, runId)?.found === 1
    )
  }
}
