/**
 * Live placement repair and retired-scope checks for the summon gate server.
 * Split out of `summon-gate-server.ts`.
 */

import type { HrcDatabase } from 'hrc-store-sqlite'

import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus } from '../server-util.js'
import { markRuntimeStale } from '../startup-reconcile/runtime-mutations.js'
import { assertSummonAuthority } from './summon-gate-server-authority.js'
import { type SummonGateServerContext, gateDepsFor } from './summon-gate-server-context.js'
import type { SummonCapabilityHint, SummonGateResult, SummonPath } from './summon-gate.js'

export type LivePlacementRepairSummary = {
  scanned: number
  repaired: number
  alreadyBound: number
  unresolved: number
}

export type LivePlacementRepairCandidate = {
  readonly scopeRef: string
  readonly capabilityHint?: SummonCapabilityHint | undefined
}

function fenceUnresolvedRepairCandidate(
  server: SummonGateServerContext,
  scopeRef: string,
  detail: string
): void {
  for (const runtime of server.db.runtimes.listAll()) {
    if (runtime.scopeRef !== scopeRef || isRuntimeUnavailableStatus(runtime.status)) continue
    if (isExternalLifecycleOwner(runtime)) continue
    const session = server.db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (session === null) continue
    markRuntimeStale(server.db, session, runtime, {
      reason: 'placement_repair_refused',
      detail,
    })
  }
}

/**
 * Snapshot scopes that were live when startup opened the database.
 *
 * Startup reconciliation may conservatively mark an otherwise-repairable
 * runtime stale before the federation endpoints are constructed. Capturing at
 * this boundary preserves that scope for binding repair without ever sweeping
 * older stale/dead/terminated rows into the candidate set.
 */
export function captureLivePlacementRepairCandidates(
  db: HrcDatabase
): readonly LivePlacementRepairCandidate[] {
  const candidates = new Map<string, LivePlacementRepairCandidate>()
  for (const runtime of db.runtimes.listAll()) {
    if (isRuntimeUnavailableStatus(runtime.status) || !runtime.scopeRef.startsWith('agent:')) {
      continue
    }
    const session = db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (session?.status !== 'active') continue
    candidates.set(runtime.scopeRef, {
      scopeRef: runtime.scopeRef,
      ...(session.lastAppliedIntentJson === undefined
        ? {}
        : {
            capabilityHint: {
              placement: session.lastAppliedIntentJson.placement,
              harness: session.lastAppliedIntentJson.harness,
            },
          }),
    })
  }
  return [...candidates.values()]
}

/**
 * Rollout repair for T-06697's already-running unbound policy births.
 *
 * Existing-session delivery does not re-enter the summon gate. Before a
 * restarted daemon is reported ready, replay every locally live agent scope
 * through the implicit policy path. The normal gate remains the sole decision
 * authority, and the normal registry-first commit remains the sole writer.
 */
export async function repairLiveUnboundPlacements(
  server: SummonGateServerContext,
  candidates = captureLivePlacementRepairCandidates(server.db)
): Promise<LivePlacementRepairSummary> {
  const summary: LivePlacementRepairSummary = {
    scanned: 0,
    repaired: 0,
    alreadyBound: 0,
    unresolved: 0,
  }
  if (candidates.length === 0) return summary

  const deps = gateDepsFor(server)
  if (deps === undefined) return summary

  for (const candidate of candidates) {
    const { scopeRef } = candidate
    summary.scanned += 1
    if (deps.ledger.activeAuthority(scopeRef) !== undefined) {
      summary.alreadyBound += 1
      continue
    }

    // A collective binding already naming this node is the crash-recovery
    // authority. Install it before capability observation: these candidates
    // were already running at the startup boundary, so materialization checks
    // for a future launch (for example, an agent home since removed after a
    // soak probe ran) must not prevent the exact registry row from healing the
    // local ledger or wedge the whole daemon at boot.
    try {
      const registry = await deps.registry.consult(scopeRef)
      if (registry.outcome === 'bound' && registry.binding.homeNodeId === deps.localNodeId) {
        deps.ledger.installActive(registry.binding)
        summary.repaired += 1
        continue
      }

      await assertSummonAuthority(server, {
        scopeRef,
        path: 'ensure-target',
        intent: 'implicit',
        origin: 'startup-repair',
        ...(candidate.capabilityHint === undefined
          ? {}
          : { capabilityHint: candidate.capabilityHint }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      fenceUnresolvedRepairCandidate(server, scopeRef, detail)
      summary.unresolved += 1
      writeServerLog('WARN', 'federation.placement_repair.refused', {
        scopeRef,
        localNodeId: deps.localNodeId,
        mode: deps.mode,
        detail,
      })
      continue
    }

    const repaired = deps.ledger.activeAuthority(scopeRef)
    if (repaired?.homeNodeId === deps.localNodeId) {
      summary.repaired += 1
      continue
    }

    summary.unresolved += 1
    writeServerLog('WARN', 'federation.placement_repair.unresolved', {
      scopeRef,
      localNodeId: deps.localNodeId,
      mode: deps.mode,
    })
    fenceUnresolvedRepairCandidate(
      server,
      scopeRef,
      `live placement repair left ${scopeRef} without local collective authority on ${deps.localNodeId}`
    )
  }

  writeServerLog('INFO', 'federation.placement_repair.completed', {
    localNodeId: deps.localNodeId,
    ...summary,
  })
  return summary
}

/**
 * Refuses a locally retired scope before an existing target
 * row can bypass the summon gate entirely.
 *
 * This is deliberately limited to node-local hard stops: target selection also
 * handles established local sessions and legitimate remote routing, neither of
 * which may be forced through virgin-placement or capability evaluation merely
 * to check the fence. When no exact local mark exists, this does one local
 * lookup and leaves the pre-existing path byte-for-byte unchanged.
 */
export async function assertScopeNotRetired(
  server: SummonGateServerContext,
  request: {
    scopeRef: string
    path: SummonPath
    /** True only when the same request is guaranteed to enter the full gate later. */
    advisoryCoveredByDownstreamGate?: (() => boolean) | undefined
  }
): Promise<SummonGateResult | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined

  const locallyRetired = deps.ledger.get?.(request.scopeRef)?.state === 'retired'
  if (!locallyRetired) {
    return undefined
  }

  // Enforce never invokes this callback: the hard stop below still runs before
  // any target lookup. Advisory is observational, so an archived/new target
  // already guaranteed to enter the full summon gate should keep its existing
  // single event instead of emitting a duplicate at both seams.
  if (deps.mode === 'advisory' && request.advisoryCoveredByDownstreamGate?.()) {
    return undefined
  }

  // Re-enter the canonical gate only after proving that a local hard stop applies.
  // Omitting a caller birth credential is intentional: node-local hard stops
  // must win before any authority mechanism is read.
  return await assertSummonAuthority(server, {
    scopeRef: request.scopeRef,
    path: request.path,
    intent: 'implicit',
  })
}
