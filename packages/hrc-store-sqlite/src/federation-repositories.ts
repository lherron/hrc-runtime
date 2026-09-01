import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  BirthDesignationProvenance,
  BirthDesignationRecord,
  BirthDesignationState,
  FederationPlacementBinding,
  FederationPlacementSource,
} from 'hrc-core'

export type {
  BirthDesignationProvenance,
  BirthDesignationRecord,
  BirthDesignationResult,
  BirthDesignationState,
  FederationPlacementSource,
} from 'hrc-core'

export type PlacementLedgerState = 'active' | 'retired'
export type PlacementBinding = FederationPlacementBinding
export type BindingRegistryRecord = PlacementBinding

export type PlacementLedgerRecord = PlacementBinding & {
  state: PlacementLedgerState
  retiredAt?: string | undefined
  retirementReason?: string | undefined
}

export type InstallActivePlacementInput = Omit<PlacementBinding, 'createdAt'> & {
  createdAt?: string | undefined
}

export type RetirePlacementInput = {
  scopeRef: string
  expectedHomeNodeId: string
  reason: string
  retiredAt: string
}

export type RetirePlacementResult = {
  outcome: 'retired' | 'idempotent' | 'conflict' | 'not_found'
  record?: PlacementLedgerRecord | undefined
}

export type EstablishBindingInput = {
  scopeRef: string
  homeNodeId: string
  /** Transient T-07655 designation precedence input; it is not persisted. */
  placementSource: FederationPlacementSource
  now: string
}

export type BindingEstablishResult =
  | { outcome: 'created' | 'existing'; binding: PlacementBinding }
  | { outcome: 'designation-mismatch'; designation: BirthDesignationRecord }

export type DeleteBindingInput = {
  scopeRef: string
  expectedHomeNodeId: string
  retiredAt: string
}

export type DeleteBindingResult = {
  outcome: 'deleted' | 'idempotent' | 'conflict'
  binding?: PlacementBinding | undefined
}

export type RecordBirthDesignationInput = {
  scopeRef: string
  homeNodeId: string
  provenance: BirthDesignationProvenance
  birthEnvelopeId: string
  senderScopeRef: string
  now: string
}

const SUPERSEDING_SOURCES = new Set<FederationPlacementSource>([
  'pin',
  'task_default',
  'default_home_node',
  'explicit_local',
])

const DESIGNATED_SOURCES = new Set<FederationPlacementSource>([
  'default_home_node(sender)',
  'default_home_node(sender-retired)',
])

type PlacementRow = {
  scope_ref: string
  home_node_id: string
  state: PlacementLedgerState
  retired_at: string | null
  retirement_reason: string | null
  created_at: string
  updated_at: string
}

type RegistryRow = {
  scope_ref: string
  home_node_id: string
  created_at: string
  updated_at: string
}

type DesignationRow = {
  scope_ref: string
  designation_epoch: number
  home_node_id: string
  provenance: BirthDesignationProvenance
  birth_envelope_id: string
  sender_scope_ref: string
  designated_at: string
  state: BirthDesignationState
  superseded_by: FederationPlacementSource | null
  superseded_at: string | null
}

const LEDGER_COLUMNS = `
  scope_ref,
  home_node_id,
  state,
  retired_at,
  retirement_reason,
  created_at,
  updated_at
`

const REGISTRY_COLUMNS = 'scope_ref, home_node_id, created_at, updated_at'

const DESIGNATION_COLUMNS = `
  scope_ref,
  designation_epoch,
  home_node_id,
  provenance,
  birth_envelope_id,
  sender_scope_ref,
  designated_at,
  state,
  superseded_by,
  superseded_at
`

function canonicalScopeRef(scopeRef: string): string {
  return formatCanonicalScopeRef({ scopeRef })
}

function requireNodeId(nodeId: string, field: string): string {
  const normalized = nodeId.trim()
  if (normalized.length === 0) throw new Error(`${field} must not be empty`)
  return normalized
}

