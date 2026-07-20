import type { HrcRuntimeIntent, HrcTurnResponseFormat } from './contracts.js'
import type { HrcMessageAddress, HrcMessageKind, HrcMessagePhase } from './hrcchat-contracts.js'

/**
 * Federation wire vocabulary shared by the daemon, the SDK, and the CLI.
 *
 * WHY HERE AND NOT IN hrc-store-sqlite. The placement vocabulary was born in
 * the storage layer (T-06607) because storage was the only thing that needed
 * it. `hrc target locate` (T-06613) put it on the wire, and hrc-sdk builds
 * BEFORE hrc-server — so a locate DTO defined next to the ledger is not
 * reachable from the client that has to deserialize it. hrc-core is the one
 * package everything downstream can see.
 *
 * `hrc-store-sqlite` re-exports the three enums from here, so there is still
 * exactly ONE definition of what an establishment provenance may be. That
 * matters more than the file it lives in: the value is CHECK-constrained in two
 * SQL schemas, re-validated on two HTTP boundaries, and now rendered by locate.
 */

/** How a scope came to exist (federation spec §3). */
export type FederationBirthClass = 'policy-born' | 'mechanism-born'

/**
 * WHICH placement rule established a binding — locate's display vocabulary.
 *
 * `explicit_local` is an establishment provenance only, never a declared
 * policy: it records that an operator's start at a node WAS the declaration,
 * which by definition cannot be read out of a profile. `rebind` is writable
 * only by a compare-and-swap, never by an establish.
 */
export type EstablishmentProvenance =
  | 'pin'
  | 'task_default'
  | 'default_home_node'
  | 'default_home_node(local)'
  | 'explicit_local'
  | 'rebind'

/** Open-ended birth credential chain payload; `kind` discriminates. */
export type BirthAuthorityProvenance = Readonly<Record<string, unknown>> & {
  readonly kind: string
}

/** Gate enforcement level for this node. */
export type FederationGateModeValue = 'off' | 'advisory' | 'enforce'

// -- Peer message envelope ---------------------------------------------------

/** Epoch-fenced destination named by an origin before it enters the outbox. */
export type FederationExpectedPlacement = {
  readonly homeNodeId: string
  readonly placementEpoch: number
}

/**
 * Optional delivery context needed to preserve today's local summon/queue
 * behavior after the receiver durably inserts the transcript row.
 *
 * It deliberately excludes wait (which stays origin-local) and birthCredential
 * (child birth never crosses nodes).
 */
export type FederationMessageDelivery = {
  readonly runtimeIntent?: HrcRuntimeIntent | undefined
  readonly createIfMissing?: boolean | undefined
  readonly parsedScopeJson?: Readonly<Record<string, unknown>> | undefined
  readonly respondTo?: HrcMessageAddress | undefined
  readonly responseFormat?: HrcTurnResponseFormat | undefined
  readonly allowStaleGeneration?: boolean | undefined
}

/** Federation v1 tolerant-reader envelope (spec §6). */
export type FederationMessageEnvelope = {
  readonly protocolVersion: string
  readonly messageId: string
  readonly kind: HrcMessageKind
  readonly phase: HrcMessagePhase
  readonly from: HrcMessageAddress
  readonly to: HrcMessageAddress
  readonly body: string
  readonly rootMessageId: string
  readonly replyToMessageId?: string | undefined
  readonly expected: FederationExpectedPlacement
  readonly delivery?: FederationMessageDelivery | undefined
}

// -- `hrc target locate` -----------------------------------------------------

/**
 * What placement policy DECLARES for a scope, in the same vocabulary used to
 * stamp `establishmentProvenance` — so a reader can line the two up directly.
 */
export type LocateDeclaredPolicy =
  | { source: 'pin'; pinKey: string; nodeId: string; profilePath: string }
  | {
      source: 'pin-invalid'
      pinKey: string
      rawValue: string
      profilePath: string
      detail: string
    }
  | { source: 'task-default'; taskKey: string; nodeId: string; profilePath: string }
  | {
      source: 'task-default-invalid'
      taskKey: string
      rawValue: string
      profilePath: string
      detail: string
    }
  | { source: 'default_home_node'; nodeId: string; profilePath: string }
  /** `default_home_node = "local"`, resolved once to the daemon's own nodeId. */
  | { source: 'default_home_node(local)'; nodeId: string; profilePath: string }
  /** A readable profile that declares no placement for this scope. */
  | { source: 'none'; detail: string; profilePath?: string | undefined }
  /** Policy could not be read. NOT the same as "declares nothing". */
  | { source: 'unavailable'; detail: string }

