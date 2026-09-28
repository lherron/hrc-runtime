/**
 * "Does this node home that scope?" — the one answer, shared by every mechanism
 * that must not act on a scope it has no authority for (T-07650).
 *
 * It lives here rather than inside the kicker because two mechanisms need the
 * same verdict from opposite ends: the drive path asks it BEFORE claiming, and
 * the shadow teardown asks it about seats that already exist. A second copy
 * would be a second answer, and a delivery filter that disagreed with a
 * teardown rule is worse than either alone.
 *
 * It is deliberately NOT the summon gate. The gate rules on whether this node
 * may ESTABLISH a scope and is reachable only through `ensureTargetSession`; a
 * node holding a stale local session never reaches it, which is exactly how
 * lab and svc presented into scopes homed on max3 without a single gate
 * refusal. This is the cheaper, narrower question — "is it mine right now" —
 * asked where the gate is not consulted at all.
 */

import type { Database } from 'bun:sqlite'

import type { LocateAuthority, LocateBindingRecord, LocateRegistryView } from 'hrc-core'
import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import type { BindingRegistryClient, RegistryConsultResult } from './registry-client.js'
import { RegistryUnreachableError } from './registry-client.js'

/**
 * A home this node believes a scope has, when that home is NOT this node.
 *
 * `source` is kept because the two answers have different lifetimes: a
 * `placement-ledger` verdict is re-read from local SQLite on every ask and is
 * authoritative, while a `registry` verdict is a remembered network answer.
 */
export type ForeignHome = Readonly<{
  homeNodeId: string
  source: 'placement-ledger' | 'registry'
}>

export type HomeAuthorityDeps = Readonly<{
  localNodeId: string
  /** Absent on an unfederated node, where nothing is ever foreign. */
  registry: Pick<BindingRegistryClient, 'consult'> | undefined
  ledger: { get(scopeRef: string): PlacementLedgerRecord | undefined }
  /**
   * Remembered registry answers, keyed by scopeRef. Process-local by design:
   * it exists to charge one consult per scope per process instead of one per
   * tick, and a restart must be able to re-ask.
   */
  memo?: Map<string, LocateBindingRecord> | undefined
  onConsultFailure?: ((scopeRef: string, error: unknown) => void) | undefined
}>

type HomeAuthorityServer = Readonly<{
  db: { sqlite: Database }
  federationNodeId: string
  federationRegistryClient: BindingRegistryClient | undefined
  foreignHomeMemo: Map<string, LocateBindingRecord>
}>

/** One resolution: what the ledger holds, what the registry said, and the verdict. */
export type HomeAuthorityResolution = Readonly<{
  local: PlacementLedgerRecord | undefined
  registry: LocateRegistryView
  authority: LocateAuthority
}>

/** The deps a running daemon supplies, gathered in one place so both callers agree. */
export function homeAuthorityDeps(
  server: HomeAuthorityServer,
  onConsultFailure?: (scopeRef: string, error: unknown) => void
): HomeAuthorityDeps {
  return {
    localNodeId: server.federationNodeId,
    registry: server.federationRegistryClient,
    ledger: createPlacementLedgerRepository(server.db.sqlite),
    memo: server.foreignHomeMemo,
    ...(onConsultFailure === undefined ? {} : { onConsultFailure }),
  }
}

