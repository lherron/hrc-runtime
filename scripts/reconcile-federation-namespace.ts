import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { formatCanonicalScopeRef } from 'hrc-core'
import {
  BindingRegistry,
  ScopeRetirementConflictError,
  createScopeRetirementRepository,
  openBindingRegistry,
  readPlacementLedgerRows,
  readScopeRetirements,
} from '../packages/hrc-store-sqlite/src/index.ts'
import type {
  BindingRegistryRecord,
  FederationBirthClass,
  PlacementBinding,
  PlacementLedgerRecord,
  RegistryRetirementRecord,
  ScopeRetirementRecord,
} from '../packages/hrc-store-sqlite/src/index.ts'

export type NamespaceNodeStore = { nodeId: string; path: string }

export type AdvisoryCreation = {
  scopeRef: string
  nodeId: string
  occurredAt: string
  decision: string
}

export type NamespaceOccurrence = {
  nodeId: string
  hostSessionIds: string[]
  lastActivityAt?: string | undefined
  continuationPresent: boolean
  retired: boolean
  retirement?: ScopeRetirementRecord | undefined
  placement?: PlacementLedgerRecord | undefined
}

export type NamespaceScopeInventory = {
  scopeRef: string
  binding?: PlacementBinding | undefined
  registryRetirement?: RegistryRetirementRecord | undefined
  nodes: NamespaceOccurrence[]
  advisoryCreations: AdvisoryCreation[]
}

export type UnreconciledReason =
  | 'binding_missing'
  | 'binding_home_missing'
  | 'multiple_unretired_nodes'
  | 'off_home_unretired'
  | 'retired_canonical_node'
  | 'registry_retirement_fence_missing'

export type UnreconciledScope = { scopeRef: string; reasons: UnreconciledReason[] }

export type ExcludedSystemRef = {
  scopeRef: string
  nodeId: string
  sessionCount: number
}

export type RuledRetirementDisposition = {
  scopeRef: string
  retiredNodeId: string
  retiredPlacementEpoch: number
  successorNodeId: string | null
  rationaleRef: string
}

export type RuledVirginExclusion = {
  scopeRef: string
  rationaleRef: string
  disposition: 'pin-governed-deferred'
}

export type NamespaceInventoryReport = {
  generatedAt: string
  scopes: NamespaceScopeInventory[]
  excludedSystemRefs: ExcludedSystemRef[]
  excludedVirginScopes: RuledVirginExclusion[]
  remainingUnreconciled: UnreconciledScope[]
  f1EnablementBlocked: boolean
}

// summon-gate.ts documents this synthetic bookkeeping row as deliberately
// outside agent admission. Keep the reconciliation exemption equally narrow
// and visible: every other non-agent ref remains a hard inventory failure.
const EXCLUDED_SYSTEM_SESSION_REFS = new Set(['system:hrc/sweep'])

const RULED_RETIREMENTS = new Map<string, RuledRetirementDisposition>([
  [
    'agent:cody:project:agent-control-plane:task:wrkq-refactor',
    {
      scopeRef: 'agent:cody:project:agent-control-plane:task:wrkq-refactor',
      retiredNodeId: 'svc',
      retiredPlacementEpoch: 1,
      successorNodeId: 'lab',
      rationaleRef: 'T-06681/Lance-ruling-A',
    },
  ],
  [
    'agent:cody:project:hrc-runtime:task:pin-probe',
    {
      scopeRef: 'agent:cody:project:hrc-runtime:task:pin-probe',
      retiredNodeId: 'svc',
      retiredPlacementEpoch: 1,
      successorNodeId: null,
      rationaleRef: 'T-06681/Lance-ruling-A',
    },
  ],
  [
    'agent:mable:project:hrc-runtime:task:max3',
    {
      scopeRef: 'agent:mable:project:hrc-runtime:task:max3',
      retiredNodeId: 'svc',
      retiredPlacementEpoch: 1,
      successorNodeId: 'max3',
      rationaleRef: 'T-06681/Lance-ruling-A',
    },
  ],
])

const RULED_VIRGIN_EXCLUSIONS = new Map<string, RuledVirginExclusion>([
  [
    'agent:mable:project:hrc-runtime:task:primary',
    {
      scopeRef: 'agent:mable:project:hrc-runtime:task:primary',
      rationaleRef: 'T-06616/DM#404',
      disposition: 'pin-governed-deferred',
    },
  ],
])

const USAGE = `usage:
  bun scripts/reconcile-federation-namespace.ts inventory \\
    --registry <binding-registry.sqlite> --node <nodeId>=<sqlite-backup>... \\
    [--exclude-virgin <allowlisted-scopeRef>]... \\
    [--advisory-log <normalized.jsonl>]...

  bun scripts/reconcile-federation-namespace.ts reconcile \\
    --registry <binding-registry.sqlite> --node <nodeId>=<sqlite-backup>... \\
    [--select <scopeRef>=<canonicalNodeId>]... \\
    [--retire <allowlisted-scopeRef>]... \\
    [--exclude-virgin <allowlisted-scopeRef>]... (--dry-run | --yes) \\
    [--advisory-log <normalized.jsonl>]...

  bun scripts/reconcile-federation-namespace.ts apply \\
    --node-id <declaredNodeId> --state <writable-state.sqlite> \\
    --artifact <reconcile-output.json> (--dry-run | --yes)

inventory is read-only. Remote live WAL databases must first be exported with
sqlite3 .backup; never pass a copied state.sqlite file. reconcile emits
node-addressed retirement steps and finalizes registry retirement only after
the matching fence is visible in the supplied node inventory. apply mutates
exactly one explicit node-local store. --dry-run is non-mutating and --yes is
required for application. Output is reviewable JSON and remainingUnreconciled
is the current F1-enablement blocker list.`

type SessionInventoryRow = {
  scope_ref: string
  host_session_id: string
  updated_at: string
  continuation_json: string | null
}

type RuntimeActivityRow = { scope_ref: string; activity_at: string }

function canonicalScopeRef(scopeRef: string): string {
  return formatCanonicalScopeRef({ scopeRef })
}