export type LocateBindingRecord = {
  homeNodeId: string
  placementEpoch: number
  birthClass: FederationBirthClass
  establishmentProvenance: EstablishmentProvenance
  authorityProvenance: BirthAuthorityProvenance
  priorHomeNodeId?: string | undefined
  createdAt: string
  updatedAt: string
}

export type LocateLedgerView =
  | { state: 'active' | 'revoked'; record: LocateBindingRecord }
  | { state: 'absent' }

export type LocateRegistryView =
  | { outcome: 'bound'; record: LocateBindingRecord }
  | { outcome: 'unbound' }
  /** Consulted and failed. Never collapsed into `unbound` (§5 fail-closed). */
  | { outcome: 'unknown'; detail: string; retryable: boolean }
  /** Not consulted — the local ledger already answered, or federation is off. */
  | { outcome: 'not-consulted'; detail: string }

/** Who holds summon authority, and which layer said so. */
export type LocateAuthority =
  | { state: 'bound'; source: 'ledger' | 'registry'; record: LocateBindingRecord; isLocal: boolean }
  | { state: 'unbound' }
  | { state: 'unknown'; detail: string; retryable: boolean }

export type LocateObservedRuntime = {
  runtimeId: string
  laneRef: string
  status: string
  transport?: string | undefined
  updatedAt?: string | undefined
}

export type LocateObservation = {
  /** F0 observes this node only; peer observation is F1. */
  scope: 'local-node-only'
  nodeId: string
  runtimeCount: number
  runtimes: readonly LocateObservedRuntime[]
}

/** A matched placement constraint disagreeing with an established binding. */
export type LocateSkew =
  | {
      kind: 'pin-vs-binding'
      pinKey: string
      pinnedNodeId: string
      boundNodeId: string
      placementEpoch: number
      establishmentProvenance: EstablishmentProvenance
      detail: string
    }
  | {
      kind: 'task-default-vs-binding'
      taskKey: string
      taskDefaultNodeId: string
      boundNodeId: string
      placementEpoch: number
      establishmentProvenance: EstablishmentProvenance
      detail: string
    }

/** Non-skew explanations, so expected divergence stays legible. */
export type LocateNote = {
  code:
    | 'unpinned-established-elsewhere'
    | 'unpinned-established-locally'
    | 'pin-honored'
    | 'task-default-honored'
    | 'scope-retired'
    | 'birth-chain-unresolved'
  detail: string
}

export type LocateBirthChainLink = {
  scopeRef: string
  birthClass: FederationBirthClass
  homeNodeId: string
  authorityProvenance: BirthAuthorityProvenance
}

export type LocateBirthChain =
  | { state: 'not-applicable'; detail: string }
  /** `ancestor` is the terminating policy-born or claim-born link. */
  | { state: 'resolved'; links: readonly LocateBirthChainLink[]; ancestor: LocateBirthChainLink }
  | { state: 'unresolved'; detail: string }

/** Node-local retirement mark written by reconciliation (T-06614). */
export type LocateRetirement = {
  retiredNodeId: string
  canonicalHomeNodeId: string
  canonicalPlacementEpoch: number
  reason: string
}

/** `GET /v1/federation/locate?scopeRef=…` */
export type ScopeLocation = {
  scopeRef: string
  localNodeId: string
  federationConfigured: boolean
  gateMode: FederationGateModeValue
  declared: LocateDeclaredPolicy
  ledger: LocateLedgerView
  registry: LocateRegistryView
  authority: LocateAuthority
  observed: LocateObservation
  /** Present only for a pin that disagrees with an established binding. */
  skew?: LocateSkew | undefined
  notes: readonly LocateNote[]
  retirement?: LocateRetirement | undefined
  birthChain: LocateBirthChain
}

export type LedgerSkewScan = {
  scanned: number
  skewed: readonly { scopeRef: string; skew: LocateSkew }[]
  /** Scopes whose declared policy could not be read, so skew is unknown. */
  unreadable: readonly { scopeRef: string; detail: string }[]
}

/** `GET /v1/federation/bindings` */
export type LocateBindingsReport = {
  localNodeId: string
  federationConfigured: boolean
  gateMode: FederationGateModeValue
  scan: LedgerSkewScan
}
