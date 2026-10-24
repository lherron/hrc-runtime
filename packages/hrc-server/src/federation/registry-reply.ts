import type {
  BirthDesignationProvenance,
  BirthDesignationRecord,
  BirthDesignationState,
  BirthDesignationSupersededBy,
  PlacementBinding,
} from 'hrc-store-sqlite'

import { RegistryRefusedError, RegistryUnreachableError } from './registry-client.js'

/**
 * Decoding of registry HOST replies. Every decoder fails closed: a reply it
 * cannot vouch for is never read as an absence of a binding or designation.
 */

const DESIGNATION_SUPERSESSION_SOURCES = new Set<BirthDesignationSupersededBy>([
  'pin',
  'task_default',
  'default_home_node',
  'explicit_local',
])

const DESIGNATION_PROVENANCE = new Set<string>([
  'default_home_node(sender)',
  'default_home_node(sender-retired)',
])

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseDesignation(
  value: unknown,
  expectedScopeRef: string
): BirthDesignationRecord | undefined {
  if (!isRecord(value)) return undefined
  if (value['scopeRef'] !== expectedScopeRef) return undefined
  const provenance = value['provenance']
  const state = value['state']
  const designationEpoch = value['designationEpoch']
  if (
    !isNonemptyString(value['homeNodeId']) ||
    typeof provenance !== 'string' ||
    !DESIGNATION_PROVENANCE.has(provenance) ||
    !isNonemptyString(value['birthEnvelopeId']) ||
    !isNonemptyString(value['senderScopeRef']) ||
    !isNonemptyString(value['designatedAt']) ||
    (state !== 'live' && state !== 'superseded') ||
    !Number.isSafeInteger(designationEpoch) ||
    Number(designationEpoch) < 1
  ) {
    return undefined
  }
  const supersededBy = value['supersededBy']
  const supersededAt = value['supersededAt']
  return {
    scopeRef: expectedScopeRef,
    homeNodeId: value['homeNodeId'],
    provenance: provenance as BirthDesignationProvenance,
    birthEnvelopeId: value['birthEnvelopeId'],
    senderScopeRef: value['senderScopeRef'],
    designationEpoch: Number(designationEpoch),
    designatedAt: value['designatedAt'],
    state: state as BirthDesignationState,
    ...(isNonemptyString(supersededBy) &&
    DESIGNATION_SUPERSESSION_SOURCES.has(supersededBy as BirthDesignationSupersededBy)
      ? { supersededBy: supersededBy as BirthDesignationSupersededBy }
      : {}),
    ...(isNonemptyString(supersededAt) ? { supersededAt } : {}),
  }
}

export function parseBinding(
  value: unknown,
  expectedScopeRef: string
): PlacementBinding | undefined {
  if (!isRecord(value)) return undefined
  if (value['scopeRef'] !== expectedScopeRef || !isNonemptyString(value['homeNodeId'])) {
    return undefined
  }
  if (!isNonemptyString(value['createdAt']) || !isNonemptyString(value['updatedAt'])) {
    return undefined
  }

  return {
    scopeRef: expectedScopeRef,
    homeNodeId: value['homeNodeId'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
  }
}

/**
 * Throws the refusal an auth or request status means, or an unreachable
 * registry for any status the route does not handle.
 */
export function checkStatus(status: number, handled: readonly number[]): void {
  if (status === 401) throw new RegistryRefusedError(401, 'unauthorized')
  if (status === 400) throw new RegistryRefusedError(400, 'invalid_request')
  if (status === 403) throw new RegistryRefusedError(403, 'authenticated_node_mismatch')
  if (!handled.includes(status)) {
    throw new RegistryUnreachableError(
      `federation binding registry returned unexpected status ${status}`
    )
  }
}

export async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new RegistryUnreachableError(
      'federation binding registry returned an unreadable response',
      error
    )
  }
}