function resolveRuledRetirements(scopeRefs: readonly string[]): RuledRetirementDisposition[] {
  const seen = new Set<string>()
  return scopeRefs.map((rawScopeRef) => {
    const scopeRef = canonicalScopeRef(rawScopeRef)
    if (seen.has(scopeRef)) throw new Error(`duplicate retirement disposition for ${scopeRef}`)
    seen.add(scopeRef)
    const disposition = RULED_RETIREMENTS.get(scopeRef)
    if (disposition === undefined) {
      throw new Error(`${scopeRef} is not an allowlisted retirement disposition`)
    }
    return disposition
  })
}

function resolveRuledVirginExclusions(scopeRefs: readonly string[]): RuledVirginExclusion[] {
  const seen = new Set<string>()
  return scopeRefs.map((rawScopeRef) => {
    const scopeRef = canonicalScopeRef(rawScopeRef)
    if (seen.has(scopeRef)) throw new Error(`duplicate virgin exclusion for ${scopeRef}`)
    seen.add(scopeRef)
    const disposition = RULED_VIRGIN_EXCLUSIONS.get(scopeRef)
    if (disposition === undefined) {
      throw new Error(`${scopeRef} is not an allowlisted virgin exclusion`)
    }
    return disposition
  })
}

function requireNodeId(nodeId: string): string {
  const normalized = nodeId.trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(normalized) || normalized === 'local') {
    throw new Error(`invalid declared nodeId: ${nodeId}`)
  }
  return normalized
}

function maxTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return left >= right ? left : right
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table) !== null
  )
}

type LegacyRegistryRow = {
  scope_ref: string
  home_node_id: string
  placement_epoch: number
  birth_class: FederationBirthClass
  authority_provenance_json: string
  establishment_provenance: PlacementBinding['establishmentProvenance']
  prior_home_node_id: string | null
  created_at: string
  updated_at: string
}

