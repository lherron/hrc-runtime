import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcTurnResponseFormat } from './contracts.js'
import type { HrcMessageAddress, HrcMessageKind, HrcMessagePhase } from './hrcchat-contracts.js'
import type { HrcMailEnvelope, HrcMailSendRequest } from './hrcmail-contracts.js'

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

// -- Peer message envelope ---------------------------------------------------

/** Destination home named by an origin before it enters the retained outbox store. */
export type FederationExpectedPlacement = {
  readonly homeNodeId: string
}

/**
 * Optional delivery context needed to preserve today's local summon/queue
 * behavior after the receiver durably inserts the transcript row.
 *
 * It deliberately excludes wait, which stays origin-local.
 */
export type FederationMessageDelivery = {
  readonly runtimeIntent?: HrcRuntimeIntent | undefined
  readonly createIfMissing?: boolean | undefined
  readonly parsedScopeJson?: Readonly<Record<string, unknown>> | undefined
  readonly respondTo?: HrcMessageAddress | undefined
  readonly responseFormat?: HrcTurnResponseFormat | undefined
  readonly allowStaleGeneration?: boolean | undefined
  /**
   * Additive discriminator for `/v1/messages/turn-handoff`.
   *
   * Older peers deliberately do not receive this payload: the origin first
   * requires the `semanticTurnHandoff` peer-health capability so an old
   * tolerant reader cannot silently downgrade a turn into an ordinary DM.
   */
  readonly semanticTurnHandoff?:
    | { readonly version: 1 }
    | { readonly version: 2; readonly freshContext: true }
    | undefined
  /**
   * T-07155 — urgent (preemptive) delivery marker.
   *
   * Versioned and strict-validated so an unknown version is refused rather than
   * ignored. Note this member never reaches an old tolerant reader at all:
   * urgent envelopes ride `/v1/federation/accept-urgent`, which a peer without
   * the feature refuses at the transport before parsing anything. The marker is
   * belt-and-braces for peers that DO have the route but an older parse.
   */
  readonly urgent?: { readonly version: 1 } | undefined
  /**
   * T-07214 — tolerant best-effort delivery class. Deliberately TOLERANT
   * (unlike `urgent`): a downlevel peer that ignores it delivers the ordinary
   * floor, which is legitimate delivery for a best-effort class. Only
   * 'steer_else_queue' ever rides ordinary carriage — the strict class is
   * refused at the origin for remote targets and never reaches an envelope.
   * Destination ingress honours it only for peers holding allowUrgentDelivery.
   */
  readonly whenBusy?: 'steer_else_queue' | undefined
}

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
    readonly transport?: 'sdk' | 'tmux' | 'headless' | undefined
    readonly payload: Readonly<Record<string, unknown>>
  }
}

/**
 * hrcmail's additive payload on the existing home-fenced federation message.
 *
 * The ordinary message fields remain the transport identity and response
 * fence. A request creates one destination-local envelope; a disposition is
 * the terminal envelope projection returned to its accepted origin request.
 */
export type FederationMailPayload =
  | {
      readonly version: 1
      readonly type: 'request'
      readonly envelopeId: string
      readonly request: HrcMailSendRequest
    }
  | {
      readonly version: 1
      readonly type: 'disposition'
      readonly envelope: HrcMailEnvelope
    }

/** Federation v1 tolerant-reader envelope (spec §6). */
export type FederationMessageEnvelope = {
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
  readonly semanticTurnSignal?: FederationSemanticTurnSignal | undefined
  readonly interactiveSignal?: FederationInteractiveLifecycleSignal | undefined
  readonly mail?: FederationMailPayload | undefined
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
}

/** `GET /v1/federation/bindings` */
export type LocateBindingsReport = {
  localNodeId: string
  federationConfigured: boolean
  gateMode: FederationGateModeValue
  scan: LedgerSkewScan
}
