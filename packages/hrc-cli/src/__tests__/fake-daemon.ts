/**
 * T-08597 — hermetic fake HRC daemon for CLI tests.
 *
 * Serves the daemon-backed resolution routes over a unix socket so CLI tests
 * run offline: `POST /v1/placements/resolve` and `POST /v1/declarations/resolve`
 * with scripted responses. Point the CLI at it via `HRC_RUNTIME_DIR` (socket
 * discovery honors it). No aspd, no registry, no network.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeDaemonScript = {
  placement?:
    | Record<string, unknown>
    | ((request: Record<string, unknown>) => Record<string, unknown>)
  declaration?:
    | Record<string, unknown>
    | ((request: Record<string, unknown>) => Record<string, unknown>)
}

export type FakeDaemon = {
  runtimeDir: string
  socketPath: string
  requests: { path: string; body: unknown }[]
  stop: () => void
  /** Point unknown routes at a real server socket (proxy pass-through). */
  setProxy: (socketPath: string | undefined) => void
}

export function startFakeDaemon(script: FakeDaemonScript): FakeDaemon {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hrc-fake-daemon-'))
  const socketPath = join(runtimeDir, 'hrc.sock')
  const requests: { path: string; body: unknown }[] = []
  let proxySocket: string | undefined

  const serve = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.json().catch(() => ({}))
      requests.push({ path: url.pathname, body })
      if (url.pathname === '/v1/placements/resolve' && request.method === 'POST') {
        if (script.placement === undefined) {
          return Response.json(
            { error: { code: 'unsupported_capability', message: 'no placement script' } },
            { status: 404 }
          )
        }
        try {
          const payload =
            typeof script.placement === 'function'
              ? script.placement(body as Record<string, unknown>)
              : script.placement
          return Response.json(payload)
        } catch (error) {
          return Response.json(
            {
              error: {
                code: 'declaration_invalid',
                message: error instanceof Error ? error.message : String(error),
              },
            },
            { status: 422 }
          )
        }
      }
      if (url.pathname === '/v1/declarations/resolve' && request.method === 'POST') {
        if (script.declaration === undefined) {
          return Response.json(
            { error: { code: 'unsupported_capability', message: 'no declaration script' } },
            { status: 404 }
          )
        }
        try {
          const payload =
            typeof script.declaration === 'function'
              ? script.declaration(body as Record<string, unknown>)
              : script.declaration
          return Response.json(payload)
        } catch (error) {
          return Response.json(
            {
              error: {
                code: 'declaration_invalid',
                message: error instanceof Error ? error.message : String(error),
              },
            },
            { status: 422 }
          )
        }
      }
      if (proxySocket !== undefined) {
        // The request body was already consumed above for request logging;
        // forwarding request.body re-sends a locked stream. Replay the bytes.
        const proxyHeaders = new Headers(request.headers)
        proxyHeaders.delete('content-length')
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
        return fetch(`http://hrc${url.pathname}${url.search}`, {
          method: request.method,
          headers: proxyHeaders,
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
          unix: proxySocket,
        } as never)
      }
      return Response.json(
        { error: { code: 'unknown', message: 'unexpected path' } },
        { status: 404 }
      )
    },
  })

  return {
    runtimeDir,
    socketPath,
    requests,
    stop: () => serve.stop(),
    setProxy: (socketPath: string | undefined) => {
      proxySocket = socketPath
    },
  }
}

/** Env override directing CLI socket discovery at the fake daemon. */
export function fakeDaemonEnv(daemon: FakeDaemon): Record<string, string> {
  return { HRC_RUNTIME_DIR: daemon.runtimeDir }
}
