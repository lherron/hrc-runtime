/**
 * PROVISIONAL — shapes transcribed from T-08563 rev 5; not graded for producer
 * parity until compared with a real T-08563 producer call.
 *
 * Unix-socket NDJSON JSON-RPC double for T-08564's declaration and preview
 * observations. Keep the request ledger behavioral: the route tests use it to
 * prove project-mode/context forwarding and the single-connection preview law.
 */
import type { HarnessInvocationSpec, InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type RuntimeIdentityAllocation,
  neutralSpecHash,
  neutralStartRequestHash,
} from 'spaces-runtime-contracts'

import { type Release, executionReleaseOf } from './aspd-route-doubles'

export type ResolveScript = 'ok' | 'absent' | 'invalid' | 'incompatible'
export type PromptScript = 'present' | 'absent' | 'invalid'

export type AspdObservationOptions = {
  resolve?: ResolveScript
  prompt?: PromptScript
  invalidAgentProfile?: boolean
  protocolVersion?: string
  capabilities?: Partial<{
    resolveRuntimeDeclaration: boolean
    inspectRuntimePlacement: boolean
    compileHarnessInvocation: boolean
  }>
  socketAbsent?: boolean
}

export type ObservationRequest = {
  method: string
  params: Record<string, unknown>
}

export type ObservationConnection = {
  methods: string[]
  requests: ObservationRequest[]
}

export type AspdObservationDouble = {
  serving: Release
  connections: ObservationConnection[]
  openConnections: number
  stop(): void
}

function sourceState(invalidAgentProfile: boolean) {
  return {
    agentProfile: invalidAgentProfile
      ? {
          state: 'invalid',
          diagnostics: [
            {
              severity: 'error',
              code: 'agent_profile_invalid',
              message: 'fixture profile parse failed',
              source: 'agent-profile',
            },
          ],
        }
      : { state: 'valid', code: 'parsed', contentHash: 'sha256:agent-profile' },
    projectTargets: { state: 'valid', code: 'parsed', contentHash: 'sha256:targets' },
    selectedTarget: { state: 'valid', code: 'parsed', contentHash: 'sha256:selected' },
    priming: { state: 'absent', code: 'not_declared' },
  }
}

function agentSources(context: Record<string, unknown>) {
  const supplied = (context['agentSources'] ?? {}) as Record<string, unknown>
  return {
    ...supplied,
    provenance: typeof context['agentRoot'] === 'string' ? 'caller-agent-root' : 'caller',
  }
}

function okDeclaration(
  context: Record<string, unknown>,
  invalidAgentProfile: boolean
): Record<string, unknown> {
  const project = (context['project'] ?? { mode: 'none' }) as Record<string, unknown>
  const projectRoot = project['mode'] === 'root' ? project['projectRoot'] : undefined
  const agentRoot = String(context['agentRoot'] ?? '/tmp/t08564-agent')
  const placement = {
    agentRoot,
    ...(typeof projectRoot === 'string' ? { projectRoot } : {}),
    cwd: String(context['cwd'] ?? agentRoot),
    runMode: String(context['runMode'] ?? 'task'),
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  }
  const provisioning = {
    scalars: { model: 'x', yolo: true, sandbox: 'danger-full-access' },
    effectiveHarness: 'codex',
    frontend: 'codex-cli',
    provider: 'openai',
    family: 'codex',
    runtime: 'codex-cli',
  }
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: true,
    evaluatedAt: '2026-09-16T00:00:00.000Z',
    contextHash: 'sha256:t08564-context',
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: sourceState(invalidAgentProfile),
    identity: { role: 'verify', operator: false },
    policy: { claimsTask: true, placement: { pins: {}, homes: {} } },
    baselineProvisioning: provisioning,
    provisioning,
    placement,
    bundle: { ref: placement.bundle, identity: 'bundle:t08564' },
    diagnostics: invalidAgentProfile
      ? [
          {
            severity: 'error',
            code: 'agent_profile_invalid',
            message: 'fixture profile parse failed',
            source: 'agent-profile',
          },
        ]
      : [],
  }
}

function resolveResponse(
  context: Record<string, unknown>,
  script: ResolveScript,
  invalidAgentProfile: boolean
): Record<string, unknown> {
  if (script === 'ok') return okDeclaration(context, invalidAgentProfile)
  if (script === 'incompatible') {
    return {
      schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
      ok: false,
      failure: {
        kind: 'incompatible',
        code: 'configured_context_mismatch',
        message: 'configured caller context does not match the resolved agent root',
      },
    }
  }

  const invalid = script === 'invalid'
  return {
    schemaVersion: 'aspc-resolve-runtime-declaration-response/v1',
    ok: false,
    agentSources: agentSources(context),
    searchedAgentRoots: [],
    source: {
      ...sourceState(false),
      ...(invalid
        ? {
            projectTargets: {
              state: 'invalid',
              diagnostics: [
                {
                  severity: 'error',
                  code: 'project_targets_invalid',
                  message: 'fixture targets parse failed',
                  source: 'project-targets',
                },
              ],
            },
          }
        : { agentProfile: { state: 'absent', code: 'not_declared' } }),
    },
    resolution: invalid
      ? {
          state: 'invalid',
          code: 'project_targets_invalid',
          message: 'fixture targets parse failed',
          diagnostics: [
            {
              severity: 'error',
              code: 'project_targets_invalid',
              message: 'fixture targets parse failed',
              source: 'project-targets',
            },
          ],
        }
      : {
          state: 'absent',
          code: 'agent_not_found',
          message: 'fixture agent not found',
          diagnostics: [],
        },
  }
}

