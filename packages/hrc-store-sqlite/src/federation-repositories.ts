import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { formatCanonicalScopeRef } from 'hrc-core'
import type {
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
} from 'hrc-core'

import type { ScopeRetirementRecord } from './federation-reconciliation.js'

/**
 * The placement vocabulary is defined in hrc-core (federation-contracts.ts) and
 * re-exported here, so storage, the wire, and locate cannot drift on the
 * spelling of a value that is CHECK-constrained in two schemas.
 */
export type {
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
} from 'hrc-core'

export type PlacementLedgerState = 'active' | 'revoked'

export type PlacementBinding = {
  scopeRef: string
  homeNodeId: string
  placementEpoch: number
  birthClass: FederationBirthClass
  authorityProvenance: BirthAuthorityProvenance
  establishmentProvenance: EstablishmentProvenance
  priorHomeNodeId?: string | undefined
  createdAt: string
  updatedAt: string
}

export type RegistryRetirementRecord = {
  state: 'retired'
  scopeRef: string
  /** Last disclosed/active epoch. A successor, when present, activates at E+1. */
  placementEpoch: number
  birthClass: FederationBirthClass
  authorityProvenance: BirthAuthorityProvenance
  createdAt: string
  updatedAt: string
  retiredHomeNodeId: string
  retiredAt: string
  reason: string
  /** Null is an explicit terminal bar. */
  successorNodeId: string | null
}

export type BindingRegistryRecord =
  | (PlacementBinding & { state: 'active' })
  | RegistryRetirementRecord

export type PlacementLedgerRecord = PlacementBinding & {
  state: PlacementLedgerState
}

export type InstallActivePlacementInput = Omit<PlacementLedgerRecord, 'state' | 'createdAt'> & {
  createdAt?: string | undefined
  state?: 'active' | undefined
}

export type EstablishBindingInput = Omit<
  PlacementBinding,
  'createdAt' | 'updatedAt' | 'priorHomeNodeId' | 'establishmentProvenance'
> & {
  establishmentProvenance: Exclude<EstablishmentProvenance, 'rebind'>
  now: string
}

export type BindingEstablishResult =
  | { outcome: 'created' | 'existing'; binding: PlacementBinding }
  | { outcome: 'retired'; retirement: RegistryRetirementRecord }

export type BindingCasInput = {
  scopeRef: string
  expectedHomeNodeId: string
  expectedPlacementEpoch: number
  newHomeNodeId: string
  now: string
}

export type BindingCasResult = {
  outcome: 'updated' | 'idempotent' | 'conflict' | 'not_found'
  binding?: PlacementBinding | undefined
  retirement?: RegistryRetirementRecord | undefined
}

export type RetireBindingInput = {
  scopeRef: string
  expectedHomeNodeId: string
  expectedPlacementEpoch: number
  successorNodeId: string | null
  reason: string
  retiredAt: string
}

export type RetireBindingResult = {
  outcome: 'retired' | 'idempotent' | 'conflict' | 'not_found'
  retirement?: RegistryRetirementRecord | undefined
  binding?: PlacementBinding | undefined
}

export type ActivateRetiredBindingInput = {
  scopeRef: string
  successorNodeId: string
  expectedPlacementEpoch: number
  now: string
}

export type ActivateRetiredBindingResult = {
  outcome:
    | 'activated'
    | 'idempotent'
    | 'conflict'
    | 'not_found'
    | 'mechanism_refused'
    | 'epoch_exhausted'
  binding?: PlacementBinding | undefined
  retirement?: RegistryRetirementRecord | undefined
}

export type RetargetRetiredBindingInput = {
  scopeRef: string
  expectedSuccessorNodeId: string | null
  expectedPlacementEpoch: number
  newSuccessorNodeId: string | null
  now: string
}

export type RetargetRetiredBindingResult = {
  outcome: 'updated' | 'idempotent' | 'conflict' | 'not_found' | 'epoch_exhausted'
  retirement?: RegistryRetirementRecord | undefined
  binding?: PlacementBinding | undefined
}

type PlacementRow = {
  scope_ref: string
  home_node_id: string
  placement_epoch: number
  state?: PlacementLedgerState | undefined
  birth_class: FederationBirthClass
  authority_provenance_json: string
  establishment_provenance: EstablishmentProvenance
  prior_home_node_id: string | null
  created_at: string
  updated_at: string
}

type RegistryRow = {
  scope_ref: string
  state: 'active' | 'retired'
  placement_epoch: number
  birth_class: FederationBirthClass
  authority_provenance_json: string
  created_at: string
  updated_at: string
  home_node_id: string | null
  establishment_provenance: EstablishmentProvenance | null
  prior_home_node_id: string | null
  retired_home_node_id: string | null
  retired_at: string | null
  retirement_reason: string | null
  successor_node_id: string | null
}

