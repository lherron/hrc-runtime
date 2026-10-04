import { type RunStatus, type RuntimeStatus, isRuntimeStatus } from 'spaces-runtime-contracts'

/** ASP owns the current vocabulary; these extra literals remain readable in legacy HRC rows. */
export type HrcRuntimeStatus =
  | RuntimeStatus
  | 'pending'
  | 'idle'
  | 'running'
  | 'exited'
  | 'broker-ipc-unavailable'
export type HrcRunStatus =
  | RunStatus
  | 'queued'
  | 'awaiting_permission'
  | 'coalesced'
  | 'reaped'
  | 'exited'
export type HrcSessionStatus = 'active' | 'archived' | 'inactive' | 'terminated'

export function parseHrcRuntimeStatus(value: unknown): HrcRuntimeStatus {
  if (
    isRuntimeStatus(value) ||
    value === 'broker-ipc-unavailable' ||
    value === 'pending' ||
    value === 'idle' ||
    value === 'running' ||
    value === 'exited'
  ) {
    return value
  }
  throw new Error(`Invalid stored runtime status: ${String(value)}`)
}

export function parseHrcRunStatus(value: unknown): HrcRunStatus {
  switch (value) {
    case 'accepted':
    case 'started':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'degraded':
    case 'zombie':
    case 'queued':
    case 'awaiting_permission':
    case 'coalesced':
    case 'reaped':
    case 'exited':
      return value
    default:
      throw new Error(`Invalid stored run status: ${String(value)}`)
  }
}

export function parseHrcSessionStatus(value: unknown): HrcSessionStatus {
  if (value === 'active' || value === 'archived' || value === 'inactive' || value === 'terminated')
    return value
  throw new Error(`Invalid stored session status: ${String(value)}`)
}

/** A coalesced row is settled; its carrier run may still be active. */
export function isRunTerminal(run: { readonly status: HrcRunStatus }): boolean {
  switch (run.status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'degraded':
    case 'zombie':
    case 'reaped':
    case 'coalesced':
    case 'exited':
      return true
    default:
      return false
  }
}