function promptResponse(script: PromptScript): Record<string, unknown> {
  if (script === 'absent') return { state: 'absent', code: 'prompt_not_declared' }
  if (script === 'invalid') {
    return {
      state: 'invalid',
      code: 'prompt_resolution_failed',
      message: 'fixture prompt exec failed',
      diagnostics: [
        {
          level: 'error',
          code: 'prompt_resolution_failed',
          message: 'fixture prompt exec failed',
        },
      ],
    }
  }
  return {
    state: 'present',
    value: {
      systemPrompt: 'T-08564 system prompt',
      systemPromptMode: 'append',
      reminderContent: 'T-08564 reminder',
      primingPrompt: 'T-08564 priming',
      promptSectionSizes: [{ name: 'system', chars: 22 }],
      reminderSectionSizes: [{ name: 'reminder', chars: 18 }],
      promptTotalChars: 22,
      reminderTotalChars: 18,
      totalContextChars: 40,
      nearMaxChars: false,
    },
  }
}

function compileResponse(params: Record<string, unknown>, serving: Release) {
  const compileRequest = (params['compileRequest'] ?? {}) as Record<string, unknown>
  const identity = (compileRequest['identity'] ?? {
    requestId: 'dry-req-t08564',
    operationId: 'dry-op-t08564',
    hostSessionId: 'dry-run-host-session',
    generation: 0,
    runtimeId: 'dry-rt-t08564',
    invocationId: 'dry-inv-t08564',
    initialInputId: 'dry-input-t08564',
    runId: 'dry-run-t08564',
    traceId: 'dry-trace-t08564',
  }) as RuntimeIdentityAllocation
  const invocationId = identity.invocationId ?? ('dry-inv-t08564' as never)
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId,
    harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
    process: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/t08564-project',
      lockedEnv: { CODEX_HOME: '/tmp/t08564-codex-home' },
      harnessTransport: { kind: 'jsonrpc-stdio' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single' },
    driver: { kind: 'codex-app-server', model: 'gpt-5-codex' },
    correlation: {
      requestId: String(identity.requestId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      invocationId: String(invocationId),
    },
  }
  const startRequest: InvocationStartRequest = { spec }
  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_t08564',
    profileHash: 'profilehash_t08564',
    compatibilityHash: 'compat_t08564',
    kind: 'harness-broker',
    interactionMode: 'headless',
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    expectedCapabilities: {},
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(spec),
      startRequestHash: neutralStartRequestHash(startRequest),
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {},
      exposurePolicy: {},
    },
    observability: {},
  }
  const plan = {
    schemaVersion: 'agent-runtime-plan/v1',
    compiler: { name: 'agent-spaces', version: 't08564-double' },
    compileId: 'compile_t08564',
    planHash: 'planhash_t08564',
    createdAt: '2026-09-16T00:00:00.000Z',
    identity,
    placement: {
      agentRoot: '/tmp/t08564-agent',
      projectRoot: '/tmp/t08564-project',
      cwd: '/tmp/t08564-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
    },
    resolvedBundle: { bundleIdentity: 'bundle:t08564' },
    harness: { family: 'codex', runtime: 'codex-cli', provider: 'openai' },
    model: { provider: 'openai', modelId: 'gpt-5-codex' },
    executionProfiles: [profile],
    artifacts: { bundleIdentity: 'bundle:t08564' },
    lockedEnv: { lockedEnvKeys: ['CODEX_HOME'] },
    diagnostics: [],
  }
  const runtimeCompile = {
    schemaVersion: 'agent-runtime-compile-response/v1',
    ok: true,
    plan,
    diagnostics: [],
  }
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: true,
    compileResponse: runtimeCompile,
    plan,
    selectedProfile: profile,
    startRequest,
    dispatchRequest: { startRequest },
    diagnostics: [],
    executionRelease: executionReleaseOf(serving),
  }
}

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
            reply(socket as never, message.id, {
              facadeInfo: { name: 'aspc-facade', version: 't08564-double' },
              protocolVersion: options.protocolVersion ?? 'aspc/0.1',
              capabilities: {
                compileRuntimePlan: true,
                catalogAgents: true,
                inspectAgent: true,
                catalogAgentInspection: true,
                inspectAgentSelection: true,
                compileAndStart: false,
                cohostedBroker: false,
                transports: ['unix-jsonrpc-ndjson'],
                ...capabilities,
              },
              release: {
                releaseId: serving.releaseId,
                sourceCommit: serving.sourceCommit,
                builtAt: serving.builtAt,
              },
            })
          } else if (message.method === 'aspc.resolveRuntimeDeclaration') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            reply(
              socket as never,
              message.id,
              resolveResponse(
                context,
                options.resolve ?? 'ok',
                options.invalidAgentProfile ?? false
              )
            )
          } else if (message.method === 'aspc.inspectRuntimePlacement') {
            const context = (params['context'] ?? {}) as Record<string, unknown>
            reply(socket as never, message.id, {
              schemaVersion: 'aspc-inspect-runtime-placement-response/v1',
              ok: true,
              declaration: okDeclaration(context, options.invalidAgentProfile ?? false),
              inspection: { parts: [], diagnostics: [] },
              prompt: promptResponse(options.prompt ?? 'present'),
              effectiveEnvironmentHash: 'sha256:t08564-environment',
            })
          } else if (message.method === 'aspc.compileHarnessInvocation') {
            reply(socket as never, message.id, compileResponse(params, serving))
          } else {
            send(socket as never, {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `method not found: ${message.method}` },
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
