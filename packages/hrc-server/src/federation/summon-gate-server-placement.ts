/**
 * Placement resolution and remote/external establishment for the summon gate
 * server. Split out of `summon-gate-server.ts`.
 */

import type { ProvisioningScalars } from 'agent-scope'
import { formatCanonicalScopeRef } from 'hrc-core'
import type { FederationRemoteEstablishResult, SummonIntent } from 'hrc-core'
import type { PlacementBinding } from 'hrc-store-sqlite'

import { writeServerLog } from '../server-log.js'
import { withScopeSummonLock } from './authority-lock.js'
import { establishLocalPlacement } from './establishment.js'
import { createPlacementPolicyResolver } from './placement-policy.js'
import { RegistryRefusedError } from './registry-client.js'
import { type SummonGateServerContext, gateDepsFor } from './summon-gate-server-context.js'
import {
  type PlacementDisposition,
  type SummonCapabilityHint,
  type SummonGateResult,
  type SummonPath,
  resolveDeclaredPlacementHome,
  resolvePlacementDisposition,
} from './summon-gate.js'

/**
 * The gate request, shaped so `explicit_local` is UNREACHABLE from any path but
 * `resolve-session`.
 *
 * §5's line is that generic SDK and test callers with `create: true` must never
 * become placement declarations. The four non-operator paths — message-driven
 * ensure-target, archived-successor, command-run, app-session — are summons
 * *on behalf of* something else, so none of them can be an operator's start.
 * Encoding that as a union means a future caller cannot hand one of them an
 * explicit intent even by accident: it is a compile error rather than a review
 * catch, on a surface where the review catch would have to hold for years.
 *
 * `resolve-session` is the one arm that can carry either value, because it is
 * the one surface `hrc run` and `hrc start` enter through — and, per T-06608's
 * path-C finding, the same surface every generic SDK caller enters through.
 * Separating those two is the entire reason the typed field exists.
 */
export type SummonAuthorityRequest = (
  | { scopeRef: string; path: 'resolve-session'; intent: SummonIntent }
  | {
      scopeRef: string
      path: Exclude<SummonPath, 'resolve-session'>
      /** Absent ⇒ `implicit`; `implicit` is the only value these paths accept. */
      intent?: 'implicit' | undefined
    }
) & {
  /** Common mint context; neither field widens the typed intent arm. */
  capabilityHint?: SummonCapabilityHint | undefined
  origin?: 'local' | 'federated-ingress' | 'federated-establish' | 'startup-repair' | undefined
  /** True only when this daemon owns the predecessor session being continued. */
  knownSession?: boolean | undefined
  /** Present at session-mint call sites to serialize exactly one continuity birth. */
  laneRef?: string | undefined
  /**
   * T-07398 — the request's explicit provisioning directive block. Placement
   * reads `node=` from it (gap-filling only, strictly below `[placement]`); the
   * rest of the block is carried on the intent and applied at birth.
   */
  provision?: Partial<ProvisioningScalars> | undefined
}

export type SummonAuthorityResult = SummonGateResult

export type ExternalRegistrationPlacementResult =
  | { outcome: 'pending'; reason: string; detail: string }
  | { outcome: 'canonical'; binding: PlacementBinding }
  | {
      outcome: 'noncanonical'
      cause: 'placement_refused' | 'binding_conflict'
      detail: string
      homeNodeId?: string | undefined
      binding?: PlacementBinding | undefined
    }

/**
 * Best-effort issuance-time policy projection. It deliberately does not touch
 * the registry or return a refusal: placement never gates EPR grant issuance.
 */
export async function externalRegistrationPlacementAdvisory(
  server: SummonGateServerContext,
  scopeRef: string
): Promise<string | undefined> {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (config === undefined || !config.sourceExists || config.gate.mode === 'off') return undefined

  try {
    const policyFor =
      server.policyFor ?? createPlacementPolicyResolver(server.placementPolicyOptions)
    const designated = resolveDeclaredPlacementHome(
      scopeRef,
      await policyFor(scopeRef),
      config.nodeId
    )
    if (designated === undefined || designated.homeNodeId === config.nodeId) return undefined
    return `policy designates ${designated.homeNodeId} as home; this registration will be noncanonical on ${config.nodeId}`
  } catch {
    // Missing/unreadable policy is reconciled visibly after local mint. An
    // optional advisory must never become an issuance refusal.
    return undefined
  }
}

/**
 * Post-mint EPR placement reconciliation.
 *
 * The participant is already materialized, so this deliberately reuses the
 * normal placement decision without its future-launch capability observation.
 * Authority still goes through the exact registry-first establishment writer.
 */
