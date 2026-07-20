import type {
  BindingRegistry,
  BirthAuthorityProvenance,
  EstablishmentProvenance,
  FederationBirthClass,
  PlacementBinding,
  PlacementLedgerRepository,
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

export type EstablishLocalPlacementResult = {
  outcome: 'established' | 'already-established' | 'bound-elsewhere'
  binding: PlacementBinding
}

/**
 * Linearizes a first birth at the collective registry before installing local
 * summon authority. If the process stops between those writes, the registry
 * remains authoritative and the same call converges by installing that exact
 * winning binding on retry.
 */
export function establishLocalPlacement(input: {
  registry: Pick<BindingRegistry, 'establish'>
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'installActive'>
  request: EstablishLocalPlacementRequest
}): EstablishLocalPlacementResult {
  const homeNodeId = parseNodeId(input.request.homeNodeId, 'homeNodeId')

  // Registry first is load-bearing. Do not move a ledger read above this call:
  // absence of a local row is explicitly not the virgin-binding predicate.
  const registryResult = input.registry.establish({
    scopeRef: input.request.scopeRef,
    homeNodeId,
    placementEpoch: 1,
    birthClass: input.request.birthClass,
    authorityProvenance: input.request.authorityProvenance,
    establishmentProvenance: input.request.establishmentProvenance,
    now: input.request.now,
  })
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
