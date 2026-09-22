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
import { neutralStartRequestHash } from 'spaces-runtime-contracts'

import { makeBrokerProfile, makeInteractiveTmuxProfile } from '../broker-compile-fixtures'

/**
 * A fixture declaration of what ASP has already selected.  It is deliberately
 * independent of the raw HRC request: tests may inspect that request, but the
 * double never uses it to choose an execution.
 */
export type AspdProducerResult = {
  selection: {
    harness: string
    modelProvider: string
    model: string
    reasoningEffort?: string | undefined
    presentation: boolean
    provenance?: Record<string, string> | undefined
  }
  execution: {
    recipeId: string
    driver: string
    hosting:
      | {
          executionTransport: 'jsonrpc-stdio'
          terminalRequired: false
          processExecution: 'broker-process'
        }
      | {
          executionTransport: 'pty'
          terminalRequired: true
          terminalHost: 'tmux'
          processExecution: 'broker-process'
        }
    presentationFulfillment: 'intrinsic' | 'attachable' | 'birth-variant'
    presentationSurface?: { transport: 'terminal' | 'websocket-unix'; terminalHost: 'tmux' }
  }
}

export function producerResult(
  result: Partial<AspdProducerResult> & {
    execution?: Partial<AspdProducerResult['execution']>
  } = {}
): AspdProducerResult {
  const execution = result.execution ?? {}
  return {
    selection: {
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.5',
      presentation: false,
      provenance: {
        harness: 'catalog-default',
        modelProvider: 'catalog-default',
        model: 'catalog-default',
        presentation: 'catalog-default',
      },
      ...result.selection,
    },
    execution: {
      recipeId: 'fixture-agent-harness',
      driver: 'codex-app-server',
      hosting: {
        executionTransport: 'jsonrpc-stdio',
        terminalRequired: false,
        processExecution: 'broker-process',
      },
      presentationFulfillment: 'attachable',
      ...execution,
    } as AspdProducerResult['execution'],
  }
}

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
  /** `aspHome` carried by each compile request, in order (T-08555). */
  compileAspHomes: Array<string | undefined>
  /** The materialization of each compile request, in order (T-08560). */
  compileMaterializations: Array<Record<string, unknown>>
  /** Raw v2 requested fields received by the producer, in order. */
  compileRequested: Array<Record<string, unknown>>
  /** Frozen producer output to emit for every compile. */
  producerResult: AspdProducerResult
  openConnections: number
  helloOverride?: Record<string, unknown> | undefined
  omitExecutionRelease?: boolean | undefined
  /**
   * T-08562: `executionRelease.worker.hostedDrivers` to emit. Undefined omits the
   * field (a retained pre-binding release); any value is sent verbatim.
   */
  hostedDrivers?: unknown
  /** Retained raw-request observation for older fixture consumers; always undefined on v2. */
  compileSelectors: Array<Record<string, unknown> | undefined>
  /** Retained fixture field; it never influences the producer result. */
  selectDriverOverride?: string | undefined
  /** The `continuation` carried by each compile request, in order (T-08562). */
  compileContinuations: unknown[]
  /**
   * T-08562: answer compiles with the existing failure envelope carrying this
   * diagnostic code (e.g. the producer's `release_worker_driver_unavailable`).
   */
  compileFailureCode?: string | undefined
  /**
   * T-08712: emit the real claude-code-tmux shape, where a terminal execution
   * carries the first turn on the launch (spec.launch.initialPrompt) and has no
   * broker initialInput to echo HRC's allocated initialInputId.
   */
  launchCarriedInitialPrompt?: boolean | undefined
  /** T-08712: overwrite fields of the echoed plan identity (a forced admission refusal). */
  planIdentityOverride?: Record<string, unknown> | undefined
  stop(): void
}

