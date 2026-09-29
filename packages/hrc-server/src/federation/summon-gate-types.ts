import type { ProvisioningScalars } from 'agent-scope'
import type {
  HrcHarnessIntent,
  HrcRuntimePlacement as RuntimePlacement,
  SummonIntent,
} from 'hrc-core'
import type {
  BirthDesignationEstablishmentDecision,
  BirthDesignationRecord,
  PlacementBinding,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

import type { BindingRegistryClient } from './registry-client.js'

/** Structured-log sink. Matches `writeServerLog` (server-log.ts) by shape. */
export type SummonGateLog = (
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  details?: Record<string, unknown>
) => void

/** Single greppable event for the soak and for life after the enforce flip. */
export const SUMMON_GATE_REFUSAL_EVENT = 'federation.summon_gate.refusal'

export type SummonGateMode = 'off' | 'advisory' | 'enforce'

/**
 * The five session-creation paths the gate covers (enumerated on T-06608).
 *
 * `rotateSessionContext` and the sweep-summary row are deliberately NOT here:
 * a rotation continues an already-summoned agent rather than summoning one, and
 * the sweep row is synthetic bookkeeping under `system:hrc/sweep`, not an agent.
 * Both exemptions are documented rather than silent because `rotateSessionContext`
 * fires via `maybeAutoRotateStaleSession` on nearly every ingress.
 */
export type SummonPath =
  | 'ensure-target'
  | 'archived-successor'
  | 'resolve-session'
  | 'command-run'
  | 'app-session'

/**
 * Why this node was asked to summon (T-06609). Re-exported from the wire
 * contract so the gate and the HTTP surface can never drift apart on the
 * spelling of a value the whole placement rule turns on.
 *
 * This replaces T-06608's provisional derivation from the `create` /
 * `createIfMissing` booleans, and with it the `intentSource: 'legacy-boolean'`
 * tag those events carried.
 */
export type { SummonIntent }

export type SummonGateAllowReason =
  | 'gate-dark'
  | 'non-agent-scope'
  | 'local-authority'
  | 'registry-bound-local'
  | 'virgin-establishment'

export type SummonGateRefuseReason =
  | 'scope-retired'
  | 'participant-only'
  | 'bound-elsewhere'
  | 'pin-mismatch'
  | 'invalid-pin'
  | 'routed-elsewhere'
  | 'undeclared-placement'
  | 'policy-unavailable'
  | 'registry-unreachable'
  | 'registry-refused'
  | `capability-${SummonCapabilityName}-missing`
  | 'capability-project-root-unresolvable'
  | 'capability-observation-failed'
  | 'zombie-runtime'
  /**
   * T-07398 — the three directive refusals. They are refusals of the REQUEST,
   * not of this node's authority, so the server maps them to their own typed
   * wire codes rather than folding them into `stale_context`.
   */
  | 'placement-directive-conflict'
  | 'unknown-node'
  | 'invalid-provision-value'
  /**
   * T-07655 — the two tier-5 birth-designation refusals. Neither is a race
   * lost: they are what stops every node that tailed one ledger insert from
   * racing for the same virgin birth.
   *
   * `birth-designated-elsewhere` means the registry designated another node,
   * which will birth it from the same insert. `designated-home-unreachable`
   * means the designated node is not a peer this daemon knows, so nobody here
   * can act and an operator has to see it.
   */
  | 'birth-designated-elsewhere'
  | 'designated-home-unreachable'
  /** The establish fence itself, when a designated birth loses the CAS. */
  | 'birth-designation-mismatch'

/** Node-local facts required to materialize an agent scope (§5). */
export type SummonCapabilityName =
  | 'project-checkout'
  | 'agent-home-skills'
  | 'credentials'
  | 'harness'

/**
 * Observation made only after this node has summon authority.
 *
 * Capability is deliberately unable to name another node or return authority:
 * it can preserve the authority decision or turn it into a visible refusal,
 * never grant, move, or route authority.
 */
export type SummonCapabilityObservation =
  | { outcome: 'capable' }
  | {
      outcome: 'incapable'
      capability: SummonCapabilityName
      diagnostic: string
      capabilityReason?: 'project-root-unresolvable' | undefined
      retryable?: boolean | undefined
      capabilitySource?: 'presence-heuristic' | undefined
    }

/** Materialization inputs already resolved by an ingress such as hrcchat. */
export type SummonCapabilityHint = {
  placement?: RuntimePlacement | undefined
  harness?: HrcHarnessIntent | undefined
}

export type SummonGateEvaluation =
  | {
      decision: 'allow'
      reason: SummonGateAllowReason
      homeNodeId?: string | undefined
      /** T-07655-only transaction input; never established binding data. */
      birthDesignation?: BirthDesignationEstablishmentDecision | undefined
      /** Registry authority to install locally after a registry-first crash. */
      registryBinding?: PlacementBinding | undefined
      /** Exact local authority observed by the placement resolver. */
      placementBinding?: PlacementBinding | undefined
    }
  | {
      decision: 'refuse'
      reason: SummonGateRefuseReason
      /** Whether retrying can plausibly succeed without an operator edit. */
      retryable: boolean
      /** Operator-facing text. Always names the next action. */
      diagnostic: string
      homeNodeId?: string | undefined
      capability?: SummonCapabilityName | undefined
      capabilitySource?: 'presence-heuristic' | undefined
      /** Exact established remote authority; present only for bound-elsewhere. */
      placementBinding?: PlacementBinding | undefined
      /** The live tier-5 designation this refusal is about (T-07655). */
      birthDesignation?: BirthDesignationRecord | undefined
      /** True only when current named policy permits remote virgin establishment. */
      remoteEstablishmentAllowed?: true | undefined
    }

/**
 * Closed placement result shared by every summon-capable ingress.
 *
 * This is a decision only. Consumers may route, establish, or refuse from the
 * result, but the resolver itself never writes authority, enqueues delivery,
 * or mints a session.
 */
export type PlacementDisposition =
  | {
      outcome: 'local-bound'
      binding: PlacementBinding
      source: 'local-ledger' | 'registry'
    }
  | {
      outcome: 'local-establish'
      kind: 'virgin-policy'
      homeNodeId: string
      /** T-07655-only transaction input; absent for an ordinary local fallback. */
      birthDesignation?: BirthDesignationEstablishmentDecision | undefined
    }
  | {
      outcome: 'remote-bound'
      binding: PlacementBinding
    }
  | {
      outcome: 'remote-establish'
      kind: 'virgin-policy'
      candidateHomeNodeId: string
      reason: 'pin-mismatch' | 'routed-elsewhere'
    }
  | {
      outcome: 'refuse'
      reason: SummonGateRefuseReason
      retryable: boolean
      diagnostic: string
      homeNodeId?: string | undefined
    }

export type SummonGateResult = {
  evaluation: SummonGateEvaluation
  /** Undefined only for the flag-dark and synthetic non-agent abstentions. */
  placement?: PlacementDisposition | undefined
  /** True only when a refusal actually bites — i.e. enforce mode. */
  enforced: boolean
  mode: SummonGateMode
}

/** Compiled placement policy (spaces-config `ResolvedAgentPolicy`, C-11100). */
export type SummonGatePolicy = {
  provisioning?:
    | {
        node?: string | undefined
      }
    | undefined
  placement?:
    | {
        launch?: 'participant-only' | undefined
        pins: Record<string, string>
        homes: Record<string, string>
      }
    | undefined
  claimsTask: boolean
}

export type SummonGateDeps = {
  mode: SummonGateMode
  /** False when federation.json is absent — the dark path. */
  federationConfigured: boolean
  localNodeId: string
  ledger: Pick<PlacementLedgerRepository, 'activeAuthority' | 'installActive'> &
    Partial<Pick<PlacementLedgerRepository, 'get'>>
  registry: BindingRegistryClient
  /**
   * Compiled placement policy for the scope. `undefined` means the profile
   * declares none — `agentPolicy` omitted entirely, which per C-11100 IS the
   * undeclared-placement signal for legacy profiles.
   */
  policyFor: (scopeRef: string) => Promise<SummonGatePolicy | undefined>
  /** Observes node-local materialization facts after authority allows. */
  capabilityFor?:
    | ((
        scopeRef: string,
        hint?: SummonCapabilityHint | undefined
      ) => Promise<SummonCapabilityObservation>)
    | undefined
  /**
   * Every node id this daemon knows: its own, plus its configured peers
   * (T-07398). A `node=` directive is validated against it at BOTH origin and
   * receiver — the receiver re-runs this derivation on its OWN registry rather
   * than trusting the resolution the origin forwarded.
   */
  knownNodeIds?: readonly string[] | undefined
  log?: SummonGateLog | undefined
}

export type SummonGateRequest = {
  scopeRef: string
  path: SummonPath
  intent: SummonIntent
  /** Direct participant registration claims its own hosted address; HRC does not launch it. */
  participantClaim?: boolean | undefined
  /** Remote bare addressing can route to an existing scope, never create claim authority. */
  origin?: 'local' | 'federated-ingress' | 'federated-establish' | 'startup-repair' | undefined
  /** Daemon-owned proof that the summon is a successor of a known local session. */
  knownSession?: boolean | undefined
  deps: SummonGateDeps
  capabilityHint?: SummonCapabilityHint | undefined
  /**
   * T-07398 — the explicit provisioning directive block carried by the request
   * body. `node=` is the only member placement reads, and it is admissible only
   * where `[placement]` is silent. This is a DECLARED request field, never an
   * ambient caller assertion: nothing here reads the caller's own node, its
   * transport, or its environment.
   */
  provision?: Partial<ProvisioningScalars> | undefined
}
