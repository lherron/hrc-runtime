import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const SOCKET_SCRATCH_PARENT = '/tmp'
const TEST_SOCKET_PATH_LIMIT = 100

export type SocketScratch = {
  root: string
  socketPath(...segments: string[]): string
  cleanup(): Promise<void>
}

export function assertShortSocketPath(socketPath: string): void {
  if (socketPath.length >= TEST_SOCKET_PATH_LIMIT) {
    throw new Error(
      `test unix socket path must be shorter than ${TEST_SOCKET_PATH_LIMIT} characters: ${socketPath}`
    )
  }
}

/**
 * Create fixture-owned scratch space beneath a deliberately short root.
 *
 * Unix-domain sockets on macOS have a 104-byte sun_path budget. Test fixtures
 * must not inherit the much longer per-user TMPDIR when they bind real sockets.
 */
export async function createSocketScratch(prefix = 'hrc-t-'): Promise<SocketScratch> {
  const root = await mkdtemp(join(SOCKET_SCRATCH_PARENT, prefix))
  return {
    root,
    socketPath(...segments: string[]): string {
      const socketPath = join(root, ...segments)
      assertShortSocketPath(socketPath)
      return socketPath
    },
    cleanup: async () => rm(root, { recursive: true, force: true }),
  }
}
