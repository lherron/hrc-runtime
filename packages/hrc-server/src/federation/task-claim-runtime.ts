import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

const SAFE_HOST_SESSION_ID = /^[A-Za-z0-9._-]+$/
const TERMINAL_RUNTIME_STATUSES = new Set([
  'dead',
  'disposed',
  'exited',
  'failed',
  'stale',
  'stopped',
  'terminated',
])

export type RuntimeTaskClaimCredentialCleanup =
  | { outcome: 'removed' | 'absent' }
  | { outcome: 'retained'; activeRuntimeIds: string[] }
  | { outcome: 'failed'; error: string }

function taskClaimCredentialPath(runtimeRoot: string, hostSessionId: string): string {
  if (!SAFE_HOST_SESSION_ID.test(hostSessionId)) {
    throw new Error(`unsafe host session id for task claim credential: ${hostSessionId}`)
  }
  return join(runtimeRoot, 'task-claim-credentials', `${hostSessionId}.json`)
}

/** Materialize the session bearer only at runtime launch, then pass its path. */
export function injectRuntimeTaskClaimCredentialFile(
  env: Record<string, string>,
  input: {
    db: HrcDatabase
    runtimeRoot: string
    hostSessionId: string
  }
): Record<string, string> {
  const authority = input.db.sessionTaskClaimAuthorities.getByHostSessionId(input.hostSessionId)
  if (authority === null) return env
  const directory = join(input.runtimeRoot, 'task-claim-credentials')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const destination = taskClaimCredentialPath(input.runtimeRoot, input.hostSessionId)
  const temporary = join(directory, `.${input.hostSessionId}.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(
    temporary,
    `${JSON.stringify({
      taskId: authority.taskId,
      claimedBy: authority.claimedBy,
      claimedScope: authority.claimedScope,
      claimedNode: authority.claimedNode,
      claimedAt: authority.claimedAt,
      claimGeneration: authority.claimGeneration,
      claimToken: authority.claimToken,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  renameSync(temporary, destination)
  chmodSync(destination, 0o600)
  return { ...env, [HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV]: destination }
}

/**
 * Remove a terminated runtime's bearer file once no live sibling still uses it.
 *
 * Credential paths are host-session scoped because successor runtimes carry the
 * same claim authority. A late terminate for an older runtime must therefore
 * retain the file while any non-terminal sibling remains alive.
 */
export function cleanupRuntimeTaskClaimCredentialFile(input: {
  db: HrcDatabase
  runtimeRoot: string
  hostSessionId: string
  runtimeId: string
}): RuntimeTaskClaimCredentialCleanup {
  try {
    const activeRuntimeIds = input.db.runtimes
      .listByHostSessionId(input.hostSessionId)
      .filter(
        (runtime) =>
          runtime.runtimeId !== input.runtimeId && !TERMINAL_RUNTIME_STATUSES.has(runtime.status)
      )
      .map((runtime) => runtime.runtimeId)
    if (activeRuntimeIds.length > 0) {
      return { outcome: 'retained', activeRuntimeIds }
    }

    try {
      unlinkSync(taskClaimCredentialPath(input.runtimeRoot, input.hostSessionId))
      return { outcome: 'removed' }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { outcome: 'absent' }
      }
      throw error
    }
  } catch (error) {
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}
