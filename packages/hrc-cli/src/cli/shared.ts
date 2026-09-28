import { readFileSync } from 'node:fs'

import { CliUsageError } from 'cli-kit'
import {
  HRC_LIFECYCLE_CREDENTIAL_HEADER,
  HRC_LIFECYCLE_RUNTIME_HEADER,
  HRC_LIFECYCLE_SESSION_REF_HEADER,
  isLifecycleCredentialRuntimeId,
  lifecycleCredentialPath,
} from 'hrc-core'
import {
  HrcClient,
  discoverSocket,
  writePlacementWarnings as writeSdkPlacementWarnings,
} from 'hrc-sdk'

export { formatAgentNotFound } from 'hrc-sdk'

export function createClient(): HrcClient {
  const socketPath = discoverSocket()
  return new HrcClient(socketPath)
}

export function fatal(message: string): never {
  throw new CliUsageError(message)
}

export function writePlacementWarnings(warnings: string[] | undefined): void {
  writeSdkPlacementWarnings('hrc', warnings)
}

export class CliStatusExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
    this.name = 'CliStatusExit'
  }
}

/**
 * T-09861 §3: the credential rides in headers, read from the 0600 file the
 * daemon minted for this caller's runtime. `HRC_RUNTIME_ID` only LOCATES it;
 * `HRC_SESSION_REF` is attribution for the server's binding check. A caller
 * with neither simply presents nothing and is refused server-side.
 */
export function lifecycleCredentialHeaders(runtimeRoot: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const sessionRef = process.env['HRC_SESSION_REF']?.trim()
  if (sessionRef) headers[HRC_LIFECYCLE_SESSION_REF_HEADER] = sessionRef
  const runtimeId = process.env['HRC_RUNTIME_ID']?.trim()
  if (!runtimeId || !isLifecycleCredentialRuntimeId(runtimeId)) return headers
  let value: string
  try {
    value = readFileSync(lifecycleCredentialPath(runtimeRoot, runtimeId), 'utf8').trim()
  } catch {
    return headers
  }
  if (value.length === 0) return headers
  headers[HRC_LIFECYCLE_RUNTIME_HEADER] = runtimeId
  headers[HRC_LIFECYCLE_CREDENTIAL_HEADER] = value
  return headers
}
