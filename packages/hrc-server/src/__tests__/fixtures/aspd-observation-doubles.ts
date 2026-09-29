import { resolveDeclarationResult } from './aspd-observation-resolve'
import {
  capabilityResponse,
  compileResponse,
  helloResponse,
  inspectNonOkResponse,
  inspectResponse,
} from './aspd-observation-responses'
import type {
  AspdObservationDouble,
  AspdObservationOptions,
  ObservationConnection,
} from './aspd-observation-types'
/**
 * PROVISIONAL — shapes transcribed from T-08563 rev 5; not graded for producer
 * parity until compared with a real T-08563 producer call.
 *
 * Unix-socket NDJSON JSON-RPC double for T-08564's declaration and preview
 * observations. Keep the request ledger behavioral: the route tests use it to
 * prove project-mode/context forwarding and the single-connection preview law.
 */
import type { Release } from './aspd-route-doubles'

export type {
  AspdObservationDouble,
  AspdObservationOptions,
  ObservationConnection,
  ObservationRequest,
  PromptScript,
  ResolveScript,
} from './aspd-observation-types'

export function startAspdObservationDouble(
  socketPath: string,
  serving: Release,
  options: AspdObservationOptions = {}
): AspdObservationDouble {
  const state: AspdObservationDouble = {
    serving,
    connections: [],
    openConnections: 0,
    stop: () => undefined,
  }
  if (options.socketAbsent === true) return state

  const capabilities = {
    resolveRuntimeDeclaration: true,
    inspectRuntimePlacement: true,
    compileHarnessInvocation: true,
    observeRuntimeCapability: true,
    ...options.capabilities,
  }
  const buffers = new Map<unknown, string>()
  const pending = new Map<unknown, Buffer>()
  const ledgers = new Map<unknown, ObservationConnection>()
  const flush = (socket: { write(data: Buffer): number }) => {
    const queued = pending.get(socket)
    if (queued === undefined || queued.length === 0) return
    const written = socket.write(queued)
    pending.set(socket, queued.subarray(Math.max(written, 0)))
  }
  const send = (socket: { write(data: Buffer): number }, payload: Record<string, unknown>) => {
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`)
    pending.set(socket, Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), bytes]))
    flush(socket)
  }
  const reply = (socket: { write(data: Buffer): number }, id: unknown, result: unknown) => {
    send(socket, { jsonrpc: '2.0', id, result })
  }

  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        state.openConnections += 1
        const ledger = { methods: [], requests: [] }
        state.connections.push(ledger)
        ledgers.set(socket, ledger)
        buffers.set(socket, '')
      },
      drain(socket) {
        flush(socket as never)
      },
      close(socket) {
        state.openConnections -= 1
        ledgers.delete(socket)
        buffers.delete(socket)
        pending.delete(socket)
      },
      data(socket, chunk) {
        let buffer = (buffers.get(socket) ?? '') + chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (line.trim().length === 0) continue
          const message = JSON.parse(line) as {
            id: unknown
            method: string
            params?: Record<string, unknown>
          }
          const params = message.params ?? {}
          const ledger = ledgers.get(socket)
          ledger?.methods.push(message.method)
          ledger?.requests.push({ method: message.method, params })

          if (message.method === 'aspc.hello') {
            reply(socket as never, message.id, helloResponse(serving, options, capabilities))
          } else if (message.method === 'aspc.resolveRuntimeDeclaration') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            const result = resolveDeclarationResult(context, options)
            reply(socket as never, message.id, result)
          } else if (message.method === 'aspc.observeRuntimeCapability') {
            reply(socket as never, message.id, capabilityResponse(params))
          } else if (message.method === 'aspc.inspectRuntimePlacement') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            reply(
              socket as never,
              message.id,
              options.inspectNonOk === true
                ? inspectNonOkResponse()
                : inspectResponse(context, options.prompt ?? 'present')
            )
          } else if (message.method === 'aspc.compileHarnessInvocation') {
            reply(
              socket as never,
              message.id,
              options.compileRejected === true
                ? {
                    schemaVersion: 'aspc-compile-harness-invocation-response/v2',
                    ok: false,
                    diagnostics: [
                      {
                        level: 'error',
                        code: 'fixture_compile_rejected',
                        message: 'fixture compile rejected',
                      },
                    ],
                  }
                : compileResponse(params, serving)
            )
          } else {
            send(socket as never, {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32601,
                message: `method not found: ${message.method}`,
              },
            })
          }
        }
        buffers.set(socket, buffer)
      },
    },
  })
  state.stop = () => listener.stop(true)
  return state
}
