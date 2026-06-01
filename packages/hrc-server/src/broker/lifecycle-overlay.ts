/**
 * Broker route lifecycle overlay assembly (T-01783 Workstream A / T-01787).
 *
 * HRC materializes a {@link BrokerLifecyclePolicyOverlay} per BROKER route and
 * dispatches it ONLY via the broker client's dispatch-options form
 * (InvocationDispatchRequest.lifecyclePolicy). The overlay is audit/dispatch
 * material — it MUST NEVER be folded into the compiled HarnessInvocationSpec,
 * InvocationStartRequest, the selected execution profile, or any
 * startRequestHash material (INV-14.4 compiler closure).
 *
 * v1 policy: all certified drivers advertise CONSERVATIVE_LIFECYCLE_CAPABILITIES
 * (keep-alive / none / none), so the only overlay HRC ever materializes is the
 * conservative default. RAW broker omission on NON-broker routes stays legacy
 * (no overlay).
 */

import {
  conservativeDefaultLifecyclePolicyOverlay,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerLifecyclePolicyOverlay,
  InvocationLifecycleCapabilities,
} from 'spaces-harness-broker-protocol'

/** Minimal route context needed to resolve a lifecycle overlay. */
export type LifecyclePolicyRouteContext = {
  /** Stable route identifier (e.g. the dispatch route id / flag-selected route). */
  routeId: string
  /** Whether this route dispatches through the Harness Broker. */
  brokerRoute: boolean
}

/**
 * Deterministic, stable per-route lifecycle policy id. Same route id always
 * yields the same policy id (and therefore the same canonical policy + hash for
 * the conservative default); different routes yield different ids.
 */
export function lifecyclePolicyIdForRoute(routeId: string): string {
  return `policy-route-${routeId}`
}

/**
 * Resolve the lifecycle overlay for a route. Broker routes with no explicit
 * lifecycle policy materialize the conservative default keyed by a stable
 * per-route policy id. Non-broker routes send no overlay (legacy behaviour).
 */
export function resolveLifecyclePolicyOverlay(
  ctx: LifecyclePolicyRouteContext
): BrokerLifecyclePolicyOverlay | undefined {
  if (!ctx.brokerRoute) {
    return undefined
  }
  return conservativeDefaultLifecyclePolicyOverlay(lifecyclePolicyIdForRoute(ctx.routeId))
}

/**
 * Typed, fail-closed error raised when a lifecycle overlay requests a mode the
 * route/profile capabilities do not advertise. This is the advisory gate that
 * prevents an uncertified idle-ttl / recycle-child / safe-retry overlay from
 * ever being dispatched. Broker dispatch validation remains authoritative.
 */
export class LifecyclePolicyCapabilityError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'LifecyclePolicyCapabilityError'
  }
}

/**
 * Assert that every mode the overlay requests is a subset of the supplied
 * lifecycle capabilities. Throws {@link LifecyclePolicyCapabilityError} on any
 * mismatch. The conservative default (keep-alive / none / none) is trivially a
 * subset of CONSERVATIVE_LIFECYCLE_CAPABILITIES.
 */
export function preflightLifecyclePolicyCapabilities(
  overlay: BrokerLifecyclePolicyOverlay,
  capabilities: InvocationLifecycleCapabilities
): void {
  const violations: Array<{ axis: string; mode: string; allowed: readonly string[] }> = []

  if (!capabilities.runtimeRetention.includes(overlay.retention.mode)) {
    violations.push({
      axis: 'runtimeRetention',
      mode: overlay.retention.mode,
      allowed: capabilities.runtimeRetention,
    })
  }
  if (!capabilities.harnessRecovery.includes(overlay.harnessRecovery.mode)) {
    violations.push({
      axis: 'harnessRecovery',
      mode: overlay.harnessRecovery.mode,
      allowed: capabilities.harnessRecovery,
    })
  }
  if (!capabilities.turnRetry.includes(overlay.turnRetry.mode)) {
    violations.push({
      axis: 'turnRetry',
      mode: overlay.turnRetry.mode,
      allowed: capabilities.turnRetry,
    })
  }

  if (violations.length > 0) {
    throw new LifecyclePolicyCapabilityError(
      'lifecycle policy overlay requests modes outside route/profile capabilities',
      {
        policyId: overlay.policyId,
        policyHash: overlay.policyHash,
        violations,
      }
    )
  }
}