function readRegistryRecords(path: string): BindingRegistryRecord[] {
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    if (!tableExists(db, 'binding_registry')) return []
    const schema = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'binding_registry'"
      )
      .get()?.sql
    if (schema?.includes("state TEXT NOT NULL CHECK (state IN ('active', 'retired'))")) {
      return new BindingRegistry(db).listRecords().map((record) => ({
        ...record,
        scopeRef: canonicalScopeRef(record.scopeRef),
      }))
    }
    return db
      .query<LegacyRegistryRow, []>(
        `SELECT
           scope_ref, home_node_id, placement_epoch, birth_class,
           authority_provenance_json, establishment_provenance,
           prior_home_node_id, created_at, updated_at
         FROM binding_registry ORDER BY scope_ref`
      )
      .all()
      .map((row) => ({
        state: 'active' as const,
        scopeRef: canonicalScopeRef(row.scope_ref),
        homeNodeId: row.home_node_id,
        placementEpoch: row.placement_epoch,
        birthClass: row.birth_class,
        authorityProvenance: JSON.parse(
          row.authority_provenance_json
        ) as PlacementBinding['authorityProvenance'],
        establishmentProvenance: row.establishment_provenance,
        ...(row.prior_home_node_id === null ? {} : { priorHomeNodeId: row.prior_home_node_id }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
  } finally {
    db.close()
  }
}

function readNodeStore(store: NamespaceNodeStore): {
  occurrences: Map<string, NamespaceOccurrence>
  retirements: ScopeRetirementRecord[]
  excludedSystemRefs: ExcludedSystemRef[]
} {
  const nodeId = requireNodeId(store.nodeId)
  if (!existsSync(store.path)) throw new Error(`node state store does not exist: ${store.path}`)
  const db = new Database(store.path, { readonly: true })
  try {
    const occurrences = new Map<string, NamespaceOccurrence>()
    const placements = new Map(readPlacementLedgerRows(db).map((row) => [row.scopeRef, row]))
    const retirements = readScopeRetirements(db)
    const retirementsByScope = new Map(retirements.map((row) => [row.scopeRef, row]))
    const sessionRows = tableExists(db, 'sessions')
      ? db
          .query<SessionInventoryRow, []>(
            `SELECT scope_ref, host_session_id, updated_at, continuation_json
             FROM sessions ORDER BY scope_ref, generation, host_session_id`
          )
          .all()
      : []
    const runtimeRows = tableExists(db, 'runtimes')
      ? db
          .query<RuntimeActivityRow, []>(
            `SELECT scope_ref, COALESCE(last_activity_at, updated_at) AS activity_at
             FROM runtimes`
          )
          .all()
      : []

    const excludedSessionCounts = new Map<string, number>()
    for (const row of sessionRows) {
      if (!row.scope_ref.startsWith('agent:')) {
        if (EXCLUDED_SYSTEM_SESSION_REFS.has(row.scope_ref)) {
          excludedSessionCounts.set(
            row.scope_ref,
            (excludedSessionCounts.get(row.scope_ref) ?? 0) + 1
          )
          continue
        }
        // Preserve the canonical parser's loud, stable diagnostic for every
        // unknown namespace rather than silently filtering it.
        canonicalScopeRef(row.scope_ref)
      }
      const scopeRef = canonicalScopeRef(row.scope_ref)
      const current = occurrences.get(scopeRef) ?? {
        nodeId,
        hostSessionIds: [],
        continuationPresent: false,
        retired: retirementsByScope.has(scopeRef),
        ...(retirementsByScope.get(scopeRef) === undefined
          ? {}
          : { retirement: retirementsByScope.get(scopeRef) }),
        ...(placements.get(scopeRef) === undefined ? {} : { placement: placements.get(scopeRef) }),
      }
      current.hostSessionIds.push(row.host_session_id)
      current.lastActivityAt = maxTimestamp(current.lastActivityAt, row.updated_at)
      current.continuationPresent ||= row.continuation_json !== null
      occurrences.set(scopeRef, current)
    }
    for (const row of runtimeRows) {
      const scopeRef = canonicalScopeRef(row.scope_ref)
      const current = occurrences.get(scopeRef)
      if (current !== undefined) {
        current.lastActivityAt = maxTimestamp(current.lastActivityAt, row.activity_at)
      }
    }
    for (const [scopeRef, placement] of placements) {
      if (occurrences.has(scopeRef)) continue
      const retirement = retirementsByScope.get(scopeRef)
      occurrences.set(scopeRef, {
        nodeId,
        hostSessionIds: [],
        continuationPresent: false,
        retired: retirement !== undefined,
        ...(retirement === undefined ? {} : { retirement }),
        placement,
      })
    }
    for (const retirement of retirements) {
      if (occurrences.has(retirement.scopeRef)) continue
      occurrences.set(retirement.scopeRef, {
        nodeId,
        hostSessionIds: [],
        continuationPresent: false,
        retired: true,
        retirement,
      })
    }
    return {
      occurrences,
      retirements,
      excludedSystemRefs: [...excludedSessionCounts]
        .map(([scopeRef, sessionCount]) => ({ scopeRef, nodeId, sessionCount }))
        .sort((a, b) => a.scopeRef.localeCompare(b.scopeRef)),
    }
  } finally {
    db.close()
  }
}

function blockerReasons(scope: NamespaceScopeInventory): UnreconciledReason[] {
  const reasons: UnreconciledReason[] = []
  const unretired = scope.nodes.filter((node) => !node.retired)
  const unretiredEvidenceNodeIds = new Set(unretired.map((node) => node.nodeId))
  for (const creation of scope.advisoryCreations) {
    const occurrence = scope.nodes.find((node) => node.nodeId === creation.nodeId)
    if (occurrence?.retired !== true) unretiredEvidenceNodeIds.add(creation.nodeId)
  }
  if (scope.registryRetirement !== undefined) {
    const retiredHome = scope.nodes.find(
      (node) => node.nodeId === scope.registryRetirement?.retiredHomeNodeId
    )
    if (
      retiredHome?.retirement === undefined ||
      retiredHome.retirement.retiredNodeId !== scope.registryRetirement.retiredHomeNodeId ||
      retiredHome.retirement.retiredPlacementEpoch !== scope.registryRetirement.placementEpoch ||
      retiredHome.retirement.successorNodeId !== scope.registryRetirement.successorNodeId
    ) {
      reasons.push('registry_retirement_fence_missing')
    }
    return reasons
  }
  // A scope whose every known node occurrence carries a retirement mark is an
  // intentionally virgin result, not a missing-binding blocker. A deleted
  // binding without its local mark still has unretired evidence and remains
  // loudly incomplete.
  if (scope.binding === undefined && unretiredEvidenceNodeIds.size > 0) {
    reasons.push('binding_missing')
  }
  if (unretiredEvidenceNodeIds.size > 1) reasons.push('multiple_unretired_nodes')
  if (scope.binding !== undefined) {
    const home = scope.nodes.find((node) => node.nodeId === scope.binding?.homeNodeId)
    if (home === undefined) reasons.push('binding_home_missing')
    else if (home.retired) reasons.push('retired_canonical_node')
    if ([...unretiredEvidenceNodeIds].some((nodeId) => nodeId !== scope.binding?.homeNodeId)) {
      reasons.push('off_home_unretired')
    }
  }
  return reasons
}

export function inventoryFederationNamespace(input: {
  nodeStores: readonly NamespaceNodeStore[]
  registryPath: string
  advisoryCreations?: readonly AdvisoryCreation[] | undefined
  excludeVirginScopeRefs?: readonly string[] | undefined
  generatedAt?: string | undefined
}): NamespaceInventoryReport {
  if (input.nodeStores.length === 0) throw new Error('at least one node state store is required')
  const nodeIds = new Set<string>()
  const byScope = new Map<string, NamespaceScopeInventory>()
  const excludedSystemRefs: ExcludedSystemRef[] = []
  for (const rawStore of input.nodeStores) {
    const store = { ...rawStore, nodeId: requireNodeId(rawStore.nodeId) }
    if (nodeIds.has(store.nodeId)) throw new Error(`duplicate nodeId input: ${store.nodeId}`)
    nodeIds.add(store.nodeId)
    const { occurrences, excludedSystemRefs: excluded } = readNodeStore(store)
    excludedSystemRefs.push(...excluded)
    for (const [scopeRef, occurrence] of occurrences) {
      const scope = byScope.get(scopeRef) ?? { scopeRef, nodes: [], advisoryCreations: [] }
      scope.nodes.push(occurrence)
      byScope.set(scopeRef, scope)
    }
  }
  for (const record of readRegistryRecords(input.registryPath)) {
    const scope = byScope.get(record.scopeRef) ?? {
      scopeRef: record.scopeRef,
      nodes: [],
      advisoryCreations: [],
    }
    if (record.state === 'active') {
      const { state: _state, ...binding } = record
      scope.binding = binding
    } else {
      scope.registryRetirement = record
    }
    byScope.set(record.scopeRef, scope)
  }
  for (const rawCreation of input.advisoryCreations ?? []) {
    const creation = {
      ...rawCreation,
      scopeRef: canonicalScopeRef(rawCreation.scopeRef),
      nodeId: requireNodeId(rawCreation.nodeId),
    }
    const scope = byScope.get(creation.scopeRef) ?? {
      scopeRef: creation.scopeRef,
      nodes: [],
      advisoryCreations: [],
    }
    scope.advisoryCreations.push(creation)
    byScope.set(creation.scopeRef, scope)
  }
  const scopes = [...byScope.values()]
    .map((scope) => ({
      ...scope,
      nodes: scope.nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      advisoryCreations: scope.advisoryCreations.sort((a, b) =>
        a.occurredAt.localeCompare(b.occurredAt)
      ),
    }))
    .sort((a, b) => a.scopeRef.localeCompare(b.scopeRef))
  const scopesByRef = new Map(scopes.map((scope) => [scope.scopeRef, scope]))
  const excludedVirginScopes = resolveRuledVirginExclusions(input.excludeVirginScopeRefs ?? [])
  for (const exclusion of excludedVirginScopes) {
    const scope = scopesByRef.get(exclusion.scopeRef)
    if (scope === undefined)
      throw new Error(`scope is absent from inventory: ${exclusion.scopeRef}`)
    if (scope.binding !== undefined || scope.registryRetirement !== undefined) {
      throw new Error(`virgin exclusion requires an unbound scope: ${exclusion.scopeRef}`)
    }
  }
  const excludedVirginRefs = new Set(excludedVirginScopes.map((item) => item.scopeRef))
  const remainingUnreconciled = scopes
    .map((scope) => ({ scopeRef: scope.scopeRef, reasons: blockerReasons(scope) }))
    .filter((scope) => scope.reasons.length > 0 && !excludedVirginRefs.has(scope.scopeRef))
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scopes,
    excludedSystemRefs: excludedSystemRefs.sort(
      (a, b) => a.scopeRef.localeCompare(b.scopeRef) || a.nodeId.localeCompare(b.nodeId)
    ),
    excludedVirginScopes,
    remainingUnreconciled,
    f1EnablementBlocked: remainingUnreconciled.length > 0,
  }
}

export type ReconciliationSelection = {
  scopeRef: string
  canonicalNodeId: string
  birthClass?: FederationBirthClass | undefined
}

type RetirementRegistryAction =
  | 'would_stage_fence'
  | 'would_retire'
  | 'awaiting_fence'
  | 'retired'
  | 'already_retired'
  | 'requires_f0_migration'

export type ReconciliationResult = {
  dryRun: boolean
  changed: number
  wouldChange: number
  reconciledScopes: string[]
  excludedSystemRefs: ExcludedSystemRef[]
  retiredScopes: Array<
    RuledRetirementDisposition & {
      registryAction: RetirementRegistryAction
    }
  >
  excludedVirginScopes: RuledVirginExclusion[]
  remainingUnreconciled: UnreconciledScope[]
  projectedRemainingUnreconciledAfterApply: UnreconciledScope[]
  f1EnablementBlocked: boolean
  artifact: NamespaceRetirementArtifact
}

export type NamespaceRetirementStep = ScopeRetirementRecord

export type NamespaceRetirementArtifact = {
  version: 2
  generatedAt: string
  dryRun: boolean
  retirementSteps: NamespaceRetirementStep[]
  archiveSteps?: Array<{ scopeRef: string; nodeId: string; archivedAt: string }> | undefined
}

function desiredBinding(
  scope: NamespaceScopeInventory,
  selection: ReconciliationSelection,
  now: string
): Omit<PlacementBinding, 'createdAt' | 'updatedAt' | 'priorHomeNodeId'> & {
  now: string
} {
  const canonical = scope.nodes.find((node) => node.nodeId === selection.canonicalNodeId)
  if (canonical === undefined) {
    throw new Error(
      `canonical node ${selection.canonicalNodeId} has no inventory occurrence for ${scope.scopeRef}`
    )
  }
  if (canonical.retired) {
    throw new Error(
      `canonical node ${selection.canonicalNodeId} is already retired for ${scope.scopeRef}`
    )
  }
  const placement = canonical.placement
  return {
    scopeRef: scope.scopeRef,
    homeNodeId: selection.canonicalNodeId,
    placementEpoch: placement?.placementEpoch ?? 1,
    birthClass: placement?.birthClass ?? selection.birthClass ?? 'policy-born',
    authorityProvenance: placement?.authorityProvenance ?? {
      kind: 'namespace_reconciliation',
      canonicalHostSessionId: canonical.hostSessionIds.at(-1),
    },
    establishmentProvenance: placement?.establishmentProvenance ?? 'explicit_local',
    now,
  }
}

function selectionNeedsChange(
  scope: NamespaceScopeInventory,
  selection: ReconciliationSelection
): boolean {
  return scope.binding?.homeNodeId !== selection.canonicalNodeId
}

function requireInventoryScope(
  scopesByRef: ReadonlyMap<string, NamespaceScopeInventory>,
  scopeRef: string
): NamespaceScopeInventory {
  const scope = scopesByRef.get(scopeRef)
  if (scope === undefined) throw new Error(`scope is absent from inventory: ${scopeRef}`)
  return scope
}

function dryRunRetirementAction(
  scope: NamespaceScopeInventory,
  disposition: RuledRetirementDisposition
): RetirementRegistryAction {
  if (scope.registryRetirement !== undefined) return 'already_retired'
  const retiredNode = scope.nodes.find((node) => node.nodeId === disposition.retiredNodeId)
  if (retiredNode?.retirement === undefined) return 'would_stage_fence'
  return scope.binding === undefined ? 'requires_f0_migration' : 'would_retire'
}

function finalizeRuledRetirements(input: {
  registryPath: string
  scopesByRef: ReadonlyMap<string, NamespaceScopeInventory>
  retirements: readonly RuledRetirementDisposition[]
}): { actions: Map<string, RetirementRegistryAction>; changed: number } {
  const actions = new Map<string, RetirementRegistryAction>()
  let changed = 0
  if (input.retirements.length === 0) return { actions, changed }

  const registry = openBindingRegistry(input.registryPath)
  try {
    for (const disposition of input.retirements) {
      const scope = requireInventoryScope(input.scopesByRef, disposition.scopeRef)
      const retiredNode = scope.nodes.find((node) => node.nodeId === disposition.retiredNodeId)
      const fence = retiredNode?.retirement
      const record = registry.getRecord(disposition.scopeRef)
      if (record === undefined) {
        actions.set(disposition.scopeRef, 'requires_f0_migration')
        continue
      }
      if (record.state === 'retired') {
        if (
          record.retiredHomeNodeId !== disposition.retiredNodeId ||
          record.placementEpoch !== disposition.retiredPlacementEpoch ||
          record.successorNodeId !== disposition.successorNodeId
        ) {
          throw new Error(`registry retirement conflicts for ${disposition.scopeRef}`)
        }
        actions.set(disposition.scopeRef, 'already_retired')
        continue
      }
      if (
        record.homeNodeId !== disposition.retiredNodeId ||
        record.placementEpoch !== disposition.retiredPlacementEpoch
      ) {
        throw new Error(
          `retirement disposition does not match registry binding for ${disposition.scopeRef}`
        )
      }
      if (fence === undefined) {
        actions.set(disposition.scopeRef, 'awaiting_fence')
        continue
      }
      const retired = registry.retire({
        scopeRef: disposition.scopeRef,
        expectedHomeNodeId: disposition.retiredNodeId,
        expectedPlacementEpoch: disposition.retiredPlacementEpoch,
        successorNodeId: disposition.successorNodeId,
        reason: fence.reason,
        retiredAt: fence.retiredAt,
      })
      if (retired.outcome !== 'retired' && retired.outcome !== 'idempotent') {
        throw new Error(`registry retirement ${retired.outcome} for ${disposition.scopeRef}`)
      }
      if (retired.outcome === 'retired') changed += 1
      actions.set(
        disposition.scopeRef,
        retired.outcome === 'retired' ? 'retired' : 'already_retired'
      )
    }
  } finally {
    registry.close()
  }
  return { actions, changed }
}

export function reconcileFederationNamespace(input: {
  nodeStores: readonly NamespaceNodeStore[]
  registryPath: string
  selections: readonly ReconciliationSelection[]
  retireScopeRefs?: readonly string[] | undefined
  excludeVirginScopeRefs?: readonly string[] | undefined
  dryRun: boolean
  now?: string | undefined
  advisoryCreations?: readonly AdvisoryCreation[] | undefined
}): ReconciliationResult {
  const now = input.now ?? new Date().toISOString()
  const inventory = inventoryFederationNamespace({
    nodeStores: input.nodeStores,
    registryPath: input.registryPath,
    advisoryCreations: input.advisoryCreations,
    excludeVirginScopeRefs: input.excludeVirginScopeRefs,
    generatedAt: now,
  })
  const scopesByRef = new Map(inventory.scopes.map((scope) => [scope.scopeRef, scope]))
  const selections = input.selections.map((selection) => ({
    ...selection,
    scopeRef: canonicalScopeRef(selection.scopeRef),
    canonicalNodeId: requireNodeId(selection.canonicalNodeId),
  }))
  const retirements = resolveRuledRetirements(input.retireScopeRefs ?? [])
  const retirementRefs = new Set(retirements.map((item) => item.scopeRef))
  const excludedVirginRefs = new Set(inventory.excludedVirginScopes.map((item) => item.scopeRef))
  const selectedRefs = new Set<string>()
  for (const selection of selections) {
    if (selectedRefs.has(selection.scopeRef)) {
      throw new Error(`duplicate reconciliation selection for ${selection.scopeRef}`)
    }
    selectedRefs.add(selection.scopeRef)
    if (retirementRefs.has(selection.scopeRef) || excludedVirginRefs.has(selection.scopeRef)) {
      throw new Error(`scope has conflicting reconciliation dispositions: ${selection.scopeRef}`)
    }
    const scope = scopesByRef.get(selection.scopeRef)
    if (scope === undefined)
      throw new Error(`scope is absent from inventory: ${selection.scopeRef}`)
    if (scope.registryRetirement !== undefined) {
      throw new Error(
        `scope is retired and cannot be selected as virgin authority: ${selection.scopeRef}`
      )
    }
    desiredBinding(scope, selection, now)
    for (const node of scope.nodes) {
      if (node.nodeId === selection.canonicalNodeId || node.retirement === undefined) continue
      if (
        node.retirement.successorNodeId !== selection.canonicalNodeId ||
        node.retirement.scopeRef !== selection.scopeRef
      ) {
        throw new ScopeRetirementConflictError(selection.scopeRef)
      }
    }
  }

  for (const disposition of retirements) {
    if (excludedVirginRefs.has(disposition.scopeRef)) {
      throw new Error(`scope has conflicting reconciliation dispositions: ${disposition.scopeRef}`)
    }
    const scope = requireInventoryScope(scopesByRef, disposition.scopeRef)
    if (
      scope.registryRetirement !== undefined &&
      (scope.registryRetirement.retiredHomeNodeId !== disposition.retiredNodeId ||
        scope.registryRetirement.placementEpoch !== disposition.retiredPlacementEpoch ||
        scope.registryRetirement.successorNodeId !== disposition.successorNodeId)
    ) {
      throw new Error(`registry retirement conflicts for ${disposition.scopeRef}`)
    }
    const retiredNode = scope.nodes.find((node) => node.nodeId === disposition.retiredNodeId)
    if (retiredNode === undefined) {
      throw new Error(
        `retired node ${disposition.retiredNodeId} has no inventory occurrence for ${disposition.scopeRef}`
      )
    }
    const binding = scope.binding
    if (
      binding !== undefined &&
      (binding.homeNodeId !== disposition.retiredNodeId ||
        binding.placementEpoch !== disposition.retiredPlacementEpoch)
    ) {
      throw new Error(
        `retirement disposition does not match registry binding for ${disposition.scopeRef}`
      )
    }
    if (
      retiredNode.retirement !== undefined &&
      (retiredNode.retirement.successorNodeId !== disposition.successorNodeId ||
        retiredNode.retirement.retiredPlacementEpoch !== disposition.retiredPlacementEpoch)
    ) {
      throw new ScopeRetirementConflictError(disposition.scopeRef)
    }
  }

  const changing = selections.filter((selection) =>
    selectionNeedsChange(requireInventoryScope(scopesByRef, selection.scopeRef), selection)
  )
  const retirementChanges = retirements.filter((disposition) => {
    const scope = requireInventoryScope(scopesByRef, disposition.scopeRef)
    const action = dryRunRetirementAction(scope, disposition)
    return action === 'would_stage_fence' || action === 'would_retire'
  })
  const unreconciledWithoutSelections = inventory.remainingUnreconciled.filter(
    (scope) => !selectedRefs.has(scope.scopeRef) && !retirementRefs.has(scope.scopeRef)
  )
  const buildArtifact = (
    bindingFor: (selection: ReconciliationSelection) => PlacementBinding
  ): NamespaceRetirementArtifact => ({
    version: 2,
    generatedAt: now,
    dryRun: input.dryRun,
    retirementSteps: [
      ...selections.flatMap((selection) => {
        const scope = requireInventoryScope(scopesByRef, selection.scopeRef)
        const binding = bindingFor(selection)
        const losingNodeIds = new Set([
          ...scope.nodes.map((node) => node.nodeId),
          ...scope.advisoryCreations.map((creation) => creation.nodeId),
        ])
        losingNodeIds.delete(selection.canonicalNodeId)
        return [...losingNodeIds].sort().map((nodeId) => {
          const existingFence = scope.nodes.find((node) => node.nodeId === nodeId)?.retirement
          return {
            scopeRef: selection.scopeRef,
            retiredNodeId: nodeId,
            retiredPlacementEpoch: binding.placementEpoch,
            successorNodeId: selection.canonicalNodeId,
            reason: 'namespace_reconciliation' as const,
            retiredAt: existingFence?.retiredAt ?? now,
          }
        })
      }),
      ...retirements.map((disposition) => {
        const scope = requireInventoryScope(scopesByRef, disposition.scopeRef)
        const existingFence = scope.nodes.find(
          (node) => node.nodeId === disposition.retiredNodeId
        )?.retirement
        return {
          scopeRef: disposition.scopeRef,
          retiredNodeId: disposition.retiredNodeId,
          retiredPlacementEpoch: disposition.retiredPlacementEpoch,
          successorNodeId: disposition.successorNodeId,
          reason: 'namespace_reconciliation' as const,
          retiredAt: existingFence?.retiredAt ?? now,
        }
      }),
    ],
    archiveSteps: retirements.map((disposition) => ({
      scopeRef: disposition.scopeRef,
      nodeId: disposition.retiredNodeId,
      archivedAt: now,
    })),
  })
  if (input.dryRun) {
    const projectedBindings = new Map<string, PlacementBinding>()
    for (const selection of selections) {
      const scope = requireInventoryScope(scopesByRef, selection.scopeRef)
      const current = scope.binding
      if (current === undefined) {
        const desired = desiredBinding(scope, selection, now)
        projectedBindings.set(selection.scopeRef, {
          ...desired,
          createdAt: now,
          updatedAt: now,
        })
      } else if (current.homeNodeId === selection.canonicalNodeId) {
        projectedBindings.set(selection.scopeRef, current)
      } else {
        projectedBindings.set(selection.scopeRef, {
          ...current,
          homeNodeId: selection.canonicalNodeId,
          placementEpoch: current.placementEpoch + 1,
          establishmentProvenance: 'rebind',
          priorHomeNodeId: current.homeNodeId,
          updatedAt: now,
        })
      }
    }
    return {
      dryRun: true,
      changed: 0,
      wouldChange: changing.length + retirementChanges.length,
      reconciledScopes: selections.map((selection) => selection.scopeRef),
      excludedSystemRefs: inventory.excludedSystemRefs,
      retiredScopes: retirements.map((disposition) => ({
        ...disposition,
        registryAction: dryRunRetirementAction(
          requireInventoryScope(scopesByRef, disposition.scopeRef),
          disposition
        ),
      })),
      excludedVirginScopes: inventory.excludedVirginScopes,
      remainingUnreconciled: inventory.remainingUnreconciled,
      projectedRemainingUnreconciledAfterApply: unreconciledWithoutSelections,
      f1EnablementBlocked: inventory.remainingUnreconciled.length > 0,
      artifact: buildArtifact((selection) => {
        const binding = projectedBindings.get(selection.scopeRef)
        if (binding === undefined) throw new Error('missing projected binding')
        return binding
      }),
    }
  }

  const appliedBindings = new Map<string, PlacementBinding>()
  if (changing.length > 0) {
    const registry = openBindingRegistry(input.registryPath)
    try {
      for (const selection of selections) {
        const scope = requireInventoryScope(scopesByRef, selection.scopeRef)
        const desired = desiredBinding(scope, selection, now)
        let binding = registry.get(selection.scopeRef)
        if (binding === undefined) {
          binding = registry.establish(desired).binding
        } else if (binding.homeNodeId !== selection.canonicalNodeId) {
          const cas = registry.compareAndSwap({
            scopeRef: selection.scopeRef,
            expectedHomeNodeId: binding.homeNodeId,
            expectedPlacementEpoch: binding.placementEpoch,
            newHomeNodeId: selection.canonicalNodeId,
            now,
          })
          if (cas.outcome !== 'updated' && cas.outcome !== 'idempotent') {
            throw new Error(`binding CAS ${cas.outcome} for ${selection.scopeRef}`)
          }
          binding = cas.binding
        }
        if (binding === undefined)
          throw new Error(`binding missing after import: ${selection.scopeRef}`)
        appliedBindings.set(selection.scopeRef, binding)
      }
    } finally {
      registry.close()
    }
  }

  for (const selection of selections) {
    if (appliedBindings.has(selection.scopeRef)) continue
    const registry = openBindingRegistry(input.registryPath)
    try {
      const binding = registry.get(selection.scopeRef)
      if (binding === undefined)
        throw new Error(`binding missing after import: ${selection.scopeRef}`)
      appliedBindings.set(selection.scopeRef, binding)
    } finally {
      registry.close()
    }
  }

  const retirementFinalization = finalizeRuledRetirements({
    registryPath: input.registryPath,
    scopesByRef,
    retirements,
  })

  const after = inventoryFederationNamespace({
    nodeStores: input.nodeStores,
    registryPath: input.registryPath,
    advisoryCreations: input.advisoryCreations,
    excludeVirginScopeRefs: input.excludeVirginScopeRefs,
    generatedAt: now,
  })
  return {
    dryRun: false,
    changed: changing.length + retirementFinalization.changed,
    wouldChange: 0,
    reconciledScopes: selections.map((selection) => selection.scopeRef),
    excludedSystemRefs: after.excludedSystemRefs,
    retiredScopes: retirements.map((disposition) => ({
      ...disposition,
      registryAction:
        retirementFinalization.actions.get(disposition.scopeRef) ?? 'requires_f0_migration',
    })),
    excludedVirginScopes: after.excludedVirginScopes,
    remainingUnreconciled: after.remainingUnreconciled,
    projectedRemainingUnreconciledAfterApply: unreconciledWithoutSelections,
    f1EnablementBlocked: after.f1EnablementBlocked,
    artifact: buildArtifact((selection) => {
      const binding = appliedBindings.get(selection.scopeRef)
      if (binding === undefined) throw new Error('missing applied binding')
      return binding
    }),
  }
}

export type ApplyRetirementsResult = {
  nodeId: string
  dryRun: boolean
  changed: number
  wouldChange: number
  archivedSessionsChanged: number
  wouldArchiveSessions: number
  appliedMarks: Array<{
    scopeRef: string
    markedNodeId: string
    retiredPlacementEpoch: number
    successorNodeId: string | null
    action: 'would_create' | 'created' | 'updated' | 'existing'
  }>
  archivedSessions: Array<{ scopeRef: string; nodeId: string; count: number }>
  appliedScopes: string[]
}

export function applyNamespaceRetirements(input: {
  nodeId: string
  statePath: string
  artifact: NamespaceRetirementArtifact
  dryRun: boolean
}): ApplyRetirementsResult {
  const nodeId = requireNodeId(input.nodeId)
  if (input.artifact.version !== 2) {
    throw new Error(`unsupported retirement artifact version: ${String(input.artifact.version)}`)
  }
  if (input.artifact.dryRun) {
    throw new Error('refusing to apply an artifact produced by a reconcile dry-run')
  }
  if (!existsSync(input.statePath)) {
    throw new Error(`node state store does not exist: ${input.statePath}`)
  }
  const steps = input.artifact.retirementSteps.filter((step) => step.retiredNodeId === nodeId)
  const archiveSteps = (input.artifact.archiveSteps ?? []).filter((step) => step.nodeId === nodeId)
  const readonly = new Database(input.statePath, { readonly: true })
  let wouldChange = 0
  let wouldArchiveSessions = 0
  const dryRunMarks: ApplyRetirementsResult['appliedMarks'] = []
  const dryRunArchives: ApplyRetirementsResult['archivedSessions'] = []
  try {
    for (const step of steps) {
      const existing = readScopeRetirements(readonly).find((row) => row.scopeRef === step.scopeRef)
      if (existing === undefined) {
        wouldChange += 1
        dryRunMarks.push({
          scopeRef: step.scopeRef,
          markedNodeId: step.retiredNodeId,
          retiredPlacementEpoch: step.retiredPlacementEpoch,
          successorNodeId: step.successorNodeId,
          action: 'would_create',
        })
        continue
      }
      if (
        existing.retiredNodeId !== step.retiredNodeId ||
        existing.successorNodeId !== step.successorNodeId ||
        existing.retiredPlacementEpoch !== step.retiredPlacementEpoch ||
        existing.reason !== step.reason ||
        existing.retiredAt !== step.retiredAt
      ) {
        throw new ScopeRetirementConflictError(step.scopeRef)
      }
      dryRunMarks.push({
        scopeRef: step.scopeRef,
        markedNodeId: step.retiredNodeId,
        retiredPlacementEpoch: step.retiredPlacementEpoch,
        successorNodeId: step.successorNodeId,
        action: 'existing',
      })
    }
    for (const step of archiveSteps) {
      const row = readonly
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM sessions WHERE scope_ref = ? AND status != 'archived'`
        )
        .get(step.scopeRef)
      wouldArchiveSessions += row?.count ?? 0
      dryRunArchives.push({
        scopeRef: step.scopeRef,
        nodeId: step.nodeId,
        count: row?.count ?? 0,
      })
    }
  } finally {
    readonly.close()
  }
  if (input.dryRun) {
    return {
      nodeId,
      dryRun: true,
      changed: 0,
      wouldChange,
      archivedSessionsChanged: 0,
      wouldArchiveSessions,
      appliedMarks: dryRunMarks,
      archivedSessions: dryRunArchives,
      appliedScopes: steps.map((step) => step.scopeRef),
    }
  }
  const db = new Database(input.statePath)
  let changed = 0
  let archivedSessionsChanged = 0
  const appliedMarks: ApplyRetirementsResult['appliedMarks'] = []
  const archivedSessions: ApplyRetirementsResult['archivedSessions'] = []
  try {
    const retirements = createScopeRetirementRepository(db)
    for (const step of steps) {
      const outcome = retirements.retire(step).outcome
      if (outcome === 'created') changed += 1
      appliedMarks.push({
        scopeRef: step.scopeRef,
        markedNodeId: step.retiredNodeId,
        retiredPlacementEpoch: step.retiredPlacementEpoch,
        successorNodeId: step.successorNodeId,
        action: outcome,
      })
    }
    for (const step of archiveSteps) {
      const archived = db
        .query<unknown, [string, string]>(
          `UPDATE sessions SET status = 'archived', updated_at = ?
           WHERE scope_ref = ? AND status != 'archived'`
        )
        .run(step.archivedAt, step.scopeRef)
      archivedSessionsChanged += archived.changes
      archivedSessions.push({
        scopeRef: step.scopeRef,
        nodeId: step.nodeId,
        count: archived.changes,
      })
    }
  } finally {
    db.close()
  }
  return {
    nodeId,
    dryRun: false,
    changed,
    wouldChange: 0,
    archivedSessionsChanged,
    wouldArchiveSessions: 0,
    appliedMarks,
    archivedSessions,
    appliedScopes: steps.map((step) => step.scopeRef),
  }
}

type ParsedInventoryCommand = {
  command: 'inventory' | 'reconcile'
  registryPath: string
  nodeStores: NamespaceNodeStore[]
  advisoryLogPaths: string[]
  selections: ReconciliationSelection[]
  retireScopeRefs: string[]
  excludeVirginScopeRefs: string[]
  dryRun: boolean
}

type ParsedApplyCommand = {
  command: 'apply'
  nodeId: string
  statePath: string
  artifactPath: string
  dryRun: boolean
}

type ParsedCommand = ParsedInventoryCommand | ParsedApplyCommand

function splitAssignment(raw: string, flag: string): [string, string] {
  const separator = raw.lastIndexOf('=')
  if (separator < 1 || separator === raw.length - 1) {
    throw new Error(`${flag} must use <left>=<right>, got ${raw}`)
  }
  return [raw.slice(0, separator), raw.slice(separator + 1)]
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const [rawCommand, ...args] = argv
  if (rawCommand !== 'inventory' && rawCommand !== 'reconcile' && rawCommand !== 'apply') {
    throw new Error(USAGE)
  }
  if (rawCommand === 'apply') {
    let nodeId: string | undefined
    let statePath: string | undefined
    let artifactPath: string | undefined
    let dryRun = false
    let yes = false
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index]
      if (flag === '--help' || flag === '-h') throw new Error(USAGE)
      if (flag === '--dry-run') {
        dryRun = true
        continue
      }
      if (flag === '--yes') {
        yes = true
        continue
      }
      const value = args[index + 1]
      if (value === undefined) throw new Error(`missing value for ${flag}`)
      index += 1
      if (flag === '--node-id') nodeId = requireNodeId(value)
      else if (flag === '--state') statePath = resolve(value)
      else if (flag === '--artifact') artifactPath = resolve(value)
      else throw new Error(`unknown flag: ${flag}`)
    }
    if (nodeId === undefined) throw new Error('apply requires --node-id')
    if (statePath === undefined) throw new Error('apply requires --state')
    if (artifactPath === undefined) throw new Error('apply requires --artifact')
    if (dryRun === yes) throw new Error('apply requires exactly one of --dry-run or --yes')
    return { command: 'apply', nodeId, statePath, artifactPath, dryRun }
  }
  let registryPath: string | undefined
  const nodeStores: NamespaceNodeStore[] = []
  const advisoryLogPaths: string[] = []
  const selections: ReconciliationSelection[] = []
  const retireScopeRefs: string[] = []
  const excludeVirginScopeRefs: string[] = []
  let dryRun = false
  let yes = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--help' || flag === '-h') throw new Error(USAGE)
    if (flag === '--dry-run') {
      dryRun = true
      continue
    }
    if (flag === '--yes') {
      yes = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    index += 1
    if (flag === '--registry') {
      registryPath = resolve(value)
    } else if (flag === '--node') {
      const [nodeId, path] = splitAssignment(value, '--node')
      nodeStores.push({ nodeId: requireNodeId(nodeId), path: resolve(path) })
    } else if (flag === '--advisory-log') {
      advisoryLogPaths.push(resolve(value))
    } else if (flag === '--select') {
      const [scopeRef, canonicalNodeId] = splitAssignment(value, '--select')
      selections.push({ scopeRef: canonicalScopeRef(scopeRef), canonicalNodeId })
    } else if (flag === '--retire') {
      retireScopeRefs.push(canonicalScopeRef(value))
    } else if (flag === '--exclude-virgin') {
      excludeVirginScopeRefs.push(canonicalScopeRef(value))
    } else {
      throw new Error(`unknown flag: ${flag}`)
    }
  }
  if (registryPath === undefined) throw new Error('--registry is required')
  if (nodeStores.length === 0) throw new Error('at least one --node is required')
  if (rawCommand === 'inventory') {
    if (dryRun || yes || selections.length > 0 || retireScopeRefs.length > 0) {
      throw new Error('inventory does not accept --dry-run, --yes, --select, or --retire')
    }
  } else {
    if (
      selections.length === 0 &&
      retireScopeRefs.length === 0 &&
      excludeVirginScopeRefs.length === 0
    ) {
      throw new Error('reconcile requires at least one disposition')
    }
    if (dryRun === yes) throw new Error('reconcile requires exactly one of --dry-run or --yes')
  }
  return {
    command: rawCommand,
    registryPath,
    nodeStores,
    advisoryLogPaths,
    selections,
    retireScopeRefs,
    excludeVirginScopeRefs,
    dryRun,
  }
}

function readAdvisoryCreations(paths: readonly string[]): AdvisoryCreation[] {
  const creations: AdvisoryCreation[] = []
  for (const path of paths) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        throw new Error(`invalid advisory JSONL at ${path}:${index + 1}`, { cause: error })
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`invalid advisory record at ${path}:${index + 1}`)
      }
      const record = parsed as Record<string, unknown>
      if (
        typeof record.scopeRef !== 'string' ||
        typeof record.nodeId !== 'string' ||
        typeof record.occurredAt !== 'string' ||
        typeof record.decision !== 'string'
      ) {
        throw new Error(
          `advisory record requires scopeRef, nodeId, occurredAt, decision at ${path}:${index + 1}`
        )
      }
      creations.push({
        scopeRef: canonicalScopeRef(record.scopeRef),
        nodeId: requireNodeId(record.nodeId),
        occurredAt: record.occurredAt,
        decision: record.decision,
      })
    }
  }
  return creations
}

export function runNamespaceReconciliationCommand(argv: readonly string[]): unknown {
  const command = parseCommand(argv)
  if (command.command === 'apply') {
    const parsed = JSON.parse(readFileSync(command.artifactPath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('retirement artifact must be a JSON object')
    }
    const root = parsed as Record<string, unknown>
    const rawArtifact = (root.artifact ?? root) as unknown
    if (rawArtifact === null || typeof rawArtifact !== 'object' || Array.isArray(rawArtifact)) {
      throw new Error('retirement artifact payload must be a JSON object')
    }
    const artifact = rawArtifact as NamespaceRetirementArtifact
    return applyNamespaceRetirements({
      nodeId: command.nodeId,
      statePath: command.statePath,
      artifact,
      dryRun: command.dryRun,
    })
  }
  const advisoryCreations = readAdvisoryCreations(command.advisoryLogPaths)
  if (command.command === 'inventory') {
    return inventoryFederationNamespace({
      nodeStores: command.nodeStores,
      registryPath: command.registryPath,
      advisoryCreations,
      excludeVirginScopeRefs: command.excludeVirginScopeRefs,
    })
  }
  return reconcileFederationNamespace({
    nodeStores: command.nodeStores,
    registryPath: command.registryPath,
    selections: command.selections,
    retireScopeRefs: command.retireScopeRefs,
    excludeVirginScopeRefs: command.excludeVirginScopeRefs,
    dryRun: command.dryRun,
    advisoryCreations,
  })
}

if (import.meta.main) {
  try {
    const output = runNamespaceReconciliationCommand(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
