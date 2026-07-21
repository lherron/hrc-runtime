import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

const SAFE_HOST_SESSION_ID = /^[A-Za-z0-9._-]+$/

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
  if (!SAFE_HOST_SESSION_ID.test(input.hostSessionId)) {
    throw new Error(`unsafe host session id for task claim credential: ${input.hostSessionId}`)
  }

  const directory = join(input.runtimeRoot, 'task-claim-credentials')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const destination = join(directory, `${input.hostSessionId}.json`)
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
