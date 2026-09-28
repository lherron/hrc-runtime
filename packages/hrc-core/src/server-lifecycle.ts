import { join } from 'node:path'

/**
 * T-09861 — HRC server lifecycle authorization contract (spec rev 4, Daedalus
 * APPROVED EN-20244). Shared wire and path vocabulary for the daemon endpoint
 * and the thin `hrc server stop|restart` client.
 *
 * What this enforces: every HRC-provided path authorizes server-side, from a
 * daemon-minted credential, never from caller env. It stops accidental and
 * doctrinal violations and makes deliberate ones detectable and attributable.
 * It does not stop a determined same-uid actor (raw `kill`, `launchctl`).
 */

/** Header carrying the caller's runtime id (locates the credential it minted). */
export const HRC_LIFECYCLE_RUNTIME_HEADER = 'x-hrc-lifecycle-runtime-id'
/** Header carrying the daemon-minted lifecycle credential value. */
export const HRC_LIFECYCLE_CREDENTIAL_HEADER = 'x-hrc-lifecycle-credential'
/** Attribution only: the caller's `HRC_SESSION_REF`, used for the binding check. */
export const HRC_LIFECYCLE_SESSION_REF_HEADER = 'x-hrc-lifecycle-session-ref'

export const HRC_SERVER_LAUNCHD_LABEL = 'com.praesidium.hrc-server'

/** The documented break-glass. It is residual R1, recorded `unattributed` at the next boot. */
export const HRC_LIFECYCLE_BREAK_GLASS = `launchctl kickstart -k gui/$UID/${HRC_SERVER_LAUNCHD_LABEL}`

export const HRC_LIFECYCLE_PRE_CONTRACT_MESSAGE = `the running daemon predates the lifecycle contract and cannot authorize this; activate it with the documented break-glass: ${HRC_LIFECYCLE_BREAK_GLASS}`

const LIFECYCLE_RUNTIME_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** A runtime id safe to use as a file name; `.`/`..` and separators never qualify. */
export function isLifecycleCredentialRuntimeId(runtimeId: string): boolean {
  return LIFECYCLE_RUNTIME_ID_PATTERN.test(runtimeId) && runtimeId !== '.' && runtimeId !== '..'
}

export function lifecycleCredentialDirectory(runtimeRoot: string): string {
  return join(runtimeRoot, 'lifecycle')
}

/** `<runtime root>/lifecycle/<runtimeId>.credential`; throws on an unsafe id. */
export function lifecycleCredentialPath(runtimeRoot: string, runtimeId: string): string {
  if (!isLifecycleCredentialRuntimeId(runtimeId)) {
    throw new Error(`unsafe runtime id for a lifecycle credential: ${JSON.stringify(runtimeId)}`)
  }
  return join(lifecycleCredentialDirectory(runtimeRoot), `${runtimeId}.credential`)
}

export type HrcServerLifecycleAction = 'stop' | 'restart'

export type HrcServerLifecycleFlags = {
  wait: boolean
  drain: boolean
  force: boolean
}

export type HrcServerLifecycleCallerKind = 'mable-primary' | 'mable-node-local'

/**
 * The verified grant a daemon records before it acts. `requestedBy` is the
 * credential's bound scopeRef (or, cross-node, the origin's attested one) —
 * never an env string.
 */
export type HrcServerLifecycleGrant = {
  requestId: string
  requestedBy: string
  callerKind: HrcServerLifecycleCallerKind
  originNode: string
  reason: string
  action: HrcServerLifecycleAction
  flags: HrcServerLifecycleFlags
}

export type HrcServerLifecycleRequest = {
  action: HrcServerLifecycleAction
  reason?: string | undefined
  targetNode?: string | undefined
  wait?: boolean | undefined
  drain?: boolean | undefined
  force?: boolean | undefined
  waitTimeoutMs?: number | undefined
  drainTimeoutMs?: number | undefined
  /** Cross-node restart: how long the origin waits for the target's new process. */
  proofTimeoutMs?: number | undefined
  /** Attribution only: excludes the caller's own run from the in-flight gate. */
  requestedRunId?: string | undefined
}

export type HrcServerLifecycleRemoteProof = {
  beforeStartedAt: string | null
  afterStartedAt: string | null
  proven: boolean
}

export type HrcServerLifecycleResponse = {
  ok: true
  accepted: true
  targetNode: string
  grant: HrcServerLifecycleGrant
  /** Present for a cross-node restart: the target's federation health before/after. */
  remote?: HrcServerLifecycleRemoteProof | undefined
  /** Local drain notes (force fallback after a timed-out closed-admission drain). */
  notes?: string[] | undefined
}

export type HrcServerLifecycleInFlightItem = {
  runId: string
  scopeRef: string
  laneRef: string
  status: string
  transport?: string | undefined
  startedAt?: string | undefined
}
