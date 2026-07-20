import type { Database } from 'bun:sqlite'

import { formatCanonicalScopeRef } from 'hrc-core'

export type ScopeRetirementReason = 'namespace_reconciliation'

export type ScopeRetirementRecord = {
  scopeRef: string
  retiredNodeId: string
  canonicalHomeNodeId: string
  canonicalPlacementEpoch: number
  canonicalHostSessionId?: string | undefined
  reason: ScopeRetirementReason
  retiredAt: string
}

export type RetireScopeInput = ScopeRetirementRecord

type RetirementRow = {
  scope_ref: string
  retired_node_id: string
  canonical_home_node_id: string
  canonical_placement_epoch: number
  canonical_host_session_id: string | null
  reason: ScopeRetirementReason
  retired_at: string
}

const RETIREMENT_COLUMNS = `
  scope_ref,
  retired_node_id,
  canonical_home_node_id,
  canonical_placement_epoch,
  canonical_host_session_id,
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
    throw new Error(`canonicalPlacementEpoch must be a positive safe integer, got ${String(epoch)}`)
  }
  return epoch
}

function mapRetirement(row: RetirementRow): ScopeRetirementRecord {
  return {
    scopeRef: row.scope_ref,
    retiredNodeId: row.retired_node_id,
    canonicalHomeNodeId: row.canonical_home_node_id,
    canonicalPlacementEpoch: row.canonical_placement_epoch,
    ...(row.canonical_host_session_id === null
      ? {}
      : { canonicalHostSessionId: row.canonical_host_session_id }),
    reason: row.reason,
    retiredAt: row.retired_at,
  }
}

function ensureRetirementSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS federation_scope_retirements (
      scope_ref TEXT PRIMARY KEY,
      retired_node_id TEXT NOT NULL,
      canonical_home_node_id TEXT NOT NULL,
      canonical_placement_epoch INTEGER NOT NULL CHECK (canonical_placement_epoch >= 1),
      canonical_host_session_id TEXT,
      reason TEXT NOT NULL CHECK (reason IN ('namespace_reconciliation')),
      retired_at TEXT NOT NULL
    );
  `)
}

function sameRetirement(left: ScopeRetirementRecord, right: ScopeRetirementRecord): boolean {
  return (
    left.scopeRef === right.scopeRef &&
    left.retiredNodeId === right.retiredNodeId &&
    left.canonicalHomeNodeId === right.canonicalHomeNodeId &&
    left.canonicalPlacementEpoch === right.canonicalPlacementEpoch &&
    left.canonicalHostSessionId === right.canonicalHostSessionId &&
    left.reason === right.reason
  )
}

function normalizeRetirement(input: RetireScopeInput): ScopeRetirementRecord {
  return {
    scopeRef: canonicalScopeRef(input.scopeRef),
    retiredNodeId: requireNodeId(input.retiredNodeId, 'retiredNodeId'),
    canonicalHomeNodeId: requireNodeId(input.canonicalHomeNodeId, 'canonicalHomeNodeId'),
    canonicalPlacementEpoch: requireEpoch(input.canonicalPlacementEpoch),
    ...(input.canonicalHostSessionId === undefined
      ? {}
      : { canonicalHostSessionId: input.canonicalHostSessionId }),
    reason: input.reason,
    retiredAt: input.retiredAt,
  }
}

export class ScopeRetirementConflictError extends Error {
  constructor(scopeRef: string) {
    super(`scope ${scopeRef} is already retired toward a different canonical binding`)
    this.name = 'ScopeRetirementConflictError'
  }
}

/** Gate-consumable persistent record for a node whose legacy continuity lost reconciliation. */
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
    outcome: 'created' | 'existing'
    record: ScopeRetirementRecord
  } {
    const normalized = normalizeRetirement(input)
    return this.db
      .transaction(() => {
        const current = this.get(normalized.scopeRef)
        if (current !== undefined) {
          if (sameRetirement(current, normalized)) return { outcome: 'existing', record: current }
          throw new ScopeRetirementConflictError(normalized.scopeRef)
        }
        this.db
          .query(
            `INSERT INTO federation_scope_retirements (${RETIREMENT_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            normalized.scopeRef,
            normalized.retiredNodeId,
            normalized.canonicalHomeNodeId,
            normalized.canonicalPlacementEpoch,
            normalized.canonicalHostSessionId ?? null,
            normalized.reason,
            normalized.retiredAt
          )
        const record = this.get(normalized.scopeRef)
        if (record === undefined) throw new Error('scope retirement invariant failed after insert')
        return { outcome: 'created', record }
      })
      .immediate() as { outcome: 'created' | 'existing'; record: ScopeRetirementRecord }
  }
}

export function createScopeRetirementRepository(db: Database): ScopeRetirementRepository {
  return new ScopeRetirementRepository(db)
}

/** Read-only gate/inventory surface; pre-reconciliation databases return no mark. */
export function readScopeRetirement(
  db: Database,
  scopeRef: string
): ScopeRetirementRecord | undefined {
  const table = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('federation_scope_retirements')
  if (table === null) return undefined
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
  const table = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('federation_scope_retirements')
  if (table === null) return []
  return db
    .query<RetirementRow, []>(
      `SELECT ${RETIREMENT_COLUMNS} FROM federation_scope_retirements ORDER BY scope_ref`
    )
    .all()
    .map(mapRetirement)
}
