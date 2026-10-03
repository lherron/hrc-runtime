/**
 * Server-side wiring for the summon gate (T-06608).
 *
 * The gate itself (`summon-gate.ts`) is a pure decision over injected
 * dependencies. This module is the one place that builds those dependencies
 * from live daemon state and the one call the five session-creation paths make,
 * so a path can never accidentally ask a differently-configured gate.
 *
 * Cost discipline: the gate context is built LAZILY and memoized. A daemon with
 * no federation config never constructs a ledger repository, never opens the
 * placement table, and never resolves placement policy — `assertSummonAuthority`
 * returns on its first branch. That is what "flag-gated" has to mean for a
 * change that sits on every session-creation path.
 */

export type { SummonGateServerContext } from './summon-gate-server-context.js'
export {
  assertSummonAuthority,
  withParticipantAddressAuthority,
  withSummonAuthority,
} from './summon-gate-server-authority.js'
export {
  assertProvisionDirectiveAdmissible,
  preflightExactScope,
  preflightSuffixRosterFamily,
  resolveImplicitScopeHome,
} from './summon-gate-server-preflight.js'
export type {
  ExternalRegistrationPlacementResult,
  SummonAuthorityRequest,
  SummonAuthorityResult,
} from './summon-gate-server-placement.js'
export {
  establishExternalRegistrationPlacement,
  establishRemotePolicyAuthority,
  externalRegistrationPlacementAdvisory,
  resolvePlacementOnServer,
} from './summon-gate-server-placement.js'
export type {
  LivePlacementRepairCandidate,
  LivePlacementRepairSummary,
} from './summon-gate-server-repair.js'
export {
  assertScopeNotRetired,
  captureLivePlacementRepairCandidates,
  repairLiveUnboundPlacements,
} from './summon-gate-server-repair.js'