const REGISTRY_COLUMNS = `
  scope_ref,
  state,
  placement_epoch,
  birth_class,
  authority_provenance_json,
  created_at,
  updated_at,
  home_node_id,
  establishment_provenance,
  prior_home_node_id,
  retired_home_node_id,
  retired_at,
  retirement_reason,
  successor_node_id
`

const LEDGER_COLUMNS = `
  scope_ref,
  home_node_id,
  placement_epoch,
  state,
  birth_class,
  authority_provenance_json,
  establishment_provenance,
  prior_home_node_id,
  created_at,
  updated_at
`

function canonicalScopeRef(scopeRef: string): string {
  return formatCanonicalScopeRef({ scopeRef })
}

function requirePositiveEpoch(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`placementEpoch must be a positive safe integer, got ${String(epoch)}`)
  }
  return epoch
}

function requireNodeId(nodeId: string, field: string): string {
  const normalized = nodeId.trim()
  if (normalized.length === 0) throw new Error(`${field} must not be empty`)
  return normalized
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function serializeAuthority(value: BirthAuthorityProvenance): string {
  if (typeof value.kind !== 'string' || value.kind.trim().length === 0) {
    throw new Error('authorityProvenance.kind must be a non-empty string')
  }
  return stableJson(value)
}

function parseAuthority(value: string): BirthAuthorityProvenance {
  const parsed = JSON.parse(value) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored authority provenance is not an object')
  }
  return parsed as BirthAuthorityProvenance
}

