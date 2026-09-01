import type {
  BindingRegistry,
  BirthDesignationRecord,
  FederationPlacementSource,
  PlacementBinding,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

import { parseNodeId } from './node-id.js'

export type EstablishLocalPlacementRequest = {
  scopeRef: string
  homeNodeId: string
  placementSource: FederationPlacementSource
  now: string
}

export type EstablishLocalPlacementResult =
  | {
      outcome: 'established' | 'already-established' | 'bound-elsewhere'
      binding: PlacementBinding
    }
  /**
   * The T-07655 establish fence: this node tried a tier-5 designated birth for
   * a scope the registry has designated to a DIFFERENT node. Nothing was
   * written. It is not a race lost — it is the arbitration that stops the race
   * from happening, so it is reported as its own outcome rather than folded
   * into `bound-elsewhere`, which means a birth that actually happened.
   */
  | { outcome: 'designation-mismatch'; designation: BirthDesignationRecord }

/**
 * Linearizes a first birth at the collective registry before installing local
 * summon authority. If the process stops between those writes, the registry
 * remains authoritative and the same call converges by installing that exact
 * winning binding on retry.
 */
export async function establishLocalPlacement(input: {
  registry: {
    establish(
      request: Parameters<BindingRegistry['establish']>[0]
    ): ReturnType<BindingRegistry['establish']> | Promise<ReturnType<BindingRegistry['establish']>>
  }
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'installActive'>
  request: EstablishLocalPlacementRequest
}): Promise<EstablishLocalPlacementResult> {
  const homeNodeId = parseNodeId(input.request.homeNodeId, 'homeNodeId')

  // Registry first is load-bearing. Do not move a ledger read above this call:
  // absence of a local row is explicitly not the virgin-binding predicate.
  const registryResult = await input.registry.establish({
    scopeRef: input.request.scopeRef,
    homeNodeId,
    placementSource: input.request.placementSource,
    now: input.request.now,
  })
  if (registryResult.outcome === 'designation-mismatch') {
    return { outcome: 'designation-mismatch', designation: registryResult.designation }
  }
  const binding = registryResult.binding

  if (binding.homeNodeId !== homeNodeId) {
    return { outcome: 'bound-elsewhere', binding }
  }

  const alreadyActive = input.ledger.activeAuthority(binding.scopeRef)
  input.ledger.installActive(binding)
  return {
    outcome: alreadyActive === undefined ? 'established' : 'already-established',
    binding,
  }
}