export async function establishExternalRegistrationPlacement(
  server: SummonGateServerContext,
  request: { scopeRef: string; registrationId: string; classId: string }
): Promise<ExternalRegistrationPlacementResult> {
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    return {
      outcome: 'pending',
      reason: 'federation_not_configured',
      detail: 'collective placement is not enabled on this node',
    }
  }

  return await withScopeSummonLock(server as object, request.scopeRef, async () => {
    const placement = await resolvePlacementDisposition({
      scopeRef: request.scopeRef,
      path: 'resolve-session',
      // Registration is mechanism-born, not an operator declaration that this
      // node should own the scope. Resolve pins/task defaults/default home.
      intent: 'implicit',
      origin: 'local',
      // Local mint already proved materialization. Capability probing here
      // would incorrectly ask whether HRC can launch the external process.
      // This bounded controller owns cause-change and terminal logging. Letting
      // the generic gate log here would emit a second WARN on every retry tick.
      deps: { ...deps, capabilityFor: undefined, log: undefined },
    })

    if (placement === undefined) {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement did not resolve for ${request.scopeRef}`,
      }
    }
    if (placement.outcome === 'local-bound') {
      try {
        const declared = resolveDeclaredPlacementHome(
          request.scopeRef,
          await deps.policyFor(request.scopeRef),
          deps.localNodeId
        )
        if (declared !== undefined && declared.homeNodeId !== deps.localNodeId) {
          return {
            outcome: 'noncanonical',
            cause: 'placement_refused',
            detail: `placement policy designates ${declared.homeNodeId} for ${request.scopeRef}`,
            homeNodeId: declared.homeNodeId,
            binding: placement.binding,
          }
        }
      } catch (error) {
        return {
          outcome: 'pending',
          reason: 'policy-unavailable',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      if (placement.source === 'registry') deps.ledger.installActive(placement.binding)
      return { outcome: 'canonical', binding: placement.binding }
    }
    if (placement.outcome === 'remote-bound') {
      return {
        outcome: 'noncanonical',
        cause: 'binding_conflict',
        detail: `${request.scopeRef} is already bound on ${placement.binding.homeNodeId}`,
        homeNodeId: placement.binding.homeNodeId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-establish') {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement policy designates ${placement.candidateHomeNodeId} for ${request.scopeRef}`,
        homeNodeId: placement.candidateHomeNodeId,
      }
    }
    if (placement.outcome === 'refuse') {
      if (placement.retryable) {
        return {
          outcome: 'pending',
          reason: placement.reason,
          detail: placement.diagnostic,
        }
      }
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: placement.diagnostic,
        ...(placement.homeNodeId === undefined ? {} : { homeNodeId: placement.homeNodeId }),
      }
    }
    if (placement.kind !== 'virgin-policy') {
      return {
        outcome: 'noncanonical',
        cause: 'placement_refused',
        detail: `placement selected unsupported ${placement.kind} authority for external registration ${request.registrationId}`,
        homeNodeId: placement.homeNodeId,
      }
    }

    try {
      const established = await establishLocalPlacement({
        registry: deps.registry,
        ledger: deps.ledger,
        request: {
          scopeRef: request.scopeRef,
          homeNodeId: deps.localNodeId,
          ...(placement.birthDesignation === undefined
            ? {}
            : { birthDesignation: placement.birthDesignation }),
          now: new Date().toISOString(),
        },
      })
      if (established.outcome === 'designation-mismatch') {
        return {
          outcome: 'noncanonical',
          cause: 'placement_refused',
          detail: `${request.scopeRef} is designated to be born on ${established.designation.homeNodeId} (T-07655); this node did not take the birth`,
          homeNodeId: established.designation.homeNodeId,
        }
      }
      if (established.outcome === 'bound-elsewhere') {
        return {
          outcome: 'noncanonical',
          cause: 'binding_conflict',
          detail: `${request.scopeRef} became bound on ${established.binding.homeNodeId}`,
          homeNodeId: established.binding.homeNodeId,
          binding: established.binding,
        }
      }
      return { outcome: 'canonical', binding: established.binding }
    } catch (error) {
      return {
        outcome: 'pending',
        reason: error instanceof RegistryRefusedError ? 'registry-refused' : 'establishment_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

/** Decision-only server seam shared by message prechecks and summon execution. */
export async function resolvePlacementOnServer(
  server: SummonGateServerContext,
  request: SummonAuthorityRequest
): Promise<PlacementDisposition | undefined> {
  const deps = gateDepsFor(server)
  if (deps === undefined) return undefined
  return await resolvePlacementDisposition({
    scopeRef: request.scopeRef,
    path: request.path,
    intent: request.intent ?? 'implicit',
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    ...(request.knownSession === undefined ? {} : { knownSession: request.knownSession }),
    deps,
    ...(request.capabilityHint === undefined ? {} : { capabilityHint: request.capabilityHint }),
    ...(request.provision === undefined ? {} : { provision: request.provision }),
  })
}

function remoteEstablishRefusal(input: {
  status?: number | undefined
  code?: 'stale_context' | 'runtime_unavailable' | undefined
  message: string
  reason: string
  retryable: boolean
  homeNodeId?: string | undefined
}): Extract<FederationRemoteEstablishResult, { outcome: 'refused' }> {
  return {
    outcome: 'refused',
    status: input.status ?? 409,
    code: input.code ?? 'stale_context',
    message: input.message,
    reason: input.reason,
    retryable: input.retryable,
    ...(input.homeNodeId === undefined ? {} : { homeNodeId: input.homeNodeId }),
  }
}

/**
 * Authenticated authority-only half of remote delivery.
 *
 * The receiver re-runs the same gate from current facts. This function may
 * install authority through the registry-first CAS; it never inserts a
 * message, mints a session, or accepts origin-side placement assertions.
 */
export async function establishRemotePolicyAuthority(
  server: SummonGateServerContext,
  request: { scopeRef: string; correlationId: string }
): Promise<FederationRemoteEstablishResult> {
  const scopeRef = formatCanonicalScopeRef({ scopeRef: request.scopeRef })
  const deps = gateDepsFor(server)
  if (deps === undefined) {
    return remoteEstablishRefusal({
      message: 'remote policy establishment is not enabled on this node',
      reason: 'undeclared-placement',
      retryable: false,
    })
  }

  return await withScopeSummonLock(server as object, scopeRef, async () => {
    const placement = await resolvePlacementDisposition({
      scopeRef,
      path: 'ensure-target',
      intent: 'implicit',
      origin: 'federated-establish',
      deps,
    })
    if (placement === undefined) {
      return remoteEstablishRefusal({
        message: 'remote policy establishment requires an agent scope',
        reason: 'undeclared-placement',
        retryable: false,
      })
    }

    if (placement.outcome === 'local-bound') {
      if (placement.source === 'registry') deps.ledger.installActive(placement.binding)
      return {
        outcome: 'existing',
        correlationId: request.correlationId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-bound') {
      return {
        outcome: 'existing',
        correlationId: request.correlationId,
        binding: placement.binding,
      }
    }
    if (placement.outcome === 'remote-establish') {
      return remoteEstablishRefusal({
        message: 'remote policy establishment is not authorized on this node',
        reason: placement.reason,
        retryable: false,
        homeNodeId: placement.candidateHomeNodeId,
      })
    }
    if (placement.outcome === 'refuse') {
      const unavailable = placement.reason === 'registry-unreachable'
      return remoteEstablishRefusal({
        status: unavailable ? 503 : 409,
        code: unavailable ? 'runtime_unavailable' : 'stale_context',
        message: unavailable
          ? 'remote policy establishment is temporarily unavailable'
          : 'remote policy establishment refused',
        reason: placement.reason,
        retryable: placement.retryable,
        ...(placement.homeNodeId === undefined ? {} : { homeNodeId: placement.homeNodeId }),
      })
    }
    if (placement.kind !== 'virgin-policy') {
      return remoteEstablishRefusal({
        message: 'remote establishment is restricted to named policy-born virgin scopes',
        reason: 'claim-birth-authority-required',
        retryable: false,
      })
    }

    try {
      const established = await establishLocalPlacement({
        registry: deps.registry,
        ledger: deps.ledger,
        request: {
          scopeRef,
          homeNodeId: deps.localNodeId,
          ...(placement.birthDesignation === undefined
            ? {}
            : { birthDesignation: placement.birthDesignation }),
          now: new Date().toISOString(),
        },
      })
      if (established.outcome === 'designation-mismatch') {
        return remoteEstablishRefusal({
          message: 'remote policy establishment lost to a birth designation',
          reason: 'birth-designation-mismatch',
          retryable: false,
          homeNodeId: established.designation.homeNodeId,
        })
      }
      return {
        outcome: established.outcome === 'established' ? 'established' : 'existing',
        correlationId: request.correlationId,
        binding: established.binding,
      }
    } catch (error) {
      const refused = error instanceof RegistryRefusedError
      writeServerLog('WARN', 'federation.establish.registry_failure', {
        scopeRef,
        localNodeId: deps.localNodeId,
        reason: refused ? 'registry-refused' : 'registry-unreachable',
        error: error instanceof Error ? error.message : String(error),
      })
      return remoteEstablishRefusal({
        status: refused ? 409 : 503,
        code: refused ? 'stale_context' : 'runtime_unavailable',
        message: refused
          ? 'remote policy establishment was refused by binding authority'
          : 'remote policy establishment is temporarily unavailable',
        reason: refused ? 'registry-refused' : 'registry-unreachable',
        retryable: !refused,
        homeNodeId: deps.localNodeId,
      })
    }
  })
}
