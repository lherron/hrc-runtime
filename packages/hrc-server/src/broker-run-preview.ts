import { randomUUID } from 'node:crypto'

import {
  type HrcRuntimeIntent,
  type HrcSessionRecord,
  type RestartStyle,
  resolveStateRoot,
} from 'hrc-core'

import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { buildDirectAgentHarnessPlan } from './agent-spaces-adapter/direct-agent-harness.js'
import {
  isInteractiveTmuxBrokerIntent,
  normalizeClaudeInteractiveBrokerIntent,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import { startAspcFacadeBrokerClient } from './option-resolvers.js'
import { createPrecompileLaunchTimingContext } from './precompile-launch-timing.js'

export type BrokerRunPreview = {
  controllerKind: 'harness-broker'
  brokerDriver: string
  interactionMode: string
  profileId: string
  profileHash: string
  specHash: string
  startRequestHash: string
  process: {
    command: string
    args: string[]
    cwd: string
  }
  initialInput: boolean
  launchInitialPromptLength?: number | undefined
  inputQueue: string
  interrupt: string
  resource?: string | undefined
  warnings: string[]
}

export async function buildBrokerRunPreview(
  intent: HrcRuntimeIntent,
  options: {
    sessionRef: string
    restartStyle: RestartStyle
    promptLength?: number | undefined
  }
): Promise<BrokerRunPreview | undefined> {
  const previewIntent = shouldRedirectClaudeToInteractiveBroker(intent)
    ? normalizeClaudeInteractiveBrokerIntent(intent)
    : intent
  if (!isInteractiveTmuxBrokerIntent(previewIntent) && !shouldUseHeadlessTransport(previewIntent)) {
    return undefined
  }

  const runtimeId = `dry-rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('preview', runtimeId, resolveStateRoot())
  const directAgentHarness =
    shouldUseHeadlessTransport(previewIntent) &&
    (previewIntent.harness.id === 'agent-harness' || previewIntent.harness.id === 'pi-sdk')
  const client = directAgentHarness ? undefined : await startAspcFacadeBrokerClient(timing)

  try {
    const compiled = directAgentHarness
      ? {
          admitted: true as const,
          ...(await buildDirectAgentHarnessPlan({
            intent: previewIntent,
            session: {
              hostSessionId: 'dry-run-host-session',
              scopeRef:
                previewIntent.placement.correlation?.sessionRef?.scopeRef ??
                options.sessionRef.split('/lane:')[0] ??
                options.sessionRef,
              laneRef: previewIntent.placement.correlation?.sessionRef?.laneRef ?? 'main',
              generation: 0,
            } as HrcSessionRecord,
            runtimeId,
            runId: `dry-run-${randomUUID()}`,
            dispatchEnv: {},
            now: new Date().toISOString(),
            resolveProfileYolo: async () => undefined,
          })),
          diagnostics: [],
        }
      : await compileBrokerRuntimePlan(
          {
            intent: previewIntent,
            hostSessionId: 'dry-run-host-session',
            generation: 0,
            continuation: undefined,
          },
          {
            compileHarnessInvocation: (request) => {
              if (client === undefined) {
                throw new Error('ASPC facade client is unavailable for broker preview')
              }
              return client.compileHarnessInvocation(request)
            },
            timing,
            ids: {
              requestId: () => `dry-req-${randomUUID()}`,
              operationId: () => `dry-op-${randomUUID()}`,
              runtimeId: () => runtimeId,
              invocationId: () => `dry-inv-${randomUUID()}`,
              initialInputId: () => `dry-input-${randomUUID()}`,
              runId: () => `dry-run-${randomUUID()}`,
              traceId: () => `dry-trace-${randomUUID()}`,
            },
          }
        )

    if (!compiled.admitted) {
      return undefined
    }

    const spec = compiled.startRequest.spec
    const launchInitialPrompt = spec.launch?.initialPrompt
    const warnings = (compiled.profile.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.level !== 'error')
      .map((diagnostic) => diagnostic.message)

    return {
      controllerKind: 'harness-broker',
      brokerDriver: compiled.profile.brokerDriver,
      interactionMode: compiled.profile.interactionMode,
      profileId: compiled.profile.profileId,
      profileHash: compiled.profile.profileHash,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      process: {
        command: spec.process.command,
        args: spec.process.args,
        cwd: spec.process.cwd,
      },
      initialInput: compiled.startRequest.initialInput !== undefined,
      ...(typeof launchInitialPrompt === 'string'
        ? { launchInitialPromptLength: launchInitialPrompt.length }
        : {}),
      inputQueue: spec.interaction?.inputQueue ?? 'none',
      interrupt: compiled.profile.expectedCapabilities.turns.interrupt,
      ...(compiled.profile.brokerTerminal?.host === 'tmux'
        ? { resource: 'runtime-owned broker tmux lease socket' }
        : {}),
      warnings,
    }
  } finally {
    await client?.close().catch(() => undefined)
  }
}
