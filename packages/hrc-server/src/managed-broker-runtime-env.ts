import type { HrcDatabase } from 'hrc-store-sqlite'

import { injectRuntimeBirthCredential } from './federation/birth-credential.js'
import { injectRuntimeTaskClaimCredentialFile } from './federation/task-claim-runtime.js'
import { injectRuntimeWrkqAuthority } from './federation/wrkq-authority.js'

export type ManagedBrokerDispatchEnvInput = {
  baseEnv: Record<string, string>
  db: HrcDatabase
  runtimeRoot: string
  hostSessionId: string
  runtimeId: string
  mailStopSocket: string
  wrkqAuthoritySource?: Record<string, string | undefined> | undefined
}

/**
 * Build the daemon-owned portion of a broker launch environment.
 *
 * Host wrkq reachability is independent of the optional task-claim bearer:
 * every managed runtime receives locator/token-file authority, while only a
 * session with a persisted claim receives the claim credential file.
 */
export function buildManagedBrokerDispatchEnv(
  input: ManagedBrokerDispatchEnvInput
): Record<string, string> {
  return {
    ...injectRuntimeTaskClaimCredentialFile(
      injectRuntimeWrkqAuthority(
        injectRuntimeBirthCredential(input.baseEnv, input.runtimeId),
        input.wrkqAuthoritySource
      ),
      {
        db: input.db,
        runtimeRoot: input.runtimeRoot,
        hostSessionId: input.hostSessionId,
      }
    ),
    HRC_MAIL_STOP_SOCKET: input.mailStopSocket,
  }
}
