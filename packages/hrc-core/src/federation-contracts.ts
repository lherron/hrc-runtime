import type { HrcRuntimeSnapshot } from './contracts.js'

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
 * The only retained provenance vocabulary belongs to the distinct T-07655
 * birth-designation decision. Established bindings carry no provenance.
 */

/** A declared establishment that atomically supersedes a tier-5 designation. */
export type BirthDesignationSupersededBy =
  | 'pin'
  | 'task_default'
  | 'default_home_node'
  | 'explicit_local'

/**
 * Transient input to the birth-designation transaction, never binding data.
 * Ordinary establishment omits it entirely.
 */
export type BirthDesignationEstablishmentDecision =
  | {
      readonly action: 'supersede'
      readonly supersededBy: BirthDesignationSupersededBy
    }
  | { readonly action: 'enforce-designated-home' }

/** The tier-5 provenances a birth designation can produce (T-07655). */
export type BirthDesignationProvenance =
  | 'default_home_node(sender)'
  | 'default_home_node(sender-retired)'

/**
 * A recorded tier-5 birth designation: the node one virgin scope is born on,
 * derived ONCE by the single-writer registry host from registry state plus the
 * wrkq birth envelope it reads itself.
 *
 * It is a DEFAULT, not a constraint. `superseded` is what a tier-1-4
 * establishment leaves behind when it wins, in the same transaction.
 */
export type BirthDesignationState = 'live' | 'superseded'

export type BirthDesignationRecord = {
  readonly scopeRef: string
  readonly homeNodeId: string
  readonly provenance: BirthDesignationProvenance
  readonly birthEnvelopeId: string
  /** The sender scope whose home this designation followed. */
  readonly senderScopeRef: string
  /**
   * Per-scope ordinal: 1 for a scope's first designation, incremented by each
   * later one. It re-arms the once-per-scope `birth_deferred` line after a
   * supersession instead of silencing it forever.
   */
  readonly designationEpoch: number
  readonly designatedAt: string
  readonly state: BirthDesignationState
  /** The declared tier that superseded this designation. */
  readonly supersededBy?: BirthDesignationSupersededBy | undefined
  readonly supersededAt?: string | undefined
}

/**
 * The registry host's answer to `designateBirth {scopeRef}`.
 *
 * `none` means the ledger cannot name a placeable sender — no birth envelope, a
 * scope-less sender, or one the registry does not know — and NOTHING is
 * recorded. The caller falls through to today's tier 5.
 */
export type BirthDesignationResult =
  | { readonly kind: 'designated'; readonly designation: BirthDesignationRecord }
  | { readonly kind: 'none' }

/** Gate enforcement level for this node. */
export type FederationGateModeValue = 'off' | 'advisory' | 'enforce'

export type FederationSemanticTurnIdentity = {
  readonly sessionRef: string
  readonly scopeRef: string
  readonly laneRef: string
  readonly hostSessionId: string
  readonly runtimeId: string
  readonly runId: string
  readonly generation: number
  readonly mode: 'headless' | 'interactive' | 'nonInteractive'
  readonly transport: 'sdk' | 'tmux' | 'headless'
}

/**
 * Destination-authored lifecycle bracket for a federated semantic turn.
 *
 * The signal returns over the already-fenced response route. The origin
 * projects it into its local lifecycle stream so existing hrcchat watchers do
 * not need a peer URL, token, or a second transport.
 */
export type FederationSemanticTurnSignal =
  | {
      readonly version: 1
      readonly type: 'started'
      readonly sourceHrcSeq: number
      readonly identity: FederationSemanticTurnIdentity
    }
  | {
      readonly version: 1
      readonly type: 'terminal'
      readonly sourceHrcSeq: number
      readonly identity: FederationSemanticTurnIdentity
      readonly outcome: 'completed' | 'failed'
      readonly errorCode?: string | undefined
      readonly errorMessage?: string | undefined
    }

/** Exact durable placement tuple returned by authority establishment. */
export type FederationPlacementBinding = LocateBindingRecord & {
  readonly scopeRef: string
}

