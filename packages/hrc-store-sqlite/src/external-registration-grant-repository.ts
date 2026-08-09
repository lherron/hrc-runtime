import type { Database } from 'bun:sqlite'

import { execute } from './migrations/types.js'

export type ExternalRegistrationGrant = {
  registrationId: string
  classId: string
  derivedScope: string
  socketPath: string
  credentialHash: string
  expiresAt: string
  consumed: boolean
  turnsAllowed: boolean
  provisioner: Record<string, unknown>
  createdAt: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  operationId?: string | undefined
  invocationId?: string | undefined
  attachTokenRef?: string | undefined
  controllerInstanceId?: string | undefined
  establishmentState?: 'DELIVERY_PENDING' | 'ESTABLISHED' | undefined
  capabilities?: Record<string, unknown> | undefined
  participantInfo?: Record<string, unknown> | undefined
  establishedAt?: string | undefined
  retiredAt?: string | undefined
  retirementReason?: 'external_registration_gc' | undefined
}

export type ExternalRegistrationMint = {
  hostSessionId: string
  runtimeId: string
  operationId: string
  invocationId: string
  attachTokenRef: string
  controllerInstanceId: string
  capabilities: Record<string, unknown>
  participantInfo: Record<string, unknown>
}

export type IssueExternalRegistrationGrantResult =
  | { outcome: 'issued'; grant: ExternalRegistrationGrant }
  | { outcome: 'instances-exhausted'; occupied: number }

type ExternalRegistrationGrantRow = {
  registration_id: string
  class_id: string
  derived_scope: string
  socket_path: string
  credential_hash: string
  expires_at: string
  consumed: number
  turns_allowed: number
  provisioner_json: string
  created_at: string
  host_session_id: string | null
  runtime_id: string | null
  operation_id: string | null
  invocation_id: string | null
  attach_token_ref: string | null
  controller_instance_id: string | null
  establishment_state: 'DELIVERY_PENDING' | 'ESTABLISHED' | null
  capabilities_json: string | null
  participant_info_json: string | null
  established_at: string | null
  retired_at: string | null
  retirement_reason: 'external_registration_gc' | null
}

const COLUMNS = `
  registration_id,
  class_id,
  derived_scope,
  socket_path,
  credential_hash,
  expires_at,
  consumed,
  turns_allowed,
  provisioner_json,
  created_at,
  host_session_id,
  runtime_id,
  operation_id,
  invocation_id,
  attach_token_ref,
  controller_instance_id,
  establishment_state,
  capabilities_json,
  participant_info_json,
  established_at,
  retired_at,
  retirement_reason`

