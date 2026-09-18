import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import { isRecord } from './common.js'

/**
 * T-08597: the agent-profile fallback is deleted with ASP interpretation.
 * A placement without an inline harness no longer derives one from
 * `agent-profile.toml` in-process — callers resolve `{provider, id}` from the
 * daemon's declaration observation (`POST /v1/placements/resolve`) and send a
 * complete harness. Hand-built harness-less intents fail closed here with the
 * same message the missing-profile branch always produced.
 */
export function resolveHarnessFromPlacement(
  placement: unknown,
  _execution: unknown
): HrcRuntimeIntent['harness'] {
  if (!isRecord(placement)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required unless placement.agentRoot can resolve it',
      { field: 'runtimeIntent.harness' }
    )
  }

  const agentRoot = placement['agentRoot']
  if (typeof agentRoot !== 'string' || agentRoot.trim().length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required unless placement.agentRoot can resolve it',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    'runtimeIntent.harness is required when agent-profile.toml is missing',
    { field: 'runtimeIntent.placement.agentRoot' }
  )
}
