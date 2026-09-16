/**
 * Release binding checks for an aspd-prepared headless codex attempt (T-08542).
 *
 * Every check here reads only the persisted `executionRelease` and the release
 * directory it names. None resolves a binary by driver name, PATH, `current`,
 * a per-binary override, the toolchain root, or HRC's dependency tree.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import type { AspReleaseIdentity, BrokerHelloResponse } from 'spaces-harness-broker-protocol'

/** The only broker protocol HRC negotiates on a durable route. */
export const ASPD_SUPPORTED_WORKER_PROTOCOLS = ['harness-broker/0.2'] as const

export type ExecutionReleaseRefusalCode =
  | 'execution_release_missing'
  | 'release_unavailable'
  | 'release_identity_mismatch'
  | 'worker_executable_outside_release'
  | 'unsupported_worker_protocol'
  | 'launch_description_mismatch'
  | 'worker_protocol_mismatch'
  | 'worker_release_unidentified'
  | 'worker_release_mismatch'

export class ExecutionReleaseRefusal extends Error {
  readonly code: ExecutionReleaseRefusalCode
  readonly detail: Record<string, unknown>

  constructor(
    code: ExecutionReleaseRefusalCode,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ExecutionReleaseRefusal'
    this.code = code
    this.detail = detail
  }
}

export function releaseIdentityOf(release: AspReleaseIdentity): AspReleaseIdentity {
  return {
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    builtAt: release.builtAt,
  }
}

/**
 * Validate the frozen release from bytes on disk. Returns the canonical worker
 * executable inside the release, or throws a named refusal. Launches nothing.
 */
export function validateFrozenExecutionRelease(release: AspcExecutionRelease | undefined): {
  executable: string
} {
  if (release === undefined) {
    throw new ExecutionReleaseRefusal(
      'execution_release_missing',
      'aspd preparation carries no executionRelease'
    )
  }
  const manifestPath = join(release.releaseRoot, 'release.json')
  let manifest: { releaseId?: unknown; sourceCommit?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (error) {
    throw new ExecutionReleaseRefusal(
      'release_unavailable',
      `ASP release ${release.releaseId} is not available at ${release.releaseRoot}`,
      {
        releaseId: release.releaseId,
        releaseRoot: release.releaseRoot,
        cause: error instanceof Error ? error.message : String(error),
      }
    )
  }
  if (manifest.releaseId !== release.releaseId || manifest.sourceCommit !== release.sourceCommit) {
    throw new ExecutionReleaseRefusal(
      'release_identity_mismatch',
      'ASP release manifest does not match the frozen preparation',
      {
        expected: { releaseId: release.releaseId, sourceCommit: release.sourceCommit },
        found: { releaseId: manifest.releaseId, sourceCommit: manifest.sourceCommit },
      }
    )
  }
  let executable: string | undefined
  let root: string
  try {
    root = realpathSync(release.releaseRoot)
    executable = realpathSync(release.worker.executable)
  } catch {
    executable = undefined
    root = release.releaseRoot
  }
  if (executable === undefined || !executable.startsWith(`${root}${sep}`)) {
    throw new ExecutionReleaseRefusal(
      'worker_executable_outside_release',
      'worker executable does not resolve inside the frozen release',
      { executable: release.worker.executable, releaseRoot: root }
    )
  }
  if (!(ASPD_SUPPORTED_WORKER_PROTOCOLS as readonly string[]).includes(release.worker.protocol)) {
    throw new ExecutionReleaseRefusal(
      'unsupported_worker_protocol',
      `HRC does not support worker protocol ${release.worker.protocol}`,
      { offered: release.worker.protocol, supported: ASPD_SUPPORTED_WORKER_PROTOCOLS }
    )
  }
  return { executable }
}

/** Existing broker CLI hosting flags HRC realizes after the release's argv prefix. */
export function buildAspdWorkerArgv(
  release: AspcExecutionRelease,
  hosting: {
    socketPath: string
    eventLedgerPath: string
    runtimeId: string
    hostSessionId: string
    generation: number
    attachTokenPath: string
    /** T-08554: a tmux-tui viewer's observer socket, served by the worker. */
    observerSocketPath?: string | undefined
  }
): string[] {
  return [
    ...release.worker.argvPrefix,
    '--socket',
    hosting.socketPath,
    '--event-ledger',
    hosting.eventLedgerPath,
    '--runtime-id',
    hosting.runtimeId,
    '--host-session-id',
    hosting.hostSessionId,
    '--generation',
    String(hosting.generation),
    '--attach-token-file',
    hosting.attachTokenPath,
    ...(hosting.observerSocketPath !== undefined
      ? ['--experimental-observer-socket', hosting.observerSocketPath]
      : []),
  ]
}

/** Refusal when the handshaking worker is not the frozen release, else undefined. */
export function workerHelloRefusal(
  release: AspcExecutionRelease,
  hello: Pick<BrokerHelloResponse, 'protocolVersion' | 'release'>
): ExecutionReleaseRefusal | undefined {
  if (hello.protocolVersion !== release.worker.protocol) {
    return new ExecutionReleaseRefusal(
      'worker_protocol_mismatch',
      `worker negotiated ${hello.protocolVersion}; the frozen release requires ${release.worker.protocol}`,
      { negotiated: hello.protocolVersion, required: release.worker.protocol }
    )
  }
  if (hello.release === undefined) {
    return new ExecutionReleaseRefusal(
      'worker_release_unidentified',
      'worker hello carries no release identity',
      { expected: releaseIdentityOf(release) }
    )
  }
  const expected = releaseIdentityOf(release)
  const actual = releaseIdentityOf(hello.release)
  if (
    expected.releaseId !== actual.releaseId ||
    expected.sourceCommit !== actual.sourceCommit ||
    expected.builtAt !== actual.builtAt
  ) {
    return new ExecutionReleaseRefusal(
      'worker_release_mismatch',
      `worker is release ${actual.releaseId}; the attempt is bound to ${expected.releaseId}`,
      { expected, actual }
    )
  }
  return undefined
}