/** Authority-only request. No origin-side placement assertion crosses the wire. */
export type FederationRemoteEstablishRequest = {
  readonly scopeRef: string
  readonly intent: 'implicit'
  readonly correlationId: string
}

export type FederationRemoteEstablishResult =
  | {
      readonly outcome: 'established' | 'existing'
      readonly correlationId: string
      readonly binding: FederationPlacementBinding
    }
  | {
      readonly outcome: 'refused'
      readonly status: number
      readonly code: 'stale_context' | 'runtime_unavailable'
      readonly message: string
      readonly reason: string
      readonly retryable: boolean
      readonly homeNodeId?: string | undefined
    }

// -- Origin outbox operator surface -----------------------------------------

/** Durable origin-side delivery lifecycle exposed to operators in F3. */
export type FederationOutboxState =
  | 'pending'
  | 'retry_scheduled'
  | 'peer_unreachable'
  | 'delivered'
  | 'dead_letter'

// -- F3 peer health and all-node runtime projections ------------------------

/** Capabilities reported by the authenticated peer-protocol health route. */
export type FederationPeerCapabilities = {
  readonly locate: boolean
  readonly health: boolean
  /** Authority-only remote policy establishment. */
  readonly establish?: boolean | undefined
  /** Authenticated home-node suffix-roster provisioning. */
  readonly rosterStart?: boolean | undefined
  /** T-07302 — authenticated home-node exact-scope provisioning (`exactStart`). */
  readonly exactStart?: boolean | undefined
  /** Additive v1 capability; older peers simply omit it. */
  readonly runtimeProjection?: boolean | undefined
  /** Additive v1 capability; required before forwarding semantic turn handoffs. */
  readonly semanticTurnHandoff?: boolean | undefined
}

/** One bounded on-demand peer probe. Tokens and other transport secrets never enter this DTO. */
export type FederationPeerHealthObservation = {
  readonly nodeId: string
  readonly state: 'healthy' | 'unreachable' | 'refused' | 'invalid-response'
  readonly checkedAt: string
  readonly answeredAt?: string | undefined
  readonly latencyMs: number
  readonly startedAt?: string | undefined
  readonly capabilities?: FederationPeerCapabilities | undefined
  readonly detail?: string | undefined
}

/**
 * Node-labeled runtime inventory. An unreachable node may retain the last
 * successful in-memory projection; `answeredAt` makes that staleness explicit.
 */
export type FederationNodeRuntimeProjection = {
  readonly nodeId: string
  readonly state: 'answered' | 'unreachable' | 'refused' | 'invalid-response'
  readonly checkedAt: string
  readonly answeredAt?: string | undefined
  readonly latencyMs: number
  readonly runtimes: readonly HrcRuntimeSnapshot[]
  readonly detail?: string | undefined
}

/** Best-effort, bounded aggregation returned by `hrc runtime list --all-nodes`. */
export type FederationRuntimeProjectionReport = {
  readonly localNodeId: string
  readonly generatedAt: string
  readonly nodes: readonly FederationNodeRuntimeProjection[]
}

// -- F3 ordered retirement ---------------------------------------------------

export type FederationRetirementRequest = {
  readonly scopeRef: string
  readonly reason: string
}

export type FederationRetirementOutcome =
  | 'retired'
  | 'idempotent'
  | 'conflict'
  | 'refused'
  | 'registry-unavailable'
  | 'live-runtime-present'

export type FederationRetirementState =
  | 'unchanged'
  | 'old-home-live'
  | 'fenced-registry-pending'
  | 'retired'

/** Visible result of the authenticated, idempotent old-home operation. */
export type FederationRetirementResult = {
  readonly ok: boolean
  readonly outcome: FederationRetirementOutcome
  readonly state: FederationRetirementState
  readonly retryable: boolean
  readonly detail: string
  readonly request: FederationRetirementRequest
  readonly binding?: LocateBindingRecord | undefined
  readonly ledger?: LocateLedgerView | undefined
  readonly liveRuntimeIds?: readonly string[] | undefined
}

// -- `hrc target locate` -----------------------------------------------------

/** What placement policy declares for a scope. */
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
  createdAt: string
  updatedAt: string
}

