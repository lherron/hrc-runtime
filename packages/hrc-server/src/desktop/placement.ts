import { resolvePlacementPolicy } from '../federation/placement-policy.js'
import {
  type SummonGateServerContext,
  establishExternalRegistrationPlacement,
} from '../federation/summon-gate-server.js'

export type DesktopPlacementPending = {
  status: 'pending'
  reason: string
  detail: string
}

/** Select a declared home family, never infer placement from a hostname. */
export async function desktopHomeFamily(
  server: SummonGateServerContext,
  scopeRef: string
): Promise<{ baseTask: string } | DesktopPlacementPending> {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (!config?.sourceExists) return { baseTask: 'primary' }
  const resolved = server.policyFor
    ? { outcome: 'resolved' as const, policy: await server.policyFor(scopeRef) }
    : resolvePlacementPolicy(scopeRef, server.placementPolicyOptions)
  if (resolved.outcome !== 'resolved') {
    return { status: 'pending', reason: 'policy_unavailable', detail: resolved.detail }
  }
  const homes = Object.entries(resolved.policy?.placement?.homes ?? {})
    .filter(([, node]) => node === config.nodeId)
    .map(([home]) => home)
  if (homes.length !== 1 || homes[0] === undefined) {
    return {
      status: 'pending',
      reason: 'desktop_home_ambiguous',
      detail: `expected one placement home for desktop node ${config.nodeId}; found ${homes.join(', ') || 'none'}`,
    }
  }
  return { baseTask: homes[0] }
}

/** Registry-first authority must precede a successful desktop registration. */
export async function ensureDesktopPlacement(
  server: SummonGateServerContext,
  scopeRef: string,
  registrationKey: string
): Promise<DesktopPlacementPending | undefined> {
  const config = server.federationConfig ?? server.options?.federationConfig
  if (!config?.sourceExists) return undefined
  const result = await establishExternalRegistrationPlacement(server, {
    scopeRef,
    registrationId: registrationKey,
    classId: 'codex-desktop',
  })
  if (result.outcome === 'canonical') return undefined
  return {
    status: 'pending',
    reason: result.outcome === 'pending' ? result.reason : result.cause,
    detail: result.detail,
  }
}