function mapBinding(row: PlacementRow): PlacementBinding {
  return {
    scopeRef: row.scope_ref,
    homeNodeId: row.home_node_id,
    placementEpoch: row.placement_epoch,
    birthClass: row.birth_class,
    authorityProvenance: parseAuthority(row.authority_provenance_json),
    establishmentProvenance: row.establishment_provenance,
    ...(row.prior_home_node_id === null ? {} : { priorHomeNodeId: row.prior_home_node_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRegistryRecord(row: RegistryRow): BindingRegistryRecord {
  const common = {
    scopeRef: row.scope_ref,
    placementEpoch: row.placement_epoch,
    birthClass: row.birth_class,
    authorityProvenance: parseAuthority(row.authority_provenance_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.state === 'active') {
    if (row.home_node_id === null || row.establishment_provenance === null) {
      throw new Error(`active registry row ${row.scope_ref} is missing active fields`)
    }
    return {
      state: 'active',
      ...common,
      homeNodeId: row.home_node_id,
      establishmentProvenance: row.establishment_provenance,
      ...(row.prior_home_node_id === null ? {} : { priorHomeNodeId: row.prior_home_node_id }),
    }
  }
  if (
    row.retired_home_node_id === null ||
    row.retired_at === null ||
    row.retirement_reason === null
  ) {
    throw new Error(`retired registry row ${row.scope_ref} is missing retirement fields`)
  }
  return {
    state: 'retired',
    ...common,
    retiredHomeNodeId: row.retired_home_node_id,
    retiredAt: row.retired_at,
    reason: row.retirement_reason,
    successorNodeId: row.successor_node_id,
  }
}

function activeBinding(record: BindingRegistryRecord): PlacementBinding | undefined {
  if (record.state !== 'active') return undefined
  const { state: _state, ...binding } = record
  return binding
}

function mapLedger(row: PlacementRow): PlacementLedgerRecord {
  return { ...mapBinding(row), state: row.state ?? 'active' }
}

function sameBinding(left: PlacementBinding, right: PlacementBinding): boolean {
  return (
    left.scopeRef === right.scopeRef &&
    left.homeNodeId === right.homeNodeId &&
    left.placementEpoch === right.placementEpoch &&
    left.birthClass === right.birthClass &&
    stableJson(left.authorityProvenance) === stableJson(right.authorityProvenance) &&
    left.establishmentProvenance === right.establishmentProvenance &&
    left.priorHomeNodeId === right.priorHomeNodeId
  )
}

function requireStoredBinding(
  binding: PlacementBinding | undefined,
  operation: string
): PlacementBinding {
  if (binding === undefined) {
    throw new Error(`binding registry invariant failed after ${operation}`)
  }
  return binding
}

function requireStoredLedger(
  record: PlacementLedgerRecord | undefined,
  operation: string
): PlacementLedgerRecord {
  if (record === undefined) {
    throw new Error(`placement ledger invariant failed after ${operation}`)
  }
  return record
}

export class PlacementEpochRegressionError extends Error {
  constructor(scopeRef: string, currentEpoch: number, attemptedEpoch: number) {
    super(
      `placement epoch regression for ${scopeRef}: current epoch ${currentEpoch}, attempted ${attemptedEpoch}`
    )
    this.name = 'PlacementEpochRegressionError'
  }
}

export class PlacementLedgerConflictError extends Error {
  constructor(scopeRef: string, epoch: number) {
    super(`conflicting placement ledger row for ${scopeRef} at epoch ${epoch}`)
    this.name = 'PlacementLedgerConflictError'
  }
}

function ensurePlacementLedgerSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_ledger (
      scope_ref TEXT PRIMARY KEY,
      home_node_id TEXT NOT NULL,
      placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
      birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
      authority_provenance_json TEXT NOT NULL,
      establishment_provenance TEXT NOT NULL CHECK (
        establishment_provenance IN (
          'pin',
          'task_default',
          'default_home_node',
          'default_home_node(local)',
          'explicit_local',
          'rebind'
        )
      ),
      prior_home_node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('placement_ledger')?.sql
  if (schema?.includes("'task_default'")) return

  // T-06697 widens a CHECK-constrained vocabulary. SQLite cannot alter a
  // CHECK in place, so preserve every row while rebuilding the table once.
  db.transaction(() => {
    db.exec(`
      ALTER TABLE placement_ledger RENAME TO placement_ledger_legacy_t06697;
      CREATE TABLE placement_ledger (
        scope_ref TEXT PRIMARY KEY,
        home_node_id TEXT NOT NULL,
        placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
        authority_provenance_json TEXT NOT NULL,
        establishment_provenance TEXT NOT NULL CHECK (
          establishment_provenance IN (
            'pin',
            'task_default',
            'default_home_node',
            'default_home_node(local)',
            'explicit_local',
            'rebind'
          )
        ),
        prior_home_node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO placement_ledger (${LEDGER_COLUMNS})
      SELECT ${LEDGER_COLUMNS} FROM placement_ledger_legacy_t06697;
      DROP TABLE placement_ledger_legacy_t06697;
    `)
  }).immediate()
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

  installActive(input: InstallActivePlacementInput): PlacementLedgerRecord {
    const normalized: PlacementLedgerRecord = {
      scopeRef: canonicalScopeRef(input.scopeRef),
      homeNodeId: requireNodeId(input.homeNodeId, 'homeNodeId'),
      placementEpoch: requirePositiveEpoch(input.placementEpoch),
      state: 'active',
      birthClass: input.birthClass,
      authorityProvenance: input.authorityProvenance,
      establishmentProvenance: input.establishmentProvenance,
      ...(input.priorHomeNodeId === undefined
        ? {}
        : { priorHomeNodeId: requireNodeId(input.priorHomeNodeId, 'priorHomeNodeId') }),
      createdAt: input.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt,
    }
    const authorityJson = serializeAuthority(normalized.authorityProvenance)

    return this.db
      .transaction(() => {
        const current = this.get(normalized.scopeRef)
        if (current !== undefined) {
          if (normalized.placementEpoch < current.placementEpoch) {
            throw new PlacementEpochRegressionError(
              normalized.scopeRef,
              current.placementEpoch,
              normalized.placementEpoch
            )
          }
          if (normalized.placementEpoch === current.placementEpoch) {
            if (current.state === 'active' && sameBinding(current, normalized)) return current
            throw new PlacementLedgerConflictError(normalized.scopeRef, normalized.placementEpoch)
          }
        }

        this.db
          .query(
            `
            INSERT INTO placement_ledger (${LEDGER_COLUMNS})
            VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope_ref) DO UPDATE SET
              home_node_id = excluded.home_node_id,
              placement_epoch = excluded.placement_epoch,
              state = excluded.state,
              birth_class = excluded.birth_class,
              authority_provenance_json = excluded.authority_provenance_json,
              establishment_provenance = excluded.establishment_provenance,
              prior_home_node_id = excluded.prior_home_node_id,
              updated_at = excluded.updated_at
          `
          )
          .run(
            normalized.scopeRef,
            normalized.homeNodeId,
            normalized.placementEpoch,
            normalized.birthClass,
            authorityJson,
            normalized.establishmentProvenance,
            normalized.priorHomeNodeId ?? null,
            normalized.createdAt,
            normalized.updatedAt
          )
        return requireStoredLedger(this.get(normalized.scopeRef), 'install')
      })
      .immediate()
  }
}

export function createPlacementLedgerRepository(db: Database): PlacementLedgerRepository {
  return new PlacementLedgerRepository(db)
}

/** Read-only reconstruction surface; returns no rows for a pre-federation DB. */
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
      state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
      placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
      birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
      authority_provenance_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      home_node_id TEXT,
      establishment_provenance TEXT CHECK (
        establishment_provenance IN (
          'pin',
          'task_default',
          'default_home_node',
          'default_home_node(local)',
          'explicit_local',
          'rebind'
        )
      ),
      prior_home_node_id TEXT,
      retired_home_node_id TEXT,
      retired_at TEXT,
      retirement_reason TEXT,
      successor_node_id TEXT,
      CHECK (
        (
          state = 'active' AND
          home_node_id IS NOT NULL AND
          establishment_provenance IS NOT NULL AND
          retired_home_node_id IS NULL AND
          retired_at IS NULL AND
          retirement_reason IS NULL AND
          successor_node_id IS NULL
        ) OR (
          state = 'retired' AND
          home_node_id IS NULL AND
          establishment_provenance IS NULL AND
          prior_home_node_id IS NULL AND
          retired_home_node_id IS NOT NULL AND
          retired_at IS NOT NULL AND
          retirement_reason IS NOT NULL
        )
      )
    );
  `)
}

function createRegistryDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')

  const schema = db
    .query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get('binding_registry')?.sql
  if (schema === undefined) {
    createRegistryTable(db)
    return db
  }
  if (schema.includes("state TEXT NOT NULL CHECK (state IN ('active', 'retired'))")) return db

  // Existing registry rows are all active. Upgrade them in one SQLite
  // transaction so no observer can see a half-migrated authority table.
  db.transaction(() => {
    db.exec('ALTER TABLE binding_registry RENAME TO binding_registry_legacy_t06681;')
    createRegistryTable(db)
    db.exec(`
      INSERT INTO binding_registry (
        scope_ref,
        state,
        placement_epoch,
        birth_class,
        authority_provenance_json,
        created_at,
        updated_at,
        home_node_id,
        establishment_provenance,
        prior_home_node_id,
        retired_home_node_id,
        retired_at,
        retirement_reason,
        successor_node_id
      )
      SELECT
        scope_ref,
        'active',
        placement_epoch,
        birth_class,
        authority_provenance_json,
        created_at,
        updated_at,
        home_node_id,
        establishment_provenance,
        prior_home_node_id,
        NULL,
        NULL,
        NULL,
        NULL
      FROM binding_registry_legacy_t06681;
      DROP TABLE binding_registry_legacy_t06681;
    `)
  }).immediate()
  return db
}

export class BindingRegistry {
  constructor(readonly sqlite: Database) {}

  close(): void {
    this.sqlite.close()
  }

  getRecord(scopeRef: string): BindingRegistryRecord | undefined {
    const row = this.sqlite
      .query<RegistryRow, [string]>(
        `SELECT ${REGISTRY_COLUMNS} FROM binding_registry WHERE scope_ref = ?`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapRegistryRecord(row)
  }

  /** Compatibility active lookup. A tombstone is deliberately not a binding. */
  get(scopeRef: string): PlacementBinding | undefined {
    const record = this.getRecord(scopeRef)
    return record === undefined ? undefined : activeBinding(record)
  }

  list(): PlacementBinding[] {
    return this.sqlite
      .query<RegistryRow, []>(
        `SELECT ${REGISTRY_COLUMNS} FROM binding_registry WHERE state = 'active' ORDER BY scope_ref`
      )
      .all()
      .map(mapRegistryRecord)
      .map(activeBinding)
      .filter((binding): binding is PlacementBinding => binding !== undefined)
  }

  listRecords(): BindingRegistryRecord[] {
    return this.sqlite
      .query<RegistryRow, []>(`SELECT ${REGISTRY_COLUMNS} FROM binding_registry ORDER BY scope_ref`)
      .all()
      .map(mapRegistryRecord)
  }

  establish(input: EstablishBindingInput): BindingEstablishResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const homeNodeId = requireNodeId(input.homeNodeId, 'homeNodeId')
    const placementEpoch = requirePositiveEpoch(input.placementEpoch)
    if (placementEpoch !== 1) {
      throw new Error(`virgin establishment must use placementEpoch 1, got ${placementEpoch}`)
    }
    const authorityJson = serializeAuthority(input.authorityProvenance)

    return this.sqlite
      .transaction(() => {
        const current = this.getRecord(scopeRef)
        if (current?.state === 'retired') {
          return { outcome: 'retired', retirement: current }
        }
        if (current?.state === 'active') {
          const binding = activeBinding(current)
          if (binding === undefined) throw new Error('active registry record mapping failed')
          return { outcome: 'existing', binding }
        }
        const result = this.sqlite
          .query(
            `
            INSERT INTO binding_registry (${REGISTRY_COLUMNS})
            VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
            ON CONFLICT(scope_ref) DO NOTHING
          `
          )
          .run(
            scopeRef,
            placementEpoch,
            input.birthClass,
            authorityJson,
            input.now,
            input.now,
            homeNodeId,
            input.establishmentProvenance
          )
        const stored = this.getRecord(scopeRef)
        if (stored?.state === 'retired') return { outcome: 'retired', retirement: stored }
        return {
          outcome: result.changes === 1 ? 'created' : 'existing',
          binding: requireStoredBinding(this.get(scopeRef), 'establishment'),
        }
      })
      .immediate() as BindingEstablishResult
  }

  compareAndSwap(input: BindingCasInput): BindingCasResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedHome = requireNodeId(input.expectedHomeNodeId, 'expectedHomeNodeId')
    const expectedEpoch = requirePositiveEpoch(input.expectedPlacementEpoch)
    const newHome = requireNodeId(input.newHomeNodeId, 'newHomeNodeId')
    if (newHome === expectedHome) {
      throw new Error('binding CAS newHomeNodeId must differ from expectedHomeNodeId')
    }
    if (expectedEpoch === Number.MAX_SAFE_INTEGER) {
      throw new Error(`placement epoch exhausted for ${scopeRef}`)
    }
    const nextEpoch = expectedEpoch + 1

    return this.sqlite
      .transaction(() => {
        const record = this.getRecord(scopeRef)
        if (record?.state === 'retired') {
          return { outcome: 'conflict', retirement: record }
        }
        const current = record === undefined ? undefined : activeBinding(record)
        if (current === undefined) return { outcome: 'not_found' }
        if (
          current.homeNodeId === newHome &&
          current.placementEpoch === nextEpoch &&
          current.priorHomeNodeId === expectedHome
        ) {
          return { outcome: 'idempotent', binding: current }
        }
        if (current.homeNodeId !== expectedHome || current.placementEpoch !== expectedEpoch) {
          return { outcome: 'conflict', binding: current }
        }

        this.sqlite
          .query(
            `
            UPDATE binding_registry
            SET home_node_id = ?,
                placement_epoch = ?,
                establishment_provenance = 'rebind',
                prior_home_node_id = ?,
                updated_at = ?
            WHERE scope_ref = ? AND state = 'active' AND home_node_id = ? AND placement_epoch = ?
          `
          )
          .run(newHome, nextEpoch, expectedHome, input.now, scopeRef, expectedHome, expectedEpoch)
        return {
          outcome: 'updated',
          binding: requireStoredBinding(this.get(scopeRef), 'compare-and-swap'),
        }
      })
      .immediate() as BindingCasResult
  }

  retire(input: RetireBindingInput): RetireBindingResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedHomeNodeId = requireNodeId(input.expectedHomeNodeId, 'expectedHomeNodeId')
    const expectedPlacementEpoch = requirePositiveEpoch(input.expectedPlacementEpoch)
    const successorNodeId =
      input.successorNodeId === null
        ? null
        : requireNodeId(input.successorNodeId, 'successorNodeId')
    if (input.reason.trim().length === 0) throw new Error('retirement reason must not be empty')

    return this.sqlite
      .transaction(() => {
        const current = this.getRecord(scopeRef)
        if (current === undefined) return { outcome: 'not_found' }
        if (current.state === 'retired') {
          if (
            current.retiredHomeNodeId === expectedHomeNodeId &&
            current.placementEpoch === expectedPlacementEpoch &&
            current.successorNodeId === successorNodeId &&
            current.reason === input.reason &&
            current.retiredAt === input.retiredAt
          ) {
            return { outcome: 'idempotent', retirement: current }
          }
          return { outcome: 'conflict', retirement: current }
        }
        const binding = activeBinding(current)
        if (binding === undefined) throw new Error('active registry record mapping failed')
        if (
          binding.homeNodeId !== expectedHomeNodeId ||
          binding.placementEpoch !== expectedPlacementEpoch
        ) {
          return { outcome: 'conflict', binding }
        }

        const changed = this.sqlite
          .query(
            `UPDATE binding_registry
             SET state = 'retired',
                 home_node_id = NULL,
                 establishment_provenance = NULL,
                 prior_home_node_id = NULL,
                 retired_home_node_id = ?,
                 retired_at = ?,
                 retirement_reason = ?,
                 successor_node_id = ?,
                 updated_at = ?
             WHERE scope_ref = ?
               AND state = 'active'
               AND home_node_id = ?
               AND placement_epoch = ?`
          )
          .run(
            expectedHomeNodeId,
            input.retiredAt,
            input.reason,
            successorNodeId,
            input.retiredAt,
            scopeRef,
            expectedHomeNodeId,
            expectedPlacementEpoch
          )
        if (changed.changes !== 1) return { outcome: 'conflict', binding }
        const retirement = this.getRecord(scopeRef)
        if (retirement?.state !== 'retired') {
          throw new Error('binding registry invariant failed after retirement')
        }
        return { outcome: 'retired', retirement }
      })
      .immediate() as RetireBindingResult
  }

  activateRetired(input: ActivateRetiredBindingInput): ActivateRetiredBindingResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const successorNodeId = requireNodeId(input.successorNodeId, 'successorNodeId')
    const expectedPlacementEpoch = requirePositiveEpoch(input.expectedPlacementEpoch)
    if (expectedPlacementEpoch === Number.MAX_SAFE_INTEGER) {
      return { outcome: 'epoch_exhausted' }
    }
    const nextEpoch = expectedPlacementEpoch + 1

    return this.sqlite
      .transaction(() => {
        const current = this.getRecord(scopeRef)
        if (current === undefined) return { outcome: 'not_found' }
        if (current.state === 'active') {
          const binding = activeBinding(current)
          if (binding === undefined) throw new Error('active registry record mapping failed')
          if (binding.homeNodeId === successorNodeId && binding.placementEpoch === nextEpoch) {
            return { outcome: 'idempotent', binding }
          }
          return { outcome: 'conflict', binding }
        }
        if (current.birthClass === 'mechanism-born') {
          return { outcome: 'mechanism_refused', retirement: current }
        }
        if (
          current.placementEpoch !== expectedPlacementEpoch ||
          current.successorNodeId !== successorNodeId
        ) {
          return { outcome: 'conflict', retirement: current }
        }

        const changed = this.sqlite
          .query(
            `UPDATE binding_registry
             SET state = 'active',
                 placement_epoch = ?,
                 home_node_id = ?,
                 establishment_provenance = 'rebind',
                 prior_home_node_id = retired_home_node_id,
                 retired_home_node_id = NULL,
                 retired_at = NULL,
                 retirement_reason = NULL,
                 successor_node_id = NULL,
                 updated_at = ?
             WHERE scope_ref = ?
               AND state = 'retired'
               AND placement_epoch = ?
               AND successor_node_id = ?`
          )
          .run(
            nextEpoch,
            successorNodeId,
            input.now,
            scopeRef,
            expectedPlacementEpoch,
            successorNodeId
          )
        if (changed.changes !== 1) return { outcome: 'conflict', retirement: current }
        return {
          outcome: 'activated',
          binding: requireStoredBinding(this.get(scopeRef), 'retired activation'),
        }
      })
      .immediate() as ActivateRetiredBindingResult
  }

  retargetRetired(input: RetargetRetiredBindingInput): RetargetRetiredBindingResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedPlacementEpoch = requirePositiveEpoch(input.expectedPlacementEpoch)
    const expectedSuccessorNodeId =
      input.expectedSuccessorNodeId === null
        ? null
        : requireNodeId(input.expectedSuccessorNodeId, 'expectedSuccessorNodeId')
    const newSuccessorNodeId =
      input.newSuccessorNodeId === null
        ? null
        : requireNodeId(input.newSuccessorNodeId, 'newSuccessorNodeId')
    if (expectedPlacementEpoch === Number.MAX_SAFE_INTEGER) {
      return { outcome: 'epoch_exhausted' }
    }
    const nextEpoch = expectedPlacementEpoch + 1

    return this.sqlite
      .transaction(() => {
        const current = this.getRecord(scopeRef)
        if (current === undefined) return { outcome: 'not_found' }
        if (current.state === 'active')
          return { outcome: 'conflict', binding: activeBinding(current) }
        if (
          current.placementEpoch !== expectedPlacementEpoch ||
          current.successorNodeId !== expectedSuccessorNodeId
        ) {
          return { outcome: 'conflict', retirement: current }
        }
        this.sqlite
          .query(
            `UPDATE binding_registry
             SET placement_epoch = ?, successor_node_id = ?, updated_at = ?
             WHERE scope_ref = ? AND state = 'retired' AND placement_epoch = ?
               AND successor_node_id IS ?`
          )
          .run(
            nextEpoch,
            newSuccessorNodeId,
            input.now,
            scopeRef,
            expectedPlacementEpoch,
            expectedSuccessorNodeId
          )
        const retirement = this.getRecord(scopeRef)
        if (retirement?.state !== 'retired') {
          throw new Error('binding registry invariant failed after retirement retarget')
        }
        return { outcome: 'updated', retirement }
      })
      .immediate() as RetargetRetiredBindingResult
  }

  /** Rebuild-only insertion. The target registry must be empty. */
  insertRebuilt(record: BindingRegistryRecord | PlacementBinding): void {
    if ('state' in record && record.state === 'retired') {
      this.sqlite
        .query(
          `INSERT INTO binding_registry (${REGISTRY_COLUMNS})
           VALUES (?, 'retired', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`
        )
        .run(
          canonicalScopeRef(record.scopeRef),
          requirePositiveEpoch(record.placementEpoch),
          record.birthClass,
          serializeAuthority(record.authorityProvenance),
          record.createdAt,
          record.updatedAt,
          requireNodeId(record.retiredHomeNodeId, 'retiredHomeNodeId'),
          record.retiredAt,
          record.reason,
          record.successorNodeId
        )
      return
    }
    const binding = record as PlacementBinding
    this.sqlite
      .query(
        `INSERT INTO binding_registry (${REGISTRY_COLUMNS})
         VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
      )
      .run(
        canonicalScopeRef(binding.scopeRef),
        requirePositiveEpoch(binding.placementEpoch),
        binding.birthClass,
        serializeAuthority(binding.authorityProvenance),
        binding.createdAt,
        binding.updatedAt,
        requireNodeId(binding.homeNodeId, 'homeNodeId'),
        binding.establishmentProvenance,
        binding.priorHomeNodeId ?? null
      )
  }
}

export function openBindingRegistry(path: string): BindingRegistry {
  return new BindingRegistry(createRegistryDatabase(path))
}

export function rebuildBindingRegistryFromLedgers(
  target: BindingRegistry,
  ledgerRows: readonly PlacementLedgerRecord[],
  retirementFences: readonly ScopeRetirementRecord[] = []
): { inserted: number; duplicates: number } {
  if (target.listRecords().length !== 0) {
    throw new Error('binding registry rebuild target must be empty')
  }

  const selected = new Map<string, PlacementLedgerRecord>()
  const rowsByScopeAndEpoch = new Map<string, PlacementLedgerRecord[]>()
  let duplicates = 0
  for (const row of ledgerRows) {
    const scopeRef = canonicalScopeRef(row.scopeRef)
    const epochKey = `${scopeRef}\u0000${String(row.placementEpoch)}`
    const epochRows = rowsByScopeAndEpoch.get(epochKey) ?? []
    epochRows.push({ ...row, scopeRef })
    rowsByScopeAndEpoch.set(epochKey, epochRows)
    const current = selected.get(scopeRef)
    if (current === undefined || row.placementEpoch > current.placementEpoch) {
      selected.set(scopeRef, { ...row, scopeRef })
      continue
    }
    if (row.placementEpoch < current.placementEpoch) continue
    if (!sameBinding(current, row)) {
      throw new PlacementLedgerConflictError(scopeRef, row.placementEpoch)
    }
    duplicates += 1
  }

  const selectedFences = new Map<string, ScopeRetirementRecord>()
  for (const fence of retirementFences) {
    const scopeRef = canonicalScopeRef(fence.scopeRef)
    const normalized = { ...fence, scopeRef }
    const current = selectedFences.get(scopeRef)
    if (current === undefined || fence.retiredPlacementEpoch > current.retiredPlacementEpoch) {
      selectedFences.set(scopeRef, normalized)
      continue
    }
    if (fence.retiredPlacementEpoch < current.retiredPlacementEpoch) continue
    if (
      current.retiredNodeId !== normalized.retiredNodeId ||
      current.successorNodeId !== normalized.successorNodeId ||
      current.reason !== normalized.reason
    ) {
      throw new PlacementLedgerConflictError(scopeRef, fence.retiredPlacementEpoch)
    }
    duplicates += 1
  }

  const rebuiltRecords = new Map<string, BindingRegistryRecord | PlacementBinding>()
  const scopeRefs = new Set([...selected.keys(), ...selectedFences.keys()])
  for (const scopeRef of scopeRefs) {
    const highestLedger = selected.get(scopeRef)
    const fence = selectedFences.get(scopeRef)
    if (fence === undefined) {
      if (highestLedger?.state === 'active') rebuiltRecords.set(scopeRef, highestLedger)
      continue
    }
    if (
      highestLedger?.state === 'active' &&
      highestLedger.placementEpoch > fence.retiredPlacementEpoch
    ) {
      rebuiltRecords.set(scopeRef, highestLedger)
      continue
    }

    const epochRows =
      rowsByScopeAndEpoch.get(`${scopeRef}\u0000${String(fence.retiredPlacementEpoch)}`) ?? []
    const retiredLedger = epochRows.find((row) => row.homeNodeId === fence.retiredNodeId)
    if (retiredLedger === undefined) {
      throw new Error(
        `cannot rebuild retirement for ${scopeRef} at epoch ${fence.retiredPlacementEpoch}: matching retired-home ledger metadata is absent`
      )
    }
    rebuiltRecords.set(scopeRef, {
      state: 'retired',
      scopeRef,
      placementEpoch: fence.retiredPlacementEpoch,
      birthClass: retiredLedger.birthClass,
      authorityProvenance: retiredLedger.authorityProvenance,
      createdAt: retiredLedger.createdAt,
      updatedAt: fence.retiredAt,
      retiredHomeNodeId: fence.retiredNodeId,
      retiredAt: fence.retiredAt,
      reason: fence.reason,
      successorNodeId: fence.successorNodeId,
    })
  }

  target.sqlite
    .transaction(() => {
      for (const record of [...rebuiltRecords.values()].sort((a, b) =>
        a.scopeRef.localeCompare(b.scopeRef)
      )) {
        target.insertRebuilt(record)
      }
    })
    .immediate()
  return { inserted: rebuiltRecords.size, duplicates }
}

const T06681_F0_RETIREMENTS = [
  {
    scopeRef: 'agent:cody:project:agent-control-plane:task:wrkq-refactor',
    retiredHomeNodeId: 'svc',
    placementEpoch: 1,
    successorNodeId: 'lab',
    correctedAuthority: {
      kind: 'policy',
      source: 'pin',
      pinKey: 'agent-control-plane:wrkq-refactor',
      designatedNodeId: 'lab',
      rationaleRef: 'T-06681/Lance-ruling-A',
    },
  },
  {
    scopeRef: 'agent:cody:project:hrc-runtime:task:pin-probe',
    retiredHomeNodeId: 'svc',
    placementEpoch: 1,
    successorNodeId: null,
    correctedAuthority: null,
  },
  {
    scopeRef: 'agent:mable:project:hrc-runtime:task:max3',
    retiredHomeNodeId: 'svc',
    placementEpoch: 1,
    successorNodeId: 'max3',
    correctedAuthority: {
      kind: 'policy',
      source: 'reconciliation-ruling',
      designatedNodeId: 'max3',
      rationaleRef: 'T-06681/Lance-ruling-A',
    },
  },
] as const

export type T06681F0RetirementMigrationResult = {
  dryRun: boolean
  rows: Array<{
    scopeRef: string
    action: 'would_insert' | 'inserted' | 'existing'
    retirement: RegistryRetirementRecord
  }>
}

/**
 * One-time, exact F0 data correction from T-06681/Lance-ruling-A.
 *
 * This deliberately accepts no caller-selected scopes, birth classes,
 * successors, or authority payloads. It is not a general identity rewrite
 * capability: the three identities and two policy corrections are embedded in
 * source, while pin-probe preserves its mechanism-born ledger identity.
 */
export function applyT06681F0RetirementMigration(input: {
  target: BindingRegistry
  ledgerRows: readonly PlacementLedgerRecord[]
  retirementFences: readonly ScopeRetirementRecord[]
  dryRun: boolean
}): T06681F0RetirementMigrationResult {
  const planned = T06681_F0_RETIREMENTS.map((disposition) => {
    const fence = input.retirementFences.find(
      (candidate) =>
        canonicalScopeRef(candidate.scopeRef) === disposition.scopeRef &&
        candidate.retiredNodeId === disposition.retiredHomeNodeId &&
        candidate.retiredPlacementEpoch === disposition.placementEpoch &&
        candidate.successorNodeId === disposition.successorNodeId
    )
    if (fence === undefined) {
      throw new Error(
        `T-06681 F0 migration requires the exact retirement fence for ${disposition.scopeRef}`
      )
    }
    const ledger = input.ledgerRows.find(
      (candidate) =>
        canonicalScopeRef(candidate.scopeRef) === disposition.scopeRef &&
        candidate.homeNodeId === disposition.retiredHomeNodeId &&
        candidate.placementEpoch === disposition.placementEpoch
    )
    if (ledger === undefined) {
      throw new Error(
        `T-06681 F0 migration requires retired-home ledger metadata for ${disposition.scopeRef}`
      )
    }
    if (disposition.correctedAuthority === null && ledger.birthClass !== 'mechanism-born') {
      throw new Error('T-06681 pin-probe migration must preserve a mechanism-born identity')
    }
    const retirement: RegistryRetirementRecord = {
      state: 'retired',
      scopeRef: disposition.scopeRef,
      placementEpoch: disposition.placementEpoch,
      birthClass: disposition.correctedAuthority === null ? ledger.birthClass : 'policy-born',
      authorityProvenance:
        disposition.correctedAuthority === null
          ? ledger.authorityProvenance
          : disposition.correctedAuthority,
      createdAt: ledger.createdAt,
      updatedAt: fence.retiredAt,
      retiredHomeNodeId: disposition.retiredHomeNodeId,
      retiredAt: fence.retiredAt,
      reason: fence.reason,
      successorNodeId: disposition.successorNodeId,
    }
    const current = input.target.getRecord(disposition.scopeRef)
    if (current !== undefined) {
      if (
        current.state !== 'retired' ||
        current.placementEpoch !== retirement.placementEpoch ||
        current.retiredHomeNodeId !== retirement.retiredHomeNodeId ||
        current.successorNodeId !== retirement.successorNodeId ||
        current.birthClass !== retirement.birthClass ||
        stableJson(current.authorityProvenance) !== stableJson(retirement.authorityProvenance) ||
        current.createdAt !== retirement.createdAt ||
        current.retiredAt !== retirement.retiredAt ||
        current.reason !== retirement.reason
      ) {
        throw new Error(
          `T-06681 F0 migration conflicts with registry authority for ${disposition.scopeRef}`
        )
      }
      return { action: 'existing' as const, retirement: current }
    }
    return { action: input.dryRun ? ('would_insert' as const) : ('inserted' as const), retirement }
  })

  if (!input.dryRun) {
    input.target.sqlite
      .transaction(() => {
        for (const row of planned) {
          if (row.action === 'inserted') input.target.insertRebuilt(row.retirement)
        }
      })
      .immediate()
  }

  return {
    dryRun: input.dryRun,
    rows: planned.map((row) => ({
      scopeRef: row.retirement.scopeRef,
      action: row.action,
      retirement: row.retirement,
    })),
  }
}
