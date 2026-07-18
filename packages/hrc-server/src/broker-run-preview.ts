import { randomUUID } from 'node:crypto'

import type { HrcRuntimeIntent, RestartStyle } from 'hrc-core'

import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import { isInteractiveTmuxBrokerIntent, shouldUseHeadlessTransport } from './broker-decisions.js'
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
  _options: {
    sessionRef: string
    restartStyle: RestartStyle
    promptLength?: number | undefined
  }
): Promise<BrokerRunPreview | undefined> {
  if (!isInteractiveTmuxBrokerIntent(intent) && !shouldUseHeadlessTransport(intent)) {
    return undefined
  }

  const runtimeId = `dry-rt-${randomUUID()}`
  const timing = createPrecompileLaunchTimingContext('preview', runtimeId)
  const client = await startAspcFacadeBrokerClient(timing)

  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent,
        hostSessionId: 'dry-run-host-session',
        generation: 0,
        continuation: undefined,
      },
      {
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
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
    await client.close().catch(() => undefined)
  }
}
