import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcTurnResponseFormat } from './contracts.js'
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

/**
 * Narrow cross-node lifecycle projection for an interactive semantic turn.
 * This is deliberately not a general event-stream protocol: it carries only
 * the AskUserQuestion start needed by an origin-side interface to render and
 * route the human's answer.
 */
export type FederationInteractiveLifecycleSignal = {
  readonly version: 1
  readonly type: 'ask_user_question'
  readonly sourceHrcSeq: number
  readonly acpRunId?: string | undefined
  readonly event: {
    readonly eventKind: 'turn.tool_call'
    readonly ts: string
    readonly hostSessionId: string
    readonly scopeRef: string
    readonly laneRef: string
    readonly generation: number
    readonly runtimeId?: string | undefined
    readonly runId: string
    readonly transport?: 'sdk' | 'tmux' | 'headless' | 'ghostty' | undefined
    readonly payload: Readonly<Record<string, unknown>>
  }
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
  readonly interactiveSignal?: FederationInteractiveLifecycleSignal | undefined
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

/** Message payload retained durably before an authority fence exists. */
export type FederationPendingMessageEnvelope = Omit<FederationMessageEnvelope, 'expected'>

// -- Origin outbox operator surface -----------------------------------------

/** Durable origin-side delivery lifecycle exposed to operators in F3. */
export type FederationOutboxState =
  | 'pending'
  | 'retry_scheduled'
  | 'peer_unreachable'
  | 'delivered'
  | 'dead_letter'

/** Public typed failure retained with a durable delivery. */
export type FederationOutboxError = {
  readonly code: string
  readonly message: string
  readonly reason?: string | undefined
  readonly retryable: boolean
  readonly homeNodeId?: string | undefined
}

/**
 * One durable delivery attempt stream. The envelope remains available in the
 * JSON projection for forensic use; the human CLI intentionally renders only
 * routing, age, attempt, and last-error fields.
 */
type FederationOutboxDeliveryCommon = {
  deliveryId: string
  messageId: string
  peerNodeId: string
  state: FederationOutboxState
  totalAttempts: number
  cycleAttempts: number
  replayCount: number
  retryWindowStartedAt: string
  nextAttemptAt?: string | undefined
  lastAttemptAt?: string | undefined
  deliveredAt?: string | undefined
  deadLetteredAt?: string | undefined
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
  lastError?: FederationOutboxError | undefined
  createdAt: string
  updatedAt: string
}

export type FederationOutboxDeliveryRecord = FederationOutboxDeliveryCommon &
  (
    | {
        stage: 'establishing'
        establish: FederationRemoteEstablishRequest
        envelope: FederationPendingMessageEnvelope
      }
    | {
        stage: 'delivering'
        envelope: FederationMessageEnvelope
      }
  )

// -- F3 peer health and all-node runtime projections ------------------------

/** Capabilities reported by the authenticated peer-protocol health route. */
export type FederationPeerCapabilities = {
  readonly accept: boolean
  readonly locate: boolean
  readonly health: boolean
  /** Authority-only remote policy establishment. */
  readonly establish?: boolean | undefined
  /** Additive v1 capability; older peers simply omit it. */
  readonly runtimeProjection?: boolean | undefined
}

/** One bounded on-demand peer probe. Tokens and other transport secrets never enter this DTO. */
export type FederationPeerHealthObservation = {
  readonly nodeId: string
  readonly state: 'healthy' | 'unreachable' | 'refused' | 'invalid-response'
  readonly checkedAt: string
  readonly answeredAt?: string | undefined
  readonly latencyMs: number
  readonly protocolVersion?: string | undefined
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

// -- F3 fenced manual rebind -------------------------------------------------

export type FederationRebindStep = 'revoke' | 'cas' | 'activate'

/** The exact old tuple and intended successor used by every idempotent step. */
export type FederationRebindRequest = {
  readonly scopeRef: string
  readonly expectedHomeNodeId: string
  readonly expectedPlacementEpoch: number
  readonly newHomeNodeId: string
}

export type FederationRebindOutcome =
  | 'revoked'
  | 'registry-updated'
  | 'activated'
  | 'idempotent'
  | 'conflict'
  | 'refused'
  | 'peer-unreachable'
  | 'live-runtime-present'

export type FederationRebindState =
  | 'unchanged'
  | 'old-home-live'
  | 'revoked-nowhere'
  | 'registry-moved-activation-pending'
  | 'active-new-home'

/** Visible result of one retryable manual-rebind step; never contains peer tokens. */
export type FederationRebindResult = {
  readonly step: FederationRebindStep
  readonly ok: boolean
  readonly outcome: FederationRebindOutcome
  readonly state: FederationRebindState
  readonly retryable: boolean
  readonly detail: string
  readonly request: FederationRebindRequest
  readonly binding?: LocateBindingRecord | undefined
  readonly ledger?: LocateLedgerView | undefined
  readonly liveRuntimeIds?: readonly string[] | undefined
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
  | {
      outcome: 'retired'
      record: {
        placementEpoch: number
        retiredHomeNodeId: string
        successorNodeId: string | null
        birthClass: FederationBirthClass
        authorityProvenance: BirthAuthorityProvenance
        createdAt: string
        updatedAt: string
        retiredAt: string
        reason: string
      }
    }
  | { outcome: 'unbound' }
  /** Consulted and failed. Never collapsed into `unbound` (§5 fail-closed). */
  | { outcome: 'unknown'; detail: string; retryable: boolean }
  /** Not consulted — the local ledger already answered, or federation is off. */
  | { outcome: 'not-consulted'; detail: string }

/** Who holds summon authority, and which layer said so. */
export type LocateAuthority =
  | { state: 'bound'; source: 'ledger' | 'registry'; record: LocateBindingRecord; isLocal: boolean }
  | {
      state: 'retired'
      placementEpoch: number
      retiredHomeNodeId: string
      successorNodeId: string | null
      birthClass: FederationBirthClass
      authorityProvenance: BirthAuthorityProvenance
    }
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
    | 'rebind-revoked'
    | 'rebind-activation-pending'
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
  retiredPlacementEpoch: number
  successorNodeId: string | null
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
  /** Present when authority names another node and this daemon attempts an on-demand peer locate. */
  peerResolution?: LocatePeerResolution | undefined
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