function mapBinding(row: RegistryRow | PlacementRow): PlacementBinding {
  return {
    scopeRef: row.scope_ref,
    homeNodeId: row.home_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapLedger(row: PlacementRow): PlacementLedgerRecord {
  return {
    ...mapBinding(row),
    state: row.state,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
    ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
  }
}

function mapDesignation(row: DesignationRow): BirthDesignationRecord {
  return {
    scopeRef: row.scope_ref,
    homeNodeId: row.home_node_id,
    provenance: row.provenance,
    birthEnvelopeId: row.birth_envelope_id,
    senderScopeRef: row.sender_scope_ref,
    designationEpoch: row.designation_epoch,
    designatedAt: row.designated_at,
    state: row.state,
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
    ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
  }
}

function createPlacementLedgerTable(db: Database): void {
  db.exec(`
    CREATE TABLE placement_ledger (
      scope_ref TEXT PRIMARY KEY,
      home_node_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
      retired_at TEXT,
      retirement_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'active' AND retired_at IS NULL AND retirement_reason IS NULL) OR
        (state = 'retired' AND retired_at IS NOT NULL AND retirement_reason IS NOT NULL)
      )
    );
  `)
}

function ensurePlacementLedgerSchema(db: Database): void {
  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('placement_ledger')?.sql
  if (schema === undefined) {
    createPlacementLedgerTable(db)
    return
  }
  if (!schema.includes('placement_epoch') && schema.includes("'retired'")) return

  db.transaction(() => {
    db.exec('ALTER TABLE placement_ledger RENAME TO placement_ledger_legacy_v12;')
    createPlacementLedgerTable(db)
    db.exec(`
      INSERT INTO placement_ledger (${LEDGER_COLUMNS})
      SELECT
        scope_ref,
        home_node_id,
        CASE WHEN state = 'active' THEN 'active' ELSE 'retired' END,
        CASE WHEN state = 'active' THEN NULL ELSE updated_at END,
        CASE WHEN state = 'active' THEN NULL ELSE 'migrated-v1.2-local-fence' END,
        created_at,
        updated_at
      FROM placement_ledger_legacy_v12;
      DROP TABLE placement_ledger_legacy_v12;
    `)
  }).immediate()
}

export class PlacementLedgerConflictError extends Error {
  constructor(scopeRef: string) {
    super(`conflicting placement ledger row for ${scopeRef}`)
    this.name = 'PlacementLedgerConflictError'
  }
}

export class PlacementLedgerRetiredError extends Error {
  constructor(scopeRef: string) {
    super(`scope ${scopeRef} is permanently retired on this node`)
    this.name = 'PlacementLedgerRetiredError'
  }
}

export class PlacementLedgerRepository {
  constructor(private readonly db: Database) {
    ensurePlacementLedgerSchema(db)
  }

  get(scopeRef: string): PlacementLedgerRecord | undefined {
    const row = this.db
      .query<PlacementRow, [string]>(
        `SELECT ${LEDGER_COLUMNS} FROM placement_ledger WHERE scope_ref = ?`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapLedger(row)
  }

  activeAuthority(scopeRef: string): PlacementLedgerRecord | undefined {
    const record = this.get(scopeRef)
    return record?.state === 'active' ? record : undefined
  }

  list(): PlacementLedgerRecord[] {
    return readPlacementLedgerRows(this.db)
  }

  retire(input: RetirePlacementInput): RetirePlacementResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedHomeNodeId = requireNodeId(input.expectedHomeNodeId, 'expectedHomeNodeId')
    if (input.reason.trim().length === 0) throw new Error('retirement reason must not be empty')
    return this.db
      .transaction(() => {
        const current = this.get(scopeRef)
        if (current === undefined) return { outcome: 'not_found' }
        if (current.homeNodeId !== expectedHomeNodeId) {
          return { outcome: 'conflict', record: current }
        }
        if (current.state === 'retired') return { outcome: 'idempotent', record: current }
        const changed = this.db
          .query(
            `UPDATE placement_ledger
                SET state = 'retired', retired_at = ?, retirement_reason = ?, updated_at = ?
              WHERE scope_ref = ? AND state = 'active' AND home_node_id = ?`
          )
          .run(input.retiredAt, input.reason, input.retiredAt, scopeRef, expectedHomeNodeId)
        if (changed.changes !== 1) return { outcome: 'conflict', record: current }
        return { outcome: 'retired', record: this.get(scopeRef) }
      })
      .immediate() as RetirePlacementResult
  }

  installActive(input: InstallActivePlacementInput): PlacementLedgerRecord {
    const normalized: PlacementBinding = {
      scopeRef: canonicalScopeRef(input.scopeRef),
      homeNodeId: requireNodeId(input.homeNodeId, 'homeNodeId'),
      createdAt: input.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    }
    return this.db
      .transaction(() => {
        const current = this.get(normalized.scopeRef)
        if (current?.state === 'retired') throw new PlacementLedgerRetiredError(normalized.scopeRef)
        if (current !== undefined) {
          if (current.homeNodeId !== normalized.homeNodeId) {
            throw new PlacementLedgerConflictError(normalized.scopeRef)
          }
          return current
        }
        this.db
          .query(
            `INSERT INTO placement_ledger (${LEDGER_COLUMNS})
             VALUES (?, ?, 'active', NULL, NULL, ?, ?)`
          )
          .run(
            normalized.scopeRef,
            normalized.homeNodeId,
            normalized.createdAt,
            normalized.updatedAt
          )
        const stored = this.get(normalized.scopeRef)
        if (stored === undefined) throw new Error('placement ledger insert did not store a row')
        return stored
      })
      .immediate()
  }
}

export function createPlacementLedgerRepository(db: Database): PlacementLedgerRepository {
  return new PlacementLedgerRepository(db)
}

export function readPlacementLedgerRows(db: Database): PlacementLedgerRecord[] {
  const table = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('placement_ledger')
  if (table === null) return []
  return db
    .query<PlacementRow, []>(`SELECT ${LEDGER_COLUMNS} FROM placement_ledger ORDER BY scope_ref`)
    .all()
    .map(mapLedger)
}

function createRegistryTable(db: Database): void {
  db.exec(`
    CREATE TABLE binding_registry (
      scope_ref TEXT PRIMARY KEY,
      home_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function createRetirementAuditTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS binding_retirement_audit (
      scope_ref TEXT PRIMARY KEY,
      last_home_node_id TEXT NOT NULL,
      retired_at TEXT NOT NULL
    );
  `)
}

function createBirthDesignationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS birth_designation (
      scope_ref TEXT NOT NULL,
      designation_epoch INTEGER NOT NULL CHECK (designation_epoch >= 1),
      home_node_id TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (
        provenance IN ('default_home_node(sender)', 'default_home_node(sender-retired)')
      ),
      birth_envelope_id TEXT NOT NULL,
      sender_scope_ref TEXT NOT NULL,
      designated_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('live', 'superseded')),
      superseded_by TEXT,
      superseded_at TEXT,
      PRIMARY KEY (scope_ref, designation_epoch),
      CHECK (
        (state = 'live' AND superseded_by IS NULL AND superseded_at IS NULL) OR
        (state = 'superseded' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS birth_designation_live_idx
      ON birth_designation(scope_ref) WHERE state = 'live';
  `)
}

export type OpenBindingRegistryOptions = { busyTimeoutMs?: number | undefined }

function createRegistryDatabase(path: string, options: OpenBindingRegistryOptions = {}): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  const busyTimeout =
    typeof options.busyTimeoutMs === 'number' && Number.isFinite(options.busyTimeoutMs)
      ? Math.max(0, options.busyTimeoutMs)
      : 5_000
  db.exec(`PRAGMA busy_timeout = ${busyTimeout};`)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')

  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('binding_registry')?.sql
  if (schema === undefined) createRegistryTable(db)
  else if (schema.includes('placement_epoch') || schema.includes('establishment_provenance')) {
    db.transaction(() => {
      db.exec('ALTER TABLE binding_registry RENAME TO binding_registry_legacy_v12;')
      createRegistryTable(db)
      const hasState = schema.includes("state TEXT NOT NULL CHECK (state IN ('active', 'retired'))")
      db.exec(`
        INSERT INTO binding_registry (${REGISTRY_COLUMNS})
        SELECT scope_ref, home_node_id, created_at, updated_at
          FROM binding_registry_legacy_v12
          ${hasState ? "WHERE state = 'active'" : ''};
        DROP TABLE binding_registry_legacy_v12;
      `)
    }).immediate()
  }
  createBirthDesignationTable(db)
  createRetirementAuditTable(db)
  return db
}

export class BindingRegistry {
  constructor(readonly sqlite: Database) {}

  close(): void {
    this.sqlite.close()
  }

  get(scopeRef: string): PlacementBinding | undefined {
    const row = this.sqlite
      .query<RegistryRow, [string]>(
        `SELECT ${REGISTRY_COLUMNS} FROM binding_registry WHERE scope_ref = ?`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapBinding(row)
  }

  getRecord(scopeRef: string): BindingRegistryRecord | undefined {
    return this.get(scopeRef)
  }

  retiredHome(scopeRef: string): string | undefined {
    return (
      this.sqlite
        .query<{ last_home_node_id: string }, [string]>(
          'SELECT last_home_node_id FROM binding_retirement_audit WHERE scope_ref = ?'
        )
        .get(canonicalScopeRef(scopeRef))?.last_home_node_id ?? undefined
    )
  }

  list(): PlacementBinding[] {
    return this.sqlite
      .query<RegistryRow, []>(`SELECT ${REGISTRY_COLUMNS} FROM binding_registry ORDER BY scope_ref`)
      .all()
      .map(mapBinding)
  }

  listRecords(): BindingRegistryRecord[] {
    return this.list()
  }

  liveDesignation(scopeRef: string): BirthDesignationRecord | undefined {
    const row = this.sqlite
      .query<DesignationRow, [string]>(
        `SELECT ${DESIGNATION_COLUMNS} FROM birth_designation
          WHERE scope_ref = ? AND state = 'live'`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapDesignation(row)
  }

  latestDesignation(scopeRef: string): BirthDesignationRecord | undefined {
    const row = this.sqlite
      .query<DesignationRow, [string]>(
        `SELECT ${DESIGNATION_COLUMNS} FROM birth_designation
          WHERE scope_ref = ? ORDER BY designation_epoch DESC LIMIT 1`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapDesignation(row)
  }

  listUnbornDesignationsForNode(homeNodeId: string, limit = 200): BirthDesignationRecord[] {
    return this.sqlite
      .query<DesignationRow, [string, number]>(
        `SELECT ${DESIGNATION_COLUMNS} FROM birth_designation d
          WHERE d.state = 'live'
            AND d.home_node_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM binding_registry b WHERE b.scope_ref = d.scope_ref
            )
          ORDER BY d.scope_ref
          LIMIT ?`
      )
      .all(requireNodeId(homeNodeId, 'homeNodeId'), limit)
      .map(mapDesignation)
  }

  designationHistory(scopeRef: string): BirthDesignationRecord[] {
    return this.sqlite
      .query<DesignationRow, [string]>(
        `SELECT ${DESIGNATION_COLUMNS} FROM birth_designation
          WHERE scope_ref = ? ORDER BY designation_epoch`
      )
      .all(canonicalScopeRef(scopeRef))
      .map(mapDesignation)
  }

  recordDesignation(input: RecordBirthDesignationInput): BirthDesignationRecord {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const homeNodeId = requireNodeId(input.homeNodeId, 'homeNodeId')
    return this.sqlite
      .transaction(() => {
        const live = this.liveDesignation(scopeRef)
        if (live !== undefined) return live
        const previous = this.sqlite
          .query<{ epoch: number | null }, [string]>(
            'SELECT MAX(designation_epoch) AS epoch FROM birth_designation WHERE scope_ref = ?'
          )
          .get(scopeRef)?.epoch
        const designationEpoch = (previous ?? 0) + 1
        this.sqlite
          .query(
            `INSERT INTO birth_designation (${DESIGNATION_COLUMNS})
             VALUES (?, ?, ?, ?, ?, ?, ?, 'live', NULL, NULL)`
          )
          .run(
            scopeRef,
            designationEpoch,
            homeNodeId,
            input.provenance,
            input.birthEnvelopeId,
            input.senderScopeRef,
            input.now
          )
        const stored = this.liveDesignation(scopeRef)
        if (stored === undefined) throw new Error('birth designation insert did not store a row')
        return stored
      })
      .immediate() as BirthDesignationRecord
  }

  establish(input: EstablishBindingInput): BindingEstablishResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const homeNodeId = requireNodeId(input.homeNodeId, 'homeNodeId')
    return this.sqlite
      .transaction(() => {
        const current = this.get(scopeRef)
        const designation = this.liveDesignation(scopeRef)
        if (designation !== undefined && current === undefined) {
          if (
            DESIGNATED_SOURCES.has(input.placementSource) &&
            homeNodeId !== designation.homeNodeId
          ) {
            return { outcome: 'designation-mismatch', designation }
          }
          if (SUPERSEDING_SOURCES.has(input.placementSource)) {
            this.sqlite
              .query(
                `UPDATE birth_designation
                    SET state = 'superseded', superseded_by = ?, superseded_at = ?
                  WHERE scope_ref = ? AND designation_epoch = ?`
              )
              .run(input.placementSource, input.now, scopeRef, designation.designationEpoch)
          }
        }
        if (current !== undefined) return { outcome: 'existing', binding: current }
        const inserted = this.sqlite
          .query(
            `INSERT INTO binding_registry (${REGISTRY_COLUMNS})
             VALUES (?, ?, ?, ?) ON CONFLICT(scope_ref) DO NOTHING`
          )
          .run(scopeRef, homeNodeId, input.now, input.now)
        const stored = this.get(scopeRef)
        if (stored === undefined) throw new Error('binding registry insert did not store a row')
        return { outcome: inserted.changes === 1 ? 'created' : 'existing', binding: stored }
      })
      .immediate() as BindingEstablishResult
  }

  deleteBinding(input: DeleteBindingInput): DeleteBindingResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedHomeNodeId = requireNodeId(input.expectedHomeNodeId, 'expectedHomeNodeId')
    return this.sqlite
      .transaction(() => {
        const current = this.get(scopeRef)
        if (current === undefined) return { outcome: 'idempotent' }
        if (current.homeNodeId !== expectedHomeNodeId) {
          return { outcome: 'conflict', binding: current }
        }
        const deleted = this.sqlite
          .query('DELETE FROM binding_registry WHERE scope_ref = ? AND home_node_id = ?')
          .run(scopeRef, expectedHomeNodeId)
        if (deleted.changes !== 1) return { outcome: 'conflict', binding: current }
        this.sqlite
          .query("DELETE FROM birth_designation WHERE scope_ref = ? AND state = 'live'")
          .run(scopeRef)
        this.sqlite
          .query(
            `INSERT INTO binding_retirement_audit (scope_ref, last_home_node_id, retired_at)
             VALUES (?, ?, ?)
             ON CONFLICT(scope_ref) DO UPDATE SET
               last_home_node_id = excluded.last_home_node_id,
               retired_at = excluded.retired_at`
          )
          .run(scopeRef, expectedHomeNodeId, input.retiredAt)
        return { outcome: 'deleted' }
      })
      .immediate() as DeleteBindingResult
  }

  insertRebuilt(binding: PlacementBinding): void {
    this.sqlite
      .query(`INSERT INTO binding_registry (${REGISTRY_COLUMNS}) VALUES (?, ?, ?, ?)`)
      .run(binding.scopeRef, binding.homeNodeId, binding.createdAt, binding.updatedAt)
  }
}

export function openBindingRegistry(
  path: string,
  options: OpenBindingRegistryOptions = {}
): BindingRegistry {
  return new BindingRegistry(createRegistryDatabase(path, options))
}

export function rebuildBindingRegistryFromLedgers(
  target: BindingRegistry,
  ledgerRows: readonly PlacementLedgerRecord[]
): { inserted: number; duplicates: number } {
  if (target.list().length !== 0) throw new Error('binding registry rebuild target must be empty')
  const selected = new Map<string, PlacementLedgerRecord>()
  let duplicates = 0
  for (const row of ledgerRows) {
    if (row.state !== 'active') continue
    const scopeRef = canonicalScopeRef(row.scopeRef)
    const current = selected.get(scopeRef)
    if (current === undefined) {
      selected.set(scopeRef, { ...row, scopeRef })
      continue
    }
    if (current.homeNodeId !== row.homeNodeId) throw new PlacementLedgerConflictError(scopeRef)
    duplicates += 1
  }
  target.sqlite
    .transaction(() => {
      for (const row of [...selected.values()].sort((a, b) =>
        a.scopeRef.localeCompare(b.scopeRef)
      )) {
        target.insertRebuilt(row)
      }
    })
    .immediate()
  return { inserted: selected.size, duplicates }
}
