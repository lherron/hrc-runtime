import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { formatCanonicalScopeRef } from 'hrc-core'

export type FederationBirthClass = 'policy-born' | 'mechanism-born'
export type PlacementLedgerState = 'active' | 'revoked'
export type EstablishmentProvenance =
  | 'pin'
  | 'default_home_node'
  | 'default_home_node(local)'
  | 'explicit_local'
  | 'rebind'

export type BirthAuthorityProvenance = Readonly<Record<string, unknown>> & {
  readonly kind: string
}

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

export type PlacementLedgerRecord = PlacementBinding & {
  state: PlacementLedgerState
}

export type InstallActivePlacementInput = Omit<PlacementLedgerRecord, 'state' | 'createdAt'> & {
  createdAt?: string | undefined
  state?: 'active' | undefined
}

export type EstablishBindingInput = Omit<
  PlacementBinding,
  'createdAt' | 'updatedAt' | 'priorHomeNodeId'
> & {
  now: string
}

export type BindingEstablishResult = {
  outcome: 'created' | 'existing'
  binding: PlacementBinding
}

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

const BINDING_COLUMNS = `
  scope_ref,
  home_node_id,
  placement_epoch,
  birth_class,
  authority_provenance_json,
  establishment_provenance,
  prior_home_node_id,
  created_at,
  updated_at
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

    return this.db.transaction(() => {
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
      return this.get(normalized.scopeRef)!
    }).immediate()
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

function createRegistryDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS binding_registry (
      scope_ref TEXT PRIMARY KEY,
      home_node_id TEXT NOT NULL,
      placement_epoch INTEGER NOT NULL CHECK (placement_epoch >= 1),
      birth_class TEXT NOT NULL CHECK (birth_class IN ('policy-born', 'mechanism-born')),
      authority_provenance_json TEXT NOT NULL,
      establishment_provenance TEXT NOT NULL CHECK (
        establishment_provenance IN (
          'pin',
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
  return db
}

export class BindingRegistry {
  constructor(readonly sqlite: Database) {}

  close(): void {
    this.sqlite.close()
  }

  get(scopeRef: string): PlacementBinding | undefined {
    const row = this.sqlite
      .query<PlacementRow, [string]>(
        `SELECT ${BINDING_COLUMNS} FROM binding_registry WHERE scope_ref = ?`
      )
      .get(canonicalScopeRef(scopeRef))
    return row === null ? undefined : mapBinding(row)
  }

  list(): PlacementBinding[] {
    return this.sqlite
      .query<PlacementRow, []>(`SELECT ${BINDING_COLUMNS} FROM binding_registry ORDER BY scope_ref`)
      .all()
      .map(mapBinding)
  }

  establish(input: EstablishBindingInput): BindingEstablishResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const homeNodeId = requireNodeId(input.homeNodeId, 'homeNodeId')
    const placementEpoch = requirePositiveEpoch(input.placementEpoch)
    if (placementEpoch !== 1) {
      throw new Error(`virgin establishment must use placementEpoch 1, got ${placementEpoch}`)
    }
    const authorityJson = serializeAuthority(input.authorityProvenance)

    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `
            INSERT INTO binding_registry (${BINDING_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(scope_ref) DO NOTHING
          `
        )
        .run(
          scopeRef,
          homeNodeId,
          placementEpoch,
          input.birthClass,
          authorityJson,
          input.establishmentProvenance,
          input.now,
          input.now
        )
      return {
        outcome: result.changes === 1 ? 'created' : 'existing',
        binding: this.get(scopeRef)!,
      }
    }).immediate() as BindingEstablishResult
  }

  compareAndSwap(input: BindingCasInput): BindingCasResult {
    const scopeRef = canonicalScopeRef(input.scopeRef)
    const expectedHome = requireNodeId(input.expectedHomeNodeId, 'expectedHomeNodeId')
    const expectedEpoch = requirePositiveEpoch(input.expectedPlacementEpoch)
    const newHome = requireNodeId(input.newHomeNodeId, 'newHomeNodeId')
    const nextEpoch = expectedEpoch + 1

    return this.sqlite.transaction(() => {
      const current = this.get(scopeRef)
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
            WHERE scope_ref = ? AND home_node_id = ? AND placement_epoch = ?
          `
        )
        .run(newHome, nextEpoch, expectedHome, input.now, scopeRef, expectedHome, expectedEpoch)
      return { outcome: 'updated', binding: this.get(scopeRef)! }
    }).immediate() as BindingCasResult
  }

  /** Rebuild-only insertion. The target registry must be empty. */
  insertRebuilt(binding: PlacementBinding): void {
    this.sqlite
      .query(
        `
          INSERT INTO binding_registry (${BINDING_COLUMNS})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        canonicalScopeRef(binding.scopeRef),
        requireNodeId(binding.homeNodeId, 'homeNodeId'),
        requirePositiveEpoch(binding.placementEpoch),
        binding.birthClass,
        serializeAuthority(binding.authorityProvenance),
        binding.establishmentProvenance,
        binding.priorHomeNodeId ?? null,
        binding.createdAt,
        binding.updatedAt
      )
  }
}

export function openBindingRegistry(path: string): BindingRegistry {
  return new BindingRegistry(createRegistryDatabase(path))
}

export function rebuildBindingRegistryFromLedgers(
  target: BindingRegistry,
  ledgerRows: readonly PlacementLedgerRecord[]
): { inserted: number; duplicates: number } {
  if (target.list().length !== 0) {
    throw new Error('binding registry rebuild target must be empty')
  }

  const selected = new Map<string, PlacementLedgerRecord>()
  let duplicates = 0
  for (const row of ledgerRows) {
    const scopeRef = canonicalScopeRef(row.scopeRef)
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

  target.sqlite.transaction(() => {
    for (const binding of [...selected.values()].sort((a, b) =>
      a.scopeRef.localeCompare(b.scopeRef)
    )) {
      target.insertRebuilt(binding)
    }
  }).immediate()
  return { inserted: selected.size, duplicates }
}
