import { isAbsolute, relative, resolve } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import { getBrokerRuntimeTmuxSocketPath } from '../broker-decisions.js'
import { parseBrokerRuntimeHostingState } from './runtime-hosting.js'

export const BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT = 'broker_adoption_path_outside_runtime_root'

export type BrokerAdoptionPathKind =
  | 'broker-endpoint-socket'
  | 'broker-attach-token'
  | 'broker-lease-tmux-socket'
  | 'broker-compat-tmux-socket'

export type BrokerAdoptionPathRejection = {
  kind: BrokerAdoptionPathKind
  path: string
}

/**
 * Broker adoption authority is rooted in the daemon's configured runtimeRoot.
 * Persisted paths are untrusted store data: a copied database may still name the
 * source daemon's live sockets. Require an absolute candidate whose normalized
 * path is the runtime root itself or one of its descendants.
 */
export function isPathInsideRuntimeRoot(candidate: string, runtimeRoot: string): boolean {
  if (!isAbsolute(candidate)) return false
  const normalizedRoot = resolve(runtimeRoot)
  const normalizedCandidate = resolve(candidate)
  const suffix = relative(normalizedRoot, normalizedCandidate)
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))
}

/** Return every persisted broker path this daemon must refuse to reach. */
export function rejectedBrokerAdoptionPaths(
  runtime: HrcRuntimeSnapshot,
  runtimeRoot: string
): BrokerAdoptionPathRejection[] {
  const candidates: BrokerAdoptionPathRejection[] = []
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.endpoint.kind === 'unix-jsonrpc-ndjson') {
    candidates.push(
      { kind: 'broker-endpoint-socket', path: hosting.endpoint.socketPath },
      { kind: 'broker-attach-token', path: hosting.endpoint.attachTokenRef.path }
    )
  }
  if (hosting?.substrate.kind === 'leased-tmux') {
    candidates.push({
      kind: 'broker-lease-tmux-socket',
      path: hosting.substrate.tmuxSocketPath,
    })
  }
  const compatibilityTmuxSocket = getBrokerRuntimeTmuxSocketPath(runtime)
  if (compatibilityTmuxSocket !== undefined) {
    candidates.push({ kind: 'broker-compat-tmux-socket', path: compatibilityTmuxSocket })
  }

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (isPathInsideRuntimeRoot(candidate.path, runtimeRoot)) return false
    const key = `${candidate.kind}\0${candidate.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function brokerAdoptionPathsAreConfined(
  runtime: HrcRuntimeSnapshot,
  runtimeRoot: string
): boolean {
  return rejectedBrokerAdoptionPaths(runtime, runtimeRoot).length === 0
}
