import {
  HrcConflictError,
  HrcErrorCode,
  validateFence,
} from 'hrc-core'
import type {
  HrcFence,
  HrcLocalBridgeRecord,
  HrcSessionRecord,
  RegisterBridgeTargetRequest,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { DeliverTextRequest } from './server-parsers.js'

export function findActiveBridgesByTarget(
  db: HrcDatabase,
  transport: string,
  target: string
): HrcLocalBridgeRecord[] {
  return db.localBridges
    .listActive()
    .filter((bridge) => bridge.transport === transport && bridge.target === target)
}

export function matchesBridgeBinding(
  bridge: HrcLocalBridgeRecord,
  request: RegisterBridgeTargetRequest
): boolean {
  return (
    bridge.hostSessionId === request.hostSessionId &&
    bridge.runtimeId === request.runtimeId &&
    bridge.expectedHostSessionId === request.expectedHostSessionId &&
    bridge.expectedGeneration === request.expectedGeneration
  )
}

export function mergeBridgeFence(
  bridge: HrcLocalBridgeRecord,
  delivery: Pick<DeliverTextRequest, 'expectedHostSessionId' | 'expectedGeneration'>
): HrcFence {
  return {
    ...(delivery.expectedHostSessionId !== undefined
      ? { expectedHostSessionId: delivery.expectedHostSessionId }
      : bridge.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: bridge.expectedHostSessionId }
        : {}),
    ...(delivery.expectedGeneration !== undefined
      ? { expectedGeneration: delivery.expectedGeneration }
      : bridge.expectedGeneration !== undefined
        ? { expectedGeneration: bridge.expectedGeneration }
        : {}),
  }
}

export function validateBridgeFence(
  fence: HrcFence | undefined,
  activeSession: HrcSessionRecord
): void {
  const result = validateFence(fence, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!result.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, result.message, result.detail)
  }
}
