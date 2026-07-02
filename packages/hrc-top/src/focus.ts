import type { HrcTargetOperatorDisplayState, HrcTargetView } from 'hrc-core'

import { recommendPrimaryAction } from './action-policy.js'
import type { HrcTopPrimaryAction } from './action-policy.js'

export type HrcTopDisabledAction = {
  kind: 'attach' | 'resume' | 'run'
  reason: string
}

export type HrcTopAmbiguityCandidate = {
  runtimeId: string
  label: string
  command?: string[] | undefined
}

export type HrcTopFocusInput = {
  handle: string
  target: HrcTargetView
  displayState: HrcTargetOperatorDisplayState
  operatorAttachable: boolean
  hasValidContinuation: boolean
  disabledActions?: readonly HrcTopDisabledAction[] | undefined
  latestEventSummary?: string | undefined
  ambiguityCandidates?: readonly HrcTopAmbiguityCandidate[] | undefined
}

export type HrcTopFocusPanelModel = {
  handle: string
  sessionRef: string
  lane: string
  hostSessionId?: string | undefined
  latestRuntimeId?: string | undefined
  primaryAction: HrcTopPrimaryAction
  disabledActions: readonly { kind: string; reason: string }[]
  latestEventSummary: string
  ambiguityCandidates: readonly HrcTopAmbiguityCandidate[]
  commandPreview?: string[] | undefined
}

export function buildFocusPanelModel(input: HrcTopFocusInput): HrcTopFocusPanelModel {
  const primaryAction = recommendPrimaryAction({
    handle: input.handle,
    target: input.target,
    displayState: input.displayState,
    operatorAttachable: input.operatorAttachable,
    hasValidContinuation: input.hasValidContinuation,
  })

  return {
    handle: input.handle,
    sessionRef: input.target.sessionRef,
    lane: input.target.laneRef,
    hostSessionId: input.target.activeHostSessionId,
    latestRuntimeId: input.target.runtime?.runtimeId,
    primaryAction,
    disabledActions: input.disabledActions ?? [],
    latestEventSummary: input.latestEventSummary ?? 'No recent event summary is available.',
    ambiguityCandidates: input.ambiguityCandidates ?? [],
    commandPreview: primaryAction.command,
  }
}
