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

import { createPlacementLedgerRepository } from 'hrc-store-sqlite'
import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import type { BindingRegistryClient } from './registry-client.js'

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
  memo: Map<string, ForeignHome>
  onConsultFailure?: ((scopeRef: string, error: unknown) => void) | undefined
}>

type HomeAuthorityServer = Readonly<{
  db: { sqlite: Database }
  federationNodeId: string
  federationRegistryClient: BindingRegistryClient | undefined
  foreignHomeMemo: Map<string, ForeignHome>
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
 * Resolution order mirrors the summon gate's own (§5), because a verdict that
 * disagreed with the gate would either withhold work this node owes or keep
 * acting on work it does not:
 *
 *  1. NO FEDERATION — no registry client means no other node exists to home
 *     anything. A single-node daemon homes everything it can see and nothing is
 *     ever foreign; this is why the test is not "must have a local placement
 *     row", which would silence delivery on every unfederated install.
 *  2. LOCAL PLACEMENT LEDGER — this node's own record of the bindings it holds
 *     authority for, and the only answer that costs no network. An active row
 *     naming another node is definitive; an active row naming this node is
 *     definitive the other way and CLEARS any remembered registry answer, so a
 *     scope rebound back here resumes the moment activation installs the row.
 *  3. REMEMBERED REGISTRY ANSWER.
 *  4. REGISTRY CONSULT, only for a scope with no local row at all.
 *
 * Anything else — unbound, retired, bound here, or a registry we cannot reach —
 * is `undefined`, and the caller proceeds exactly as it would have. This never
 * invents a foreign home; it only reports one already on the record.
 */
export async function resolveForeignHome(
  deps: HomeAuthorityDeps,
  scopeRef: string
): Promise<ForeignHome | undefined> {
  if (deps.registry === undefined) return undefined

  const local = deps.ledger.get(scopeRef)
  if (local?.state === 'active') {
    if (local.homeNodeId === deps.localNodeId) {
      deps.memo.delete(scopeRef)
      return undefined
    }
    return {
      homeNodeId: local.homeNodeId,
      source: 'placement-ledger',
    }
  }

  const remembered = deps.memo.get(scopeRef)
  if (remembered !== undefined) return remembered

  try {
    const consulted = await deps.registry.consult(scopeRef)
    if (consulted.outcome !== 'bound') return undefined
    if (consulted.binding.homeNodeId === deps.localNodeId) return undefined
    const learned: ForeignHome = {
      homeNodeId: consulted.binding.homeNodeId,
      source: 'registry',
    }
    deps.memo.set(scopeRef, learned)
    return learned
  } catch (error) {
    // An unreachable or refused registry is not evidence of a foreign home.
    deps.onConsultFailure?.(scopeRef, error)
    return undefined
  }
}
