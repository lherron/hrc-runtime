import type { Database } from 'bun:sqlite'

import { formatCanonicalScopeRef } from 'hrc-core'

export type ScopeRetirementReason = 'namespace_reconciliation'

/** Durable node-local epoch fence retained even after a later activation. */
export type ScopeRetirementRecord = {
  scopeRef: string
  retiredNodeId: string
  retiredPlacementEpoch: number
  /** Null is an explicit terminal bar, never an undecided successor. */
  successorNodeId: string | null
  reason: ScopeRetirementReason
  retiredAt: string
}

export type RetireScopeInput = ScopeRetirementRecord

type RetirementRow = {
  scope_ref: string
  retired_node_id: string
  retired_placement_epoch: number
  successor_node_id: string | null
  reason: ScopeRetirementReason
  retired_at: string
}

type LegacyRetirementRow = {
  scope_ref: string
  retired_node_id: string
  canonical_home_node_id: string
  canonical_placement_epoch: number
  reason: ScopeRetirementReason
  retired_at: string
}

const RETIREMENT_COLUMNS = `
  scope_ref,
  retired_node_id,
  retired_placement_epoch,
  successor_node_id,
  reason,
  retired_at
`

function canonicalScopeRef(scopeRef: string): string {
  return formatCanonicalScopeRef({ scopeRef })
}

function requireNodeId(nodeId: string, field: string): string {
  const normalized = nodeId.trim()
  if (normalized.length === 0) throw new Error(`${field} must not be empty`)
  return normalized
}

function requireEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`retiredPlacementEpoch must be a positive safe integer, got ${String(epoch)}`)
  }
  return epoch
}

function mapRetirement(row: RetirementRow): ScopeRetirementRecord {
  return {
    scopeRef: row.scope_ref,
    retiredNodeId: row.retired_node_id,
    retiredPlacementEpoch: row.retired_placement_epoch,
    successorNodeId: row.successor_node_id,
    reason: row.reason,
    retiredAt: row.retired_at,
  }
}

function mapLegacyRetirement(row: LegacyRetirementRow): ScopeRetirementRecord {
  return {
    scopeRef: row.scope_ref,
    retiredNodeId: row.retired_node_id,
    retiredPlacementEpoch: row.canonical_placement_epoch,
    successorNodeId:
      row.scope_ref === 'agent:cody:project:hrc-runtime:task:pin-probe'
        ? null
        : row.canonical_home_node_id,
    reason: row.reason,
    retiredAt: row.retired_at,
  }
}

function createRetirementTable(db: Database): void {
  db.exec(`
    CREATE TABLE federation_scope_retirements (
      scope_ref TEXT PRIMARY KEY,
      retired_node_id TEXT NOT NULL,
      retired_placement_epoch INTEGER NOT NULL CHECK (retired_placement_epoch >= 1),
      successor_node_id TEXT,
      reason TEXT NOT NULL CHECK (reason IN ('namespace_reconciliation')),
      retired_at TEXT NOT NULL
    );
  `)
}

function ensureRetirementSchema(db: Database): void {
  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('federation_scope_retirements')?.sql
  if (schema === undefined) {
    createRetirementTable(db)
    return
  }
  if (schema.includes('retired_placement_epoch')) return

  // T-06681 one-time F0 schema correction. The legacy "canonical" fields
  // paired a successor node with the retired node's epoch. Preserve that
  // information as the explicit fence vocabulary. Lance's ruling makes the
  // historical pin-probe row terminal; this exact ScopeRef is deliberately
  // the only data correction embedded here.
  db.transaction(() => {
    db.exec(
      'ALTER TABLE federation_scope_retirements RENAME TO federation_scope_retirements_legacy_t06681;'
    )
    createRetirementTable(db)
    db.exec(`
      INSERT INTO federation_scope_retirements (
        scope_ref,
        retired_node_id,
        retired_placement_epoch,
        successor_node_id,
        reason,
        retired_at
      )
      SELECT
        scope_ref,
        retired_node_id,
        canonical_placement_epoch,
        CASE
          WHEN scope_ref = 'agent:cody:project:hrc-runtime:task:pin-probe' THEN NULL
          ELSE canonical_home_node_id
        END,
        reason,
        retired_at
      FROM federation_scope_retirements_legacy_t06681;
      DROP TABLE federation_scope_retirements_legacy_t06681;
    `)
  }).immediate()
}

function sameRetirement(left: ScopeRetirementRecord, right: ScopeRetirementRecord): boolean {
  return (
    left.scopeRef === right.scopeRef &&
    left.retiredNodeId === right.retiredNodeId &&
    left.retiredPlacementEpoch === right.retiredPlacementEpoch &&
    left.successorNodeId === right.successorNodeId &&
    left.reason === right.reason &&
    left.retiredAt === right.retiredAt
  )
}

