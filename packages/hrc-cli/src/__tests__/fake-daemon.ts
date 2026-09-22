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
  preview?:
    | Record<string, unknown>
    | ((request: Record<string, unknown>) => Record<string, unknown>)
}

/** Minimal admitted daemon preview used by CLI-only fixtures. */
export function fakeRunPreview(request: Record<string, unknown>): Record<string, unknown> {
  const intent = (request['intent'] ?? {}) as Record<string, unknown>
  const placement = (intent['placement'] ?? {}) as Record<string, unknown>
  return {
    controllerKind: 'harness-broker',
    specHash: 'spec-fixture',
    startRequestHash: 'request-fixture',
    selection: {
      harness: 'codex',
      modelProvider: 'openai',
      model: 'fixture-model',
      presentation: true,
      provenance: {
        harness: 'fixture',
        modelProvider: 'fixture',
        model: 'fixture',
        presentation: 'fixture',
      },
    },
    execution: {
      recipeId: 'fixture-recipe',
      driver: 'fixture-driver',
      protocol: 'harness-broker/0.2',
      hosting: {
        executionTransport: 'headless',
        terminalRequired: false,
        processExecution: 'native-worker',
      },
      presentationFulfillment: 'attachable',
      profile: {
        profileId: 'fixture-profile',
        profileHash: 'profile-fixture',
        compatibilityHash: 'compat-fixture',
        startRequestHash: 'request-fixture',
      },
    },
    process: { execution: 'native-worker', cwd: placement['cwd'] ?? process.cwd() },
    initialInput: false,
    inputQueue: 'broker',
    warnings: [],
    env: {},
    planHash: 'plan-fixture',
    compileId: 'compile-fixture',
    release: { releaseId: 'fake-aspd', sourceCommit: 'fixture' },
    diagnostics: {
      releases: { aspd: { releaseId: 'fake-aspd', sourceCommit: 'fixture' } },
      ids: { compileId: 'compile-fixture', planHash: 'plan-fixture' },
      phases: [
        { id: 'compile', status: 'ok', ms: 1 },
        { id: 'admission', status: 'ok', ms: 1 },
        { id: 'inspect-prompt', status: 'ok', ms: 1 },
      ],
    },
  }
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
      if (url.pathname === '/v1/previews/run' && request.method === 'POST') {
        if (script.preview === undefined) {
          return Response.json(
            { error: { code: 'unsupported_capability', message: 'no preview script' } },
            { status: 404 }
          )
        }
        const payload =
          typeof script.preview === 'function'
            ? script.preview(body as Record<string, unknown>)
            : script.preview
        return Response.json(payload)
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
