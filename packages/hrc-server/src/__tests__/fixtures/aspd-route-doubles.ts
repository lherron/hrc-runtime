/**
 * Shared doubles for the aspd headless Codex route tests (T-08542, T-08553):
 * retained release directories, an aspd double on a real Unix socket speaking
 * the published ASPC NDJSON wire, the worker broker client whose hello follows
 * the executable actually launched, and a recording tmux manager.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AspcExecutionRelease } from 'spaces-aspc-protocol'
import type {
  BrokerHelloResponse,
  InvocationEventEnvelope,
  InvocationStartRequest,
  InvocationStartResponse,
} from 'spaces-harness-broker-protocol'
import type { RuntimeIdentityAllocation } from 'spaces-runtime-contracts'

import { makeBrokerProfile, makeCompileResponse } from '../broker-compile-fixtures'

export type Release = {
  releaseId: string
  sourceCommit: string
  builtAt: string
  releaseRoot: string
}

// ── Release directories ───────────────────────────────────────────────────────

export function makeRelease(root: string, label: string): Release {
  const releaseId = `asp-${label}-test`
  const releaseRoot = join(root, releaseId)
  mkdirSync(releaseRoot, { recursive: true })
  const release = {
    releaseId,
    sourceCommit: `${label}`.repeat(40).slice(0, 40),
    builtAt: '2026-09-16T00:00:00.000Z',
    releaseRoot,
  }
  writeFileSync(
    join(releaseRoot, 'release.json'),
    JSON.stringify({ releaseId, sourceCommit: release.sourceCommit, builtAt: release.builtAt })
  )
  writeFileSync(join(releaseRoot, 'harness-broker'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(releaseRoot, 'harness-broker'), 0o755)
  return release
}

export function executionReleaseOf(release: Release): AspcExecutionRelease {
  return {
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    builtAt: release.builtAt,
    releaseRoot: release.releaseRoot,
    worker: {
      protocol: 'harness-broker/0.2',
      executable: join(release.releaseRoot, 'harness-broker'),
      argvPrefix: ['run', '--transport', 'unix'],
    },
  }
}

// ── aspd double on a real Unix socket ─────────────────────────────────────────

export type AspdDouble = {
  serving: Release
  compileCalls: number
  openConnections: number
  helloOverride?: Record<string, unknown> | undefined
  omitExecutionRelease?: boolean | undefined
  stop(): void
}

export function startAspdDouble(socketPath: string, serving: Release): AspdDouble {
  const state: AspdDouble = {
    serving,
    compileCalls: 0,
    openConnections: 0,
    stop: () => listener.stop(true),
  }
  const buffers = new Map<unknown, string>()
  // Bun socket writes may be partial; queue the remainder until drain.
  const pending = new Map<unknown, Buffer>()
  const flush = (socket: { write(data: Buffer): number }) => {
    const queued = pending.get(socket)
    if (queued === undefined || queued.length === 0) return
    const written = socket.write(queued)
    pending.set(socket, queued.subarray(Math.max(written, 0)))
  }
  const reply = (socket: { write(data: Buffer): number }, id: unknown, result: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
    pending.set(socket, Buffer.concat([pending.get(socket) ?? Buffer.alloc(0), bytes]))
    flush(socket)
  }
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        state.openConnections += 1
        buffers.set(socket, '')
      },
      drain(socket) {
        flush(socket as never)
      },
      close(socket) {
        state.openConnections -= 1
        buffers.delete(socket)
      },
      data(socket, chunk) {
        let buffer = (buffers.get(socket) ?? '') + chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (line.trim().length === 0) continue
          const message = JSON.parse(line) as { id: unknown; method: string; params: any }
          if (message.method === 'aspc.hello') {
            reply(socket as never, message.id, {
              facadeInfo: { name: 'aspc-facade', version: 'aspd-double' },
              protocolVersion: 'aspc/0.1',
              capabilities: {
                compileRuntimePlan: true,
                catalogAgents: true,
                inspectAgent: true,
                catalogAgentInspection: true,
                inspectAgentSelection: true,
                compileHarnessInvocation: true,
                compileAndStart: false,
                cohostedBroker: false,
                transports: ['unix-jsonrpc-ndjson'],
              },
              release: {
                releaseId: state.serving.releaseId,
                sourceCommit: state.serving.sourceCommit,
                builtAt: state.serving.builtAt,
              },
              ...(state.helloOverride ?? {}),
            })
          } else if (message.method === 'aspc.compileHarnessInvocation') {
            state.compileCalls += 1

            const identity = message.params.compileRequest.identity as RuntimeIdentityAllocation
            const { profile, startRequest } = makeBrokerProfile(identity, {
              initialInputText: message.params.compileRequest.materialization.initialPrompt,
            })
            const compileResponse = makeCompileResponse(identity, [profile])
            if (!compileResponse.ok) throw new Error('fixture compile rejected')
            reply(socket as never, message.id, {
              schemaVersion: 'aspc-compile-harness-invocation-response/v1',
              ok: true,
              compileResponse,
              plan: compileResponse.plan,
              selectedProfile: profile,
              startRequest,
              dispatchRequest: { startRequest },
              diagnostics: [],
              ...(state.omitExecutionRelease
                ? {}
                : { executionRelease: executionReleaseOf(state.serving) }),
            })
          }
        }
        buffers.set(socket, buffer)
      },
    },
  })
  return state
}

// ── Worker + tmux doubles ─────────────────────────────────────────────────────

export type HostingLedger = {
  commands: string[]
  killedServers: string[]
  startCalls: Array<{ request: InvocationStartRequest; dispatch: unknown }>
  attachCalls: number
  helloReleaseOverride?: BrokerHelloResponse['release'] | null | undefined
  startThrows?: Error | undefined
  onFirstHostingEffect?: (() => void) | undefined
}

export function capabilities(): InvocationStartResponse['capabilities'] {
  return {
    input: {
      user: true,
      steer: false,
      appendContext: false,
      localImages: false,
      fileRefs: false,
      queue: false,
    },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: false, provider: 'openai', keyKind: 'session' },
    events: {
      assistantDeltas: true,
      toolCalls: true,
      usage: false,
      diagnostics: false,
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: false },
  } as unknown as InvocationStartResponse['capabilities']
}

export function releaseFromCommand(command: string | undefined, releases: Release[]) {
  const match = releases.find((release) => command?.includes(release.releaseRoot))
  return match === undefined
    ? undefined
    : { releaseId: match.releaseId, sourceCommit: match.sourceCommit, builtAt: match.builtAt }
}

export function workerClient(
  ledger: HostingLedger,
  releases: Release[],
  command: string | undefined
) {
  const events: AsyncIterable<InvocationEventEnvelope> = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  }
  return {
    onPermissionRequest() {},
    onClose() {},
    async hello(): Promise<BrokerHelloResponse> {
      const release =
        ledger.helloReleaseOverride === null
          ? undefined
          : (ledger.helloReleaseOverride ?? releaseFromCommand(command, releases))
      return {
        brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
        protocolVersion: 'harness-broker/0.2',
        capabilities: {
          multiInvocation: false,
          transports: ['unix-jsonrpc-ndjson'],
          eventNotifications: true,
          brokerToClientRequests: true,
          attachReplay: true,
        },
        drivers: [
          {
            kind: 'codex-app-server',
            version: '0.2.0-test',
            available: true,
            capabilities: capabilities(),
          },
        ],
        ...(release !== undefined ? { release } : {}),
      } as BrokerHelloResponse
    },
    async health() {
      return { status: 'ok' as const, activeInvocations: 0, drivers: [] }
    },
    async startInvocationFromRequest(request: InvocationStartRequest, dispatch: unknown) {
      ledger.startCalls.push({ request, dispatch })
      if (ledger.startThrows) throw ledger.startThrows
      return {
        invocationId: String(request.spec.invocationId),
        response: {
          invocationId: String(request.spec.invocationId),
          state: 'ready',
          capabilities: capabilities(),
        },
        events,
      }
    },
    async dispose() {},
    async close() {},
    async attach() {
      ledger.attachCalls += 1
      throw new Error('attach reached')
    },
    async snapshot() {
      return {}
    },
    async eventsSince() {
      return { events: [] }
    },
    async ackEvents() {
      return {}
    },
  }
}

export function tmuxManagerDouble(ledger: HostingLedger) {
  return ({ socketPath }: { socketPath: string }) => ({
    async initialize() {},
    async killServer() {
      ledger.killedServers.push(socketPath)
    },
    async createWindowWithCommand(input: {
      sessionName: string
      windowName: string
      command: string
    }) {
      ledger.onFirstHostingEffect?.()
      ledger.onFirstHostingEffect = undefined
      ledger.commands.push(input.command)
      return {
        socketPath,
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
        sessionName: input.sessionName,
        windowName: input.windowName,
      }
    },
    async createOrInspectWindow(input: { sessionName: string; windowName: string }) {
      return { socketPath, sessionId: '$1', windowId: '@2', paneId: '%2', ...input }
    },
    async inspectPaneProcess() {
      return { command: 'harness-broker', pid: 4242, dead: false }
    },
  })
}