export function startAspdDouble(socketPath: string, serving: Release): AspdDouble {
  const state: AspdDouble = {
    serving,
    compileCalls: 0,
    compileAspHomes: [],
    compileMaterializations: [],
    compileRequested: [],
    producerResult: producerResult(),
    compileSelectors: [],
    compileContinuations: [],
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
            state.compileAspHomes.push(message.params?.aspHome)
            const materialization = message.params.compileRequest.materialization ?? {}
            state.compileMaterializations.push(materialization)
            state.compileRequested.push(message.params.compileRequest.requested ?? {})
            state.compileSelectors.push(message.params?.profileSelector)
            state.compileContinuations.push(message.params.compileRequest.continuation)
            if (state.compileFailureCode !== undefined) {
              const diagnostic = {
                level: 'error',
                code: state.compileFailureCode,
                message: 'Selected broker driver is not hosted by this ASP release',
                plane: 'asp-compiler',
                details: {
                  releaseId: state.serving.releaseId,
                  brokerDriver: message.params?.profileSelector?.brokerDriver,
                },
              }
              reply(socket as never, message.id, {
                schemaVersion: 'aspc-compile-harness-invocation-response/v1',
                ok: false,
                compileResponse: {
                  schemaVersion: 'agent-runtime-compile-response/v1',
                  ok: false,
                  diagnostics: [diagnostic],
                },
                diagnostics: [diagnostic],
              })
              continue
            }
            const identity = message.params.compileRequest.identity as RuntimeIdentityAllocation
            // T-08556: an interactive compile selects the interactive codex-app-server TUI.
            // T-08560: a launch-carried prompt rides it as the broker initialInput,
            // the codex-app-server compiler shape.
            const interactivePrompt =
              typeof materialization.initialPrompt === 'string' &&
              materialization.initialPrompt.length > 0
                ? materialization.initialPrompt
                : undefined
            const selected = state.producerResult
            const selectedDriver = selected.execution.driver
            const terminalRequired = selected.execution.hosting.terminalRequired
            // The v2 producer declares one execution; a fixture must not infer
            // a second dispatch shape from the selected driver's legacy name.
            // A canonical initial input remains identity-bound when allocated.
            const launchArgvDriver = state.launchCarriedInitialPrompt === true
            const { profile, startRequest } = terminalRequired
              ? makeInteractiveTmuxProfile(identity, {
                  brokerDriver: selectedDriver as never,
                  withInitialInput:
                    !launchArgvDriver &&
                    interactivePrompt !== undefined &&
                    identity.initialInputId !== undefined,
                  ...(interactivePrompt !== undefined && !launchArgvDriver
                    ? { initialInputText: interactivePrompt }
                    : {}),
                  ...(interactivePrompt !== undefined && launchArgvDriver
                    ? { launchInitialPrompt: interactivePrompt }
                    : {}),
                })
              : makeBrokerProfile(identity, {
                  initialInputText: message.params.compileRequest.materialization.initialPrompt,
                  brokerDriver: selectedDriver,
                })
            // The public v2 contract carries a singular, already selected
            // execution.  Keep using the old fixture builders only for their
            // honest broker start-request construction; the v1 profile/plan
            // envelope itself must never cross this double's socket.
            const startSpec = startRequest.spec as unknown as Record<string, unknown>
            startSpec['driver'] = {
              ...(startSpec['driver'] as Record<string, unknown>),
              kind: selectedDriver,
            }
            startSpec['harness'] = {
              ...(startSpec['harness'] as Record<string, unknown>),
              driver: selectedDriver,
            }
            startSpec['correlation'] = {
              ...(startSpec['correlation'] as Record<string, unknown>),
              requestId: identity.requestId,
              operationId: identity.operationId,
              hostSessionId: identity.hostSessionId,
              runtimeId: identity.runtimeId,
              runId: identity.runId,
              traceId: identity.traceId,
            }
            reply(socket as never, message.id, {
              schemaVersion: 'aspc-compile-harness-invocation-response/v2',
              ok: true,
              diagnostics: [],
              plan: {
                schemaVersion: 'agent-runtime-plan/v2',
                agent: message.params.compileRequest.agent,
                identity: { ...identity, ...state.planIdentityOverride },
                planHash: `plan-${String(identity.operationId)}`,
                compileId: `compile-${String(identity.operationId)}`,
                createdAt: '2026-09-22T00:00:00.000Z',
                diagnostics: [],
                selection: {
                  ...selected.selection,
                  provenance: selected.selection.provenance ?? {
                    harness: 'catalog-default',
                    modelProvider: 'catalog-default',
                    model: 'catalog-default',
                    presentation: 'catalog-default',
                  },
                },
                execution: {
                  recipeId: selected.execution.recipeId,
                  driver: selectedDriver,
                  protocol: 'harness-broker/0.2',
                  hosting: selected.execution.hosting,
                  presentationFulfillment: selected.execution.presentationFulfillment,
                  ...(selected.execution.presentationSurface !== undefined
                    ? { presentationSurface: selected.execution.presentationSurface }
                    : {}),
                  profile: {
                    profileId: profile.profileId,
                    profileHash: profile.profileHash,
                    compatibilityHash: profile.compatibilityHash,
                    startRequestHash: neutralStartRequestHash(startRequest),
                  },
                  dispatchRequest: { startRequest },
                },
              },
              ...(state.omitExecutionRelease
                ? {}
                : {
                    executionRelease: {
                      ...executionReleaseOf(state.serving),
                      worker: {
                        ...executionReleaseOf(state.serving).worker,
                        ...(state.hostedDrivers !== undefined
                          ? { hostedDrivers: state.hostedDrivers }
                          : {}),
                      },
                    },
                  }),
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
  startGate?: Promise<void> | undefined
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
        drivers: ['codex-app-server', 'claude-code-tmux', 'pi-tui-tmux', 'muse-serve'].map(
          (kind) => ({
            kind,
            version: '0.2.0-test',
            available: true,
            capabilities: capabilities(),
          })
        ),
        ...(release !== undefined ? { release } : {}),
      } as BrokerHelloResponse
    },
    async health() {
      return { status: 'ok' as const, activeInvocations: 0, drivers: [] }
    },
    async startInvocationFromRequest(request: InvocationStartRequest, dispatch: unknown) {
      ledger.startCalls.push({ request, dispatch })
      if (ledger.startThrows) throw ledger.startThrows
      await ledger.startGate
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
