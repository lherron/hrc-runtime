import type { HrcTargetOperatorDisplayState, HrcTargetView } from 'hrc-core'

import type { HrcTopPrimaryAction } from './action-policy.js'
import type { HrcTopDisabledAction } from './focus.js'

export type HrcTopCommandPreview = {
  kind: 'attach' | 'resume' | 'run' | 'capture'
  argv?: string[] | undefined
  disabledReason?: string | undefined
}

export type HrcTopInspectInput = {
  handle: string
  target: HrcTargetView
  displayState: HrcTargetOperatorDisplayState
  operatorAttachable: boolean
  hasValidContinuation: boolean
  primaryAction: HrcTopPrimaryAction
  disabledActions?: readonly HrcTopDisabledAction[] | undefined
  latestEventSummary?: string | undefined
}

export type HrcTopInspectPanelModel = {
  handle: string
  sessionRef: string
  scopeRef: string
  lane: string
  hostSessionId?: string | undefined
  generation?: number | undefined
  targetState: HrcTargetView['state']
  displayState: HrcTargetOperatorDisplayState
  runtime?:
    | {
        runtimeId: string
        status: string
        transport: string
        operatorAttachable: boolean
        supportsCapture: boolean
        supportsLiteralSend: boolean
        activeRunId?: string | undefined
        lastActivityAt?: string | undefined
        brokerSubstrate?: string | undefined
        headlessRoute?: string | undefined
        brokerEndpoint?: string | undefined
        presentation?: string | undefined
      }
    | undefined
  continuation: {
    provider?: string | undefined
    key?: string | undefined
    captured: boolean
    resumeValid: boolean
  }
  capabilities: {
    state: HrcTargetView['capabilities']['state']
    modesSupported: readonly string[]
    defaultMode: string
    dmReady: boolean
    sendReady: boolean
    peekReady: boolean
  }
  primaryAction: HrcTopPrimaryAction
  disabledActions: readonly HrcTopDisabledAction[]
  latestEventSummary: string
  commandPreviews: readonly HrcTopCommandPreview[]
}

export function buildInspectPanelModel(input: HrcTopInspectInput): HrcTopInspectPanelModel {
  const disabledActions = input.disabledActions ?? []
  const disabledByKind = new Map(disabledActions.map((action) => [action.kind, action.reason]))
  const runtime = input.target.runtime

  return {
    handle: input.handle,
    sessionRef: input.target.sessionRef,
    scopeRef: input.target.scopeRef,
    lane: input.target.laneRef,
    hostSessionId: input.target.activeHostSessionId,
    generation: input.target.generation,
    targetState: input.target.state,
    displayState: input.displayState,
    runtime: runtime
      ? {
          runtimeId: runtime.runtimeId,
          status: runtime.status,
          transport: runtime.transport,
          operatorAttachable: input.operatorAttachable,
          supportsCapture: runtime.supportsCapture,
          supportsLiteralSend: runtime.supportsLiteralSend,
          activeRunId: runtime.activeRunId,
          lastActivityAt: runtime.lastActivityAt,
          brokerSubstrate: runtime.brokerSubstrate,
          headlessRoute: runtime.headlessRoute,
          brokerEndpoint: runtime.brokerEndpoint,
          presentation: runtime.presentation,
        }
      : undefined,
    continuation: {
      provider: input.target.continuation?.provider,
      key: input.target.continuation?.key,
      captured: input.target.continuation?.key !== undefined,
      resumeValid: input.hasValidContinuation,
    },
    capabilities: {
      state: input.target.capabilities.state,
      modesSupported: input.target.capabilities.modesSupported,
      defaultMode: input.target.capabilities.defaultMode,
      dmReady: input.target.capabilities.dmReady,
      sendReady: input.target.capabilities.sendReady,
      peekReady: input.target.capabilities.peekReady,
    },
    primaryAction: input.primaryAction,
    disabledActions,
    latestEventSummary: input.latestEventSummary ?? 'No recent event summary is available.',
    commandPreviews: [
      {
        kind: 'attach',
        argv: runtime?.runtimeId ? ['hrc', 'attach', runtime.runtimeId] : undefined,
        disabledReason: disabledByKind.get('attach'),
      },
      {
        kind: 'resume',
        argv: ['hrc', 'resume', input.handle],
        disabledReason: disabledByKind.get('resume'),
      },
      {
        kind: 'run',
        argv: ['hrc', 'run', input.handle],
        disabledReason: disabledByKind.get('run'),
      },
      {
        kind: 'capture',
        argv: runtime?.runtimeId ? ['hrc', 'runtime', 'capture', runtime.runtimeId] : undefined,
        disabledReason: disabledByKind.get('capture'),
      },
    ],
  }
}
