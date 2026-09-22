/**
 * The producer-selected v2 execution is HRC's sole launch input.  This module
 * deliberately models resources and protocol, not named harnesses or drivers:
 * ASP selects a recipe; HRC validates its resource declaration and hosts it.
 */

import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'

export type SelectedExecutionHosting = {
  executionTransport: 'jsonrpc-stdio' | 'pty' | 'native-worker'
  terminalRequired: boolean
  terminalHost?: 'tmux' | undefined
  processExecution: 'native-worker' | 'broker-process'
}

export type SelectedExecution = {
  recipeId: string
  driver: string
  protocol: 'harness-broker/0.2'
  hosting: SelectedExecutionHosting
  presentationFulfillment: 'intrinsic' | 'attachable' | 'birth-variant'
  presentationSurface?:
    | {
        transport: 'terminal' | 'websocket-unix'
        terminalHost: 'tmux'
      }
    | undefined
  profile: {
    profileId: string
    profileHash: string
    compatibilityHash: string
    startRequestHash: string
  }
  dispatchRequest: {
    startRequest: InvocationStartRequest
    dispatchEnv?: Record<string, string> | undefined
  }
}

/** Metadata retained with the frozen execution for audit and persistence. */
export type SelectedExecutionPlan = {
  schemaVersion: 'agent-runtime-plan/v2'
  planHash: string
  compileId: string
  createdAt: string
  diagnostics: unknown[]
  /**
   * ASP's resolved selection and field-level provenance. This is immutable
   * realization evidence, deliberately distinct from HRC's raw requested and
   * summon-directive inputs.
   */
  selection: {
    harness: string
    modelProvider: string
    model: string
    reasoningEffort?: string | undefined
    presentation: boolean
    provenance: {
      harness: SelectionProvenance
      modelProvider: SelectionProvenance
      model: SelectionProvenance
      reasoningEffort?: SelectionProvenance | undefined
      presentation: SelectionProvenance
    }
  }
}

export type SelectionProvenance =
  | 'agent-profile'
  | 'project-target'
  | 'summon-directive'
  | 'compile-request'
  | 'catalog-default'

export type SelectedExecutionHostingRefusal =
  | 'terminal-host-without-requirement'
  | 'terminal-host-required'
  | 'terminal-host-unsupported'
  | 'transport-process-mismatch'

export function validateSelectedExecutionHosting(
  hosting: SelectedExecutionHosting
): { ok: true } | { ok: false; code: SelectedExecutionHostingRefusal } {
  if (hosting.terminalHost !== undefined && hosting.terminalHost !== 'tmux') {
    return { ok: false, code: 'terminal-host-unsupported' }
  }
  if (!hosting.terminalRequired && hosting.terminalHost !== undefined) {
    return { ok: false, code: 'terminal-host-without-requirement' }
  }
  if (hosting.terminalRequired && hosting.terminalHost !== 'tmux') {
    return { ok: false, code: 'terminal-host-required' }
  }
  const processMatchesTransport =
    (hosting.executionTransport === 'jsonrpc-stdio' &&
      hosting.processExecution === 'broker-process') ||
    (hosting.executionTransport === 'pty' &&
      hosting.processExecution === 'broker-process' &&
      hosting.terminalRequired) ||
    (hosting.executionTransport === 'native-worker' && hosting.processExecution === 'native-worker')
  return processMatchesTransport ? { ok: true } : { ok: false, code: 'transport-process-mismatch' }
}

/** The allocation choice follows resources only; no driver route is inferred. */
export function hostingAllocationKind(
  hosting: SelectedExecutionHosting
): 'terminal-surface' | 'headless-substrate' {
  return hosting.terminalRequired ? 'terminal-surface' : 'headless-substrate'
}

export function executionRequiresTerminal(execution: SelectedExecution): boolean {
  return hostingAllocationKind(execution.hosting) === 'terminal-surface'
}

export function executionUsesBrokerProcess(execution: SelectedExecution): boolean {
  return execution.hosting.processExecution === 'broker-process'
}
