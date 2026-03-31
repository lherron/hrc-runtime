import { existsSync } from 'node:fs'

import { resolveControlSocketPath } from 'hrc-core'

/**
 * Discovers the HRC daemon socket using hrc-core path resolution.
 * Throws if the socket file does not exist on disk.
 */
export function discoverSocket(): string {
  const socketPath = resolveControlSocketPath()
  if (!existsSync(socketPath)) {
    throw new Error(`HRC daemon socket not found at ${socketPath}. Is the HRC server running?`)
  }
  return socketPath
}