export type LocateLedgerView =
  | { state: 'active' | 'retired'; record: LocateBindingRecord }
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

/** Cross-node resolution of the authoritative home through the peer protocol. */
export type LocatePeerResolution =
  | {
      readonly nodeId: string
      readonly state: 'answered'
      readonly checkedAt: string
      readonly answeredAt: string
      readonly latencyMs: number
      /** Peer responses are local-only and therefore never recursively resolve another peer. */
      readonly location: ScopeLocation
    }
  | {
      readonly nodeId: string
      readonly state: 'unreachable' | 'refused' | 'invalid-response' | 'unconfigured'
      readonly checkedAt: string
      readonly latencyMs: number
      readonly detail: string
    }

/** A placement constraint disagreeing with an established binding. */
export type LocateSkew =
  | {
      kind: 'pin-vs-binding'
      pinKey: string
      pinnedNodeId: string
      boundNodeId: string
      detail: string
    }
  | {
      kind: 'task-default-vs-binding'
      taskKey: string
      taskDefaultNodeId: string
      boundNodeId: string
      detail: string
    }
  | {
      /** External registrations remain governed by declared placement. */
      kind: 'default-home-vs-binding'
      defaultHomeNodeId: string
      boundNodeId: string
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
  detail: string
}

/** Durable node-local retirement fence. */
export type LocateRetirement = {
  retiredNodeId: string
  reason: string
  retiredAt: string
}

/** `GET /v1/federation/locate?scopeRef=…` */
/**
 * The FOURTH independent truth (T-07655): what the collective designated as
 * this scope's tier-5 birth node, and whether that designation still stands.
 *
 * It is reported beside declared / binding / observed and never folded into any
 * of them, for the same reason the other three are kept apart: a designation
 * that disagreed with the binding would be invisible if either could overwrite
 * the other. A designation is not policy (nothing declared it) and not
 * authority (it never held a binding) — it is the record of a DECISION, and the
 * only place an operator can see why a scope was born where it was.
 */
export type LocateDesignationView =
  | { outcome: 'designated'; record: BirthDesignationRecord }
  /** Every designation this scope has had, when the live one is not the only one. */
  | { outcome: 'superseded'; record: BirthDesignationRecord }
  | { outcome: 'none' }
  /** Consulted and failed. Never collapsed into `none`, per the §5 fail-closed rule. */
  | { outcome: 'unknown'; detail: string; retryable: boolean }
  /** Not consulted — this node does not host the registry, or federation is off. */
  | { outcome: 'not-consulted'; detail: string }

export type ScopeLocation = {
  scopeRef: string
  localNodeId: string
  federationConfigured: boolean
  gateMode: FederationGateModeValue
  declared: LocateDeclaredPolicy
  ledger: LocateLedgerView
  registry: LocateRegistryView
  /** T-07655 — the tier-5 birth designation, reported as its own truth. */
  designation: LocateDesignationView
  authority: LocateAuthority
  observed: LocateObservation
  /** Present when authority names another node and this daemon attempts an on-demand peer locate. */
  peerResolution?: LocatePeerResolution | undefined
  /** Present when a governing placement constraint disagrees with the binding. */
  skew?: LocateSkew | undefined
  notes: readonly LocateNote[]
  retirement?: LocateRetirement | undefined
}

export type LedgerSkewScan = {
  scanned: number
  skewed: readonly { scopeRef: string; skew: LocateSkew }[]
  /** Scopes whose declared policy could not be read, so skew is unknown. */
  unreadable: readonly { scopeRef: string; detail: string }[]
  /**
   * T-09760: present when the scan stopped at its time budget. The bindings
   * counted here were not assessed, so the report is partial.
   */
  truncated?:
    | {
        budgetMs: number
        notAssessed: number
        /** The binding whose policy was still resolving when the budget ran out. */
        inFlightScopeRef: string
      }
    | undefined
}

/** `GET /v1/federation/bindings` */
export type LocateBindingsReport = {
  localNodeId: string
  federationConfigured: boolean
  gateMode: FederationGateModeValue
  scan: LedgerSkewScan
}