function normalizeRetirement(input: RetireScopeInput): ScopeRetirementRecord {
  return {
    scopeRef: canonicalScopeRef(input.scopeRef),
    retiredNodeId: requireNodeId(input.retiredNodeId, 'retiredNodeId'),
    retiredPlacementEpoch: requireEpoch(input.retiredPlacementEpoch),
    successorNodeId:
      input.successorNodeId === null
        ? null
        : requireNodeId(input.successorNodeId, 'successorNodeId'),
    reason: input.reason,
    retiredAt: input.retiredAt,
  }
}

export class ScopeRetirementConflictError extends Error {
  constructor(scopeRef: string) {
    super(`scope ${scopeRef} has a conflicting retirement epoch fence`)
    this.name = 'ScopeRetirementConflictError'
  }
}

/** Monotonic node-local retirement fence repository. */
export class ScopeRetirementRepository {
  constructor(private readonly db: Database) {
    ensureRetirementSchema(db)
  }

  get(scopeRef: string): ScopeRetirementRecord | undefined {
    return readScopeRetirement(this.db, scopeRef)
  }

  list(): ScopeRetirementRecord[] {
    return readScopeRetirements(this.db)
  }

  retire(input: RetireScopeInput): {
    outcome: 'created' | 'existing' | 'updated'
    record: ScopeRetirementRecord
  } {
    const normalized = normalizeRetirement(input)
    return this.db
      .transaction(() => {
        const current = this.get(normalized.scopeRef)
        if (current !== undefined) {
          if (sameRetirement(current, normalized)) return { outcome: 'existing', record: current }
          if (normalized.retiredPlacementEpoch <= current.retiredPlacementEpoch) {
            throw new ScopeRetirementConflictError(normalized.scopeRef)
          }
          this.db
            .query(
              `UPDATE federation_scope_retirements
               SET retired_node_id = ?,
                   retired_placement_epoch = ?,
                   successor_node_id = ?,
                   reason = ?,
                   retired_at = ?
               WHERE scope_ref = ? AND retired_placement_epoch = ?`
            )
            .run(
              normalized.retiredNodeId,
              normalized.retiredPlacementEpoch,
              normalized.successorNodeId,
              normalized.reason,
              normalized.retiredAt,
              normalized.scopeRef,
              current.retiredPlacementEpoch
            )
          const record = this.get(normalized.scopeRef)
          if (record === undefined)
            throw new Error('scope retirement invariant failed after update')
          return { outcome: 'updated', record }
        }
        this.db
          .query(
            `INSERT INTO federation_scope_retirements (${RETIREMENT_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            normalized.scopeRef,
            normalized.retiredNodeId,
            normalized.retiredPlacementEpoch,
            normalized.successorNodeId,
            normalized.reason,
            normalized.retiredAt
          )
        const record = this.get(normalized.scopeRef)
        if (record === undefined) throw new Error('scope retirement invariant failed after insert')
        return { outcome: 'created', record }
      })
      .immediate() as {
      outcome: 'created' | 'existing' | 'updated'
      record: ScopeRetirementRecord
    }
  }
}

export function createScopeRetirementRepository(db: Database): ScopeRetirementRepository {
  return new ScopeRetirementRepository(db)
}

/** Read-only gate/inventory surface; pre-reconciliation databases return no fence. */
export function readScopeRetirement(
  db: Database,
  scopeRef: string
): ScopeRetirementRecord | undefined {
  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('federation_scope_retirements')?.sql
  if (schema === undefined) return undefined
  if (!schema.includes('retired_placement_epoch')) {
    const row = db
      .query<LegacyRetirementRow, [string]>(
        `SELECT
           scope_ref,
           retired_node_id,
           canonical_home_node_id,
           canonical_placement_epoch,
           reason,
           retired_at
         FROM federation_scope_retirements
         WHERE scope_ref = ?`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapLegacyRetirement(row)
  }
  const row = db
    .query<RetirementRow, [string]>(
      `SELECT ${RETIREMENT_COLUMNS}
       FROM federation_scope_retirements
       WHERE scope_ref = ?`
    )
    .get(canonicalScopeRef(scopeRef))
  return row === null ? undefined : mapRetirement(row)
}

export function readScopeRetirements(db: Database): ScopeRetirementRecord[] {
  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('federation_scope_retirements')?.sql
  if (schema === undefined) return []
  if (!schema.includes('retired_placement_epoch')) {
    return db
      .query<LegacyRetirementRow, []>(
        `SELECT
           scope_ref,
           retired_node_id,
           canonical_home_node_id,
           canonical_placement_epoch,
           reason,
           retired_at
         FROM federation_scope_retirements
         ORDER BY scope_ref`
      )
      .all()
      .map(mapLegacyRetirement)
  }
  return db
    .query<RetirementRow, []>(
      `SELECT ${RETIREMENT_COLUMNS} FROM federation_scope_retirements ORDER BY scope_ref`
    )
    .all()
    .map(mapRetirement)
}
