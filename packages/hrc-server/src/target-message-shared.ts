import { HrcErrorCode, HrcUnprocessableEntityError, splitSessionRef } from 'hrc-core'
import type {
  HrcDispatchOrigin,
  HrcDmRuntimeIntent,
  HrcMessageAddress,
  HrcMessageRecord,
  HrcRuntimeIntent,
  SessionIdentity,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { dispatchOriginFromMessageAddress } from './acp-event-bridge.js'

/**
 * Spreadable dispatch option carrying the DM sender's recorded identity
 * (T-07236). Absent when the sender's scope cannot be parsed — an unattributed
 * run is the honest answer there, and a fabricated actor is not.
 */
export function originDispatchOption(
  from: HrcMessageAddress,
  db: HrcDatabase
): { origin?: HrcDispatchOrigin } {
  let identity: SessionIdentity | undefined
  if (from.kind === 'session') {
    const { scopeRef, laneRef } = splitSessionRef(from.sessionRef)
    identity = db.continuities.getByKey(scopeRef, laneRef)?.identity
  }
  const origin = dispatchOriginFromMessageAddress(from, identity)
  return origin === undefined ? {} : { origin }
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function federationOriginNodeId(record: HrcMessageRecord): string | undefined {
  const ingress = record.metadataJson?.['federationIngress']
  if (!isObjectRecord(ingress)) return undefined
  const nodeId = ingress['authenticatedNodeId']
  return typeof nodeId === 'string' ? nodeId : undefined
}

/** Extract the lane-stripped scopeRef from a canonical `<scopeRef>/lane:<lane>` ref. */
export function scopeRefOf(sessionRef: string): string {
  const idx = sessionRef.indexOf('/lane:')
  return idx === -1 ? sessionRef : sessionRef.slice(0, idx)
}

export function requireCompleteRuntimeIntent(
  intent: HrcDmRuntimeIntent | undefined
): HrcRuntimeIntent | undefined {
  if (intent === undefined || intent.placement !== undefined) return intent
  throw new HrcUnprocessableEntityError(
    HrcErrorCode.MISSING_RUNTIME_INTENT,
    'runtimeIntent must be complete before dispatch',
    { reason: 'directive_only_runtime_intent' }
  )
}
