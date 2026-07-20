import type {
  BindingRegistry,
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
  PlacementBinding,
  PlacementLedgerRepository,
  RegistryRetirementRecord,
} from 'hrc-store-sqlite'

import { parseNodeId } from './node-id.js'

export type EstablishLocalPlacementRequest = {
  scopeRef: string
  homeNodeId: string
  birthClass: FederationBirthClass
  authorityProvenance: BirthAuthorityProvenance
  establishmentProvenance: Exclude<EstablishmentProvenance, 'rebind'>
  now: string
}

export type EstablishLocalPlacementResult =
  | {
      outcome: 'established' | 'already-established' | 'bound-elsewhere'
      binding: PlacementBinding
    }
  | { outcome: 'retired'; retirement: RegistryRetirementRecord }

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
    placementEpoch: 1,
    birthClass: input.request.birthClass,
    authorityProvenance: input.request.authorityProvenance,
    establishmentProvenance: input.request.establishmentProvenance,
    now: input.request.now,
  })
  if (registryResult.outcome === 'retired') {
    return { outcome: 'retired', retirement: registryResult.retirement }
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
