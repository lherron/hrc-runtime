/**
 * Placement resolution and remote/external establishment for the summon gate
 * server. Split out of `summon-gate-server.ts`.
 */

import type { ProvisioningScalars } from 'agent-scope'
import { formatCanonicalScopeRef } from 'hrc-core'
import type { FederationRemoteEstablishResult, SummonIntent } from 'hrc-core'

import { writeServerLog } from '../server-log.js'
import { withScopeSummonLock } from './authority-lock.js'
import { establishLocalPlacement } from './establishment.js'
import { RegistryRefusedError } from './registry-client.js'
import { type SummonGateServerContext, gateDepsFor } from './summon-gate-server-context.js'
import {
  type PlacementDisposition,
  type SummonCapabilityHint,
  type SummonGateResult,
  type SummonPath,
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