/**
 * THE home-authority resolution. `locateScope` (and so every HTTP locate
 * caller, the out-of-process mail kicker among them) and `resolveForeignHome`
 * (the in-process drive check and the shadow teardown) both answer from this
 * one function. T-09762 is what two resolvers cost: locate read a locally
 * RETIRED row as unbound without asking the registry, the teardown asked the
 * registry, and svc spent a month birthing seats for a max3 scope that its
 * own teardown then killed.
 *
 * Resolution order mirrors the summon gate's own (§5):
 *
 *  1. ACTIVE LOCAL PLACEMENT — this node's own record, authoritative and free.
 *     It is local only when it names this node; an active row naming another
 *     node is a foreign home, never "local because the row is here". A row
 *     naming this node CLEARS any remembered registry answer, so a scope
 *     rebound back here resumes the moment activation installs the row.
 *  2. NO FEDERATION — no registry client means no other node exists. Nothing
 *     is bound anywhere this node can learn about.
 *  3. REMEMBERED REGISTRY ANSWER (only when the caller supplies a memo).
 *  4. REGISTRY CONSULT — for a scope with no local row AND for a locally
 *     retired one. Retirement fences THIS node permanently; it says nothing
 *     about where the scope lives now, and only the registry does.
 *
 * A retired scope is never local. If the registry still names this node after
 * retirement, that is stale shared discovery and the fence wins: `unbound`.
 * A registry that cannot answer is `unknown`, never collapsed into unbound and
 * never a guessed foreign home.
 */
export async function resolveHomeAuthority(
  deps: HomeAuthorityDeps,
  scopeRef: string
): Promise<HomeAuthorityResolution> {
  const local = deps.ledger.get(scopeRef)
  if (local?.state === 'active') {
    const isLocal = local.homeNodeId === deps.localNodeId
    if (isLocal) deps.memo?.delete(scopeRef)
    return {
      local,
      registry: { outcome: 'not-consulted', detail: 'The active local ledger is authoritative.' },
      authority: { state: 'bound', source: 'ledger', record: bindingRecord(local), isLocal },
    }
  }
  if (deps.registry === undefined) {
    return {
      local,
      registry: { outcome: 'not-consulted', detail: 'Federation is not configured.' },
      authority: { state: 'unbound' },
    }
  }

  const remembered = deps.memo?.get(scopeRef)
  if (remembered !== undefined) {
    return {
      local,
      registry: { outcome: 'bound', record: remembered },
      authority: { state: 'bound', source: 'registry', record: remembered, isLocal: false },
    }
  }

  let consulted: RegistryConsultResult
  try {
    consulted = await deps.registry.consult(scopeRef)
  } catch (error) {
    deps.onConsultFailure?.(scopeRef, error)
    const detail = error instanceof Error ? error.message : String(error)
    const retryable = error instanceof RegistryUnreachableError
    return {
      local,
      registry: { outcome: 'unknown', detail, retryable },
      authority: { state: 'unknown', detail, retryable },
    }
  }
  if (consulted.outcome !== 'bound') {
    return { local, registry: { outcome: 'unbound' }, authority: { state: 'unbound' } }
  }
  const record = bindingRecord(consulted.binding)
  const registry: LocateRegistryView = { outcome: 'bound', record }
  if (record.homeNodeId === deps.localNodeId) {
    return {
      local,
      registry,
      authority:
        local?.state === 'retired'
          ? { state: 'unbound' }
          : { state: 'bound', source: 'registry', record, isLocal: true },
    }
  }
  deps.memo?.set(scopeRef, record)
  return {
    local,
    registry,
    authority: { state: 'bound', source: 'registry', record, isLocal: false },
  }
}

/**
 * "Is this scope homed on ANOTHER node?" — `resolveHomeAuthority` narrowed to
 * the one answer a drive or teardown acts on. Anything that is not a positive
 * foreign binding (unbound, unknown, bound here) is `undefined`: this never
 * invents a foreign home, it only reports one already on the record.
 */
export async function resolveForeignHome(
  deps: HomeAuthorityDeps,
  scopeRef: string
): Promise<ForeignHome | undefined> {
  const { authority } = await resolveHomeAuthority(deps, scopeRef)
  if (authority.state !== 'bound' || authority.isLocal) return undefined
  return {
    homeNodeId: authority.record.homeNodeId,
    source: authority.source === 'ledger' ? 'placement-ledger' : 'registry',
  }
}

function bindingRecord(binding: {
  homeNodeId: string
  createdAt: string
  updatedAt: string
}): LocateBindingRecord {
  return {
    homeNodeId: binding.homeNodeId,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  }
}
