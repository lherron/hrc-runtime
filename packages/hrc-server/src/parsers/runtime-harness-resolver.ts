import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeIntent } from 'hrc-core'
import { parseAgentProfile, resolveHarnessProvider } from 'spaces-config'

import { isRecord } from './common.js'

export function resolveHarnessFromPlacement(
  placement: unknown,
  execution: unknown
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

  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required when agent-profile.toml is missing',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
  const provider = resolveHarnessProvider(profile.identity?.harness)
  if (!provider) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeIntent.harness is required when agent-profile identity.harness is missing',
      { field: 'runtimeIntent.placement.agentRoot' }
    )
  }

  const preferredMode =
    isRecord(execution) && typeof execution['preferredMode'] === 'string'
      ? execution['preferredMode']
      : undefined

  return {
    provider,
    interactive: preferredMode !== 'nonInteractive',
  }
}