function parseRecordJson(value: string | null, label: string): Record<string, unknown> | undefined {
  if (value === null) return undefined
  const parsed = JSON.parse(value) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`)
  }
  return parsed as Record<string, unknown>
}

function mapRow(row: ExternalRegistrationGrantRow): ExternalRegistrationGrant {
  const provisioner = JSON.parse(row.provisioner_json) as unknown
  if (typeof provisioner !== 'object' || provisioner === null || Array.isArray(provisioner)) {
    throw new Error(`registration grant ${row.registration_id} has invalid provisioner metadata`)
  }
  return {
    registrationId: row.registration_id,
    classId: row.class_id,
    derivedScope: row.derived_scope,
    socketPath: row.socket_path,
    credentialHash: row.credential_hash,
    expiresAt: row.expires_at,
    consumed: row.consumed === 1,
    turnsAllowed: row.turns_allowed === 1,
    provisioner: provisioner as Record<string, unknown>,
    createdAt: row.created_at,
    ...(row.host_session_id === null ? {} : { hostSessionId: row.host_session_id }),
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id }),
    ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
    ...(row.invocation_id === null ? {} : { invocationId: row.invocation_id }),
    ...(row.attach_token_ref === null ? {} : { attachTokenRef: row.attach_token_ref }),
    ...(row.controller_instance_id === null
      ? {}
      : { controllerInstanceId: row.controller_instance_id }),
    ...(row.establishment_state === null ? {} : { establishmentState: row.establishment_state }),
    ...(row.capabilities_json === null
      ? {}
      : {
          capabilities: parseRecordJson(
            row.capabilities_json,
            `registration grant ${row.registration_id} capabilities`
          ),
        }),
    ...(row.participant_info_json === null
      ? {}
      : {
          participantInfo: parseRecordJson(
            row.participant_info_json,
            `registration grant ${row.registration_id} participant info`
          ),
        }),
    ...(row.established_at === null ? {} : { establishedAt: row.established_at }),
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
  }
}

/** Durable, daemon-private grants bridging issuance (A1) and hello mint (A2). */
export class ExternalRegistrationGrantRepository {
  constructor(private readonly db: Database) {}

  getByRegistrationId(registrationId: string): ExternalRegistrationGrant | null {
    const row = this.db
      .query<ExternalRegistrationGrantRow, [string]>(
        `SELECT ${COLUMNS} FROM external_registration_grants WHERE registration_id = ?`
      )
      .get(registrationId)
    return row === null ? null : mapRow(row)
  }

  listByClassId(classId: string): ExternalRegistrationGrant[] {
    return this.db
      .query<ExternalRegistrationGrantRow, [string]>(
        `SELECT ${COLUMNS}
         FROM external_registration_grants
         WHERE class_id = ?
         ORDER BY created_at ASC, registration_id ASC`
      )
      .all(classId)
      .map(mapRow)
  }

  /** Registrations whose daemon-owned registration dial must converge on boot. */
  listRendezvousCandidates(now: string): ExternalRegistrationGrant[] {
    return this.db
      .query<ExternalRegistrationGrantRow, [string]>(
        `SELECT ${COLUMNS}
         FROM external_registration_grants
         WHERE retired_at IS NULL
           AND ((consumed = 0 AND expires_at > ?)
             OR establishment_state = 'DELIVERY_PENDING')
         ORDER BY created_at ASC, registration_id ASC`
      )
      .all(now)
      .map(mapRow)
  }

  /** Established identities whose transport must be re-entered after daemon restart. */
  listEstablished(): ExternalRegistrationGrant[] {
    return this.db
      .query<ExternalRegistrationGrantRow, []>(
        `SELECT ${COLUMNS}
         FROM external_registration_grants
         WHERE establishment_state = 'ESTABLISHED' AND retired_at IS NULL
         ORDER BY established_at ASC, registration_id ASC`
      )
      .all()
      .map(mapRow)
  }

  /** Minted registrations retained for operator-owned retirement projection. */
  listMinted(): ExternalRegistrationGrant[] {
    return this.db
      .query<ExternalRegistrationGrantRow, []>(
        `SELECT ${COLUMNS}
         FROM external_registration_grants
         WHERE consumed = 1
         ORDER BY created_at ASC, registration_id ASC`
      )
      .all()
      .map(mapRow)
  }

  /**
   * Count capacity occupants at one instant. Successful hellos remain class
   * instances permanently; an unconsumed grant occupies a slot only until it
   * expires, after which it is inert and a fresh registration may be issued.
   */
  countCapacityOccupants(classId: string, now: string): number {
    const row = this.db
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count
         FROM external_registration_grants
         WHERE class_id = ?
           AND retired_at IS NULL
           AND (consumed = 1 OR expires_at > ?)`
      )
      .get(classId, now)
    return row?.count ?? 0
  }

  /** Durable local projection written only after lawful authority retirement converges. */
  markRetired(registrationId: string, retiredAt: string): boolean {
    const result = this.db
      .query<never, [string, string]>(
        `UPDATE external_registration_grants
         SET retired_at = ?, retirement_reason = 'external_registration_gc'
         WHERE registration_id = ? AND consumed = 1 AND retired_at IS NULL`
      )
      .run(retiredAt, registrationId) as { changes?: number }
    if ((result.changes ?? 0) === 1) return true
    const current = this.getByRegistrationId(registrationId)
    return current?.retirementReason === 'external_registration_gc'
  }

  /** The capacity check and insert share the database's immediate write lock. */
  issueWithinCapacity(
    grant: ExternalRegistrationGrant,
    maxInstances: number,
    now: string
  ): IssueExternalRegistrationGrantResult {
    return this.db
      .transaction((): IssueExternalRegistrationGrantResult => {
        const occupied = this.countCapacityOccupants(grant.classId, now)
        if (occupied >= maxInstances) {
          return { outcome: 'instances-exhausted', occupied }
        }
        execute(
          this.db,
          `INSERT INTO external_registration_grants (
             registration_id,
             class_id,
             derived_scope,
             socket_path,
             credential_hash,
             expires_at,
             consumed,
             turns_allowed,
             provisioner_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          grant.registrationId,
          grant.classId,
          grant.derivedScope,
          grant.socketPath,
          grant.credentialHash,
          grant.expiresAt,
          grant.consumed ? 1 : 0,
          grant.turnsAllowed ? 1 : 0,
          JSON.stringify(grant.provisioner),
          grant.createdAt
        )
        return { outcome: 'issued', grant }
      })
      .immediate()
  }

  /**
   * Single-use CAS for A2. Callers may place this inside the same transaction
   * as start-graph persistence so only a successful local mint consumes it.
   */
  consumeIfAvailable(registrationId: string, now: string): boolean {
    const result = this.db
      .query<never, [string, string]>(
        `UPDATE external_registration_grants
         SET consumed = 1
         WHERE registration_id = ? AND consumed = 0 AND expires_at > ?`
      )
      .run(registrationId, now) as { changes?: number }
    return (result.changes ?? 0) === 1
  }

  /** Record the identity minted by the caller's surrounding start-graph transaction. */
  recordMint(registrationId: string, mint: ExternalRegistrationMint): void {
    const result = this.db
      .query<never, [string, string, string, string, string, string, string, string, string]>(
        `UPDATE external_registration_grants
         SET host_session_id = ?,
             runtime_id = ?,
             operation_id = ?,
             invocation_id = ?,
             attach_token_ref = ?,
             controller_instance_id = ?,
             establishment_state = 'DELIVERY_PENDING',
             capabilities_json = ?,
             participant_info_json = ?
         WHERE registration_id = ?
           AND consumed = 1
           AND establishment_state IS NULL`
      )
      .run(
        mint.hostSessionId,
        mint.runtimeId,
        mint.operationId,
        mint.invocationId,
        mint.attachTokenRef,
        mint.controllerInstanceId,
        JSON.stringify(mint.capabilities),
        JSON.stringify(mint.participantInfo),
        registrationId
      ) as { changes?: number }
    if ((result.changes ?? 0) !== 1) {
      throw new Error(`registration grant ${registrationId} could not record its mint`)
    }
  }

  /** Idempotent ready-ack transition; false means the registration was not pending. */
  markEstablished(registrationId: string, establishedAt: string): boolean {
    const result = this.db
      .query<never, [string, string]>(
        `UPDATE external_registration_grants
         SET establishment_state = 'ESTABLISHED', established_at = ?
         WHERE registration_id = ? AND establishment_state = 'DELIVERY_PENDING'`
      )
      .run(establishedAt, registrationId) as { changes?: number }
    return (result.changes ?? 0) === 1
  }

  /** Advance the single active-controller fence for a token-authenticated reattach. */
  updateControllerInstanceId(registrationId: string, controllerInstanceId: string): boolean {
    const result = this.db
      .query<never, [string, string]>(
        `UPDATE external_registration_grants
         SET controller_instance_id = ?
         WHERE registration_id = ? AND establishment_state = 'ESTABLISHED'`
      )
      .run(controllerInstanceId, registrationId) as { changes?: number }
    return (result.changes ?? 0) === 1
  }
}
